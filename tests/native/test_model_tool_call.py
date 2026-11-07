import json
import subprocess
import sys
import unittest
import urllib.request
from pathlib import Path

SERVER = Path(__file__).with_name('test-model-server.py')


class ToolCallTest(unittest.TestCase):
    def test_first_request_calls_tool_then_returns_text(self):
        for endpoint in ('responses', 'chat/completions'):
            for stream in (False, True):
                with self.subTest(endpoint=endpoint, stream=stream):
                    proc = subprocess.Popen([sys.executable, str(SERVER), '--scenario', 'tool-call'], stdout=subprocess.PIPE, text=True)
                    try:
                        port = int(proc.stdout.readline())
                        def send():
                            req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/{endpoint}',
                                json.dumps({'model': 'herder-test', 'stream': stream}).encode(),
                                {'Content-Type': 'application/json'})
                            with urllib.request.urlopen(req, timeout=5) as response:
                                return response.read().decode()
                        first = send()
                        self.assertIn('herder_test_tool', first)
                        self.assertIn('call_test_1', first)
                        self.assertIn('HERDER_TEST_MODEL_OK', send())
                        if stream and endpoint == 'responses':
                            self.assertIn('response.function_call_arguments.done', first)
                        if stream and endpoint == 'chat/completions':
                            self.assertIn('tool_calls', first)
                    finally:
                        proc.terminate()
                        proc.wait(timeout=5)
                        proc.stdout.close()


if __name__ == '__main__':
    unittest.main()
