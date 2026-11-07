import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('opencode_receipt', Path(__file__).with_name('opencode_receipt.py'))
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class OpenCodeFailureTest(unittest.TestCase):
    def test_fixture_uses_dedicated_provider_with_loopback_override(self):
        config = receipt.fixture_config('http://127.0.0.1:12345/v1')
        self.assertEqual(config['model'], 'fixture/herder-test')
        self.assertEqual(config['provider']['fixture']['options']['baseURL'], 'http://127.0.0.1:12345/v1')

    def test_failed_run_reports_stdout_stderr_and_model_count(self):
        result = SimpleNamespace(returncode=1, stdout='provider fixture unavailable', stderr='')
        message = receipt.failure_context(result, 0)
        self.assertIn('provider fixture unavailable', message)
        self.assertIn('fixture_requests=0', message)
        self.assertIn('no replay', message)

    def test_readback_requires_ordered_user_and_completed_assistant(self):
        rows = {'data': [{'id':'u1','role':'user','parts':[{'type':'text','text':'marker'}]},
                         {'id':'a1','role':'assistant','parts':[{'type':'text','text':'HERDER_TEST_MODEL_OK'}],
                          'time':{'completed':123},'finish':'stop'}]}
        self.assertTrue(receipt.complete_native_readback(rows, 'marker'))
        rows['data'][1]['time'] = {}
        self.assertFalse(receipt.complete_native_readback(rows, 'marker'))
        rows['data'][1]['time'] = {'completed':123}; rows['data'][1]['finish'] = 'error'
        self.assertFalse(receipt.complete_native_readback(rows, 'marker'))

    def test_timeout_evidence_keeps_id_role_and_completion_without_message_text(self):
        rows = {'data':[{'id':'a1','role':'assistant','text':'PRIVATE TEST TEXT',
                         'time':{'completed':123},'finish':'stop'}]}
        summary = receipt.summarize_native_messages(rows)
        self.assertEqual(summary, [{'id':'a1','role':'assistant','completed':123,'finish':'stop','error':False}])
        self.assertNotIn('PRIVATE TEST TEXT', str(summary))

    def test_v2_type_fields_identify_user_and_assistant(self):
        rows = {'data':[{'id':'u1','type':'user','parts':[{'type':'text','text':'marker'}]},
                        {'id':'a1','type':'assistant','parts':[{'type':'text','text':'HERDER_TEST_MODEL_OK'}],
                         'time':{'completed':123},'finish':'stop'}]}
        self.assertTrue(receipt.complete_native_readback(rows, 'marker'))

    def test_server_readiness_retries_transient_503_but_not_auth_refusal(self):
        statuses = iter([(503, {}), (200, {})])
        receipt.wait_for_ready(lambda: next(statuses), lambda: True, timeout=2, sleep=lambda _:None)
        with self.assertRaisesRegex(RuntimeError, '401'):
            receipt.wait_for_ready(lambda: (401, {}), lambda: True, timeout=2, sleep=lambda _:None)

    def test_v22_readiness_uses_json_health_when_old_config_path_is_html(self):
        calls = []
        def read(path):
            calls.append(path)
            return (200, None) if path == '/api/config' else (200, {'healthy': True})
        self.assertEqual(receipt.readiness_probe(read)[0], 200)
        self.assertEqual(calls, ['/api/config', '/api/health'])
        self.assertEqual(receipt.readiness_probe(lambda _: (401, None))[0], 401)
        self.assertEqual(receipt.readiness_probe(lambda path: (404, None) if path == '/api/config' else (200, {'healthy':True}))[0], 200)
        self.assertEqual(receipt.readiness_probe(lambda _: (200, [{'source':'fixture'}]))[0], 200)
        self.assertEqual(receipt.readiness_probe(lambda _: (404, None))[0], 503)

    def test_v22_provider_verification_requires_connected_exact_loopback_model(self):
        base = 'http://127.0.0.1:12345/v1'
        response = {'connected':['fixture'], 'all':[{'id':'fixture','options':{'baseURL':base},'models':{'herder-test':{}}}]}
        self.assertTrue(receipt.v22_fixture_verified(response, base))
        response['all'][0]['options']['baseURL'] = 'https://paid.example/v1'
        self.assertFalse(receipt.v22_fixture_verified(response, base))
        response['all'][0]['options']['baseURL'] = base
        response['connected'] = []
        self.assertFalse(receipt.v22_fixture_verified(response, base))

    def test_duplicate_session_is_rejected_before_second_send(self):
        previous = [{'native_session_id':'ses_one'}]
        self.assertFalse(receipt.is_new_session('ses_one', previous))
        self.assertTrue(receipt.is_new_session('ses_two', previous))
        self.assertFalse(receipt.is_new_session('', previous))


if __name__ == '__main__':
    unittest.main()
