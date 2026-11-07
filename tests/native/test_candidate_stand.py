import tempfile
import unittest
from pathlib import Path
from candidate_stand import diagnostic_tail, fixture_path, fixture_fleet_admission, fixture_codex_config, fixture_peer, require_sandbox, write_fixture_quota


class CandidateStandTest(unittest.TestCase):
    def test_current_node_precedes_system_legacy_node(self):
        self.assertEqual(fixture_path().split(':')[0], '/usr/local/bin')

    def test_fixture_does_not_consult_host_fleet_admission(self):
        self.assertEqual(fixture_fleet_admission(), 'retired')

    def test_fixture_provider_needs_no_inherited_credential(self):
        config = fixture_codex_config('http://127.0.0.1:1234/v1')
        self.assertIn('base_url = "http://127.0.0.1:1234/v1"', config)
        self.assertNotIn('env_key', config)

    def test_self_peer_uses_the_synthetic_user(self):
        self.assertEqual(fixture_peer('host', 1234, 'fixture')[0]['nativeUser'], 'fixture')

    def test_sandbox_rejects_host_namespace_and_nonfixture_home(self):
        require_sandbox('1:2', '1:3', '/tmp/herder-native-model-abc/home', True)
        for args in [('1:2', '1:2', '/tmp/herder-native-model-abc/home', True),
                     ('1:2', '', '/tmp/herder-native-model-abc/home', True),
                     ('1:2', '1:3', '/home/user', True),
                     ('1:2', '1:3', '/tmp/herder-native-model-abc/home', False)]:
            with self.subTest(args=args), self.assertRaises(ValueError): require_sandbox(*args)

    def test_fixture_quota_is_disabled_in_disposable_state(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            path = write_fixture_quota(Path(d))
            self.assertFalse(json.loads((path/'codex-quota-guard.json').read_text())['policy']['enabled'])
            self.assertTrue(path.is_relative_to(Path(d)))

    def test_failure_diagnostics_are_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d)/'fixture.log'
            log.write_text('x'*5000 + 'useful failure')
            result = diagnostic_tail(log)
            self.assertIn('useful failure', result)
            self.assertLessEqual(len(result), 4096)


if __name__ == '__main__': unittest.main()
