#!/usr/bin/env python3
"""Exercise an already-started isolated candidate; never attest the installed service."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request

from herder_journey import run_journey
from herder_transcript_http import NoRedirect, read_transcript
from search_proof import attach_search_proof


def http_error_summary(status, body):
    try:
        value = json.loads(body)
        detail = value.get('error', 'no error detail') if isinstance(value, dict) else 'no error detail'
    except (ValueError, UnicodeError):
        detail = 'invalid error response'
    return f'HTTP {status}: {str(detail)[:500]}'


def timeout_summary(stderr):
    if isinstance(stderr, bytes): stderr = stderr.decode(errors='replace')
    return 'search timed out: ' + (stderr or 'no diagnostics')[-1000:].strip()


def exit_code_for_status(status):
    return 0 if status == 'PASS' else 2


def validate_isolation(links, routes4, routes6, project, herder, model):
    if [x.get('ifname') for x in links] != ['lo'] or routes4 or routes6:
        raise ValueError('private loopback-only network required')
    if not str(Path(project).resolve()).startswith('/tmp/herder-native-model-'):
        raise ValueError('disposable fixture project required')
    for origin in (herder, model):
        u = urllib.parse.urlsplit(origin)
        if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.path not in ('', '/') or u.username or u.password or u.query or u.fragment:
            raise ValueError('fixture endpoints must be loopback HTTP origins')


def main():
    if len(sys.argv) != 7:
        raise ValueError('expected candidate dist, project, Herder origin, fixture origin, codex binary, opencode binary')
    dist, project, herder, model, codex, opencode = sys.argv[1:]
    def ip(*args):
        return json.loads(subprocess.check_output(['ip', '-j', *args], text=True, timeout=5))
    validate_isolation(ip('link', 'show'), ip('-4', 'route', 'show'), ip('-6', 'route', 'show'), project, herder, model)
    if not all(Path(x).is_absolute() for x in (dist, project, codex, opencode)):
        raise ValueError('absolute paths required')
    token = os.environ.get('HERDER_CI_TOKEN')
    if not token:
        raise ValueError('fixture MCP token missing')
    candidate = Path(dist) / 'index.js'
    before = hashlib.sha256(candidate.read_bytes()).hexdigest()
    versions = {name: subprocess.check_output([binary, '--version'], text=True, timeout=10).strip()
                for name, binary in (('codex', codex), ('opencode', opencode))}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def api(path, body=None, method=None):
        root = model if path == '/_stats' else herder
        payload = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(root + path, data=payload, method=method,
                                     headers={'Origin': herder, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=10) as response:
                raw = response.read(4_000_001)
        except urllib.error.HTTPError as error:
            raise RuntimeError(http_error_summary(error.code, error.read(4096))) from error
        if len(raw) > 4_000_000:
            raise ValueError('response exceeds fixture limit')
        return json.loads(raw)
    started = time.monotonic()
    journeys = []
    for harness, selected in (('codex', 'herder-test'), ('opencode', 'fixture/herder-test')):
        def transcript(h, sid, marker):
            return read_transcript(herder, socket.gethostname(), h, sid, marker, 'HERDER_TEST_MODEL_OK')
        journeys.append(run_journey(api, transcript, harness, selected, project))
    # This operates only on the fixture candidate's disposable settings store.
    for enabled in (False, True):
        api('/api/settings/background-indexing', {'enabled': enabled}, method='PUT')
    try:
        result = subprocess.run(['node', str(Path(__file__).with_name('herder_search.mjs')), dist, herder,
                                 json.dumps(journeys)], check=True, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(timeout_summary(error.stderr)) from error
    replies = json.loads(result.stdout)
    verified = [attach_search_proof(j, [r for r in replies if r.get('harness') == j['harness']], socket.gethostname()) for j in journeys]
    after = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if before != after:
        raise RuntimeError('candidate entrypoint changed during test')
    print(json.dumps({'scope': 'isolated-candidate', 'status': 'INCOMPLETE', 'candidate_entry_sha256': before,
                      'cli_versions': versions, 'seconds': round(time.monotonic()-started, 3),
                      'journeys': verified, 'missing': ['installed-process', 'other-required-environments']}), flush=True)
    return exit_code_for_status('INCOMPLETE')


if __name__ == '__main__': sys.exit(main())
