#!/usr/bin/env python3
"""Exercise a dynamic tool through a real Codex app-server and isolated fixture."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise ValueError('pass the absolute path to the real codex binary')
    executable = Path(sys.argv[1]).resolve(strict=True)
    base = os.environ['HERDER_TEST_MODEL_BASE_URL']
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/v1'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('isolated fixture required')
    home = Path(os.environ['HOME'])
    codex_home = home / '.codex'
    codex_home.mkdir(mode=0o700)
    (codex_home / 'config.toml').write_text(
        'model = "herder-test"\nmodel_provider = "fixture"\n'
        '[model_providers.fixture]\nname = "fixture"\n'
        f'base_url = "{base}"\nwire_api = "responses"\n'
        'env_key = "HERDER_FIXTURE_KEY"\n')
    env = dict(os.environ, CODEX_HOME=str(codex_home), HERDER_FIXTURE_KEY='fixture-only')
    proc = subprocess.Popen([str(executable), 'app-server'], cwd=home, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, bufsize=1)
    messages = queue.Queue()
    def reader():
        for line in proc.stdout:
            messages.put(json.loads(line))
        messages.put(None)
    threading.Thread(target=reader, daemon=True).start()
    def send(value):
        proc.stdin.write(json.dumps(value) + '\n')
        proc.stdin.flush()
    def wait(predicate):
        deadline = time.monotonic() + 45
        while True:
            item = messages.get(timeout=max(0.1, deadline - time.monotonic()))
            if item is None:
                raise RuntimeError('Codex exited; outcome unknown, do not retry')
            if predicate(item):
                return item
            if time.monotonic() >= deadline:
                raise TimeoutError('Codex result unknown, do not retry')
    def call(number, method, params):
        send({'id': number, 'method': method, 'params': params})
        result = wait(lambda e: e.get('id') == number and 'method' not in e)
        if 'error' in result:
            raise RuntimeError(str(result['error']))
        return result['result']
    try:
        call(1, 'initialize', {'clientInfo': {'name': 'herder-tool-fixture', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        send({'method': 'initialized', 'params': {}})
        spec = {'type': 'function', 'name': 'herder_test_tool', 'description': 'Fixture tool',
                'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value'], 'additionalProperties': False}}
        thread = call(2, 'thread/start', {'cwd': str(home), 'model': 'herder-test', 'approvalPolicy': 'never',
                                         'sandbox': 'read-only', 'dynamicTools': [spec]})['thread']['id']
        turn = call(3, 'turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'Use fixture tool'}], 'model': 'herder-test'})['turn']['id']
        request = wait(lambda e: e.get('method') == 'item/tool/call')
        params = request['params']
        if (params.get('threadId') != thread or params.get('turnId') != turn or params.get('callId') != 'call_test_1'
                or params.get('tool') != 'herder_test_tool' or params.get('arguments') != {'value': 'fixture'}):
            raise RuntimeError('tool invocation identity mismatch')
        send({'id': request['id'], 'result': {'success': True, 'contentItems': [{'type': 'inputText', 'text': 'fixture tool completed'}]}})
        completed = wait(lambda e: e.get('method') == 'turn/completed' and e.get('params', {}).get('turn', {}).get('id') == turn)
        if completed['params']['turn']['status'] != 'completed':
            raise RuntimeError('turn failed: ' + str(completed['params']['turn']))
        readback = call(4, 'thread/read', {'threadId': thread, 'includeTurns': True})['thread']
        if 'HERDER_TEST_MODEL_OK' not in json.dumps(readback):
            raise RuntimeError('fixture answer absent from native readback')
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            count = json.load(response)['requests']
        if count != 2:
            raise RuntimeError(f'expected two fixture requests, got {count}')
        print(json.dumps({'scope': 'direct Codex app-server, not Herder', 'thread': thread, 'turn': turn,
                          'tool': params['tool'], 'fixture_requests': count, 'readback': 'confirmed'}))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        proc.stdin.close()
        proc.stdout.close()


if __name__ == '__main__':
    main()
