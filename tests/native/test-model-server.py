#!/usr/bin/env python3
"""Loopback-only deterministic model endpoint for native harness integration tests."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWER = "HERDER_TEST_MODEL_OK"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    count = 0
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/_stats":
            self.reply(200, "application/json", json.dumps({"requests": self.count}).encode())
        elif self.path == "/v1/models":
            self.reply(200, "application/json", json.dumps({"object": "list", "data": [{"id": "herder-test", "object": "model", "owned_by": "test"}]}).encode())
        else:
            self.reply(404, "text/plain", b"unknown endpoint")

    def do_POST(self):
        if self.path not in ("/v1/responses", "/v1/chat/completions"):
            return self.reply(404, "text/plain", b"unknown endpoint")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 4_000_000:
                raise ValueError("invalid request size")
            request = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, "text/plain", b"invalid JSON")
        with self.lock:
            type(self).count += 1
            sequence = type(self).count
        if self.path == "/v1/responses":
            return self.send_responses(request, sequence)
        return self.chat(request, sequence)

    def send_responses(self, request, sequence):
        response_id, item_id = f"resp_test_{sequence}", f"msg_test_{sequence}"
        if self.server.scenario == 'tool-call' and sequence == 1:
            item = {'id': 'fc_test_1', 'type': 'function_call', 'call_id': 'call_test_1',
                    'name': 'herder_test_tool', 'arguments': '{"value":"fixture"}', 'status': 'completed'}
            response = {'id': response_id, 'object': 'response', 'created_at': 0,
                        'status': 'completed', 'model': request.get('model', 'herder-test'),
                        'output': [item], 'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}}
            if not request.get('stream'):
                return self.reply(200, 'application/json', json.dumps(response).encode())
            events = [
                {'type': 'response.created', 'response': dict(response, status='in_progress', output=[])},
                {'type': 'response.output_item.added', 'output_index': 0, 'item': dict(item, status='in_progress', arguments='')},
                {'type': 'response.function_call_arguments.delta', 'item_id': item['id'], 'output_index': 0, 'delta': item['arguments']},
                {'type': 'response.function_call_arguments.done', 'item_id': item['id'], 'output_index': 0, 'arguments': item['arguments']},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                {'type': 'response.completed', 'response': response},
            ]
            body = ''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
            return self.reply(200, 'text/event-stream', body)
        part = {"type": "output_text", "text": ANSWER, "annotations": []}
        item = {"id": item_id, "type": "message", "status": "completed", "role": "assistant", "content": [part]}
        response = {"id": response_id, "object": "response", "created_at": 0, "status": "completed", "model": request.get("model", "herder-test"), "output": [item], "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}
        if not request.get("stream"):
            return self.reply(200, "application/json", json.dumps(response).encode())
        pending = dict(response, status="in_progress", output=[])
        partial_item = dict(item, status="in_progress", content=[])
        events = [
            {"type": "response.created", "response": pending},
            {"type": "response.output_item.added", "output_index": 0, "item": partial_item},
            {"type": "response.content_part.added", "item_id": item_id, "output_index": 0, "content_index": 0, "part": dict(part, text="")},
            {"type": "response.output_text.delta", "item_id": item_id, "output_index": 0, "content_index": 0, "delta": ANSWER},
            {"type": "response.output_text.done", "item_id": item_id, "output_index": 0, "content_index": 0, "text": ANSWER},
            {"type": "response.content_part.done", "item_id": item_id, "output_index": 0, "content_index": 0, "part": part},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ]
        body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
        return self.reply(200, "text/event-stream", body)

    def chat(self, request, sequence):
        base = {"id": f"chatcmpl-test-{sequence}", "object": "chat.completion", "created": 0, "model": request.get("model", "herder-test")}
        if self.server.scenario == 'tool-call' and sequence == 1:
            call = {'id': 'call_test_1', 'type': 'function', 'function': {'name': 'herder_test_tool', 'arguments': '{"value":"fixture"}'}}
            if not request.get('stream'):
                base['choices'] = [{'index': 0, 'message': {'role': 'assistant', 'content': None, 'tool_calls': [call]}, 'finish_reason': 'tool_calls'}]
                return self.reply(200, 'application/json', json.dumps(base).encode())
            base['object'] = 'chat.completion.chunk'
            chunks = [dict(base, choices=[{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [dict(call, index=0)]}, 'finish_reason': None}]),
                      dict(base, choices=[{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}])]
            body = (''.join(f'data: {json.dumps(chunk)}\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
            return self.reply(200, 'text/event-stream', body)
        if not request.get("stream"):
            base["choices"] = [{"index": 0, "message": {"role": "assistant", "content": ANSWER}, "finish_reason": "stop"}]
            return self.reply(200, "application/json", json.dumps(base).encode())
        base["object"] = "chat.completion.chunk"
        chunks = [dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": ANSWER}, "finish_reason": None}]), dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}])]
        body = ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
        return self.reply(200, "text/event-stream", body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument('--scenario', choices=('text', 'tool-call'), default='text')
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.scenario = args.scenario
    print(server.server_port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
