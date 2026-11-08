#!/usr/bin/env python3
"""Read-only preflight for a pinned V1 Codex candidate under launch.py."""
import argparse
import base64
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
            'AHAP_CODEX_CWD': project, 'CODEX_HOME': codex_home,
            **({'AGENT_HERDER_WORKLOAD_ISOLATION': 'off'} if mode == 'bin' else {})}


def prove_owned_child(core_pid, codex, project, codex_home):
    def children(pid):
        path = Path('/proc') / str(pid) / 'task' / str(pid) / 'children'
        return [int(value) for value in path.read_text().split()]
    queue = [(core_pid, 0)]
    found = []
    while queue:
        pid, depth = queue.pop(0)
        if depth >= 4:
            continue
        for child in children(pid):
            queue.append((child, depth + 1))
            try:
                executable = os.readlink('/proc/%d/exe' % child)
            except OSError:
                continue
            if executable == codex:
                found.append(child)
    if len(found) != 1:
        raise ValueError('exact owned Codex child not confirmed')
    pid = found[0]
    environ = dict(item.split(b'=', 1) for item in (Path('/proc') / str(pid) / 'environ').read_bytes().split(b'\0') if b'=' in item)
    if (environ.get(b'HOME') != project.encode() or environ.get(b'CODEX_HOME') != codex_home.encode()
            or b'OPENAI_API_KEY' in environ or b'OPENAI_API_KEY_ORG' in environ):
        raise ValueError('Codex child environment invalid')
    if Path(codex_home, 'auth.json').exists() or Path(project, '.codex/auth.json').exists():
        raise ValueError('fixture auth file present')
    child_ns = os.readlink('/proc/%d/ns/net' % pid)
    if child_ns != os.readlink('/proc/self/ns/net'):
        raise ValueError('Codex child namespace differs')
    return {'core_pid': core_pid, 'child_pid': pid, 'executable': codex,
            'home': project, 'codex_home': codex_home, 'network_namespace': child_ns,
            'same_network_namespace': True, 'openai_api_key_present': False,
            'openai_api_key_org_present': False, 'auth_files_present': False}


def confirmed_receipt(task):
    result = task.get('result') if isinstance(task, dict) else None
    payload = result.get('structuredContent') if isinstance(result, dict) else None
    found = []
    def visit(value):
        if isinstance(value, dict):
            if value.get('outcome') == 'confirmed' and isinstance(value.get('native_receipt_id'), str) and value['native_receipt_id']:
                found.append(value)
            for child in value.values(): visit(child)
        elif isinstance(value, list):
            for child in value: visit(child)
    visit(payload)
    return found[0] if isinstance(task, dict) and task.get('status') == 'completed' and len(found) == 1 else None


def correlated_pairs(rows, markers, receipts):
    if len(markers) != 2 or len(receipts) != 2 or not all(isinstance(r, dict) and r.get('outcome') == 'confirmed' and isinstance(r.get('native_receipt_id'), str) and r['native_receipt_id'] for r in receipts):
        return False
    ids = [r['native_receipt_id'] for r in receipts]
    if ids[0] == ids[1] or markers[0] == markers[1]: return False
    cursor = 0
    for marker, receipt_id in zip(markers, ids):
        user = next((i for i in range(cursor, len(rows)) if rows[i].get('role') == 'user' and rows[i].get('text') == marker and rows[i].get('id') == receipt_id), None)
        if user is None: return False
        assistant = next((i for i in range(user + 1, len(rows)) if rows[i].get('role') == 'assistant' and rows[i].get('text') == 'HERDER_TEST_MODEL_OK' and isinstance(rows[i].get('id'), str) and rows[i]['id']), None)
        if assistant is None or any(rows[i].get('role') == 'user' for i in range(user + 1, assistant)):
            return False
        cursor = assistant + 1
    return True


def export_matches(result, needles):
    payload = result.get('structuredContent') if isinstance(result, dict) and not result.get('isError') else None
    if not isinstance(payload, dict) or payload.get('complete') is not True or not payload.get('source'):
        return False
    try:
        raw = base64.b64decode(payload.get('bytes_base64', ''), validate=True)
    except (ValueError, TypeError): return False
    return bool(raw) and all(isinstance(value, str) and value.encode() in raw for value in needles)


def search_matches(result, marker):
    payload = result.get('structuredContent') if isinstance(result, dict) and not result.get('isError') else None
    if not isinstance(payload, dict) or payload.get('coverage') != 'complete': return False
    hits = payload.get('hits')
    return isinstance(hits, list) and any(marker in json.dumps(hit, ensure_ascii=False) for hit in hits)


def projects_match(result, project):
    payload = result.get('structuredContent') if isinstance(result, dict) and not result.get('isError') else None
    if not isinstance(payload, dict): return False
    projects = payload.get('projects')
    if not isinstance(projects, list): return False
    provenance = payload.get('source', payload.get('provenance', payload.get('scope')))
    complete = payload.get('complete') is True and bool(provenance)
    scoped = (payload.get('complete') is False and payload.get('scope') == 'authorized_registered_sessions'
              and isinstance(payload.get('limitations'), list) and bool(payload['limitations'])
              and all(isinstance(x, str) and x.strip() for x in payload['limitations']))
    return (complete or scoped) and any(isinstance(x, dict) and x.get('project_ref') == project
                                        and x.get('source') == 'authorized_native_session' for x in projects)


def wait_readback(core, session, markers, receipts, timeout=75):
    from ahap_opencode_stand import message_records
    deadline = time.monotonic() + timeout
    while True:
        wire = rpc_tool(core, 'session', {'action': 'messages', 'session_ref': session})
        rows = message_records(wire)
        if len(markers) == 1:
            ok = any(row.get('role') == 'user' and row.get('text') == markers[0] and row.get('id') == receipts[0]['native_receipt_id'] for row in rows) and any(row.get('role') == 'assistant' and row.get('text') == 'HERDER_TEST_MODEL_OK' for row in rows)
        else:
            ok = correlated_pairs(rows, markers, receipts)
        if ok: return wire, rows
        if time.monotonic() >= deadline: raise TimeoutError('public transcript not confirmed; no resend')
        time.sleep(.5)


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
        child_proof = prove_owned_child(core.process.pid, args.codex, str(project), str(codex_home)) if args.transport == 'bin' else None
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            stats = json.load(response)
        if stats['requests'] != 0:
            raise RuntimeError('fixture was used before preflight; refusing mutation')
        print(json.dumps({'result': 'PREFLIGHT_READY', 'tools': tools, 'model_requests': stats['requests'],
                          'native_sends': 0, 'child_proof': child_proof, **identity}, sort_keys=True), flush=True)
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
        first_wire, first_rows = wait_readback(core, session, [marker], [receipt])
        evidence.update(phase='first_readback', first_readback=first_wire)
        persist_evidence(evidence_path, evidence)
        evidence.update(phase='second_submitted', result='UNKNOWN')
        persist_evidence(evidence_path, evidence)
        delivered = rpc_tool(core, 'deliver', {'action': 'session', 'session_ref': session,
                             'message': second, 'mode': 'queue', 'request_key': second_key})
        if not isinstance(delivered, dict) or delivered.get('resultType') != 'task' or not isinstance(delivered.get('taskId'), str) or not delivered['taskId']:
            raise RuntimeError('second deliver outcome unknown: no task receipt; no replay')
        second_id = delivered['taskId']
        evidence.update(phase='second_task', second_task_id=second_id)
        persist_evidence(evidence_path, evidence)
        second_task = wait_task(core, second_id)
        second_receipt = confirmed_receipt(second_task)
        evidence.update(phase='second_result', second_task=second_task)
        persist_evidence(evidence_path, evidence)
        if not second_receipt or second_receipt['native_receipt_id'] == receipt['native_receipt_id']:
            raise RuntimeError('second delivery lacks a distinct confirmed receipt; no replay')
        wire, rows = wait_readback(core, session, [marker, second], [receipt, second_receipt])
        user_rows = [row for row in rows if row.get('role') in ('user', 'assistant')]
        answer_ids = [row.get('id') for row in user_rows if row.get('role') == 'assistant' and row.get('text') == 'HERDER_TEST_MODEL_OK']
        if len(answer_ids) != 2 or len(set(answer_ids)) != 2:
            raise RuntimeError('two distinct assistant responses not confirmed')
        ids = [receipt['native_receipt_id'], second_receipt['native_receipt_id']]
        evidence.update(phase='both_read', second_receipt=second_receipt, public_read=wire,
                        checks={'create':'PASS','second_deliver_same_session':'PASS','read_both':'PASS',
                                'export_native_complete':'UNKNOWN','search_with_coverage':'UNKNOWN',
                                'projects_with_provenance':'UNKNOWN','reopen_without_resend':'UNKNOWN'})
        persist_evidence(evidence_path, evidence)
        export_args = {'action':'export', 'session_ref':session, 'format':'native'}
        exported = rpc_tool(core, 'export', export_args)
        evidence['native_export'] = exported
        persist_evidence(evidence_path, evidence)
        if not export_matches(exported, [marker, second, *ids, *answer_ids]):
            raise RuntimeError('native export lacks complete source or correlated transcript identities')
        evidence['checks']['export_native_complete'] = 'PASS'
        search_args = {'action':'search', 'query':second}
        search = rpc_tool(core, 'search', search_args)
        evidence['search'] = search
        persist_evidence(evidence_path, evidence)
        if not search_matches(search, second):
            raise RuntimeError('search did not prove marker and complete coverage')
        evidence['checks']['search_with_coverage'] = 'PASS'
        projects_args = {'action':'projects', 'instance_ref':instance}
        projects = rpc_tool(core, 'discover', projects_args)
        evidence['projects'] = projects
        persist_evidence(evidence_path, evidence)
        if not projects_match(projects, str(project)):
            raise RuntimeError('project missing or provenance incomplete')
        evidence['checks']['projects_with_provenance'] = 'PASS'
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            before_restart = json.load(response)['requests']
        if before_restart != 2:
            raise RuntimeError('fixture model request count differs from two')
        evidence.update(phase='before_restart', model_requests=before_restart)
        persist_evidence(evidence_path, evidence)
        core.close()
        core = RpcProcess(args.core, profile_path, dict(os.environ))
        probe_native_tools(core)
        after_wire, after_rows = wait_readback(core, session, [marker, second], [receipt, second_receipt])
        after_tasks = [wait_task(core, task_id) for task_id in (created['taskId'], second_id)]
        if any(confirmed_receipt(t) is None for t in after_tasks) or [confirmed_receipt(t)['native_receipt_id'] for t in after_tasks] != ids:
            raise RuntimeError('restart did not preserve exact confirmed receipts')
        export_after = rpc_tool(core, 'export', export_args)
        if not export_matches(export_after, [marker, second, *ids, *answer_ids]):
            raise RuntimeError('restart lost native export evidence')
        before_payload = exported.get('structuredContent', {})
        after_payload = export_after.get('structuredContent', {})
        if before_payload.get('source') != after_payload.get('source') or before_payload.get('bytes_base64') != after_payload.get('bytes_base64'):
            raise RuntimeError('native export bytes or source changed after restart')
        if not search_matches(rpc_tool(core, 'search', search_args), second):
            raise RuntimeError('restart lost search coverage')
        if not projects_match(rpc_tool(core, 'discover', projects_args), str(project)):
            raise RuntimeError('restart lost project provenance')
        with urllib.request.urlopen(base[:-3] + '/_stats', timeout=5) as response:
            after_restart = json.load(response)['requests']
        if after_restart != before_restart:
            raise RuntimeError('restart changed fixture model request count')
        evidence['checks']['reopen_without_resend'] = 'PASS'
        evidence.update(phase='completed', result='PASS', reopen_read=after_wire,
                        requests_before_restart=before_restart, requests_after_restart=after_restart)
        persist_evidence(evidence_path, evidence)
        print(json.dumps({'result':'PASS', 'run_id':run_id, 'checks':evidence['checks'], **identity}, sort_keys=True), flush=True)
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
