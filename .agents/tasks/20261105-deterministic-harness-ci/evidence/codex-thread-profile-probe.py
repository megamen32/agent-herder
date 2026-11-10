#!/usr/bin/env python3
"""Direct Codex native receipt canary, run only through launch.py's disposable profile.

This checks Codex itself, not Herder MCP, a Rust adapter, or E001/E002.
Never retries an admitted or uncertain turn.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.parse
import uuid


def validate_receipts(receipts, readbacks):
    if len(receipts) != 2:
        return False
    threads = [row.get('native_thread_id') for row in receipts]
    turns = [row.get('native_turn_id') for row in receipts]
    inputs = [row.get('input') for row in receipts]
    if any(not isinstance(x, str) or not x for x in threads + turns + inputs):
        return False
    if len(set(threads)) != 2 or len(set(turns)) != 2 or len(set(inputs)) != 2:
        return False
    for row in receipts:
        thread = readbacks.get(row['native_thread_id'])
        if not isinstance(thread, dict) or thread.get('id') != row['native_thread_id']:
            return False
        turns_in_thread = thread.get('turns')
        if not isinstance(turns_in_thread, list):
            return False
        turn = next((item for item in turns_in_thread if isinstance(item, dict) and item.get('id') == row['native_turn_id']), None)
        if not turn or row['input'] not in json.dumps(turn) or 'HERDER_TEST_MODEL_OK' not in json.dumps(turn):
            return False
    return True


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise ValueError('pass the absolute path to the real codex binary')
    home = Path(os.environ['HOME'])
    base = os.environ['HERDER_TEST_MODEL_BASE_URL']
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/v1' or url.username or url.password or url.query or url.fragment):
        raise ValueError('test model must be the loopback fixture')
    executable = Path(sys.argv[1]).resolve(strict=True)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    codex_home = home / '.codex'
    codex_home.mkdir(mode=0o700)
    (codex_home / 'config.toml').write_text(
        'model = "herder-test"\nmodel_provider = "fixture_default"\n'
        '[model_providers.fixture_default]\nname = "fixture"\n'
        f'base_url = "{base}"\nwire_api = "responses"\n'
        'env_key = "HERDER_FIXTURE_KEY"\n')
    (codex_home / 'fixture.config.toml').write_text('model_provider=\"fixture_project\"\n[model_providers.fixture_project]\nname=\"fixture\"\nbase_url=\"'+base+'\"\nwire_api=\"responses\"\nenv_key=\"HERDER_FIXTURE_KEY\"\n')
    env = dict(os.environ, CODEX_HOME=str(codex_home), HERDER_FIXTURE_KEY='fixture-only', PATH='/usr/local/bin:/usr/bin:/bin')
    version = subprocess.check_output([str(executable), '--version'], env=env, cwd=home,
                                      text=True, timeout=10).strip()
    proc = subprocess.Popen([str(executable), 'app-server'], cwd=home, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    events = queue.Queue()
    def read_lines():
        for line in proc.stdout:
            events.put(json.loads(line))
        events.put(None)
    threading.Thread(target=read_lines, daemon=True).start()
    pending = []
    serial = 0
    def send(value):
        proc.stdin.write(json.dumps(value) + '\n')
        proc.stdin.flush()
    def wait_for(predicate, seconds=45):
        deadline = time.monotonic() + seconds
        while True:
            for i, item in enumerate(pending):
                if predicate(item):
                    return pending.pop(i)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('native result unknown; no replay')
            item = events.get(timeout=remaining)
            if item is None:
                raise RuntimeError('native process exited; outcome may be unknown; no replay')
            pending.append(item)
    def call(method, params):
        nonlocal serial
        serial += 1
        request_id = serial
        send({'id': request_id, 'method': method, 'params': params})
        result = wait_for(lambda e: e.get('id') == request_id and 'method' not in e)
        if 'error' in result:
            raise RuntimeError(f'{method} failed: {result["error"]}; no replay')
        return result['result']
    def stats():
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            return json.load(response)['requests']
    try:
        call('initialize', {'clientInfo': {'name': 'herder-native-receipt-test', 'version': '1'},
                            'capabilities': {'experimentalApi': True}})
        send({'method': 'initialized', 'params': {}})
        before = stats()
        receipts = []
        for _ in range(2):
            created = call('thread/start', {'cwd': str(home), 'model': 'herder-test',
                                            'approvalPolicy': 'never', 'sandbox': 'read-only', 'modelProvider': 'fixture_project', 'config': {'profile': 'fixture', 'model_providers.fixture_project.name': 'fixture', 'model_providers.fixture_project.base_url': base, 'model_providers.fixture_project.wire_api': 'responses', 'model_providers.fixture_project.env_key': 'HERDER_FIXTURE_KEY'}})
            assert created['thread'].get('modelProvider') == 'fixture_project', 'native provider selection not confirmed; no send'
            thread_id = created['thread']['id']
            if not thread_id:
                raise RuntimeError('missing native thread receipt; no replay')
            token = 'HERDER_NATIVE_INPUT_' + uuid.uuid4().hex
            started = call('turn/start', {'threadId': thread_id,
                                          'input': [{'type': 'text', 'text': token}],
                                          'model': 'herder-test'})
            turn_id = started.get('turn', {}).get('id')
            if not turn_id:
                raise RuntimeError('missing native turn receipt; outcome unknown; no replay')
            completed = wait_for(lambda e: e.get('method') == 'turn/completed'
                                 and e.get('params', {}).get('threadId') == thread_id
                                 and e.get('params', {}).get('turn', {}).get('id') == turn_id)
            if completed['params']['turn']['status'] != 'completed':
                raise RuntimeError('native turn did not complete: ' + str(completed['params']['turn']))
            receipts.append({'input': token, 'native_thread_id': thread_id, 'native_turn_id': turn_id})
        readbacks = {row['native_thread_id']: call('thread/read', {'threadId': row['native_thread_id'], 'includeTurns': True})['thread'] for row in receipts}
        if not validate_receipts(receipts, readbacks):
            raise RuntimeError('two distinct exact native threads, inputs and answers not proven')
        after = stats()
        if after - before < 2:
            raise RuntimeError('fixture did not observe both model requests')
        print(json.dumps({'scope': 'direct codex app-server; not Herder MCP or E001/E002',
                          'native_version': version, 'native_executable_sha256': digest,
                          'receipts': receipts,
                          'fixture_requests': after - before, 'readback': 'confirmed'}))
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
