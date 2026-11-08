#!/usr/bin/env python3
"""Two real ChatGPT adapter instances behind one packaged native MCP process.

Uses the ordinary public tools and the existing native consumer helpers. Run
roots are exclusive. Request keys and receipts are retained before cleanup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import ahap_opencode_stand as h


def run(manifest_path, scopes, root):
    manifest = json.loads(manifest_path.read_text())
    for key in ('core', 'node', 'bootstrap'):
        assert hashlib.sha256(Path(manifest[key]).read_bytes()).hexdigest() == manifest['sha256'][key]
    runner = manifest['adapters']['chatgpt']
    assert hashlib.sha256(Path(runner).read_bytes()).hexdigest() == manifest['sha256']['adapters']['chatgpt']
    root.mkdir(mode=0o700)  # never replay an existing run
    state = {'stage': 'candidate', 'manifest': str(manifest_path), 'source': manifest['source_commit'],
             'status': 'PREPARING', 'instances': [], 'checks': {}, 'native_send_attempts': 0}
    def save():
        h.persist_evidence(root/'receipt.json', state)
    profiles = []
    save()
    for index, scope in enumerate(scopes):
        if len(scope) != 64 or any(c not in '0123456789abcdef' for c in scope):
            raise ValueError('verified account scope required')
        account_root = root/str(index)
        account_root.mkdir(mode=0o700)
        home = account_root/'herder-owner-home'
        home.mkdir(mode=0o700)
        seed = h.parse_fresh_seed(subprocess.check_output([manifest['bootstrap'], str(home)], text=True, timeout=30), home)
        work = home/'work'; work.mkdir(mode=0o700)
        profile = {key: seed[key] for key in ('database', 'gate', 'generation')}
        instance = 'chatgpt-profile-' + str(index)
        profile['owner'] = {'kind': 'chatgpt', 'principal': 'qa-multi-browser', 'node': 'qa-controller',
            'instance': instance, 'executable': manifest['node'], 'ahap_script': runner,
            'code_home': str(work), 'cwd': str(work), 'ahap_env': {
                'AHAP_BROWSER_TRANSPORT': 'mac-mini', 'AHAP_BROWSER_ACCOUNT_SCOPE': scope}}
        path = Path(seed['profile_seed']).parent/'profile.json'
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(profile, stream)
        profiles.append(path)
        state['instances'].append({'instance': instance, 'account_scope': scope, 'profile': str(path),
            'status': 'PENDING', 'checks': {}, 'keys': [], 'task_ids': []})
    class MultiRpc(h.RpcProcess):
        def __init__(self):
            argv = [manifest['core']]
            for path in profiles: argv += ['--trusted-owner-profile', str(path)]
            self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1)
            self.next_id = 0; self.buffer = ''
        def request(self, method, params, timeout=300):
            return super().request(method, params, timeout)
    core = None
    try:
        save(); core = MultiRpc(); state['core_pid'] = core.process.pid
        state['tools'] = core.preflight()
        h.validate_v1_public_contract(core.native_tool_catalog)
        discovery = h.rpc_tool(core, 'discover', {'action': 'instances'})
        assert len(discovery['structuredContent']['instances']) == len(scopes)
        state['checks']['single_core_discovery'] = 'PASS'; save()
        # Both adapters are alive; alternate accounts for the first and second turn.
        for turn in range(2):
            for item in state['instances']:
                if item['status'] == 'BLOCKED': continue
                marker = 'HERDER_MULTI_' + uuid.uuid4().hex
                prompt = 'Reply with exactly this token and nothing else: ' + marker
                key = 'qa-multi-' + uuid.uuid4().hex
                item.setdefault('prompts', []).append(prompt); item.setdefault('markers', []).append(marker)
                item['keys'].append(key); item['status'] = 'UNKNOWN'
                state['native_send_attempts'] += 1; save()
                try:
                    args = {'action':'create', 'instance_ref':item['instance'], 'prompt':prompt, 'request_key':key} if turn == 0 else {
                        'action':'session', 'session_ref':item['session_ref'], 'message':prompt, 'mode':'queue', 'request_key':key}
                    reply = h.rpc_tool(core, 'create' if turn == 0 else 'deliver', args)
                    item.setdefault('raw_calls', []).append(reply); save()
                    task_id = reply.get('taskId')
                    if not task_id: raise RuntimeError('missing task receipt; retained, no resend')
                    item['task_ids'].append(task_id); save()
                    task = h.wait_task(core, task_id, timeout=150)
                    item.setdefault('tasks', []).append(task)
                    if turn == 0:
                        item['session_ref'] = task.get('result', {}).get('structuredContent', {}).get('create', {}).get('session_ref')
                    save()
                    receipt = h.task_delivery_receipt(task)
                    if not receipt or receipt.get('outcome') != 'confirmed': raise RuntimeError('native delivery not confirmed')
                    deadline = time.monotonic() + 150
                    while True:
                        read = h.rpc_tool(core, 'session', {'action':'messages', 'session_ref':item['session_ref']})
                        item['readback'] = read; save()
                        rows = h.message_texts(read)
                        if ('user', prompt) in rows and ('assistant', marker) in rows: break
                        if time.monotonic() >= deadline: raise RuntimeError('exact answer missing; no resend')
                        time.sleep(5)
                    item['checks']['turn_'+str(turn)] = 'PASS'; item['status'] = 'READ_CONFIRMED'; save()
                except Exception as error:
                    item['status'] = 'BLOCKED'; item['error'] = str(error)[:1000]; save()
        for item in state['instances']:
            if item['status'] == 'BLOCKED': continue
            exported = h.public_export_readiness(h.rpc_tool(core,'export',{'action':'export','session_ref':item['session_ref'],'format':'native'}), 'native')
            raw = exported.pop('_payload_bytes', None)
            item['export'] = exported
            if raw: (root/(item['instance']+'-transcript.json')).write_bytes(raw)
            item['checks']['export'] = 'PASS' if raw and all(m.encode() in raw for m in item['markers']) and exported['status']=='confirmed' else 'INCOMPLETE'
            item['search'] = h.search_marker_coverage(h.rpc_tool(core,'search',{'action':'search','query':item['markers'][-1]}),item['markers'][-1])
            item['checks']['search'] = 'PASS' if item['search']['status']=='confirmed' else 'INCOMPLETE'
            item['projects'] = h.rpc_tool(core,'discover',{'action':'projects','instance_ref':item['instance']})
            projects = item['projects'].get('structuredContent', {}).get('projects', [])
            item['checks']['projects'] = 'PASS' if projects and all(p.get('project_ref') and p.get('source') in ('native_project_inventory', 'authorized_native_session') for p in projects) else 'INCOMPLETE'
            save()
        core.close(); core = MultiRpc(); core.preflight(); state['restart_pid'] = core.process.pid
        for item in state['instances']:
            if item['status'] == 'BLOCKED' or not item.get('session_ref'): continue
            rows = h.message_texts(h.rpc_tool(core,'session',{'action':'messages','session_ref':item['session_ref']}))
            item['checks']['restart'] = 'PASS' if all(('user',p) in rows and ('assistant',m) in rows for p,m in zip(item['prompts'],item['markers'])) else 'INCOMPLETE'
        state['status'] = 'CHECKED'; save()
    except Exception as error:
        state['status'] = 'INCOMPLETE'; state['error'] = str(error)[:1000]; save()
    finally:
        if core:
            for item in state['instances']:
                if not item.get('session_ref'): continue
                try:
                    item['cleanup'] = h.rpc_tool(core,'session',{'action':'archive','session_ref':item['session_ref'],'request_key':item['instance']+'-archive'})
                    item['checks']['archive'] = 'PASS' if item['cleanup'].get('structuredContent',{}).get('archived') is True else 'INCOMPLETE'
                except Exception as error:
                    item['cleanup_error'] = str(error)[:500]; item['checks']['archive'] = 'INCOMPLETE'
                save()
            core.close()
        state['status'] = 'PASS' if state['status']=='CHECKED' and all(
            item['status']!='BLOCKED' and item['checks'] and all(v=='PASS' for v in item['checks'].values()) for item in state['instances']) else 'INCOMPLETE'
        save()
    return state

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--scope', action='append', required=True)
    parser.add_argument('--run-root', type=Path, required=True)
    args = parser.parse_args()
    result = run(args.manifest, args.scope, args.run_root)
    print(json.dumps({'status':result['status'], 'receipt':str(args.run_root/'receipt.json')}))
    raise SystemExit(0 if result['status']=='PASS' else 1)
