import unittest
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import candidate_release_gate
from candidate_release_gate import invalidate_receipt, validate_cli_candidate, validate_zcode_candidate


def receipt():
    return {
        'scope': 'isolated-candidate', 'status': 'INCOMPLETE',
        'candidate_bundle': {'source_sha': 'a' * 40},
        'missing': ['installed-process', 'other-required-environments'],
        'cli_versions': {'codex': 'codex-cli 0.167.0', 'opencode': 'opencode v2.1.3'},
        'journeys': [
            {'harness': h, 'status': 'INCOMPLETE', 'missing': ['installed-process'],
             'searchProven': True, 'fixtureRequests': 2,
             'sessions': [{'id': h + '-1', 'pages': 3}, {'id': h + '-2', 'pages': 3}]}
            for h in ('codex', 'opencode')
        ],
    }


class CandidateReleaseGateTest(unittest.TestCase):
    def test_zcode_unavailable_invalidates_receipt_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'receipt.json'
            path.write_text(json.dumps({'cli_candidate': 'PASS', 'release': 'PASS'}))
            args = ['gate', '/candidate', 'a' * 40, '/codex', '/opencode', str(path)]
            completed = SimpleNamespace(returncode=2, stdout=json.dumps(receipt()), stderr='')
            with patch.object(sys, 'argv', args), patch.object(candidate_release_gate.subprocess, 'run', return_value=completed), \
                    patch.object(candidate_release_gate, 'run_zcode_candidate', side_effect=RuntimeError('unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                    candidate_release_gate.main()
            result = json.loads(path.read_text())
            self.assertEqual(result['cli_candidate'], 'INCOMPLETE')
            self.assertEqual(result['release'], 'INCOMPLETE')

    def test_zcode_requires_same_payload_and_complete_native_journey(self):
        row = {'scope': 'zcode-official-project', 'version': '3.17.2', 'fixtureRequests': 5,
               'sessions': ['one', 'two'], 'sessionsCreated': True, 'sessionsListed': True,
               'sessionsSearched': True, 'projectListed': True, 'answer': True,
               'transcriptComplete': True, 'transcriptPages': [8, 8]}
        result = {'scope': 'isolated-candidate-only', 'status': 'PASS', 'artifact_sha256': 'a' * 64,
                  'artifact_consistent': True, 'reports': [row]}
        self.assertEqual(validate_zcode_candidate(result, 'a' * 64)['scope'], 'zcode-official-project')
        for key, value in [('artifact_sha256', 'b' * 64), ('artifact_consistent', False)]:
            broken = dict(result, **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_zcode_candidate(broken, 'a' * 64)
        for key, value in [('sessionsSearched', False), ('transcriptPages', [8, 1])]:
            broken = dict(result, reports=[dict(row, **{key: value})])
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_zcode_candidate(broken, 'a' * 64)

    def test_stale_success_is_invalidated_before_a_new_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'receipt.json'
            path.write_text(json.dumps({'cli_candidate': 'PASS'}))
            invalidate_receipt(path)
            self.assertEqual(json.loads(path.read_text())['cli_candidate'], 'INCOMPLETE')

    def test_cli_pass_preserves_full_release_incomplete(self):
        result = validate_cli_candidate(receipt(), 'a' * 40, 2)
        self.assertEqual(result['cli_candidate'], 'PASS')
        self.assertEqual(result['release'], 'INCOMPLETE')

    def test_failed_runner_missing_lane_or_short_transcript_refuse_candidate(self):
        for change in ('failure', 'missing', 'short', 'wrong_sha'):
            data = receipt()
            rc = 2
            if change == 'failure': rc = 1
            if change == 'missing': data['journeys'].pop()
            if change == 'short': data['journeys'][0]['sessions'][0]['pages'] = 1
            if change == 'wrong_sha': data['candidate_bundle']['source_sha'] = 'b' * 40
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_cli_candidate(data, 'a' * 40, rc)


class V1ReportTest(unittest.TestCase):
    harnesses = ('chatgpt', 'zai', 'opencode', 'codex', 'zcode')
    checks = ('create', 'second_deliver_same_session', 'read_both', 'export_native_complete',
              'search_with_coverage', 'projects_with_provenance', 'reopen_without_resend',
              'vibe_session_visibility')

    negative_checks = ('wrong_instance_or_principal', 'same_key_no_replay',
                       'same_key_payload_conflict', 'unknown_after_restart_no_replay',
                       'human_stop_before_send')


    def browser_evidence(self, harness):
        native = harness + '-native-canary'
        active = harness + '-existing-active'
        return {'transport': 'vibe-mcp', 'run_id': self.identity['run_id'],
                'harness': harness, 'instance_ref': harness + '-local',
                'core_session_ref': 'session:' + harness + '-core',
                'native_session_id': native, 'ui_native_session_id': native,
                'native_state': 'running', 'ui_state': 'running',
                'native_state_contract': 'AgentSession.status',
                'native_raw_state_ref': 'native:' + harness + '-raw-state',
                'control_scope': 'authorized_registered_sessions',
                'native_catalog_scope': 'authorized_owner_active_sessions',
                'observation_phase': 'before_cleanup',
                'native_catalog_ref': 'native:' + harness + '-active-catalog',
                'native_catalog_complete': True, 'native_coverage_complete': True,
                'native_active_session_ids': [native, active],
                'native_active_states': {native: 'running', active: 'running'},
                'ui_visible_session_ids': [native, active],
                'ui_session_states': {native: 'running', active: 'running'},
                'native_receipt_ref': 'native:' + harness + '-receipt',
                'browser_snapshot_ref': 'vibe:' + harness + '-snapshot'}

    def setUp(self):
        self.identity = {'run_id': 'run-42', 'source_sha': 'a' * 40,
                         'artifact_sha256': 'b' * 64, 'stage': 'candidate'}
        self.report = dict(self.identity, lanes={h: {'checks': {c: 'PASS' for c in self.checks},
                                                    'browser_evidence': self.browser_evidence(h)}
                                                for h in self.harnesses},
                           negative_checks={c: 'PASS' for c in self.negative_checks})

    def test_all_lanes_pass_only_for_exact_requested_stage(self):
        result = candidate_release_gate.validate_v1_report(self.report, self.identity)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['stage'], 'candidate')
        installed = dict(self.identity, stage='installed')
        self.report['stage'] = 'installed'
        self.assertEqual(candidate_release_gate.validate_v1_report(self.report, installed)['stage'], 'installed')

    def test_missing_lane_check_and_nonpass_states_refuse(self):
        for failure in ('missing_lane', 'missing_check', 'UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'FAIL', 'other'):
            import copy
            report = copy.deepcopy(self.report)
            if failure == 'missing_lane': del report['lanes']['zai']
            elif failure == 'missing_check': del report['lanes']['chatgpt']['checks']['create']
            else: report['lanes']['opencode']['checks']['create'] = failure
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_common_negative_checks_are_mandatory_and_must_pass(self):
        import copy
        variants = [None, {}, {**self.report['negative_checks'], 'human_stop_before_send': 'UNKNOWN'}]
        for variant in variants:
            report = copy.deepcopy(self.report)
            if variant is None:
                del report['negative_checks']
            else:
                report['negative_checks'] = variant
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)
        for check in self.negative_checks:
            report = copy.deepcopy(self.report)
            del report['negative_checks'][check]
            with self.subTest(missing=check), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_wrong_identity_stale_run_and_stage_refused_without_echo(self):
        for field, wrong in [('run_id', 'old-run-secret'), ('source_sha', 'c' * 40),
                             ('artifact_sha256', 'd' * 64), ('stage', 'installed')]:
            with self.subTest(field=field), self.assertRaises(ValueError) as context:
                candidate_release_gate.validate_v1_report(dict(self.report, **{field: wrong}), self.identity)
            self.assertNotIn(wrong, str(context.exception))

    def test_invalid_identity_is_not_equal_by_accident(self):
        for field in ('run_id', 'source_sha', 'artifact_sha256', 'stage'):
            identity = dict(self.identity); identity[field] = ''
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(dict(self.report, **identity), identity)

    def test_cli_v1_is_read_only_and_reports_bounded_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'; expected = Path(tmp) / 'expected.json'
            report.write_text(json.dumps(self.report)); expected.write_text(json.dumps(self.identity))
            with patch.object(sys, 'argv', ['gate', '--validate-v1', str(report), str(expected)]), \
                    patch.object(candidate_release_gate.subprocess, 'run', side_effect=AssertionError('launched')):
                self.assertEqual(candidate_release_gate.main(), 0)
                self.report['lanes']['zcode']['checks']['create'] = 'UNKNOWN'
                report.write_text(json.dumps(self.report))
                self.assertNotEqual(candidate_release_gate.main(), 0)
                self.report['lanes']['zcode']['checks']['create'] = 'secret-provider-output'
                report.write_text(json.dumps(self.report))
                with patch('sys.stderr') as stderr:
                    self.assertNotEqual(candidate_release_gate.main(), 0)
                    self.assertNotIn('secret-provider-output', str(stderr.write.call_args_list))


    def test_vibe_evidence_is_required_even_when_all_status_checks_pass(self):
        import copy
        for harness in self.harnesses:
            report = copy.deepcopy(self.report)
            del report['lanes'][harness]['browser_evidence']
            with self.subTest(harness=harness), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_visibility_check_cannot_be_missing_or_nonpass(self):
        import copy
        for state in (None, 'UNKNOWN', 'UNSUPPORTED', 'BLOCKED', 'FAIL'):
            report = copy.deepcopy(self.report)
            checks = report['lanes']['chatgpt']['checks']
            if state is None:
                del checks['vibe_session_visibility']
            else:
                checks['vibe_session_visibility'] = state
            with self.subTest(state=state), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_evidence_is_bound_to_transport_run_lane_and_receipts(self):
        import copy
        variants = [('transport', 'playwright'), ('run_id', 'old-run'),
                    ('harness', 'zai'), ('instance_ref', ''),
                    ('core_session_ref', ''), ('native_receipt_ref', ''),
                    ('browser_snapshot_ref', '')]
        for key, value in variants:
            report = copy.deepcopy(self.report)
            report['lanes']['chatgpt']['browser_evidence'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_incomplete_native_coverage_never_becomes_green(self):
        import copy
        for coverage in (False, None, 1, 'true'):
            report = copy.deepcopy(self.report)
            lane = report['lanes']['codex']
            lane.update(complete=True, limitations=[])
            lane['browser_evidence']['native_coverage_complete'] = coverage
            with self.subTest(coverage=coverage), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_exact_native_id_must_be_visible_even_with_a_snapshot(self):
        import copy
        for change in ('different_detail', 'list_missing_exact_id', 'core_ref_as_native'):
            report = copy.deepcopy(self.report)
            evidence = report['lanes']['opencode']['browser_evidence']
            if change == 'different_detail':
                evidence['ui_native_session_id'] = 'some-other-session'
            elif change == 'list_missing_exact_id':
                evidence['ui_visible_session_ids'] = ['some-other-session']
            else:
                evidence['native_session_id'] = evidence['core_session_ref']
                evidence['ui_native_session_id'] = evidence['core_session_ref']
                evidence['ui_visible_session_ids'].append(evidence['core_session_ref'])
            with self.subTest(change=change), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_ui_and_native_state_must_match_and_be_known(self):
        import copy
        for native, ui in [('running', 'idle'), ('UNKNOWN', 'UNKNOWN'),
                           ('unknown', 'unknown'), ('invented', 'invented'),
                           (None, None)]:
            report = copy.deepcopy(self.report)
            evidence = report['lanes']['zcode']['browser_evidence']
            evidence.update(native_state=native, ui_state=ui)
            with self.subTest(native=native, ui=ui), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_all_active_native_sessions_must_be_visible(self):
        import copy
        report = copy.deepcopy(self.report)
        evidence = report['lanes']['zai']['browser_evidence']
        evidence['ui_visible_session_ids'] = [evidence['native_session_id']]
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_v1_report(report, self.identity)
        for field in ('native_active_session_ids', 'ui_visible_session_ids'):
            for value in (None, 'a-session', ['', 'bad'], ['duplicate', 'duplicate']):
                report = copy.deepcopy(self.report)
                report['lanes']['zai']['browser_evidence'][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_idle_session_and_extra_visible_inactive_sessions_are_valid(self):
        evidence = self.report['lanes']['chatgpt']['browser_evidence']
        evidence.update(native_state='idle', ui_state='idle', native_active_session_ids=[],
                        native_active_states={})
        evidence['ui_session_states'][evidence['native_session_id']] = 'idle'
        evidence['ui_visible_session_ids'].append('inactive-session')
        result = candidate_release_gate.validate_v1_report(self.report, self.identity)
        self.assertEqual(result['status'], 'PASS')

    def test_vibe_validation_does_not_echo_private_browser_values(self):
        self.report['lanes']['chatgpt']['browser_evidence']['ui_native_session_id'] = 'private-browser-session'
        with self.assertRaises(ValueError) as context:
            candidate_release_gate.validate_v1_report(self.report, self.identity)
        self.assertNotIn('private-browser-session', str(context.exception))

    def test_vibe_catalog_scope_is_separate_from_mutation_scope(self):
        import copy
        cases = [('control_scope', None), ('control_scope', 'all_native_sessions'),
                 ('native_catalog_scope', None),
                 ('native_catalog_scope', 'authorized_registered_sessions'),
                 ('native_catalog_scope', 'global_database_catalog'),
                 ('observation_phase', None), ('observation_phase', 'after_cleanup')]
        for field, value in cases:
            report = copy.deepcopy(self.report)
            report['lanes']['opencode']['browser_evidence'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_active_catalog_and_raw_state_require_complete_source_receipts(self):
        import copy
        cases = [('native_catalog_complete', value) for value in (False, None, 1, 'true')]
        cases += [('native_catalog_ref', None), ('native_catalog_ref', ''),
                  ('native_raw_state_ref', None), ('native_state_contract', None),
                  ('native_state_contract', 'inferred_from_provider_timestamps')]
        for field, value in cases:
            report = copy.deepcopy(self.report)
            evidence = report['lanes']['opencode']['browser_evidence']
            evidence[field] = value
            evidence.update(complete=True, limitations=[])
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_unregistered_authorized_active_session_must_be_visible(self):
        evidence = self.report['lanes']['opencode']['browser_evidence']
        canary = evidence['native_session_id']
        unregistered = 'opencode-authorized-unregistered-running'
        evidence['registered_session_ids'] = [canary]
        evidence['native_active_session_ids'].append(unregistered)
        evidence['native_active_states'][unregistered] = 'running'
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_v1_report(self.report, self.identity)
        evidence['ui_visible_session_ids'].append(unregistered)
        evidence['ui_session_states'][unregistered] = 'running'
        self.assertEqual(candidate_release_gate.validate_v1_report(
            self.report, self.identity)['status'], 'PASS')

    def test_vibe_each_authorized_active_state_must_match_the_rendered_state(self):
        import copy
        for field, value in [('native_active_states', None), ('ui_session_states', None),
                             ('native_active_states', {}), ('ui_session_states', {})]:
            report = copy.deepcopy(self.report)
            report['lanes']['zcode']['browser_evidence'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)
        for field, value in [('ui_session_states', 'idle'), ('ui_session_states', 'UNKNOWN'),
                             ('native_active_states', 'unknown'),
                             ('native_active_states', 'stopped')]:
            report = copy.deepcopy(self.report)
            evidence = report['lanes']['zcode']['browser_evidence']
            evidence[field]['zcode-existing-active'] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_vibe_stopped_canary_can_pass_before_cleanup_with_archived_history(self):
        evidence = self.report['lanes']['codex']['browser_evidence']
        native = evidence['native_session_id']
        evidence.update(native_state='stopped', ui_state='stopped')
        evidence['native_active_session_ids'].remove(native)
        del evidence['native_active_states'][native]
        evidence['ui_session_states'][native] = 'stopped'
        evidence['registered_history_native_coverage_complete'] = False
        self.assertEqual(candidate_release_gate.validate_v1_report(
            self.report, self.identity)['status'], 'PASS')

    def test_vibe_canary_raw_label_does_not_replace_the_canonical_state(self):
        import copy
        for status in ('completed', 'archived', 'succeeded', 'error'):
            report = copy.deepcopy(self.report)
            evidence = report['lanes']['codex']['browser_evidence']
            evidence.update(native_state=status, ui_state=status)
            evidence['ui_session_states'][evidence['native_session_id']] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                candidate_release_gate.validate_v1_report(report, self.identity)

    def test_cli_rejects_malformed_or_duplicate_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'; expected = Path(tmp) / 'expected.json'
            expected.write_text(json.dumps(self.identity))
            for content in ('{', '{"stage":"candidate","stage":"installed"}'):
                report.write_text(content)
                with patch.object(sys, 'argv', ['gate', '--validate-v1', str(report), str(expected)]):
                    self.assertNotEqual(candidate_release_gate.main(), 0)


class InstalledBrowserReportTest(unittest.TestCase):
    def setUp(self):
        self.identity = {'run_id': 'installed-42', 'source_sha': 'a' * 40,
                         'artifact_sha256': 'b' * 64, 'stage': 'installed'}
        self.report = dict(self.identity, mode='installed-browser', status='PASS',
                           functional_status='PASS', global_inventory_status='VERIFIED',
                           identity='PASS', browser_cleanup='PASS',
                           lanes={h: {'checks': {c: 'PASS' for c in candidate_release_gate.INSTALLED_BROWSER_CHECKS},
                                      'browser_evidence': V1ReportTest.browser_evidence(self, h)}
                                  for h in candidate_release_gate.V1_HARNESSES})

    def test_installed_browser_does_not_fabricate_protocol_negative_checks(self):
        result = candidate_release_gate.validate_installed_browser_report(self.report, self.identity)
        self.assertEqual(result, {'status': 'PASS', 'functional_status': 'PASS', 'global_inventory_status': 'VERIFIED',
                                  'stage': 'installed', 'mode': 'installed-browser'})
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_v1_report(self.report, self.identity)

    def test_missing_lane_continuation_cleanup_or_identity_never_passes(self):
        import copy
        cases = [('status', 'UNKNOWN'), ('identity', 'FAIL'), ('browser_cleanup', 'NOT_CREATED'),
                 ('transport_cleanup', 'FAIL'), ('mode', 'candidate')]
        for field, value in cases:
            report = copy.deepcopy(self.report); report[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        for check in candidate_release_gate.INSTALLED_BROWSER_CHECKS:
            report = copy.deepcopy(self.report); report['lanes']['codex']['checks'][check] = 'UNKNOWN'
            with self.subTest(check=check), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        del self.report['lanes']['zcode']
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_installed_browser_report(self.report, self.identity)

    def test_installed_browser_requires_real_native_ui_evidence_and_exact_build(self):
        import copy
        for change in ('browser_evidence', 'source_sha', 'artifact_sha256'):
            report = copy.deepcopy(self.report)
            if change == 'browser_evidence': del report['lanes']['opencode'][change]
            else: report[change] = 'c' * len(report[change])
            with self.subTest(change=change), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        self.identity['stage'] = self.report['stage'] = 'candidate'
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_installed_browser_report(self.report, self.identity)

    def bounded_browser(self, harness='chatgpt'):
        evidence = self.report['lanes'][harness]['browser_evidence']
        native = evidence['native_session_id']
        evidence.update(native_catalog_scope='owned_current_conversations', native_catalog_complete=False,
                        native_coverage_complete=False, canary_native_coverage_complete=True,
                        global_inventory_status='UNVERIFIED', expected_account_scope_sha256='d' * 64,
                        expected_owned_page_namespace='vibe-' + 'e' * 64,
                        native_observed_at='2026-11-09T00:00:00Z', native_observed_age_ms=1000,
                        native_active_session_ids=[native], native_active_states={native: 'running'})
        evidence['native_owned_conversation_proof'] = {
            'capability': 'owned-current-conversation', 'account_scope_sha256': 'd' * 64,
            'owned_page_namespace': 'vibe-' + 'e' * 64,
            'native_session_id': native, 'native_conversation_id': 'native-conversation', 'owned_page_id': 42,
            'owned_page_url': 'https://chatgpt.com/c/native-conversation',
            'source_route': 'https://chatgpt.com/c/native-conversation', 'owned_view_ref': 'native:owned-view',
            'observed_at': evidence['native_observed_at'],
            'canonical_status': 'running', 'native_messages_ref': 'native:messages',
            'dom_generation_state_ref': 'native:owned-dom'}
        self.report['global_inventory_status'] = 'UNVERIFIED'
        return evidence

    def test_explicit_browser_capability_passes_functional_only_and_preserves_unknown_global_inventory(self):
        self.bounded_browser()
        result = candidate_release_gate.validate_installed_browser_report(self.report, self.identity)
        self.assertEqual(result['functional_status'], 'PASS')
        self.assertEqual(result['global_inventory_status'], 'UNVERIFIED')
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_vibe_browser_evidence(
                self.report['lanes']['chatgpt']['browser_evidence'], 'chatgpt', self.identity['run_id'])

    def test_bare_partial_or_false_global_claims_do_not_pass_the_owned_conversation_exception(self):
        import copy
        evidence = self.bounded_browser()
        cases = [('native_owned_conversation_proof', None), ('canary_native_coverage_complete', False),
                 ('native_coverage_complete', True), ('native_catalog_complete', True),
                 ('global_inventory_status', 'VERIFIED'), ('expected_account_scope_sha256', 'e' * 64)]
        for field, value in cases:
            report = copy.deepcopy(self.report); report['lanes']['chatgpt']['browser_evidence'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        for field, value in [('owned_page_id', 0), ('owned_page_id', True),
                             ('native_messages_ref', ''), ('dom_generation_state_ref', None), ('owned_page_namespace', 'legacy'),
                             ('owned_view_ref', ''), ('native_conversation_id', 'other'), ('source_route', 'https://chatgpt.com/c/other'),
                             ('native_session_id', 'session:wrong'), ('canonical_status', 'UNKNOWN'),
                             ('owned_page_url', 'https://unrelated.invalid/c/native')]:
            report = copy.deepcopy(self.report)
            report['lanes']['chatgpt']['browser_evidence']['native_owned_conversation_proof'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)

    def bounded_zcode(self):
        evidence = self.report['lanes']['zcode']['browser_evidence']
        native = evidence['native_session_id']
        evidence.update(native_catalog_scope='pinned_official_server_owner', native_catalog_complete=False,
                        native_coverage_complete=False, canary_native_coverage_complete=True,
                        official_owner_coverage_complete=True, global_inventory_status='UNVERIFIED',
                        host_id='owner-server', expected_cwd='/owned/project', expected_create_model='provider/model$enabled', native_state='idle', ui_state='idle',
                        native_active_session_ids=['official-other-running'], native_active_states={'official-other-running': 'running'},
                        native_observed_at='2026-11-09T00:00:00Z', native_observed_age_ms=1000,
                        official_catalog_observed_at='2026-11-09T00:00:00Z', official_catalog_age_ms=1000,
                        official_catalog_expires_at='2026-11-09T00:00:15Z', ui_observed_at='2026-11-09T00:00:01Z')
        evidence['ui_session_states'][native] = 'idle'
        evidence['ui_session_states']['official-other-running'] = 'running'
        evidence['ui_visible_session_ids'].append('official-other-running')
        evidence['native_official_server_proof'] = {
            'capability': 'official-server-canary', 'source': 'zcode-native-session-read+official-supervisor',
            'native_session_id': native, 'core_session_ref': evidence['core_session_ref'], 'host_id': 'owner-server',
            'cwd': '/owned/project', 'create_model': 'provider/model$enabled', 'canonical_status': 'idle', 'observed_at': evidence['native_observed_at'],
            'official_pid': 1234, 'official_generation': 2, 'completed_message_ids': ['a0', 'a1'], 'user_message_ids': ['u0', 'u1'],
            'native_delivery_receipt_refs': ['receipt:first', 'receipt:second'], 'native_delivery_receipt_ids': ['native:first', 'native:second'],
            'native_transcript_sha256': 'e' * 64, 'native_transcript_ref': 'native:complete-transcript',
            'official_before_ref': 'native:official-before', 'official_after_ref': 'native:official-after'}
        self.report['global_inventory_status'] = 'UNVERIFIED'
        return evidence

    def test_exact_zcode_official_scope_is_functional_only_and_all_official_active_rows_must_be_visible(self):
        evidence = self.bounded_zcode()
        result = candidate_release_gate.validate_installed_browser_report(self.report, self.identity)
        self.assertEqual(result['functional_status'], 'PASS')
        self.assertEqual(result['global_inventory_status'], 'UNVERIFIED')
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_vibe_browser_evidence(evidence, 'zcode', self.identity['run_id'])
        evidence['ui_visible_session_ids'].remove('official-other-running')
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_installed_browser_report(self.report, self.identity)

    def test_zcode_official_proof_rejects_wrong_identity_generation_stale_snapshot_and_false_global_claims(self):
        import copy
        self.bounded_zcode()
        for field, value in [('source', 'combined-incomplete-inventory'), ('cwd', '/different'), ('host_id', 'another-host'),
                             ('native_session_id', 'other'), ('core_session_ref', 'session:other'), ('canonical_status', 'running'),
                             ('create_model', 'provider/model$disabled'),
                             ('official_pid', True), ('official_generation', -1), ('native_transcript_ref', ''),
                             ('official_before_ref', None), ('official_after_ref', ''), ('native_transcript_sha256', 'unknown'),
                             ('completed_message_ids', ['same', 'same']), ('user_message_ids', []),
                             ('native_delivery_receipt_refs', []), ('native_delivery_receipt_ids', ['same', 'same'])]:
            report = copy.deepcopy(self.report)
            report['lanes']['zcode']['browser_evidence']['native_official_server_proof'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        for field, value in [('native_catalog_complete', True), ('native_coverage_complete', True), ('global_inventory_status', 'VERIFIED'),
                             ('official_owner_coverage_complete', False), ('native_observed_age_ms', 16000),
                             ('official_catalog_age_ms', 16000), ('official_catalog_age_ms', True),
                             ('official_catalog_expires_at', '2026-11-09T00:00:00Z'), ('ui_observed_at', '2026-11-09T00:01:00Z')]:
            report = copy.deepcopy(self.report); report['lanes']['zcode']['browser_evidence'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        self.report['global_inventory_status'] = 'VERIFIED'
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_installed_browser_report(self.report, self.identity)

    def test_owned_conversation_exception_cannot_mask_native_cli_inventory_failure(self):
        self.bounded_browser('codex')
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_installed_browser_report(self.report, self.identity)

    def bounded_codex(self):
        evidence = self.report['lanes']['codex']['browser_evidence']
        native = evidence['native_session_id']
        evidence.update(native_catalog_scope='registered_canary_completed_turns', native_catalog_complete=False,
                        native_coverage_complete=False, canary_native_coverage_complete=True,
                        global_inventory_status='UNVERIFIED', expected_cwd='/owned/project',
                        native_state='idle', ui_state='idle', native_active_session_ids=[], native_active_states={},
                        native_observed_at='2026-11-09T00:00:00Z', native_observed_age_ms=1000)
        evidence['ui_session_states'][native] = 'idle'
        evidence['native_completed_turns_proof'] = {
            'capability':'registered-canary-completed-turns', 'source':'codex-native-thread-read-completion',
            'native_session_id':native, 'core_session_ref':evidence['core_session_ref'], 'cwd':'/owned/project',
            'canonical_status':'idle', 'observed_at':evidence['native_observed_at'],
            'completed_turn_ids':['turn-first','turn-second'], 'latest_turn_id':'turn-second',
            'native_delivery_receipt_refs':['receipt:first','receipt:second'],
            'native_delivery_receipt_ids':['native:first','native:second'],
            'fingerprint':'d'*64, 'canonical_transcript_sha256':'e'*64,
            'native_messages_ref':'native:messages', 'canonical_completion_ref':'native:canonical'}
        self.report['global_inventory_status'] = 'UNVERIFIED'
        return evidence

    def test_exact_completed_codex_proof_is_functional_only(self):
        evidence = self.bounded_codex()
        result = candidate_release_gate.validate_installed_browser_report(self.report, self.identity)
        self.assertEqual(result['functional_status'], 'PASS')
        self.assertEqual(result['global_inventory_status'], 'UNVERIFIED')
        with self.assertRaises(ValueError):
            candidate_release_gate.validate_vibe_browser_evidence(evidence, 'codex', self.identity['run_id'])

    def test_codex_completion_requires_exact_bound_source_identity_turns_freshness_and_receipts(self):
        import copy
        self.bounded_codex()
        for field, value in [('source','connected_native_controller'),('cwd','/wrong/project'),
                             ('native_session_id','wrong'),('core_session_ref','session:wrong'),
                             ('latest_turn_id','first'),('canonical_status','running'),
                             ('completed_turn_ids',['same','same']),('native_delivery_receipt_refs',[]),
                             ('native_delivery_receipt_ids',['same','same']),('native_messages_ref',''),
                             ('canonical_completion_ref',None),('canonical_transcript_sha256','unknown')]:
            report = copy.deepcopy(self.report)
            report['lanes']['codex']['browser_evidence']['native_completed_turns_proof'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)
        for field, value in [('native_catalog_complete',True),('native_coverage_complete',True),
                             ('native_observed_age_ms',31000),('native_observed_age_ms',True),
                             ('native_observed_at','different'),('global_inventory_status','VERIFIED')]:
            report = copy.deepcopy(self.report); report['lanes']['codex']['browser_evidence'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                candidate_release_gate.validate_installed_browser_report(report, self.identity)



if __name__ == '__main__': unittest.main()
