import unittest
from herder_journey import run_journey


class JourneyTest(unittest.TestCase):
    def fixture(self, fail_send=False):
        calls = []
        ids = []
        def api(path, body=None):
            calls.append((path, body))
            if path == '/api/settings': return {'projects': [{'id': 'test', 'path': '/isolated/project'}]}
            if path == '/_stats': return {'requests': 10 + len([x for x in calls if x[0].endswith('/message')])}
            if path == '/api/sessions':
                ids.append('id-' + str(len(ids)))
                return {'sessionId': ids[-1]}
            if path.endswith('/message'):
                if fail_send: raise TimeoutError('unknown admission')
                return {'job': {'id': 'job-' + str(len(ids))}}
            if path.startswith('/api/jobs/'): return {'job': {'state': 'completed', 'result': {'ok': True}}}
            if path.startswith('/api/sessions?harness='): return {'sessions': [{'id': i, 'harness': 'codex'} for i in ids]}
            raise AssertionError(path)
        def transcript(harness, sid, marker): return 2
        return api, transcript, calls

    def test_two_sessions_and_incomplete_status(self):
        api, transcript, calls = self.fixture()
        result = run_journey(api, transcript, 'codex', 'herder-test', '/isolated/project')
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertEqual(len(result['sessions']), 2)
        self.assertEqual(result['fixtureRequests'], 2)
        self.assertEqual(len([p for p, _ in calls if p.endswith('/message')]), 2)
        self.assertIn('search', result['missing'])
        self.assertIn('installed-process', result['missing'])

    def test_unknown_send_never_replayed(self):
        api, transcript, calls = self.fixture(fail_send=True)
        with self.assertRaisesRegex(RuntimeError, 'unknown.*no replay'):
            run_journey(api, transcript, 'codex', 'herder-test', '/isolated/project')
        self.assertEqual(len([p for p, _ in calls if p.endswith('/message')]), 1)

    def test_duplicate_session_id_is_rejected(self):
        api, transcript, calls = self.fixture()
        def duplicate(path, body=None):
            if path == '/api/sessions':
                api(path, body)
                return {'sessionId': 'same'}
            return api(path, body)
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            run_journey(duplicate, transcript, 'codex', 'herder-test', '/isolated/project')


if __name__ == '__main__': unittest.main()
