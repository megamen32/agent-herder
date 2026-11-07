import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import v1_zcode_stand as stand


class FixturePreparation(unittest.TestCase):
    def test_official_provider_layout_and_exact_runtime_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'official.cjs'
            source.write_bytes(b'original-runtime')
            home = root / 'home'
            home.mkdir()
            entry = stand.prepare_official_fixture(home, source, 'http://127.0.0.1:1234/v1')
            self.assertEqual(entry.read_bytes(), source.read_bytes())
            builtin = json.loads((entry.parent / 'provider/zcode-builtin.json').read_text())
            personal = json.loads((home / '.zcode/v2/provider_config.json').read_text())
            self.assertEqual(builtin['schemaVersion'], 1)
            rule = personal['config']['providerConfigRules']['providerRules'][0]
            self.assertEqual(rule['config']['api']['baseUrl'], 'http://127.0.0.1:1234/v1')
            self.assertEqual(rule['providerId'], 'fixture')

    def test_refuses_non_loopback_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'cli'
            source.write_bytes(b'cli')
            with self.assertRaises(ValueError):
                stand.prepare_official_fixture(Path(tmp), source, 'https://example.org/v1')


class ProjectGate(unittest.TestCase):
    def test_missing_native_registration_blocks_create(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            stand.require_exact_project({'projects': []}, '/fixture/work')

    def test_exactly_one_native_root_required(self):
        project = {'id':'p1', 'roots':[{'rootPath':'/fixture/work'}]}
        self.assertEqual(stand.require_exact_project({'projects':[project]}, '/fixture/work'), 'p1')
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            stand.require_exact_project({'projects':[project, project]}, '/fixture/work')


class UnknownReconciliation(unittest.TestCase):
    def test_public_unknown_preserves_confirmed_session(self):
        result = {'status':'completed', 'result':{'structuredContent':{
            'create':{'effect':'confirmed', 'session_ref':'session:one'},
            'prompt':{'effect':'unknown', 'retry':'forbidden'}}}}
        self.assertEqual(stand.classify_create_task(result),
                         {'session_ref':'session:one', 'prompt_effect':'unknown', 'retry':'forbidden'})

    def test_reconciliation_requires_exact_session_and_source_id(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'native.sqlite'
            c = sqlite3.connect(db)
            c.execute('create table session_input (session_id text, id text, status text, promoted_message_id text)')
            c.execute('insert into session_input values (?, ?, ?, ?)', ('native-a', 'queue_exact', 'promoted', 'message-a'))
            c.commit(); c.close()
            self.assertEqual(stand.read_promoted_input(db, 'native-a', 'exact')['message_id'], 'message-a')
            self.assertIsNone(stand.read_promoted_input(db, 'native-b', 'exact'))
            self.assertIsNone(stand.read_promoted_input(db, 'native-a', 'other'))


class PublicRuntimeRegression(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ZCODE_V1_RUNTIME') and os.environ.get('ZCODE_V1_MANIFEST'),
                         'set ZCODE_V1_RUNTIME and ZCODE_V1_MANIFEST for isolated public integration')
    def test_official_runtime_initializes_public_core(self):
        manifest = Path(os.environ['ZCODE_V1_MANIFEST']).resolve(strict=True)
        runtime = Path(os.environ['ZCODE_V1_RUNTIME']).resolve(strict=True)
        native = Path(__file__).resolve().parent
        command = [sys.executable, str(native / 'launch.py'),
                   '--ro-bind', str(manifest.parent), '--ro-bind', str(runtime.parent),
                   '--ro-bind', str(stand.OFFICIAL_CLIENT_DIST),
                   '--ro-bind', str(stand.OFFICIAL_CLIENT_DIST.parent / 'node_modules/ws'),
                   '--ro-bind', str(stand.OFFICIAL_CLIENT_DIST.parent / 'package.json'), '--',
                   sys.executable, str(native / 'v1_zcode_stand.py'),
                   '--manifest', str(manifest), '--runtime', str(runtime)]
        result = subprocess.run(command, text=True, capture_output=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(report['status'], 'PREFLIGHT_ONLY')
        self.assertTrue(report['project_id'])
        self.assertEqual(report['project_root'], '/herder-owner-home/work')


class ManifestValidation(unittest.TestCase):
    def test_rejects_unexpected_manifest_before_reading_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'manifest.json'
            path.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                stand.validate_manifest(path)

    def test_rejects_changed_candidate_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / 'artifact'
            artifact.write_text('unexpected')
            data = {'artifact_root':str(root), 'core':str(artifact), 'bootstrap':str(artifact),
                    'node':str(artifact), 'adapters':{'zcode':str(artifact)},
                    'sha256':{'core':'bad','bootstrap':'bad','node':'bad','adapters':{'zcode':'bad'}}}
            path = root / 'manifest.json'
            path.write_text(json.dumps(data))
            with patch.object(stand, 'MANIFEST_SHA', stand.digest(path)):
                with self.assertRaisesRegex(ValueError, 'artifact mismatch'):
                    stand.validate_manifest(path)


if __name__ == '__main__':
    unittest.main()
