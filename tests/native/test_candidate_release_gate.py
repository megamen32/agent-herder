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
              'search_with_coverage', 'projects_with_provenance', 'reopen_without_resend')

    negative_checks = ('wrong_instance_or_principal', 'same_key_no_replay',
                       'same_key_payload_conflict', 'unknown_after_restart_no_replay',
                       'human_stop_before_send')

    def setUp(self):
        self.identity = {'run_id': 'run-42', 'source_sha': 'a' * 40,
                         'artifact_sha256': 'b' * 64, 'stage': 'candidate'}
        self.report = dict(self.identity, lanes={h: {'checks': {c: 'PASS' for c in self.checks}}
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

    def test_cli_rejects_malformed_or_duplicate_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'; expected = Path(tmp) / 'expected.json'
            expected.write_text(json.dumps(self.identity))
            for content in ('{', '{"stage":"candidate","stage":"installed"}'):
                report.write_text(content)
                with patch.object(sys, 'argv', ['gate', '--validate-v1', str(report), str(expected)]):
                    self.assertNotEqual(candidate_release_gate.main(), 0)


if __name__ == '__main__': unittest.main()
