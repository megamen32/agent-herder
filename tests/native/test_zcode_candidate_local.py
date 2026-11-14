import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import zcode_candidate_local as local
import candidate_release_gate as gate


def runtime(root):
    root.mkdir(mode=0o700)
    for name in local.REQUIRED_RUNTIME:
        path = root / name
        path.write_bytes(name.encode())
        path.chmod(0o755 if name == 'node' else 0o644)
    deps = root / 'node_modules'
    deps.mkdir(mode=0o700)
    (deps / 'native.node').write_bytes(b'native dependency')
    (deps / 'native.node').chmod(0o600)
    return local.runtime_identity(root)


def report():
    return {'scope': 'isolated-candidate-only', 'status': 'PASS', 'artifact_consistent': True,
            'artifact_sha256': 'a' * 64,
            'source_quiescence': {'mode': 'persisted-after-official-shutdown', 'original_processes_gone': True,
                                  'stable_seconds': 1, 'stable_observation': {'db': 'exact'}, 'stop_status': {'state': 'stopped'}},
            'reports': [{'scope': 'zcode-official-project', 'version': '3.17.2', 'fixtureRequests': 5,
                         'sessions': ['native-one', 'native-two'], 'transcriptPages': [4, 4],
                         'sessionsCreated': True, 'sessionsListed': True, 'sessionsSearched': True,
                         'projectListed': True, 'answer': True, 'transcriptComplete': True,
                         'deliveryMode': 'immediate', 'deferredQueueTested': False, 'searchReadMode': 'persisted-after-official-shutdown',
                         'continuation': {'session_id': 'native-one', 'pages': 6, 'input_id': 'third-input',
                                          'mode': 'immediate', 'receipt': {'ok': True, 'inputId': 'third-input',
                                          'nativeInputMessageId': 'native-message-3'}, 'confirmed': True}}]}


def idle_session():
    return {'session': {'id': 'native-one', 'harness': 'zcode', 'cwd': '/work', 'model': 'fixture/herder-test$disabled',
                        'status': 'idle', 'needsPermission': False,
                        'meta': {'nativeLoaded': True, 'humanStopHeld': False, 'nativeStatus': 'idle', 'nativeStateRevision': 1,
                                 'pendingRequestIds': [], 'permissionMode': 'yolo', 'permissionRulesRevision': 0}}}



def completed_session():
    result = idle_session()
    result['session']['meta']['nativeLastTurn'] = {'status': 'completed', 'cancelledByUser': False,
        'pendingInput': False, 'completedAt': 1794687689000, 'turnId': 'native-turn', 'userMessageId': 'native-message'}
    return result


def deployment_module(name):
    folder = Path(__file__).resolve().parents[2] / 'deploy/fleet'
    sys.path.insert(0, str(folder))
    spec = importlib.util.spec_from_file_location('local_test_' + name.replace('-', '_'), folder / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class RuntimePinTest(unittest.TestCase):
    def test_complete_inventory_pins_dependency_bytes_and_link_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'runtime'
            first = runtime(root)
            (root / 'alias').symlink_to('node_modules/native.node')
            second = local.runtime_identity(root)
            self.assertNotEqual(first['sha256'], second['sha256'])
            (root / 'node_modules/native.node').write_bytes(b'changed dependency')
            self.assertNotEqual(second['sha256'], local.runtime_identity(root)['sha256'])

    def test_missing_runtime_files_and_escape_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'runtime'
            runtime(root)
            outside = Path(tmp) / 'outside'; outside.write_bytes(b'not mounted')
            (root / 'escape').symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'escapes'):
                local.runtime_identity(root)
            (root / 'escape').unlink()
            (root / 'server-core.js').unlink()
            with self.assertRaisesRegex(ValueError, 'capability'):
                local.runtime_identity(root)

    def test_runtime_writable_by_others_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'runtime'; runtime(root)
            (root / 'zcode.cjs').chmod(0o666)
            with self.assertRaisesRegex(ValueError, 'writable'):
                local.runtime_identity(root)

    def test_path_and_digest_are_paired_and_rechecked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'runtime'; identity = runtime(root)
            for path, expected in [(str(root), None), (None, 'a' * 64), (str(root), 'g' * 64)]:
                with self.subTest(path=path, expected=expected), self.assertRaises(ValueError):
                    local.local_configuration(path, expected)
            configuration = local.local_configuration(str(root), identity['sha256'])
            self.assertEqual(local.check_runtime(configuration), identity)
            (root / 'zcode.cjs').write_bytes(b'different official executable')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                local.check_runtime(configuration)

    def test_no_ssh_fallback_when_local_capability_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); root = base / 'runtime'; identity = runtime(root)
            release = base / ('a' * 40); release.mkdir()
            configuration = local.local_configuration(str(root), identity['sha256'])
            with patch('candidate_driver.candidate_bundle_identity', return_value={'source_sha': 'a' * 40}), \
                 patch('candidate_driver.candidate_store_identity', return_value={}), \
                 patch('zcode_candidate_remote.tested_payload_digest', return_value='b' * 64), \
                 patch.object(local.shutil, 'which', return_value=None), \
                 patch.object(local.subprocess, 'Popen') as popen, \
                 patch.object(gate, 'run_zcode_candidate') as remote:
                with self.assertRaisesRegex(ValueError, 'isolation capability'):
                    local.run_zcode_candidate(release, 'a' * 40, configuration)
                popen.assert_not_called(); remote.assert_not_called()


class LocalContractTest(unittest.TestCase):
    def test_official_product_version_uses_supported_json_route(self):
        completed = SimpleNamespace(returncode=0, stdout=json.dumps({'product': 'zcode-server', 'version': '3.17.2'}), stderr='')
        with patch.object(local.subprocess, 'run', return_value=completed) as run:
            self.assertEqual(local.official_version('/runtime')['version'], '3.17.2')
        self.assertEqual(run.call_args.args[0], ['/runtime/node', '/runtime/server-cli.js', 'version', '--json'])
        for output, rc in [('3.17.2', 0), (json.dumps({'product': 'other', 'version': '3.17.2'}), 0),
                           (json.dumps({'product': 'zcode-server', 'version': 'old'}), 0), (completed.stdout, 1)]:
            with patch.object(local.subprocess, 'run', return_value=SimpleNamespace(returncode=rc, stdout=output, stderr='')), \
                 self.assertRaisesRegex(ValueError, 'version probe failed'):
                local.official_version('/runtime')

    def test_full_journey_and_same_session_continuation_are_required(self):
        good = report()
        self.assertEqual(local.validate_local_report(good, 'a' * 64)['version'], '3.17.2')
        for field, wrong in [('version', '3.17.1'), ('sessions', ['same', 'same']),
                             ('fixtureRequests', 2), ('transcriptPages', [2, 1]),
                             ('sessionsSearched', False), ('continuation', None)]:
            bad = copy.deepcopy(good); bad['reports'][0][field] = wrong
            with self.subTest(field=field), self.assertRaises(ValueError):
                local.validate_local_report(bad, 'a' * 64)
        for field, wrong in [('confirmed', False), ('session_id', 'different'), ('input_id', ''), ('pages', 1), ('mode', 'queue'), ('receipt', {})]:
            bad = copy.deepcopy(good); bad['reports'][0]['continuation'][field] = wrong
            with self.subTest(continuation=field), self.assertRaises(ValueError):
                local.validate_local_report(bad, 'a' * 64)

    def test_unverified_writer_shutdown_cannot_claim_complete_persisted_search(self):
        bad = report()
        bad['source_quiescence']['original_processes_gone'] = False
        with self.assertRaisesRegex(ValueError, 'quiescence'):
            local.validate_local_report(bad, 'a' * 64)
        bad = report()
        bad['reports'][0]['searchReadMode'] = 'active-runtime'
        with self.assertRaisesRegex(ValueError, 'quiescence'):
            local.validate_local_report(bad, 'a' * 64)

    def test_complete_payload_digest_must_match(self):
        with self.assertRaisesRegex(ValueError, 'payload'):
            local.validate_local_report(report(), 'b' * 64)

    def test_continuation_terminal_refusal_never_retries_send(self):
        api = Mock(side_effect=[idle_session(), {'ok': False, 'notSubmitted': True, 'error': 'refused'}])
        transcript = Mock()
        with self.assertRaisesRegex(ValueError, 'no replay'):
            local.continue_session(api, transcript, {'id': 'native-one'}, '/work', 'fixture/herder-test$disabled')
        self.assertEqual(api.call_count, 2)
        self.assertEqual(sum(1 for c in api.call_args_list if len(c.args) > 1), 1)
        transcript.assert_not_called()

    def test_immediate_send_preserves_actual_native_receipt_without_synthetic_job(self):
        receipt = {'ok': True, 'inputId': 'marker', 'nativeInputMessageId': 'native-message', 'turnId': 'native-turn'}
        api = Mock(side_effect=[idle_session(), receipt, completed_session(), completed_session()])
        result = local.send_immediate(api, Mock(return_value=3), 'native-one', 'marker', '/work', 'fixture/herder-test$disabled')
        self.assertEqual(result['receipt'], receipt)
        self.assertNotIn('job', result)
        self.assertEqual(api.call_args_list[1].args[1], {'message': 'marker', 'inputId': 'marker', 'mode': 'sync', 'humanRequested': True})

    def test_full_transcript_starts_only_after_exact_delivered_turn_completes(self):
        receipt = {'ok': True, 'inputId': 'marker', 'nativeInputMessageId': 'native-message', 'turnId': 'native-turn'}
        running = idle_session()
        running['session'].update(status='running')
        running['session']['meta'].update(nativeStatus='running', nativeActiveTurnId='native-turn')
        api = Mock(side_effect=[idle_session(), receipt, running, completed_session(), completed_session()])
        def transcript(*args):
            self.assertEqual(api.call_count, 4)
            return 4
        with patch.object(local.time, 'sleep'):
            result = local.send_immediate(api, transcript, 'native-one', 'marker', '/work', 'fixture/herder-test$disabled')
        self.assertEqual(result['completed_before_transcript']['completed_input_id'], 'native-message')
        self.assertEqual(sum(1 for call in api.call_args_list if len(call.args) > 1), 1)

    def test_wrong_or_failed_terminal_turn_never_becomes_complete_transcript(self):
        receipt = {'ok': True, 'inputId': 'marker', 'nativeInputMessageId': 'native-message', 'turnId': 'native-turn'}
        for key, value in [('userMessageId', 'other'), ('turnId', 'other'), ('status', 'error'), ('cancelledByUser', True)]:
            state = completed_session()
            state['session']['meta']['nativeLastTurn'][key] = value
            api = Mock(side_effect=[idle_session(), receipt, state])
            transcript = Mock()
            with self.subTest(key=key), self.assertRaises(ValueError):
                local.send_immediate(api, transcript, 'native-one', 'marker', '/work', 'fixture/herder-test$disabled', timeout=0)
            transcript.assert_not_called()
            self.assertEqual(sum(1 for call in api.call_args_list if len(call.args) > 1), 1)

    def test_unobserved_model_changed_permission_or_stop_refuses_before_input(self):
        for level, key, value in [('session', 'model', 'other'), ('meta', 'nativeLoaded', False),
                                 ('meta', 'nativeStateRevision', None), ('meta', 'pendingRequestIds', ['pending']),
                                 ('meta', 'automationStop', {'held': True}), ('meta', 'humanStop', True), ('meta', 'humanStopHeld', True),
                                 ('meta', 'permissionMode', 'build'), ('session', 'needsPermission', True)]:
            state = idle_session()
            target = state['session'] if level == 'session' else state['session']['meta']
            target[key] = value
            api = Mock(return_value=state)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'no send'):
                local.send_immediate(api, Mock(), 'native-one', 'marker', '/work', 'fixture/herder-test$disabled')
            self.assertEqual(api.call_count, 1)

    def test_only_fresh_official_existing_snapshot_is_alternative_resident_proof(self):
        from datetime import datetime, timezone
        now = 1794686966.0
        iso = lambda seconds: datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        meta = {'activityEvidence': 'zcode-existing-native-snapshot', 'nativeActivityFresh': True,
                'nativeExecutor': 'official-server', 'deliveryRoute': 'official-server-ws',
                'nativeRuntimePid': 28, 'nativeRuntimeGeneration': 1,
                'activityObservedAt': iso(now - 1), 'activityExpiresAt': iso(now + 10)}
        self.assertEqual(local.resident_source(meta, now), 'official_existing_snapshot')
        for key, wrong in [('nativeLoaded', False), ('nativeStateObserved', False),
                           ('activityEvidence', 'zcode-official-supervisor-running-tasks'),
                           ('nativeActivityFresh', False), ('nativeExecutor', 'unknown'),
                           ('deliveryRoute', 'official-server-unverified'), ('nativeRuntimePid', 0),
                           ('nativeRuntimeGeneration', 0), ('activityObservedAt', iso(now - 11)),
                           ('activityObservedAt', iso(now + 1)), ('activityExpiresAt', iso(now - 1)),
                           ('activityExpiresAt', iso(now + 60))]:
            with self.subTest(key=key, wrong=wrong):
                self.assertIsNone(local.resident_source({**meta, key: wrong}, now))
        self.assertIsNone(local.resident_source({'nativeStatus': 'idle'}, now))

    def test_native_optional_permission_revision_is_preserved_as_unobserved(self):
        state = idle_session()
        del state['session']['meta']['permissionRulesRevision']
        value = local.verified_idle(Mock(return_value=state), 'native-one', '/work', 'fixture/herder-test$disabled')
        self.assertIsNone(value['permission_revision'])
        self.assertFalse(value['permission_revision_observed'])
        state['session']['meta']['permissionRulesRevision'] = None
        with self.assertRaisesRegex(ValueError, 'no send'):
            local.verified_idle(Mock(return_value=state), 'native-one', '/work', 'fixture/herder-test$disabled')

    def test_ok_or_pending_without_exact_native_receipt_never_passes(self):
        for receipt in [{'ok': True}, {'ok': True, 'pending': True},
                        {'ok': True, 'inputId': 'other', 'nativeInputMessageId': 'msg'}]:
            api = Mock(side_effect=[idle_session(), receipt])
            transcript = Mock()
            with self.subTest(receipt=receipt), self.assertRaisesRegex(ValueError, 'no replay'):
                local.send_immediate(api, transcript, 'native-one', 'marker', '/work', 'fixture/herder-test$disabled')
            transcript.assert_not_called()
            self.assertEqual(api.call_count, 2)

    def test_failure_keeps_terminal_result_fixture_hits_and_bounded_log(self):
        observed = {'last_job': {'job': {'state': 'failed', 'result': {'ok': False, 'error': 'deferred-only refused'}}}}
        result = local.failure_observation('delivery', observed, {'requests': 0}, 'x' * 13000, ValueError('failed'))
        self.assertEqual(result['observed'], observed)
        self.assertEqual(result['fixture_stats']['requests'], 0)
        self.assertEqual(len(result['log']), 12000)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'failure.json'
            local.write_private(path, result)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), result)
            with self.assertRaises(FileExistsError):
                local.write_private(path, {})

    def test_timeout_preserves_partial_search_output_before_cleanup(self):
        stderr = b'x' * 9000 + b'connected MCP\nsearch status partial\n'
        error = subprocess.TimeoutExpired(['search-fixture'], 60, output='partial reply', stderr=stderr)
        result = local.failure_observation('exact_session_search', {}, {'requests': 5}, '', error)
        child = result['subprocess']
        self.assertTrue(child['timed_out'])
        self.assertEqual(child['timeout_seconds'], 60)
        self.assertEqual(child['stdout']['tail'], 'partial reply')
        self.assertFalse(child['stdout']['truncated'])
        self.assertEqual(child['stderr']['bytes'], len(stderr))
        self.assertEqual(child['stderr']['sha256'], hashlib.sha256(stderr).hexdigest())
        self.assertEqual(len(child['stderr']['tail']), 8000)
        self.assertTrue(child['stderr']['truncated'])
        self.assertTrue(child['stderr']['tail'].endswith('connected MCP\nsearch status partial\n'))

    def test_http_export_refusal_body_is_preserved_before_cleanup(self):
        error = local.urllib.error.HTTPError('http://127.0.0.1:1234/transcript', 422, 'Unavailable', {},
                                            io.BytesIO(b'{"error":"exact_export_reason"}'))
        result = local.failure_observation('transcript', {}, {'requests': 2}, '', error)
        self.assertEqual(result['http_error']['status'], 422)
        self.assertEqual(json.loads(result['http_error']['body']), {'error': 'exact_export_reason'})
        self.assertFalse(result['http_error']['truncated'])

    def test_persisted_search_stops_only_owned_private_runtime_and_checks_death(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / '.zcode/server'
            (root / 'run').mkdir(parents=True)
            (root / 'run/status.json').write_text(json.dumps({'state': 'ready', 'version': local.VERSION, 'pid': 124}))
            server = Mock(pid=123)
            server.poll.return_value = None
            identities = [{'pid': 123, 'parent_pid': os.getpid(), 'start_ticks': 111},
                          {'pid': 124, 'parent_pid': 123, 'start_ticks': 222}, None, None]
            stopped = {'state': 'stopped', 'version': local.VERSION, 'pid': None,
                       'runningTaskCount': 0, 'serviceRegistered': False}
            completed = SimpleNamespace(returncode=0, stdout=json.dumps(stopped), stderr='')
            observed = {}
            with patch.object(local, 'process_identity', side_effect=identities), \
                 patch.object(local.subprocess, 'run', return_value=completed) as run, \
                 patch.object(local, 'sqlite_snapshot', return_value={'db': 'stable'}), \
                 patch.object(local.time, 'sleep'):
                proof = local.quiesce_for_persisted_search(Path('/runtime'), home, home, server,
                                                         {'ZCODE_SERVER_ROOT': str(root)}, observed)
            self.assertEqual(run.call_args.args[0], ['/runtime/node', '/runtime/server-cli.js', 'stop', '--wait',
                                                    '--server-root', str(root), '--json'])
            self.assertTrue(proof['original_processes_gone'])
            self.assertEqual(proof['mode'], 'persisted-after-official-shutdown')
            server.wait.assert_called_once()

    def test_wrong_runtime_parent_refuses_before_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp);root = home / '.zcode/server'
            (root / 'run').mkdir(parents=True)
            (root / 'run/status.json').write_text(json.dumps({'state': 'ready', 'version': local.VERSION, 'pid': 124}))
            server = Mock(pid=123);server.poll.return_value = None
            identities = [{'pid': 123, 'parent_pid': os.getpid(), 'start_ticks': 111},
                          {'pid': 124, 'parent_pid': 999, 'start_ticks': 222}]
            with patch.object(local, 'process_identity', side_effect=identities), \
                 patch.object(local.subprocess, 'run') as run, self.assertRaisesRegex(ValueError, 'identity mismatch'):
                local.quiesce_for_persisted_search(Path('/runtime'), home, home, server,
                                                  {'ZCODE_SERVER_ROOT': str(root)}, {})
            run.assert_not_called()

    def test_sqlite_snapshot_preserves_wal_bytes_and_refuses_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'db.sqlite';path.write_bytes(b'native file')
            first = local.sqlite_snapshot(path)
            wal = Path(str(path) + '-wal');wal.write_bytes(b'wal')
            second = local.sqlite_snapshot(path)
            self.assertNotEqual(first, second)
            self.assertEqual(second[wal.name]['sha256'], hashlib.sha256(b'wal').hexdigest())
            wal.unlink();wal.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'unexpected private'):
                local.sqlite_snapshot(path)

    def test_index_diagnostics_preserve_actual_generation_and_source_without_owner_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp);path = home / '.local/state/agent-herder/session-search/index.sqlite'
            path.parent.mkdir(parents=True)
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE search_run(id,status,updated_at,scan_id);CREATE TABLE sources(harness,receipt);CREATE TABLE search_owner(pid,token);")
                db.execute("INSERT INTO search_run VALUES(1,'complete','2026-11-14T00:00:00Z','actual-new-scan')")
                db.execute("INSERT INTO sources VALUES('zcode',?)", (json.dumps({'scanId': 'actual-old-scan', 'state': 'partial', 'source': '/native/db'}),))
                db.execute("INSERT INTO search_owner VALUES(42,'not-observed-token')")
            observation = local.index_snapshot(home)
            self.assertEqual(observation['runs'][0]['scan_id'], 'actual-new-scan')
            self.assertEqual(observation['sources'][0]['scanId'], 'actual-old-scan')
            self.assertEqual(observation['owners'], [{'pid': 42}])
            self.assertNotIn('not-observed-token', json.dumps(observation))

    def test_namespace_inventory_keeps_only_exact_native_fd_targets_and_access_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp);database = home / 'db.sqlite';database.write_bytes(b'native')
            unrelated = home / 'unrelated';unrelated.write_bytes(b'not-collected')
            proc = home / 'proc';proc.mkdir()
            for pid, flags in [(100, '0100000'), (101, '0100002')]:
                entry = proc / str(pid);(entry / 'fd').mkdir(parents=True);(entry / 'fdinfo').mkdir()
                fields = ['S', '2', str(pid), str(pid)] + ['0'] * 15 + [str(pid * 10)]
                (entry / 'stat').write_text(str(pid) + ' (owned fixture) ' + ' '.join(fields))
                (entry / 'comm').write_text('owned-fixture')
                (entry / 'exe').symlink_to('/pinned/runtime/node')
                (entry / 'fd/3').symlink_to(database);(entry / 'fdinfo/3').write_text('flags: ' + flags)
                (entry / 'fd/4').symlink_to(unrelated);(entry / 'fdinfo/4').write_text('flags: 0100002')
            observation = local.namespace_process_inventory(database, proc)
            self.assertFalse(observation['truncated'])
            self.assertEqual([p['native_fds'][0]['access'] for p in observation['processes']], ['read_only', 'read_write'])
            self.assertTrue(all(p['identity_stable'] and len(p['native_fds']) == 1 for p in observation['processes']))
            self.assertNotIn('unrelated', json.dumps(observation))

    def test_failure_keeps_diagnostics_even_if_other_observations_are_bounded(self):
        diagnostics = {'before_scan': {'scan_id': 'before'}, 'after_failure': {'scan_id': 'after'}}
        essentials = {'index_settings': [{'operation': 'start', 'response': {'enabled': True}}],
                      'executing_herder': {'sha256': 'a' * 64, 'executable': '/pinned/runtime/node'}}
        result = local.failure_observation('search', {'diagnostics': diagnostics, 'large': 'x' * 40000, **essentials}, {}, '', ValueError('failed'))
        self.assertTrue(result['observed']['truncated'])
        self.assertEqual(result['diagnostics'], diagnostics)
        for key, value in essentials.items():
            self.assertEqual(result[key], value)

    def test_owned_group_is_reaped_on_timeout(self):
        child = Mock(pid=123)
        child.poll.side_effect = [None, 0]
        child.wait.side_effect = [subprocess.TimeoutExpired('fixture', 5), 0]
        with patch.object(local.os, 'killpg') as killpg:
            self.assertTrue(local.terminate_owned(child))
        self.assertEqual(killpg.call_count, 2)
        self.assertEqual(child.wait.call_count, 2)


class PinnedModeTest(unittest.TestCase):
    def test_candidate_requires_explicit_matching_local_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); rt = root / 'runtime'; identity = runtime(rt)
            configuration = local.local_configuration(str(rt), identity['sha256'])
            release = root / 'release'; release.mkdir()
            (release / 'build-manifest.json').write_text(json.dumps({'nativeCandidateGate': configuration}))
            self.assertEqual(gate.select_zcode_mode(release, str(rt), identity['sha256']), configuration)
            with self.assertRaisesRegex(ValueError, 'explicit pinned'):
                gate.select_zcode_mode(release)
            with self.assertRaisesRegex(ValueError, 'explicit pinned'):
                gate.select_zcode_mode(release, str(rt), 'b' * 64)

    def test_legacy_default_remains_remote_but_explicit_local_is_never_inferred(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp)
            (release / 'build-manifest.json').write_text('{}')
            self.assertIsNone(gate.select_zcode_mode(release))
            rt = release / 'runtime'; identity = runtime(rt)
            with self.assertRaisesRegex(ValueError, 'explicit pinned'):
                gate.select_zcode_mode(release, str(rt), identity['sha256'])

    def test_install_plan_requires_same_policy_before_any_subprocess(self):
        module = deployment_module('rollout-candidate')
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp)
            configuration = {'mode': 'local', 'runtime': '/official/runtime', 'runtime_sha256': 'a' * 64,
                             'version': '3.17.2'}
            (release / 'build-manifest.json').write_text(json.dumps({'nativeCandidateGate': configuration}))
            expected = ['--zcode-local-runtime', '/official/runtime', '--zcode-local-runtime-sha256', 'a' * 64]
            self.assertEqual(module.native_gate_options(release, configuration), expected)
            for supplied in [None, {**configuration, 'runtime_sha256': 'b' * 64}]:
                with patch.object(module.subprocess, 'run') as child, self.assertRaisesRegex(RuntimeError, 'mode missing or changed'):
                    module.run_native_candidate_preflight(release, 'b' * 40, release, Mock(), supplied)
                child.assert_not_called()

    def test_install_policy_rejects_unknown_fields_and_version(self):
        module = deployment_module('rollout-candidate')
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp)
            configuration = {'mode': 'local', 'runtime': '/official/runtime', 'runtime_sha256': 'a' * 64,
                             'version': '3.17.2'}
            for change in [{'version': 'other'}, {'remote_fallback': True}, {'runtime': 'relative'}]:
                supplied = {**configuration, **change}
                (release / 'build-manifest.json').write_text(json.dumps({'nativeCandidateGate': supplied}))
                with self.assertRaisesRegex(RuntimeError, 'policy invalid'):
                    module.native_gate_options(release, supplied)


if __name__ == '__main__':
    unittest.main()
