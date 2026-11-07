#!/usr/bin/env python3
"""Direct OpenCode CLI canary; always run under the isolated native launcher.

This is not a Herder or release-gate receipt. Unknown sends are never retried.
"""
import hashlib
import base64
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid


def failure_context(result, fixture_requests):
    return (f'OpenCode returned exit={result.returncode}; fixture_requests={fixture_requests}; no replay; '
            f'stdout={result.stdout[-1200:]}; stderr={result.stderr[-1200:]}')


def is_new_session(sid, receipts):
    return isinstance(sid, str) and bool(sid) and all(item['native_session_id'] != sid for item in receipts)


def complete_native_readback(value, marker):
    rows = value.get('data') if isinstance(value, dict) else value
    if not isinstance(rows, list):
        return False
    found_user = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        info = row.get('info') if isinstance(row.get('info'), dict) else {}
        role = row.get('role') or info.get('role') or row.get('type')
        row_id = row.get('id') or info.get('id')
        if not isinstance(row_id, str) or not row_id:
            continue
        contents = json.dumps(row)
        if role == 'user' and marker in contents:
            found_user = True
        if role == 'assistant' and found_user and 'HERDER_TEST_MODEL_OK' in contents:
            timing = row.get('time') or info.get('time') or {}
            finished = timing.get('completed') if isinstance(timing, dict) else None
            finish = row.get('finish') or info.get('finish')
            if isinstance(finished, (int, float)) and not isinstance(finished, bool) and finished > 0 and finish != 'error' and not row.get('error') and not info.get('error'):
                return True
    return False


def summarize_native_messages(value):
    rows = value.get('data') if isinstance(value, dict) else value
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows[-20:]:
        if not isinstance(row, dict): continue
        info = row.get('info') if isinstance(row.get('info'), dict) else {}
        timing = row.get('time') or info.get('time') or {}
        result.append({'id':row.get('id') or info.get('id'), 'role':row.get('role') or info.get('role') or row.get('type'),
                       'completed':timing.get('completed') if isinstance(timing, dict) else None,
                       'finish':row.get('finish') or info.get('finish'), 'error':bool(row.get('error') or info.get('error'))})
    return result


def wait_for_ready(read, alive, timeout=20, sleep=time.sleep):
    deadline = time.monotonic() + timeout
    while True:
        if not alive():
            raise RuntimeError('OpenCode test server exited before readiness')
        try:
            status, _ = read()
            if status == 200:
                return
            if status != 503:
                raise RuntimeError(f'OpenCode readiness HTTP {status}')
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('OpenCode test server not ready')
        sleep(.1)


def readiness_probe(read):
    status, body = read('/api/config')
    if status == 404 or (status == 200 and body is None):
        status, body = read('/api/health')
        if status == 404:
            return 503, None
        if status == 200 and not isinstance(body, dict):
            return 502, None
    return status, body


def v22_fixture_verified(value, base):
    if not isinstance(value, dict) or 'fixture' not in value.get('connected', []):
        return False
    providers = value.get('all')
    if not isinstance(providers, list):
        return False
    matches = [item for item in providers if isinstance(item, dict) and item.get('id') == 'fixture']
    if len(matches) != 1:
        return False
    options, models = matches[0].get('options'), matches[0].get('models')
    return isinstance(options, dict) and options.get('baseURL') == base and isinstance(models, dict) and 'herder-test' in models


def fixture_config(base, provider='fixture'):
    return {'provider': {provider: {'npm': '@ai-sdk/openai-compatible', 'name': 'Fixture',
                                    'options': {'baseURL': base, 'apiKey': 'fixture-only'},
                                    'models': {'herder-test': {'name': 'herder-test'}}}},
            'model': provider + '/herder-test', 'autoupdate': False}


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise ValueError('pass the absolute path to the real OpenCode executable')
    home = Path(os.environ['HOME'])
    base = os.environ['HERDER_TEST_MODEL_BASE_URL']
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/v1' or url.username or url.password or url.query or url.fragment):
        raise ValueError('test model must be the loopback fixture')
    binary = Path(sys.argv[1]).resolve(strict=True)
    version = subprocess.check_output([str(binary), '--version'], cwd=home, text=True, timeout=10).strip()
    project = home / 'fixture-project'
    project.mkdir()
    provider_id = 'fixture'
    (project / 'opencode.json').write_text(json.dumps(fixture_config(base, provider_id)))

    def stats():
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            return json.load(response)['requests']

    before = stats()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    root = f'http://127.0.0.1:{port}'
    server_env = dict(os.environ, OPENCODE_SERVER_PASSWORD='fixture-only')
    proc = subprocess.Popen([str(binary), 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                            cwd=project, env=server_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def request(path, payload=None, timeout=3):
        auth = base64.b64encode(b'opencode:fixture-only').decode()
        req = urllib.request.Request(root + path, data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={'content-type': 'application/json', 'authorization': 'Basic ' + auth})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                try: body = json.load(response)
                except (ValueError, UnicodeError): body = None
                return response.status, body
        except urllib.error.HTTPError as error:
            try: body = json.loads(error.read())
            except (ValueError, UnicodeError): body = None
            return error.code, body

    try:
        wait_for_ready(lambda: readiness_probe(request), lambda: proc.poll() is None)
        config_status, config_body = request('/api/config')
        v22 = config_status == 404 or (config_status == 200 and config_body is None)
        if v22:
            provider_status, provider = request('/provider', timeout=15)
            if provider_status != 200 or not v22_fixture_verified(provider, base):
                raise RuntimeError('fixture provider is not verified; no turn sent')
        else:
            model_status, models = request('/api/model')
            if model_status != 200 or 'herder-test' not in json.dumps(models):
                raise RuntimeError('fixture model is not available; no turn sent')
            credential_status, _ = request('/api/credential', {'integrationID': provider_id,
                'value': {'type': 'key', 'key': 'fixture-only'}, 'activate': True})
            provider_status, provider = request('/api/provider/' + provider_id)
            info = provider.get('data', provider) if isinstance(provider, dict) else {}
            if (credential_status != 200 or provider_status != 200 or info.get('activation') != 'enabled'
                    or not isinstance(info.get('settings'), dict) or info['settings'].get('baseURL') != base):
                raise RuntimeError('fixture provider is not verified; no turn sent')
        receipts = []
        for _ in range(2):
            title = 'fixture-native-' + uuid.uuid4().hex
            creation = {'title':title} if v22 else {'title':title,
                'location':{'directory':str(project)}, 'model':{'providerID':provider_id,'id':'herder-test'}}
            status, created = request('/session' if v22 else '/api/session', creation)
            row = created.get('data', created) if isinstance(created, dict) else {}
            sid = row.get('id')
            if status != 200 or not isinstance(sid, str) or not sid:
                raise RuntimeError('native session creation unknown; no retry')
            if not is_new_session(sid, receipts):
                raise RuntimeError('duplicate native session; no turn sent')
            marker = 'HERDER_OPENCODE_INPUT_' + uuid.uuid4().hex
            print(json.dumps({'event':'native-session-created','session_id':sid,'input':marker}), flush=True)
            try:
                session_path = ('/session/' if v22 else '/api/session/') + urllib.parse.quote(sid, safe='')
                payload = {'model':{'providerID':provider_id,'modelID':'herder-test'},
                           'parts':[{'type':'text','text':marker}]} if v22 else {
                    'text':marker, 'delivery':'queue', 'metadata':{'agentHerderInputId':uuid.uuid4().hex}}
                status, _ = request(session_path + ('/message' if v22 else '/prompt'), payload, timeout=45 if v22 else 3)
            except (OSError, ValueError) as error:
                raise RuntimeError('native admission unknown; no retry') from error
            if status not in (200, 202):
                raise RuntimeError('native turn not confirmed; no retry: HTTP ' + str(status))
            print(json.dumps({'event':'native-input-admitted','session_id':sid,'http_status':status}), flush=True)
            deadline = time.monotonic() + 40
            while True:
                status, messages = request(session_path + ('/message' if v22 else '/message?limit=100&order=asc'))
                content = json.dumps(messages)
                if status == 200 and complete_native_readback(messages, marker):
                    break
                if 'provider.no-route' in content:
                    raise RuntimeError('native provider rejected the turn; no retry')
                if time.monotonic() >= deadline:
                    raise RuntimeError('native turn outcome unknown; no retry: ' + json.dumps({
                        'session_id':sid, 'messages':summarize_native_messages(messages), 'fixture_requests':stats()-before}))
                time.sleep(.25)
            receipts.append({'native_session_id':sid, 'input':marker})
        requests = stats() - before
        if len({item['native_session_id'] for item in receipts}) != 2 or requests < 2:
            raise RuntimeError('distinct sessions or model requests not proven')
        print(json.dumps({'scope':'direct OpenCode API; not Herder or release gate',
            'native_version':version, 'api_family':'provider-session' if v22 else 'api-session',
            'native_executable_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
            'receipts':receipts, 'fixture_requests':requests, 'readback':'confirmed'}))
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()


if __name__ == '__main__':
    main()
