import hashlib
import json
from pathlib import Path
import tempfile
import sys
from unittest.mock import patch
import unittest
from types import SimpleNamespace

import v1_codex_stand as stand


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.files = {}
        for name in ('core', 'bootstrap', 'node', 'adapter', 'codex'):
            path = root / name
            path.write_bytes(name.encode())
            path.chmod(0o700)
            self.files[name] = path
        self.manifest = {'source_commit': 'a' * 40,
                         **{n: str(self.files[n]) for n in ('core', 'bootstrap', 'node')},
                         'adapters': {'codex': str(self.files['adapter'])},
                         'sha256': {**{n: digest(self.files[n]) for n in ('core', 'bootstrap', 'node')},
                                    'adapters': {'codex': digest(self.files['adapter'])}}}
        self.path = root / 'manifest.json'
        self.save()
        self.args = SimpleNamespace(**{n: str(p) for n, p in self.files.items()},
                                    manifest=str(self.path), manifest_sha256=digest(self.path),
                                    codex_sha256=digest(self.files['codex']))

    def save(self):
        self.path.write_text(json.dumps(self.manifest))

    def test_valid_manifest_and_native_identity(self):
        result = stand.validate_inputs(self.args)
        self.assertEqual(result['source_sha'], 'a' * 40)
        self.assertEqual(result['codex_sha256'], self.args.codex_sha256)

    def test_changed_artifact_and_native_binary_refused(self):
        for name in self.files:
            with self.subTest(name=name):
                path = self.files[name]; original = path.read_bytes()
                path.write_bytes(original + b'changed')
                with self.assertRaises(ValueError): stand.validate_inputs(self.args)
                path.write_bytes(original)

    def test_manifest_mismatch_and_path_substitution_refused(self):
        self.path.write_text(self.path.read_text() + ' ')
        with self.assertRaises(ValueError): stand.validate_inputs(self.args)
        self.save(); self.args.manifest_sha256 = digest(self.path)
        self.args.adapter = self.args.node
        with self.assertRaises(ValueError): stand.validate_inputs(self.args)

    def test_bad_native_pin_fails_before_any_process_launch(self):
        args = ['stand']
        for name in ('core', 'bootstrap', 'node', 'adapter', 'codex', 'manifest'):
            args += ['--' + name, getattr(self.args, name)]
        args += ['--manifest-sha256', self.args.manifest_sha256, '--codex-sha256', '0' * 64]
        with patch.object(sys, 'argv', args), patch.object(stand.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'codex: SHA-256 mismatch'):
                stand.main()
            spawn.assert_not_called()

    def test_fixture_declares_no_openai_auth_and_loopback_endpoint(self):
        config = stand.fixture_config('http://127.0.0.1:12345/v1')
        self.assertIn('model_provider = "fixture"', config)
        self.assertIn('requires_openai_auth = false', config)
        self.assertIn('base_url = "http://127.0.0.1:12345/v1"', config)

    def test_owned_process_check_fails_closed_without_proc_child(self):
        with self.assertRaises((OSError, ValueError)):
            stand.prove_owned_child(999999999, '/fixture/codex', '/fixture/work', '/fixture/home')

    def test_bin_transport_explicitly_selects_direct_owned_child(self):
        env = stand.adapter_transport('bin', '/fixture/codex', '/fixture/codex.sock', '/fixture/work', '/fixture/home')
        self.assertEqual(env.get('AGENT_HERDER_WORKLOAD_ISOLATION'), 'off')
        socket = stand.adapter_transport('socket', '/fixture/codex', '/fixture/codex.sock', '/fixture/work', '/fixture/home')
        self.assertNotIn('AGENT_HERDER_WORKLOAD_ISOLATION', socket)

    def test_bin_transport_uses_exact_codex_and_no_socket(self):
        env = stand.adapter_transport('bin', '/fixture/codex', '/fixture/codex.sock', '/fixture/work', '/fixture/home')
        self.assertEqual(env['AHAP_CODEX_BIN'], '/fixture/codex')
        self.assertNotIn('AHAP_CODEX_SOCKET', env)
        self.assertEqual(env['AHAP_CODEX_CWD'], '/fixture/work')
        self.assertEqual(env['CODEX_HOME'], '/fixture/home')

    def test_create_rejection_is_distinct_from_unknown(self):
        task = {'status': 'completed', 'result': {'structuredContent': {
            'code': 'create_not_sent', 'create': {'effect': 'none'}, 'prompt': {'effect': 'none'}}}}
        self.assertEqual(stand.classify_create(task), 'NOT_SENT')
        task['result']['structuredContent']['prompt']['effect'] = 'unknown'
        self.assertEqual(stand.classify_create(task), 'UNKNOWN')
        self.assertEqual(stand.classify_create({'status': 'failed'}), 'UNKNOWN')

    def test_invalid_manifest_identity_or_missing_native_pin_refused(self):
        self.manifest['source_commit'] = 'not-a-commit'; self.save()
        self.args.manifest_sha256 = digest(self.path)
        with self.assertRaises(ValueError): stand.validate_inputs(self.args)
        self.manifest['source_commit'] = 'a' * 40; self.save()
        self.args.manifest_sha256 = digest(self.path); self.args.codex_sha256 = ''
        with self.assertRaises(ValueError): stand.validate_inputs(self.args)


class PublicEvidenceTest(unittest.TestCase):
    def test_task_receipt_must_be_unique_confirmed_and_terminal(self):
        task = {'status':'completed', 'result':{'structuredContent':{'deliver':{'outcome':'confirmed','native_receipt_id':'m1'}}}}
        self.assertEqual(stand.confirmed_receipt(task)['native_receipt_id'], 'm1')
        task['status'] = 'working'
        self.assertIsNone(stand.confirmed_receipt(task))
        task['status'] = 'completed'
        task['result']['structuredContent']['other'] = {'outcome':'confirmed','native_receipt_id':'m2'}
        self.assertIsNone(stand.confirmed_receipt(task))

    def test_two_distinct_receipts_and_correlated_ordered_messages(self):
        r1 = {'outcome': 'confirmed', 'native_receipt_id': 'm1'}
        r2 = {'outcome': 'confirmed', 'native_receipt_id': 'm2'}
        rows = [{'role':'user','id':'m1','text':'first'}, {'role':'assistant','id':'a1','text':'HERDER_TEST_MODEL_OK'},
                {'role':'user','id':'m2','text':'second'}, {'role':'assistant','id':'a2','text':'HERDER_TEST_MODEL_OK'}]
        self.assertTrue(stand.correlated_pairs(rows, ['first','second'], [r1,r2]))
        self.assertFalse(stand.correlated_pairs(rows, ['first','second'], [r1,r1]))
        self.assertFalse(stand.correlated_pairs(rows[:-1], ['first','second'], [r1,r2]))
        self.assertFalse(stand.correlated_pairs(rows[::-1], ['first','second'], [r1,r2]))

    def test_codex_turn_receipt_matches_native_turn_not_synthetic_message_id(self):
        r1 = {'outcome':'confirmed','native_receipt_id':'ahap-receipt:v1:{"kind":"turn","native_id":"turn-1"}'}
        r2 = {'outcome':'confirmed','native_receipt_id':'ahap-receipt:v1:{"kind":"turn","native_id":"turn-2"}'}
        rows = [{'role':'user','id':'session:record:1','turnId':'turn-1','text':'first'},
                {'role':'assistant','id':'session:record:2','turnId':'turn-1','text':'HERDER_TEST_MODEL_OK'},
                {'role':'user','id':'session:record:3','turnId':'turn-2','text':'second'},
                {'role':'assistant','id':'session:record:4','turnId':'turn-2','text':'HERDER_TEST_MODEL_OK'}]
        self.assertTrue(stand.correlated_pairs(rows, ['first','second'], [r1,r2]))
        rows[3]['turnId'] = 'foreign'
        self.assertFalse(stand.correlated_pairs(rows, ['first','second'], [r1,r2]))

    def test_complete_export_and_search_require_real_content(self):
        import base64
        result = {'structuredContent': {'complete': True, 'source': {'harness':'codex'},
                  'bytes_base64':base64.b64encode(b'first second m1 m2 a1 a2').decode()}}
        self.assertTrue(stand.export_matches(result, ['first','second','m1','m2','a1','a2']))
        result['structuredContent']['complete'] = False
        self.assertFalse(stand.export_matches(result, ['first']))
        self.assertFalse(stand.search_matches({'structuredContent':{'query':'second','coverage':'complete','hits':[]}}, 'second'))
        self.assertTrue(stand.search_matches({'structuredContent':{'coverage':'complete','hits':[{'text':'second'}]}}, 'second'))
        self.assertFalse(stand.search_matches({'structuredContent':{'coverage':'partial','hits':[{'text':'second'}]}}, 'second'))

    def test_projects_need_exact_scope_and_provenance(self):
        result = {'structuredContent': {'complete': False, 'scope':'authorized_registered_sessions',
                  'limitations':['limited'], 'projects':[{'project_ref':'/work','source':'authorized_native_session'}]}}
        self.assertTrue(stand.projects_match(result, '/work'))
        self.assertFalse(stand.projects_match(result, '/other'))
        result['structuredContent']['projects'][0]['source'] = 'untrusted'
        self.assertFalse(stand.projects_match(result, '/work'))


if __name__ == '__main__':
    unittest.main()
