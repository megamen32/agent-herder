import unittest
from candidate_release_gate import validate_cli_candidate


def receipt():
    return {
        'scope': 'isolated-candidate', 'status': 'INCOMPLETE',
        'candidate_bundle': {'source_sha': 'a' * 40},
        'missing': ['installed-process', 'other-required-environments'],
        'cli_versions': {'codex': 'codex-cli 0.167.0', 'opencode': 'opencode v2.1.3'},
        'journeys': [
            {'harness': h, 'status': 'INCOMPLETE', 'missing': ['installed-process'],
             'searchProven': True, 'fixtureRequests': 2,
             'sessions': [{'id': h + '-1', 'pages': 3}, {'id': h + '-2', 'pages': 3}]}
            for h in ('codex', 'opencode')
        ],
    }


class CandidateReleaseGateTest(unittest.TestCase):
    def test_cli_pass_preserves_full_release_incomplete(self):
        result = validate_cli_candidate(receipt(), 'a' * 40, 2)
        self.assertEqual(result['cli_candidate'], 'PASS')
        self.assertEqual(result['release'], 'INCOMPLETE')

    def test_failed_runner_missing_lane_or_short_transcript_refuse_candidate(self):
        for change in ('failure', 'missing', 'short', 'wrong_sha'):
            data = receipt()
            rc = 2
            if change == 'failure': rc = 1
            if change == 'missing': data['journeys'].pop()
            if change == 'short': data['journeys'][0]['sessions'][0]['pages'] = 1
            if change == 'wrong_sha': data['candidate_bundle']['source_sha'] = 'b' * 40
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_cli_candidate(data, 'a' * 40, rc)


if __name__ == '__main__': unittest.main()
