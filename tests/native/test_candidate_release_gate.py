import unittest
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import candidate_release_gate
from candidate_release_gate import invalidate_receipt, validate_cli_candidate, validate_zcode_candidate


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
    def test_zcode_unavailable_invalidates_receipt_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'receipt.json'
            path.write_text(json.dumps({'cli_candidate': 'PASS', 'release': 'PASS'}))
            args = ['gate', '/candidate', 'a' * 40, '/codex', '/opencode', str(path)]
            completed = SimpleNamespace(returncode=2, stdout=json.dumps(receipt()), stderr='')
            with patch.object(sys, 'argv', args), patch.object(candidate_release_gate.subprocess, 'run', return_value=completed), \
                    patch.object(candidate_release_gate, 'run_zcode_candidate', side_effect=RuntimeError('unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                    candidate_release_gate.main()
            result = json.loads(path.read_text())
            self.assertEqual(result['cli_candidate'], 'INCOMPLETE')
            self.assertEqual(result['release'], 'INCOMPLETE')

    def test_zcode_requires_same_payload_and_complete_native_journey(self):
        row = {'scope': 'zcode-official-project', 'version': '3.17.2', 'fixtureRequests': 5,
               'sessions': ['one', 'two'], 'sessionsCreated': True, 'sessionsListed': True,
               'sessionsSearched': True, 'projectListed': True, 'answer': True,
               'transcriptComplete': True, 'transcriptPages': [8, 8]}
        result = {'scope': 'isolated-candidate-only', 'status': 'PASS', 'artifact_sha256': 'a' * 64,
                  'artifact_consistent': True, 'reports': [row]}
        self.assertEqual(validate_zcode_candidate(result, 'a' * 64)['scope'], 'zcode-official-project')
        for key, value in [('artifact_sha256', 'b' * 64), ('artifact_consistent', False)]:
            broken = dict(result, **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_zcode_candidate(broken, 'a' * 64)
        for key, value in [('sessionsSearched', False), ('transcriptPages', [8, 1])]:
            broken = dict(result, reports=[dict(row, **{key: value})])
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_zcode_candidate(broken, 'a' * 64)

    def test_stale_success_is_invalidated_before_a_new_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'receipt.json'
            path.write_text(json.dumps({'cli_candidate': 'PASS'}))
            invalidate_receipt(path)
            self.assertEqual(json.loads(path.read_text())['cli_candidate'], 'INCOMPLETE')

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
