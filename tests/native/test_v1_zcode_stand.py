import json
import base64
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

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


class PortableConfig(unittest.TestCase):
    def test_rejects_unisolated_backend_before_launch(self):
        with self.assertRaisesRegex(ValueError, 'linux-netns-bwrap'):
            stand.config_argv({'capabilities':{'os':'linux','backend':'host'}})

    def test_expected_manifest_hash_must_be_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json'
            path.write_text('{}')
            for invalid in ('', 'a'*63, 'g'*64):
                with self.assertRaisesRegex(ValueError, 'manifest digest'):
                    stand.validate_manifest(path,invalid)


class SuccessReceipt(unittest.TestCase):
    def test_success_returns_zero_and_writes_complete_receipt_without_secret_fields(self):
        import io, contextlib
        evidence={'phase':'complete','result':'PASS','session_ref':'session:test',
                  'export':{'structuredContent':{'complete':True,'bytes_base64':'e30='}},
                  'prompt_receipt':{'outcome':'confirmed','native_receipt_id':'msg:1'},
                  'ingress-token':'secret-value'}
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            result=stand.emit_success(evidence)
        self.assertIsNone(result)
        body=json.loads(output.getvalue())
        self.assertEqual(body['status'],'PASS')
        self.assertEqual(body['evidence']['prompt_receipt']['native_receipt_id'],'msg:1')
        self.assertTrue(body['evidence']['export']['structuredContent']['complete'])
        self.assertNotIn('secret-value',output.getvalue())

    def run_fixture(self, root, archive_reply):
        tag='archive-fixture'
        session='session:fixture'
        rows=[{'role':role,'text':text} for role,text in [
            ('user','HERDER_ZCODE_FIRST_'+tag),('assistant','HERDER_TEST_MODEL_OK'),
            ('user','HERDER_ZCODE_SECOND_'+tag),('assistant','HERDER_TEST_MODEL_OK')]]
        messages={'structuredContent':{'page':{'messages':rows}}}
        receipt={'outcome':'confirmed','native_receipt_id':'msg:first'}
        tasks=[{'status':'completed','result':{'structuredContent':{
            'create':{'effect':'confirmed','session_ref':session},'prompt':receipt}}},
            {'status':'completed','result':{'structuredContent':{
                'outcome':'confirmed','native_receipt_id':'msg:second'}}}]
        calls=[]
        def rpc(client, name, args):
            calls.append((name,args))
            if name in ('create','deliver'): return {'resultType':'task','taskId':name}
            if name=='session' and args['action']=='messages': return messages
            if name=='export': return {'structuredContent':{'complete':True,'bytes_base64':
                base64.b64encode(json.dumps(rows).encode()).decode()}}
            if name=='search': return {'structuredContent':{'complete':True,'hits':[{'session_ref':session}]}}
            if name=='discover': return {'structuredContent':{'projects':[
                {'project_ref':'/herder-owner-home/work','source':'authorized_native_session'}]}}
            if name=='session' and args['action']=='archive':
                saved=json.loads((root/'zcode-v1-receipt.json').read_text())
                self.assertTrue(saved['archive_attempted'])
                self.assertEqual(saved['archive_key'],args['request_key'])
                self.assertNotEqual(saved['result'],'PASS')
                if isinstance(archive_reply,Exception): raise archive_reply
                return archive_reply
            self.fail((name,args))
        output=io.StringIO()
        with patch.dict(os.environ,{'HERDER_TEST_MODEL_BASE_URL':'http://127.0.0.1:1/v1'}), \
                patch.object(stand.uuid,'uuid4',return_value=Mock(hex=tag)), \
                patch.object(stand.urllib.request,'urlopen',side_effect=lambda *a,**kw:io.StringIO('{"requests":2}')), \
                patch.object(stand,'rpc_tool',side_effect=rpc), \
                patch.object(stand,'wait_task',side_effect=tasks), \
                patch.object(stand,'RpcProcess',return_value=Mock()), contextlib.redirect_stdout(output):
            try:
                stand.exercise(Mock(),root,{},[], 'fixture',root,'a'*64,'core','profile')
            except RuntimeError:
                return calls,output.getvalue(),json.loads((root/'zcode-v1-receipt.json').read_text())
        return calls,output.getvalue(),json.loads((root/'zcode-v1-receipt.json').read_text())

    def test_archive_receipt_survives_success_root_cleanup_in_stdout_report(self):
        reply={'resultType':'complete','isError':False,'content':[{'type':'text','text':'native archive reply'}],
               'structuredContent':{'archived':True,'effect':'confirmed','session_ref':'session:fixture'}}
        with tempfile.TemporaryDirectory() as tmp:
            calls,output,saved=self.run_fixture(Path(tmp),reply)
            self.assertEqual([a for n,a in calls if a.get('action')=='archive'],[
                {'action':'archive','session_ref':'session:fixture','request_key':'zcode-v1-create-archive-fixture-archive'}])
            self.assertEqual(calls[-1][1]['action'],'archive')
            self.assertEqual(saved['archive'],reply)
        report=json.loads(output)
        self.assertEqual(report['status'],'PASS')
        self.assertEqual(report['evidence']['archive'],reply)
        self.assertTrue(report['evidence']['archive_attempted'])
        self.assertEqual(report['evidence']['archive_key'],'zcode-v1-create-archive-fixture-archive')

    def test_unconfirmed_archive_never_passes_and_is_not_retried(self):
        for reply in [
            {'isError':True,'structuredContent':{'effect':'unknown','archived':False}},
            {'structuredContent':{'effect':'confirmed','archived':True,'session_ref':'session:other'}},
            RuntimeError('archive transport outcome unknown')]:
            with self.subTest(reply=reply), tempfile.TemporaryDirectory() as tmp:
                calls,output,saved=self.run_fixture(Path(tmp),reply)
                self.assertEqual(sum(a.get('action')=='archive' for n,a in calls),1)
                self.assertEqual(output,'')
                self.assertNotEqual(saved['result'],'PASS')
                self.assertIn('archive',saved)
                self.assertIn('error',saved)


class PublicRuntimeRegression(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ZCODE_V1_RUNTIME') and os.environ.get('ZCODE_V1_MANIFEST') and os.environ.get('ZCODE_V1_CLIENT_DIST'),
                         'set ZCODE_V1_RUNTIME and ZCODE_V1_MANIFEST for isolated public integration')
    def test_official_runtime_initializes_public_core(self):
        manifest = Path(os.environ['ZCODE_V1_MANIFEST']).resolve(strict=True)
        runtime = Path(os.environ['ZCODE_V1_RUNTIME']).resolve(strict=True)
        client_dist = Path(os.environ['ZCODE_V1_CLIENT_DIST']).resolve(strict=True)
        native = Path(__file__).resolve().parent
        command = [sys.executable, str(native / 'launch.py'),
                   '--ro-bind', str(manifest.parent), '--ro-bind', str(runtime.parent),
                   '--ro-bind', str(client_dist),
                   '--ro-bind', str(client_dist.parent / 'node_modules/ws'),
                   '--ro-bind', str(client_dist.parent / 'package.json'), '--',
                   sys.executable, str(native / 'v1_zcode_stand.py'),
                   '--manifest', str(manifest), '--manifest-sha256',stand.digest(manifest), '--client-dist',str(client_dist), '--runtime', str(runtime)]
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
                stand.validate_manifest(path, '0' * 64)

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
            with self.assertRaisesRegex(ValueError, 'artifact mismatch'):
                stand.validate_manifest(path, stand.digest(path))


if __name__ == '__main__':
    unittest.main()
