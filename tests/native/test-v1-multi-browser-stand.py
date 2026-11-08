#!/usr/bin/env python3
"""No browser, network, subprocess, or model calls: exercise the real stand."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import v1_multi_browser_stand as stand


class MultiBrowserStandTests(unittest.TestCase):
    def exercise_timeout(self, stage=None, transport_timeout=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / 'artifact'
            artifact.write_text('fixture bytes')
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({
                **{key: str(artifact) for key in ('core', 'node', 'bootstrap')},
                'adapters': {'chatgpt': str(artifact)}, 'source_commit': 'a' * 40,
                'sha256': {**{key: digest for key in ('core', 'node', 'bootstrap')},
                           'adapters': {'chatgpt': digest}},
            }))
            run_root = root / 'run'
            calls, processes, checkpoints = [], [], []
            clock = [0.0]

            def bootstrap(argv, **kwargs):
                home = Path(argv[1])
                authority = home / 'authority'
                authority.mkdir()
                database = authority / 'state.db'
                with sqlite3.connect(database) as connection:
                    connection.executescript('CREATE TABLE tasks(task_id TEXT,principal TEXT,status TEXT,result_json TEXT);'
                        'CREATE TABLE session_bindings(session_ref TEXT,node_ref TEXT,instance_id TEXT,native_session_id TEXT);')
                return json.dumps({'database': str(database), 'gate': str(authority / 'gate'),
                    'generation': 'fixture', 'profile_seed': str(authority / 'seed.json')})

            def popen(argv, **kwargs):
                process = type('FakeProcess', (), {'pid': len(processes) + 1, 'argv': argv})()
                processes.append(process)
                return process

            def preflight(client):
                client.native_tool_catalog = []
                return []

            def request(client, method, params, timeout=300):
                calls.append((method, params, timeout, client.process.pid))
                if method == 'tasks/get':
                    checkpoints.append(json.loads((run_root / 'receipt.json').read_text()))
                    if transport_timeout:
                        clock[0] += timeout
                        raise TimeoutError('native MCP request timed out: tasks/get')
                    clock[0] += min(40, timeout)
                    return {'taskId': 'create-operation:owned', 'status': 'working'}
                name, args = params['name'], params['arguments']
                if name == 'discover':
                    return {'structuredContent': {'instances': [{'instance_ref': 'chatgpt-profile-0'}]}}
                if name == 'create':
                    profile = json.loads(Path(client.process.argv[-1]).read_text())
                    with sqlite3.connect(profile['database']) as connection:
                        connection.execute('INSERT INTO tasks VALUES (?,?,?,?)', (
                            'create-operation:owned', profile['owner']['principal'], 'working',
                            json.dumps({'kind': 'fresh_create_prompt_v1',
                                'instance': {'node': 'qa-controller', 'instance_id': 'chatgpt-profile-0'},
                                'session_ref': 'session:owned', 'delivery_task': 'child', 'result': None})))
                        connection.execute('INSERT INTO session_bindings VALUES (?,?,?,?)',
                            ('session:owned', 'qa-controller', 'chatgpt-profile-0', 'native-owned'))
                    return {'taskId': 'create-operation:owned', 'status': 'working'}
                if name == 'session' and args['action'] == 'archive':
                    return {'structuredContent': {'archived': True}}
                raise AssertionError((method, params))

            with patch.object(stand.subprocess, 'check_output', side_effect=bootstrap), \
                 patch.object(stand.subprocess, 'Popen', side_effect=popen), \
                 patch.object(stand.h, 'parse_fresh_seed', side_effect=lambda raw, home: json.loads(raw)), \
                 patch.object(stand.h, 'validate_v1_public_contract'), \
                 patch.object(stand.h.RpcProcess, 'preflight', new=preflight), \
                 patch.object(stand.h.RpcProcess, 'close'), \
                 patch.object(stand.h.RpcProcess, 'request', new=request), \
                 patch.object(stand.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(stand.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
                result = stand.run(manifest, ['b' * 64], run_root, stage=stage or 'candidate')
            saved = json.loads((run_root / 'receipt.json').read_text())
            self.assertEqual(result, saved)
            self.assertEqual(result['status'], 'INCOMPLETE')
            item = result['instances'][0]
            self.assertTrue(checkpoints)
            self.assertEqual(item.get('session_ref'), 'session:owned')
            self.assertTrue(all(row['instances'][0].get('session_ref') == 'session:owned' for row in checkpoints))
            polls = item['task_polls']
            self.assertEqual(len(polls), sum(method == 'tasks/get' for method, *_ in calls))
            self.assertTrue(all(poll['duration_ms'] > 0 and poll['task_id'] == 'create-operation:owned' for poll in polls))
            self.assertTrue(all('response' in poll or 'error' in poll for poll in polls))
            self.assertLessEqual(sum(poll['duration_ms'] for poll in polls), 150000)
            if transport_timeout:
                self.assertIn('error', polls[-1])
                self.assertLessEqual(polls[-1]['timeout_s'], 150)
            else:
                self.assertTrue(all(poll['response']['status'] == 'working' for poll in polls))
            mutations = [params for method, params, *_ in calls if method == 'tools/call' and params['name'] in ('create', 'deliver')]
            self.assertEqual(len(mutations), 1, 'accepted create must never be reissued')
            archives = [(params, pid) for method, params, _, pid in calls if method == 'tools/call'
                        and params['name'] == 'session' and params['arguments']['action'] == 'archive']
            self.assertEqual(len(archives), 1)
            self.assertEqual(archives[0][0]['arguments']['session_ref'], 'session:owned')
            if transport_timeout:
                self.assertNotEqual(archives[0][1], calls[0][3], 'do not reuse a timed-out JSONL stream')
            self.assertTrue(all(command[0] == str(artifact) for command in saved['core_commands']))
            self.assertEqual(saved['manifest_sha256'], hashlib.sha256(manifest.read_bytes()).hexdigest())
            return saved

    def test_working_timeout_retains_all_polls_and_created_session_cleanup(self):
        self.exercise_timeout()

    def test_rpc_timeout_keeps_error_and_recovers_cleanup_without_resend(self):
        self.exercise_timeout(transport_timeout=True)

    def test_installed_stage_is_explicit_in_receipt(self):
        self.assertEqual(self.exercise_timeout(stage='installed')['stage'], 'installed')

    def test_invalid_stage_rejected_before_reading_manifest_or_starting_process(self):
        with patch.object(stand.subprocess, 'Popen') as popen:
            with self.assertRaises(ValueError):
                stand.run(Path('/absent'), [], Path('/absent'), stage='inferred')
            popen.assert_not_called()

    def test_completed_poll_preserves_exact_response(self):
        response = {'taskId': 'create-operation:owned', 'status': 'completed',
                    'result': {'structuredContent': {'create': {'session_ref': 'session:owned'}}}}
        client = unittest.mock.Mock()
        client.request.return_value = response
        item = {}
        saves = []
        result = stand.wait_task(client, 'create-operation:owned', item,
                                 lambda: saves.append(json.loads(json.dumps(item))))
        self.assertEqual(result, response)
        self.assertEqual(saves[-1]['task_polls'][0]['response'], response)
        client.request.assert_called_once()
        self.assertIn('duration_ms', saves[-1]['task_polls'][0])

    def test_sqlite_recovery_rejects_other_instance_and_principal(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'state.db'
            profile_path = Path(directory) / 'profile.json'
            profile_path.write_text(json.dumps({'database': str(database), 'owner': {
                'principal': 'owner', 'node': 'node', 'instance': 'instance'}}))
            item = {'profile': str(profile_path)}
            with sqlite3.connect(database) as connection:
                connection.executescript('CREATE TABLE tasks(task_id TEXT,principal TEXT,result_json TEXT);'
                    'CREATE TABLE session_bindings(session_ref TEXT,node_ref TEXT,instance_id TEXT);')
                record = json.dumps({'kind': 'fresh_create_prompt_v1', 'session_ref': 'session:other',
                                     'instance': {'node': 'node', 'instance_id': 'other'}})
                connection.execute('INSERT INTO tasks VALUES (?,?,?)', ('task', 'owner', record))
                connection.execute('INSERT INTO session_bindings VALUES (?,?,?)', ('session:other', 'node', 'other'))
            with self.assertRaisesRegex(ValueError, 'owner binding mismatch'):
                stand.recover_created_session(item, 'task')
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE tasks SET principal='other'")
            self.assertIsNone(stand.recover_created_session(item, 'task'))
            self.assertFalse(database.with_name('state.db-journal').exists())


if __name__ == '__main__':
    unittest.main()
