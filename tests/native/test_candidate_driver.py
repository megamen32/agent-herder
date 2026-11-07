import unittest
import hashlib
import json
import tempfile
from pathlib import Path
from candidate_driver import candidate_bundle_identity, exit_code_for_status, http_error_summary, timeout_summary, validate_isolation


class CandidateDriverTest(unittest.TestCase):
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
