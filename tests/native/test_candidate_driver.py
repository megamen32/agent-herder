import unittest
import hashlib
import json
import tempfile
from pathlib import Path
from candidate_driver import candidate_bundle_identity, candidate_store_identity, exit_code_for_status, http_error_summary, timeout_summary, validate_isolation


class CandidateDriverTest(unittest.TestCase):
    def test_installed_release_uses_portable_payload_when_package_links_differ(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root)
            (release / 'dist').mkdir()
            (release / 'node_modules').mkdir()
            (release / 'dist' / 'index.js').write_text('release payload')
            (release / 'node_modules' / 'fixture').symlink_to('/node-specific-store/fixture')
            value = hashlib.sha256((release / 'dist' / 'index.js').read_bytes()).hexdigest()
            portable = hashlib.sha256(f'dist/index.js\0{value}\n'.encode()).hexdigest()
            (release / 'build-manifest.json').write_text(json.dumps({
                'sourceSha': 'a' * 40, 'bundleFingerprint': 'b' * 64, 'bundleFiles': 2,
                'payloadFingerprint': portable, 'payloadFiles': 1,
            }))
            proof = candidate_bundle_identity(release)
            self.assertEqual(proof['payload_fingerprint'], portable)
            self.assertFalse(proof['whole_bundle_matches'])
            (release / 'dist' / 'index.js').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'bundle|payload'):
                candidate_bundle_identity(release)

    def test_release_identity_checks_entire_bundle_not_just_entrypoint(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root)
            (release / 'dist').mkdir()
            (release / 'dist' / 'index.js').write_text('same entry')
            (release / 'dist' / 'adapter.js').write_text('original adapter')
            entries = {p.relative_to(release).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in (release / 'dist').iterdir()}
            digest = hashlib.sha256(''.join(f'{key}\0{entries[key]}\n' for key in sorted(entries)).encode()).hexdigest()
            (release / 'build-manifest.json').write_text(json.dumps({'sourceSha': 'a' * 40, 'bundleFingerprint': digest, 'bundleFiles': 2}))
            proof = candidate_bundle_identity(release)
            self.assertEqual(proof['source_sha'], 'a' * 40)
            self.assertEqual(proof['bundle_fingerprint'], digest)
            (release / 'dist' / 'adapter.js').write_text('tampered adapter')
            with self.assertRaisesRegex(ValueError, 'bundle'):
                candidate_bundle_identity(release)

    def test_dependency_store_identity_changes_when_linked_code_changes(self):
        with tempfile.TemporaryDirectory() as root:
            catalog = Path(root)
            release = catalog / 'releases' / ('a' * 40)
            modules = release / 'node_modules'
            modules.mkdir(parents=True)
            store = catalog / 'shared-node-modules' / ('b' * 64)
            package = store / 'fixture-package'
            package.mkdir(parents=True)
            code = package / 'index.js'
            code.write_text('original dependency')
            (modules / 'fixture-package').symlink_to(package, target_is_directory=True)
            before = candidate_store_identity(release)
            code.write_text('changed dependency')
            after = candidate_store_identity(release)
            self.assertNotEqual(before['fingerprint'], after['fingerprint'])
            outside = catalog / 'outside'
            outside.mkdir()
            (modules / 'foreign').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'dependency'):
                candidate_store_identity(release)

    def test_incomplete_is_not_a_successful_exit(self):
        self.assertNotEqual(exit_code_for_status('INCOMPLETE'), 0)
        self.assertNotEqual(exit_code_for_status('FAIL'), 0)
        self.assertEqual(exit_code_for_status('PASS'), 0)

    def test_failure_explains_status_and_body(self):
        self.assertEqual(http_error_summary(502, b'{"error":"fixture unavailable"}'), 'HTTP 502: fixture unavailable')

    def test_timeout_includes_bounded_search_diagnostics(self):
        self.assertEqual(timeout_summary(b'query codex\n'), 'search timed out: query codex')

    def test_private_loopback_is_accepted(self):
        validate_isolation([{'ifname': 'lo'}], [], [], '/tmp/herder-native-model-abc/work',
                           'http://127.0.0.1:1234', 'http://127.0.0.1:1235')

    def test_foreign_network_or_nonfixture_project_is_rejected(self):
        cases = [([{'ifname': 'lo'}, {'ifname': 'eth0'}], [], [], '/tmp/herder-native-model-abc/work', 'http://127.0.0.1:1234', 'http://127.0.0.1:1235'),
                 ([{'ifname': 'lo'}], [{'dst': 'default'}], [], '/tmp/herder-native-model-abc/work', 'http://127.0.0.1:1234', 'http://127.0.0.1:1235'),
                 ([{'ifname': 'lo'}], [], [], '/home/user/project', 'http://127.0.0.1:1234', 'http://127.0.0.1:1235'),
                 ([{'ifname': 'lo'}], [], [], '/tmp/herder-native-model-abc/work', 'http://example.com:1234', 'http://127.0.0.1:1235')]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError): validate_isolation(*args)


if __name__ == '__main__': unittest.main()
