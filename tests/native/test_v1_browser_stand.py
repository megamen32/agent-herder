import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import v1_browser_stand as stand


class BrowserStandGuardTest(unittest.TestCase):
    def test_mutation_rejection_is_saved_before_task_validation(self):
        record = {}
        saved = []
        rejection = {'isError': True, 'structuredContent': {'code': 'session_busy'}}
        with self.assertRaisesRegex(RuntimeError, 'saved response'):
            stand.retain_mutation_reply(record, rejection,
                lambda: saved.append(json.loads(json.dumps(record))))
        self.assertEqual(saved[0]['mutation_replies'], [rejection])

    def test_task_reply_is_saved_and_exact_id_returned(self):
        record = {}
        saved = []
        response = {'resultType': 'task', 'taskId': 'exact-task'}
        self.assertEqual(stand.retain_mutation_reply(record, response,
            lambda: saved.append(json.loads(json.dumps(record)))), 'exact-task')
        self.assertEqual(saved[0]['mutation_replies'], [response])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manifest = {'source_commit':'a'*40, 'sha256':{'adapters':{}}, 'adapters':{}}
        for key in ('core', 'bootstrap', 'node', 'runner'):
            path = self.root / key
            path.write_bytes(key.encode())
            digest = hashlib.sha256(key.encode()).hexdigest()
            if key == 'runner':
                self.manifest['adapters']['zai'] = str(path)
                self.manifest['sha256']['adapters']['zai'] = digest
            else:
                self.manifest[key] = str(path)
                self.manifest['sha256'][key] = digest
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(self.manifest))
        self.config = {'manifest':str(path), 'manifest_sha256':stand.digest(path),
                       'harness':'zai', 'page_id':7, 'account_scope':'a'*64, 'stage':'candidate',
                       'run_root':str(self.root/'run'), 'consumer_helpers':'unused'}

    def test_changed_artifact_refuses_before_helpers_process_or_run_directory(self):
        (self.root / 'runner').write_text('changed')
        with patch.object(stand, 'load_helpers') as helpers, patch.object(stand.subprocess, 'check_output') as spawn:
            with self.assertRaisesRegex(ValueError, 'adapter digest mismatch'):
                stand.run(self.config, True)
        helpers.assert_not_called()
        spawn.assert_not_called()
        self.assertFalse((self.root/'run').exists())

    def test_exact_verified_inputs_pass_but_ambiguous_browser_binding_does_not(self):
        manifest, runner = stand.verify_inputs(self.config)
        self.assertEqual(manifest['source_commit'], 'a'*40)
        self.assertEqual(runner, str(self.root/'runner'))
        for key, value in [('page_id', True), ('account_scope','unknown'), ('stage','release')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                stand.verify_inputs(dict(self.config, **{key:value}))

    def test_retained_attempt_is_never_bootstrapped_again(self):
        (self.root/'run').mkdir()
        with patch.object(stand, 'load_helpers'), patch.object(stand.subprocess, 'check_output') as spawn:
            with self.assertRaisesRegex(ValueError, 'never replay'):
                stand.run(self.config, True)
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
