import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from herder_transcript_http import read_transcript
from test_transcript_proof import sample


class TranscriptHttpTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.pages = sample()
        self.fail = False
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                parts = urlsplit(self.path)
                outer.calls.append((parts.path, parse_qs(parts.query), self.headers.get('Origin')))
                if outer.fail and len(outer.calls) == 2:
                    self.send_error(422)
                    return
                page = outer.pages[len(outer.calls)-1]['page']
                body = json.dumps({'transcript': page}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def run_read(self):
        return read_transcript(self.base, 'server-44', 'codex', 'session-1', 'exact input', 'fixture answer')

    def test_reads_api_pages_in_order(self):
        self.assertEqual(self.run_read(), 3)
        self.assertEqual([x[1].get('cursor') for x in self.calls], [None, ['cursor-1'], ['cursor-2']])
        self.assertTrue(all(x[0] == '/api/sessions/codex/session-1/transcript' and x[2] == self.base for x in self.calls))

    def test_http_failure_is_not_complete(self):
        self.fail = True
        with self.assertRaises(Exception): self.run_read()
        self.assertEqual(len(self.calls), 2)

    def test_external_endpoints_rejected_before_request(self):
        with self.assertRaises(ValueError):
            read_transcript('http://example.com', 'server-44', 'codex', 'session-1', 'input', 'answer')
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
