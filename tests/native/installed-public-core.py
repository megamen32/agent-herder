#!/usr/bin/python3 -I
"""Private IPC facade over the maintained PublicRust consumer, no new MCP wire client."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import urllib.request
import urllib.error


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('private_fixture_required')
        raw = stream.read(1048577)
    if len(raw) > 1048576: raise ValueError('fixture_too_large')
    return json.loads(raw)


def main():
    if len(sys.argv) != 2: raise ValueError('fixed_fixture_required')
    config = private_json(Path(sys.argv[1]))['public_core']
    source = Path(config['consumer_path'])
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != config['consumer_sha256']:
        raise ValueError('maintained_consumer_digest_mismatch')
    if (config['auth_source_path'] != str(Path.home()/'.codex/config.toml')
            or config['auth_block'] != 'gptadmin'):
        raise ValueError('existing_authorized_auth_source_required')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('maintained_public_rust_consumer', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if config['expected_endpoint'] != module.PUBLIC:
        raise ValueError('public_endpoint_binding_mismatch')
    opener = urllib.request.build_opener(module.NoRedirect())
    last = {}
    def record_body(raw):
        try: last['receipt'] = json.loads(raw)
        except (ValueError, UnicodeError):
            # SSE/error bodies remain original private evidence, not just a
            # byte count. Headers and credentials are never recorded here.
            last['receipt'] = {'response_body': raw.decode('utf-8', errors='replace')}
    class RecordedResponse:
        def __init__(self, response): self.response = response; self.headers = response.headers
        def __enter__(self): return self
        def __exit__(self, *args): self.response.close()
        def read(self, maximum):
            raw = self.response.read(maximum)
            record_body(raw)
            return raw
    def transport(request, timeout=15):
        if request.full_url != module.PUBLIC:
            raise ValueError('public_endpoint_changed')
        try: return RecordedResponse(opener.open(request, timeout=timeout))
        except urllib.error.HTTPError as error:
            record_body(error.read(1048577))
            raise
    client = module.PublicRust(transport)
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        if len(line) > 1048576: raise ValueError('bounded_request_required')
        message = json.loads(line)
        request_id = message['id']
        method, params = message['method'], message['params']
        if method not in ('tools/call', 'tasks/get', 'tasks/result'):
            raise ValueError('unsupported_private_operation')
        if method == 'tools/call' and params.get('name') not in ('discover', 'create', 'deliver', 'sessions', 'session', 'stop'):
            raise ValueError('unsupported_public_tool')
        last.clear()
        try:
            result = client.rpc(method, params)
            response = {'id': request_id, 'result': result}
        except Exception:
            response = {'id': request_id, 'error': {'code': 'public_core_operation_unknown',
                                                   **({'receipt': last['receipt']} if 'receipt' in last else {})}}
        print(json.dumps(response, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    try: main()
    except Exception:
        print(json.dumps({'error': {'code': 'public_core_preflight_failed'}}), flush=True)
        raise SystemExit(2)

