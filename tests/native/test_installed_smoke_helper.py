import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2] / 'deploy/fleet/installed-smoke-helper.py'
SPEC = importlib.util.spec_from_file_location('installed_smoke_helper', SOURCE)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class FixedHelperTest(unittest.TestCase):
    def test_only_bounded_identity_can_cross_privilege_boundary(self):
        valid = {'run_id': 'gha-123-1', 'expected_source_sha': 'a' * 40}
        self.assertEqual(helper.request_input(json.dumps(valid)), valid)
        invalid = [dict(valid, command='anything'), dict(valid, run_id='../another'),
                   dict(valid, expected_source_sha='main'), {'run_id': 123, 'expected_source_sha': 'a' * 40}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                helper.request_input(json.dumps(value))
        with self.assertRaises(ValueError):
            helper.request_input('{"run_id":"one","run_id":"two","expected_source_sha":"' + 'a' * 40 + '"}')

    def test_private_file_refuses_symlink_and_group_readable_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / 'fixture.json'
            secret.write_text('{}')
            secret.chmod(0o640)
            with self.assertRaises(ValueError):
                helper.safe_read(secret, owner=os.getuid(), private=True)
            secret.chmod(0o600)
            self.assertEqual(helper.safe_read(secret, owner=os.getuid(), private=True), b'{}')
            link = Path(directory) / 'link'
            link.symlink_to(secret)
            with self.assertRaises(OSError):
                helper.safe_read(link, owner=os.getuid(), private=True)

    def test_summary_excludes_native_payloads_and_preserves_unverified_global_inventory(self):
        report = {'status': 'PASS', 'functional_status': 'PASS', 'global_inventory_status': 'UNVERIFIED',
                  'native_payload': 'PRIVATE_TRANSCRIPT', 'lanes': {'codex': {
                      'checks': {'create': 'PASS'}, 'error_code': 'PRIVATE_KEY=value', 'messages': ['PRIVATE_TRANSCRIPT']}}}
        result = helper.summary(report, {'run_id': 'one', 'expected_source_sha': 'a' * 40}, 0)
        self.assertEqual(result['global_inventory_status'], 'UNVERIFIED')
        self.assertEqual(result['lanes']['zai']['checks']['create'], 'UNKNOWN')
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(helper.summary(report, {'run_id': 'one', 'expected_source_sha': 'a' * 40}, 1)['status'], 'FAIL')

    def test_missing_profile_preflight_remains_explicit_fail_without_native_submission(self):
        report = {'status': 'FAIL', 'error_code': 'native_profiles_missing', 'model_effects': 'NOT_SUBMITTED',
                  'missing_harnesses': ['chatgpt', 'zai', 'zcode', {'private': 'payload'}]}
        result = helper.summary(report, {'run_id': 'one', 'expected_source_sha': 'a' * 40}, 2)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['model_effects'], 'NOT_SUBMITTED')
        self.assertEqual(result['error_code'], 'native_profiles_missing')
        self.assertEqual(result['missing_harnesses'], ['chatgpt', 'zai', 'zcode'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'installed helper process proof uses Linux /proc')
    def test_timeout_terminates_the_owned_group_and_keeps_effect_unknown(self):
        result = helper.run_owned_group([sys.executable, '-c',
            'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],
            os.environ.copy(), timeout=0.15, grace=0.1)
        self.assertTrue(result['timed_out'])
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(result['effect_outcome'], 'UNKNOWN')
        self.assertNotEqual(result['returncode'], 0)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'installed helper process proof uses Linux /proc')
    def test_successful_parent_cannot_leave_an_orphan_as_clean_pass(self):
        result = helper.run_owned_group([sys.executable, '-c',
            'import subprocess,sys;subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"])'],
            os.environ.copy(), timeout=3, grace=0.2)
        self.assertEqual(result['returncode'], 0)
        self.assertTrue(result['descendants_terminated'])
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(result['effect_outcome'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
