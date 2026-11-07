import copy
import unittest
from transcript_proof import fetch_transcript, validate_transcript


def sample():
    scope = {'hostId': 'server-44', 'harness': 'codex', 'nativeSessionId': 'session-1'}
    events = [
        {'eventId': 'a', 'sequence': 0, 'kind': 'message', 'author': {'sourceRole': 'user'}, 'text': 'exact input'},
        {'eventId': 'b', 'sequence': 1, 'kind': 'tool', 'author': {'kind': 'assistant'}, 'text': 'work'},
        {'eventId': 'c', 'sequence': 2, 'kind': 'message', 'author': {'kind': 'assistant'}, 'text': 'fixture answer'},
    ]
    return [{'requestedCursor': None if i == 0 else f'cursor-{i}', 'page': {
        'scope': scope.copy(), 'totalEvents': 3, 'events': [event],
        'nextCursor': f'cursor-{i+1}' if i < 2 else None, 'complete': i == 2,
    }} for i, event in enumerate(events)]


class TranscriptProofTest(unittest.TestCase):
    def check(self, pages):
        return validate_transcript(pages, 'server-44', 'codex', 'session-1', 'exact input', 'fixture answer')

    def test_complete_chain(self):
        self.assertEqual(self.check(sample()), 3)

    def test_refuses_partial_or_misdirected_readbacks(self):
        cases = []
        p = sample(); cases.append(p[:-1])
        p = sample(); p[1]['requestedCursor'] = 'other'; cases.append(p)
        p = sample(); p[1]['page']['scope']['nativeSessionId'] = 'other'; cases.append(p)
        p = sample(); p[1]['page']['events'][0]['eventId'] = 'a'; cases.append(p)
        p = sample(); p[1]['page']['events'][0]['sequence'] = 9; cases.append(p)
        p = sample(); p[2]['page']['complete'] = False; cases.append(p)
        p = sample(); p[2]['page']['events'][0]['text'] = 'different'; cases.append(p)
        p = sample(); p[1]['page']['totalEvents'] = 2; cases.append(p)
        p = sample(); p[1]['page']['nextCursor'] = 'cursor-1'; cases.append(p)
        p = sample(); p[0]['page']['complete'] = True; cases.append(p)
        for pages in cases:
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                self.check(copy.deepcopy(pages))

    def test_collector_requests_each_returned_cursor_once(self):
        pages = sample()
        calls = []
        def read(cursor):
            calls.append(cursor)
            return pages[len(calls)-1]['page']
        self.assertEqual(fetch_transcript(read, 'server-44', 'codex', 'session-1', 'exact input', 'fixture answer'), 3)
        self.assertEqual(calls, [None, 'cursor-1', 'cursor-2'])

    def test_collector_stops_on_repeated_cursor(self):
        pages = sample()
        pages[1]['page']['nextCursor'] = 'cursor-1'
        calls = []
        def read(cursor):
            calls.append(cursor)
            return pages[len(calls)-1]['page']
        with self.assertRaises(ValueError):
            fetch_transcript(read, 'server-44', 'codex', 'session-1', 'exact input', 'fixture answer')
        self.assertEqual(calls, [None, 'cursor-1'])


if __name__ == '__main__':
    unittest.main()
