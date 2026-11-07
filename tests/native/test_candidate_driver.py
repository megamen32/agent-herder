import unittest
from candidate_driver import validate_isolation


class CandidateDriverTest(unittest.TestCase):
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
