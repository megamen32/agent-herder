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


if __name__ == '__main__':
    unittest.main()
