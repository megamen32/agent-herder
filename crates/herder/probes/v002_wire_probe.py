#!/usr/bin/env python3
"""V002 raw stdio transcript; only local in-memory fixtures are used."""
import hashlib
import json
import pathlib
import queue
import subprocess
import threading
import time

BINARY = pathlib.Path(__file__).resolve().parents[1] / 'target/debug/v002_probe'
URI = 'skill://probe/SKILL.md'
CAPS = {'extensions': {'io.modelcontextprotocol/tasks': {}}}


def main():
    p = subprocess.Popen([str(BINARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    lines = queue.Queue()
    def reader():
        for line in p.stdout:
            lines.put(json.loads(line))
        lines.put(None)
    threading.Thread(target=reader, daemon=True).start()
    seq = 0
    def call(method, params=None, tasks=True):
        nonlocal seq
        seq += 1
        args = dict(params or {})
        args['_meta'] = {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                         'io.modelcontextprotocol/clientInfo': {'name': 'v002-raw', 'version': '1'},
                         'io.modelcontextprotocol/clientCapabilities': CAPS if tasks else {}}
        req = {'jsonrpc': '2.0', 'id': seq, 'method': method, 'params': args}
        print(json.dumps({'sent': req}), flush=True)
        p.stdin.write(json.dumps(req) + '\n'); p.stdin.flush()
        notes = []
        while True:
            msg = lines.get(timeout=5)
            assert msg is not None, 'server exited before response'
            print(json.dumps({'received': msg}), flush=True)
            if msg.get('id') == seq:
                return msg, notes
            assert 'method' in msg and 'id' not in msg, msg
            notes.append(msg)
    def result(method, params=None, tasks=True):
        msg, notes = call(method, params, tasks)
        assert 'result' in msg, msg
        return msg['result'], notes
    def state(task_id, desired):
        for _ in range(50):
            r, _ = result('tasks/get', {'taskId': task_id})
            if r.get('status') == desired:
                return r
            time.sleep(.01)
        raise AssertionError(f'task did not reach {desired}: {r}')
    try:
        discovery, _ = result('server/discover')
        assert discovery['supportedVersions'] == ['2026-07-28']
        extensions = discovery['capabilities']['extensions']
        assert set(extensions) >= {'io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/skills'}
        assert extensions['io.modelcontextprotocol/skills'] == {}
        before, _ = result('tools/call', {'name': 'probe_count'}, False)
        denied, _ = call('tools/call', {'name': 'probe_task'}, False)
        assert 'error' in denied and 'result' not in denied, denied
        after, _ = result('tools/call', {'name': 'probe_count'}, False)
        assert before['structuredContent']['created'] == after['structuredContent']['created'] == 0
        denied_get, _ = call('tasks/get', {'taskId': 'missing'}, False)
        assert 'error' in denied_get, denied_get
        created, _ = result('tools/call', {'name': 'probe_task'})
        assert created['resultType'] == 'task', created
        tid = created['taskId']
        pending = state(tid, 'input_required')
        assert 'probe-input' in pending['inputRequests'], pending
        ack, _ = result('tasks/update', {'taskId': tid, 'inputResponses': {'probe-input': {'action': 'accept', 'content': {'answer': 'ok'}}}})
        assert ack['resultType'] == 'complete', ack
        completed = state(tid, 'completed')
        assert completed['result']['structuredContent']['response']['content']['answer'] == 'ok', completed
        second, _ = result('tools/call', {'name': 'probe_task'})
        tid2 = second['taskId']
        state(tid2, 'input_required')
        ack, _ = result('tasks/cancel', {'taskId': tid2})
        assert ack['resultType'] == 'complete', ack
        state(tid2, 'cancelled')
        for method in ('tasks/list', 'tasks/result'):
            response, _ = call(method, {'taskId': tid})
            assert response.get('error', {}).get('code') == -32601, response
        skills, _ = result('skills/list')
        get, _ = result('skills/get', {'uri': URI})
        read, _ = result('resources/read', {'uri': URI})
        assert skills['skills'][0] == get['skill']
        content = read['contents'][0]['text']
        assert get['skill']['resources'][0]['digest'] == 'sha256:' + hashlib.sha256(content.encode()).hexdigest()
        directory, _ = call('resources/directory/read', {'uri': 'skill://probe'})
        assert directory.get('error', {}).get('code') == -32601, directory
        listening, notes = result('subscriptions/listen', {'notifications': {'toolsListChanged': True, 'promptsListChanged': True}})
        assert listening['resultType'] == 'complete', listening
        acknotes = [n for n in notes if n['method'] == 'notifications/subscriptions/acknowledged']
        changes = [n for n in notes if n['method'] == 'notifications/tools/list_changed']
        assert len(acknotes) == len(changes) == 1, notes
        assert acknotes[0]['params']['notifications'] == {'toolsListChanged': True}, notes
        assert acknotes[0]['params']['_meta']['io.modelcontextprotocol/subscriptionId'] == listening['_meta']['io.modelcontextprotocol/subscriptionId']
        p.stdin.close(); assert p.wait(timeout=5) == 0
        print(json.dumps({'status': 'PASS', 'scope': 'isolated rmcp stdio probe only'}), flush=True)
    finally:
        if p.poll() is None:
            p.kill(); p.wait(timeout=5)

if __name__ == '__main__':
    main()
