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


def candidate_bundle_identity(release):
    """Verify the same file/link inventory used by the release bundle manifest.

    Dependency symlinks are identified by target, not by hashing the shared
    store bytes; the release builder separately verifies that store.
    """
    release = Path(release)
    manifest_path = release / 'build-manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError('bundle manifest unavailable')
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError('bundle manifest invalid') from error
    source = manifest.get('sourceSha')
    expected = manifest.get('bundleFingerprint')
    count = manifest.get('bundleFiles')
    if not isinstance(source, str) or len(source) != 40 or any(c not in '0123456789abcdef' for c in source):
        raise ValueError('bundle source identity invalid')
    if not isinstance(expected, str) or len(expected) != 64 or type(count) is not int:
        raise ValueError('bundle fingerprint invalid')
    entries = {}
    for path in sorted(release.rglob('*')):
        name = path.relative_to(release).as_posix()
        if name == 'build-manifest.json':
            continue
        if path.is_symlink():
            entries[name] = 'symlink:' + os.readlink(path)
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            entries[name] = digest.hexdigest()
    payload = ''.join(f'{name}\0{entries[name]}\n' for name in sorted(entries)).encode()
    actual = hashlib.sha256(payload).hexdigest()
    if actual != expected or len(entries) != count:
        raise ValueError('bundle fingerprint or file count mismatch')
    return {'source_sha': source, 'bundle_fingerprint': actual, 'bundle_files': len(entries)}


def candidate_store_identity(release):
    """Fingerprint mounted shared dependency stores; link text is not target bytes."""
    release = Path(release).resolve(strict=True)
    modules = release / 'node_modules'
    store_root = (release.parent.parent / 'shared-node-modules').resolve(strict=True)
    if not modules.is_dir() or modules.is_symlink() or not store_root.is_dir():
        raise ValueError('dependency store unavailable')
    links = []
    for item in modules.iterdir():
        if item.is_symlink():
            links.append(item)
        elif item.name.startswith('@') and item.is_dir():
            links.extend(child for child in item.iterdir() if child.is_symlink())
    stores = set()
    for link in links:
        try:
            target = link.resolve(strict=True)
        except OSError as error:
            raise ValueError('dependency link unavailable') from error
        if target.is_relative_to(release):
            continue
        if not target.is_relative_to(store_root):
            raise ValueError('dependency link outside isolated store')
        parts = target.relative_to(store_root).parts
        if len(parts) < 2:
            raise ValueError('dependency store identity invalid')
        stores.add(store_root / parts[0])
    if not stores:
        raise ValueError('dependency stores missing')
    entries = {}
    for store in sorted(stores):
        for path in sorted(store.rglob('*')):
            name = path.relative_to(store_root).as_posix()
            if path.is_symlink():
                entries[name] = 'symlink:' + os.readlink(path)
            elif path.is_file():
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
                entries[name] = digest.hexdigest()
    payload = ''.join(f'{name}\0{entries[name]}\n' for name in sorted(entries)).encode()
    return {'fingerprint': hashlib.sha256(payload).hexdigest(), 'entries': len(entries),
            'store_count': len(stores), 'nested_symlink_targets_hashed': False}


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
    started = time.monotonic()
    candidate = Path(dist) / 'index.js'
    before = hashlib.sha256(candidate.read_bytes()).hexdigest()
    bundle_before = candidate_bundle_identity(Path(dist).parent)
    store_before = candidate_store_identity(Path(dist).parent)
    if Path(dist).parent.name != bundle_before['source_sha']:
        raise ValueError('bundle source does not match release directory')
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
    bundle_after = candidate_bundle_identity(Path(dist).parent)
    store_after = candidate_store_identity(Path(dist).parent)
    if before != after or bundle_before != bundle_after or store_before != store_after:
        raise RuntimeError('candidate bundle changed during test')
    print(json.dumps({'scope': 'isolated-candidate', 'status': 'INCOMPLETE', 'candidate_entry_sha256': before, 'candidate_bundle': bundle_before, 'dependency_store': store_before,
                      'cli_versions': versions, 'seconds': round(time.monotonic()-started, 3),
                      'journeys': verified, 'missing': ['installed-process', 'other-required-environments']}), flush=True)
    return exit_code_for_status('INCOMPLETE')


if __name__ == '__main__': sys.exit(main())
