import copy
import unittest
from search_proof import attach_search_proof, verify_search


def result():
    source = {'harness': 'codex', 'state': 'complete', 'scanId': 'scan-1', 'missingContent': 0}
    return {'partial': False, 'results': [{'hostId': 'host', 'harness': 'codex', 'nativeSessionId': 'id-1'}],
            'hosts': [{'hostId': 'host', 'state': 'available', 'partial': False,
                       'index': {'indexing': False, 'run': {'status': 'complete', 'scanId': 'scan-1'}, 'sources': [source]}}]}


class SearchProofTest(unittest.TestCase):
    def test_exact_complete_result(self):
        self.assertTrue(verify_search(result(), 'host', 'codex', 'id-1'))

    def test_partial_stale_or_wrong_identity_is_rejected(self):
        cases = []
        a=result(); a['partial']=True; cases.append(a)
        a=result(); a['results'][0]['nativeSessionId']='other'; cases.append(a)
        a=result(); a['results'][0]['hostId']='other'; cases.append(a)
        a=result(); a['hosts'][0]['index']['run']['scanId']='new'; cases.append(a)
        a=result(); a['hosts'][0]['index']['sources'][0]['missingContent']=1; cases.append(a)
        a=result(); a['hosts'][0]['index']['sources'][0]['missingContent']=False; cases.append(a)
        a=result(); a['hosts'][0]['index']['indexing']=True; cases.append(a)
        a=result(); a['hosts'][0]['partial']=True; cases.append(a)
        a=result(); a['hosts'][0]['index']['sources'].append(copy.deepcopy(a['hosts'][0]['index']['sources'][0])); cases.append(a)
        a=result(); a['hosts'].append(copy.deepcopy(a['hosts'][0])); cases.append(a)
        for a in cases:
            with self.subTest(value=a): self.assertFalse(verify_search(a, 'host', 'codex', 'id-1'))

    def test_journey_only_accepts_both_exact_searches(self):
        journey = {'status': 'INCOMPLETE', 'harness': 'codex', 'missing': ['search', 'installed-process'],
                   'sessions': [{'id': 'id-1'}, {'id': 'id-2'}]}
        second = result(); second['results'][0]['nativeSessionId'] = 'id-2'
        replies = [{'harness': 'codex', 'sessionId': 'id-1', 'response': result()},
                   {'harness': 'codex', 'sessionId': 'id-2', 'response': second}]
        updated = attach_search_proof(journey, replies, 'host')
        self.assertEqual(updated['missing'], ['installed-process'])
        self.assertEqual(updated['status'], 'INCOMPLETE')
        replies[1]['response']['partial'] = True
        with self.assertRaises(ValueError): attach_search_proof(journey, replies, 'host')


if __name__ == '__main__': unittest.main()
