"""Loopback-only OpenAI-compatible deterministic model for Hermes canaries."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

class Handler(BaseHTTPRequestHandler):
    count = 0
    paths = {}
    lock = Lock()
    def log_message(self, *_args):
        pass
    def reply(self, code, content_type, payload):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def do_GET(self):
        if self.path == '/_stats':
            self.reply(200, 'application/json', json.dumps({'requests': self.count, 'paths': self.paths}).encode())
        else:
            self.reply(404, 'text/plain', b'not found')
    def do_POST(self):
        with self.lock:
            type(self).paths[self.path] = type(self).paths.get(self.path, 0) + 1
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 4000000:
            return self.reply(400, 'text/plain', b'invalid length')
        request = json.loads(self.rfile.read(length))
        if self.path != '/v1/chat/completions':
            return self.reply(404, 'text/plain', b'not found')
        with self.lock:
            type(self).count += 1
        common = {'id':'fixture', 'created':0, 'model':request.get('model', 'herder-test')}
        if request.get('stream'):
            chunk = {**common, 'object':'chat.completion.chunk', 'choices':[{'index':0, 'delta':{'role':'assistant','content':'HERDER_TEST_MODEL_OK'}, 'finish_reason':None}]}
            end = {**chunk, 'choices':[{'index':0, 'delta':{}, 'finish_reason':'stop'}]}
            data = ('data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(end)+'\n\ndata: [DONE]\n\n').encode()
            return self.reply(200, 'text/event-stream', data)
        response = {**common, 'object':'chat.completion', 'choices':[{'index':0,'message':{'role':'assistant','content':'HERDER_TEST_MODEL_OK'},'finish_reason':'stop'}], 'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
        self.reply(200, 'application/json', json.dumps(response).encode())
