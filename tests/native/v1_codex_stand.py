#!/usr/bin/env python3
"""Read-only preflight for a pinned V1 Codex candidate under launch.py."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

from ahap_opencode_stand import (RpcProcess, parse_fresh_seed, probe_native_tools,
                                   rpc_tool, wait_task, message_texts, persist_evidence)


def _digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def validate_inputs(args):
    """Authenticate manifest and exact artifacts before launching any process."""
    def sha(value, label):
        if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
            raise ValueError(label + ': expected lowercase SHA-256')
        return value
    def path(value, label, executable=False):
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError(label + ': expected absolute file')
        p = Path(value)
        try:
            if not p.is_file() or (executable and not os.access(p, os.X_OK)):
                raise ValueError(label + ': required file unavailable or not executable')
            return p.resolve(strict=True)
        except OSError:
            raise ValueError(label + ': required file unavailable') from None
    manifest_path = path(args.manifest, 'manifest')
    expected_manifest = sha(args.manifest_sha256, 'manifest')
    try:
        with manifest_path.open('rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected_manifest:
            raise ValueError('manifest: SHA-256 mismatch or too large')
        manifest = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError('manifest: invalid or unreadable JSON') from None
    if not isinstance(manifest, dict):
        raise ValueError('manifest: expected object')
    source = manifest.get('source_commit')
    if not isinstance(source, str) or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', source):
        raise ValueError('manifest: invalid source_commit')
    if 'source_sha' in manifest and manifest['source_sha'] != source:
        raise ValueError('manifest: source identity mismatch')
    hashes = manifest.get('sha256')
    adapters = manifest.get('adapters')
    if not isinstance(hashes, dict) or not isinstance(adapters, dict) or not isinstance(hashes.get('adapters'), dict):
        raise ValueError('manifest: artifact identities missing')
    for name in ('core', 'bootstrap', 'node', 'adapter'):
        recorded = adapters.get('codex') if name == 'adapter' else manifest.get(name)
        expected = hashes['adapters'].get('codex') if name == 'adapter' else hashes.get(name)
        actual_path = path(getattr(args, name), name, executable=name != 'adapter')
        manifest_artifact = path(recorded, 'manifest.' + name)
        if actual_path != manifest_artifact:
            raise ValueError(name + ': path differs from manifest')
        try:
            actual_hash = _digest(actual_path)
        except OSError:
            raise ValueError(name + ': cannot read artifact') from None
        if actual_hash != sha(expected, 'manifest.' + name):
            raise ValueError(name + ': SHA-256 mismatch')
    codex = path(args.codex, 'codex', executable=True)
    try:
        native_hash = _digest(codex)
    except OSError:
        raise ValueError('codex: cannot read native executable') from None
    if native_hash != sha(args.codex_sha256, 'codex'):
        raise ValueError('codex: SHA-256 mismatch')
    return {'source_sha': source, 'manifest_sha256': expected_manifest, 'codex_sha256': native_hash}


def classify_create(task):
    if not isinstance(task, dict) or task.get('status') != 'completed':
        return 'UNKNOWN'
    result = task.get('result')
    content = result.get('structuredContent') if isinstance(result, dict) else None
    if not isinstance(content, dict):
        return 'UNKNOWN'
    if (content.get('code') == 'create_not_sent'
            and content.get('create') == {'effect': 'none'}
            and content.get('prompt') == {'effect': 'none'}):
        return 'NOT_SENT'
    return 'UNKNOWN'


def fixture_config(base):
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/v1' or url.query or url.fragment or url.username or url.password):
        raise ValueError('isolated fixture endpoint required')
    return ('model = "herder-test"\nmodel_provider = "fixture"\n'
            '[model_providers.fixture]\nname = "fixture"\n'
            f'base_url = "{base}"\nwire_api = "responses"\n'
            'requires_openai_auth = false\n')


def adapter_transport(mode, codex, socket, project, codex_home):
    if mode not in ('bin', 'socket'):
        raise ValueError('unsupported Codex transport')
    return {('AHAP_CODEX_BIN' if mode == 'bin' else 'AHAP_CODEX_SOCKET'):
            codex if mode == 'bin' else socket,
            'AHAP_CODEX_CWD': project, 'CODEX_HOME': codex_home}


def main():
    parser = argparse.ArgumentParser()
    for key in ('core', 'bootstrap', 'node', 'adapter', 'codex', 'manifest', 'manifest-sha256', 'codex-sha256'):
        parser.add_argument('--' + key, required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--transport', choices=('bin', 'socket'), default='bin')
    args = parser.parse_args()
    identity = validate_inputs(args)
    base = os.environ.get('HERDER_TEST_MODEL_BASE_URL', '')
    url = urllib.parse.urlsplit(base)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/v1' or url.query or url.fragment or url.username or url.password:
        raise ValueError('isolated fixture endpoint required')
    own = os.stat('/proc/self/ns/net')
    if f'{own.st_dev}:{own.st_ino}' == os.environ.get('HERDER_FIXTURE_PARENT_NET', '') or not os.environ.get('HERDER_FIXTURE_PARENT_NET'):
        raise ValueError('isolated launcher namespace required')
    run_id = 'codex-v1-' + uuid.uuid4().hex
    instance = 'codex-fixture-' + uuid.uuid4().hex
    marker = 'CODEX_V1_FIRST_' + uuid.uuid4().hex
    second = 'CODEX_V1_SECOND_' + uuid.uuid4().hex
    key = 'codex-v1-first-' + uuid.uuid4().hex
    second_key = 'codex-v1-second-' + uuid.uuid4().hex
    protected = Path('/herder-owner-home')
    project = protected / 'work'; project.mkdir(mode=0o700)
    codex_home = protected / 'codex'; codex_home.mkdir(mode=0o700)
    (codex_home / 'config.toml').write_text(fixture_config(base))
    socket = protected / 'codex.sock'
    native = None
    if args.transport == 'socket':
        native_env = dict(os.environ, HOME=str(project), CODEX_HOME=str(codex_home))
        native = subprocess.Popen([args.codex, 'app-server', '--listen', 'unix://' + str(socket)],
                                  cwd=project, env=native_env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while not socket.exists() and native.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        if not socket.exists():
            if native.poll() is None:
                native.terminate()
            raise RuntimeError('isolated Codex socket did not become ready')
    seed_process = subprocess.run([args.bootstrap, str(protected)], capture_output=True, text=True, timeout=30)
    if seed_process.returncode:
        raise RuntimeError('fixture bootstrap failed')
    seed = parse_fresh_seed(seed_process.stdout, protected)
    profile_path = Path(seed['profile_seed']).parent / 'profile.json'
    profile = {'database': seed['database'], 'gate': seed['gate'], 'generation': seed['generation'],
               'owner': {'kind': 'codex', 'principal': 'isolated-codex-owner', 'node': 'isolated-native-node',
                         'instance': instance, 'executable': args.node, 'ahap_script': args.adapter,
                         'code_home': str(project), 'cwd': str(project),
                         'ahap_env': adapter_transport(args.transport, args.codex, str(socket), str(project), str(codex_home))}}
    fd = os.open(profile_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(profile, stream)
    core = RpcProcess(args.core, profile_path, dict(os.environ))
    try:
        tools = probe_native_tools(core)
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            stats = json.load(response)
        if stats['requests'] != 0:
            raise RuntimeError('fixture was used before preflight; refusing mutation')
        print(json.dumps({'result': 'PREFLIGHT_READY', 'tools': tools, 'model_requests': stats['requests'],
                          'native_sends': 0, **identity}, sort_keys=True), flush=True)
        if not args.execute:
            return 0
        evidence_path = protected / 'v1-codex-evidence.json'
        if evidence_path.exists():
            raise RuntimeError('prior receipt exists; refusing replay')
        evidence = {'result': 'PREMUTATION_READY', 'phase': 'preflight', 'no_replay': True,
                    'run_id': run_id, 'instance': instance, 'first_input': marker,
                    'first_key': key, 'second_input': second, 'second_key': second_key, **identity}
        persist_evidence(evidence_path, evidence)
        evidence.update(phase='create_submitted', result='UNKNOWN')
        persist_evidence(evidence_path, evidence)
        created = rpc_tool(core, 'create', {'action': 'create', 'instance_ref': instance,
                          'prompt': marker, 'request_key': key})
        if created.get('resultType') != 'task' or not created.get('taskId'):
            raise RuntimeError('create outcome unknown: no task receipt; no replay')
        evidence.update(phase='create_task', task_id=created['taskId'])
        persist_evidence(evidence_path, evidence)
        task = wait_task(core, created['taskId'])
        content = task.get('result', {}).get('structuredContent', {})
        session = content.get('create', {}).get('session_ref')
        receipt = content.get('prompt', {})
        evidence.update(phase='create_result', task_status=task.get('status'), session_ref=session,
                        first_receipt=receipt, task_result=content)
        if classify_create(task) == 'NOT_SENT':
            evidence['result'] = 'BLOCKED_NOT_SENT'
        persist_evidence(evidence_path, evidence)
        if task.get('status') != 'completed' or not session or receipt.get('outcome') != 'confirmed' or not receipt.get('native_receipt_id'):
            raise RuntimeError('create not confirmed; no replay')
        deadline = time.monotonic() + 75
        while True:
            view = rpc_tool(core, 'session', {'action': 'messages', 'session_ref': session})
            messages = message_texts(view)
            if ('user', marker) in messages and ('assistant', 'HERDER_TEST_MODEL_OK') in messages:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError('first answer not confirmed; no replay')
            time.sleep(0.5)
        evidence.update(phase='first_readback', first_messages=messages)
        persist_evidence(evidence_path, evidence)
        evidence.update(phase='second_submitted', second_input=second, second_key=second_key)
        persist_evidence(evidence_path, evidence)
        delivered = rpc_tool(core, 'deliver', {'action': 'session', 'session_ref': session,
                             'message': second, 'mode': 'queue', 'request_key': second_key})
        evidence.update(phase='second_response', second_response=delivered)
        persist_evidence(evidence_path, evidence)
        print(json.dumps({'result': 'SECOND_RESPONSE', 'evidence': evidence}, sort_keys=True), flush=True)
        # Further acceptance requires exact confirmed receipt and all named checks.
        raise RuntimeError('second delivery requires receipt reconciliation; no replay')
    finally:
        core.close()
        if native is not None and native.poll() is None:
            native.terminate()
            try:
                native.wait(timeout=5)
            except subprocess.TimeoutExpired:
                native.kill(); native.wait()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('V1 Codex stand failed: ' + str(error)[:800], file=sys.stderr)
        sys.exit(2)
