#!/usr/bin/env python3
"""Exercise the public V1 MCP over an explicitly scoped live browser instance.

Default is preflight only. --run-case is an explicit two-message test; a retained
receipt is never reused for sends. Browser routing and credentials stay native.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def load_helpers(path):
    spec = importlib.util.spec_from_file_location('v1_existing_consumer', path)
    sys.path.insert(0, str(Path(path).resolve().parent))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(source.read()).hexdigest()


def verify_inputs(config):
    manifest = json.loads(Path(config['manifest']).read_text())
    if digest(config['manifest']) != config['manifest_sha256']:
        raise ValueError('manifest digest mismatch; no browser operation')
    harness = config['harness']
    if harness not in ('chatgpt', 'zai'):
        raise ValueError('browser harness required')
    for name in ('core', 'bootstrap', 'node'):
        if digest(manifest[name]) != manifest['sha256'][name]:
            raise ValueError(name + ' digest mismatch; no browser operation')
    runner = manifest['adapters'][harness]
    if digest(runner) != manifest['sha256']['adapters'][harness]:
        raise ValueError('adapter digest mismatch; no browser operation')
    if type(config.get('page_id')) is not int or config['page_id'] < 1:
        raise ValueError('exact gateway page required')
    scope = config.get('account_scope', '')
    if len(scope) != 64 or any(c not in '0123456789abcdef' for c in scope):
        raise ValueError('exact account scope required')
    if config.get('stage') not in ('candidate', 'installed'):
        raise ValueError('explicit stage required')
    return manifest, runner


def retain_mutation_reply(record, response, save):
    # A definitive admission refusal must not disappear behind a generic
    # missing-task error. Preserve the public reply before interpreting it.
    record.setdefault('mutation_replies', []).append(response)
    save()
    task_id = response.get('taskId')
    if response.get('resultType') != 'task' or not task_id:
        raise RuntimeError('mutation returned no task; inspect saved response before determining outcome')
    return task_id


def run(config, run_case=False):
    manifest, runner = verify_inputs(config)
    helpers = load_helpers(config['consumer_helpers'])
    class BrowserRpc(helpers.RpcProcess):
        # A create composes two bounded 120s AHAP operations. The consumer must
        # not kill the core before its durable receipt can be returned.
        def request(self, method, params, timeout=300):
            return super().request(method, params, timeout=timeout)
    root = Path(config['run_root'])
    if not root.is_absolute() or root.exists():
        raise ValueError('run_root must be fresh; never replay a retained browser attempt')
    root.mkdir(mode=0o700, parents=True)
    protected = root / 'herder-owner-home'
    protected.mkdir(mode=0o700)
    receipt_path = root / 'receipt.json'
    record = {'run_id': config['run_id'], 'stage': config['stage'], 'harness': config['harness'],
              'source_sha': manifest['source_commit'], 'artifact_sha256': config['manifest_sha256'],
              'page_id': config['page_id'], 'account_scope': config['account_scope'],
              'status': 'PREPARING', 'native_sends': 0, 'checks': {}, 'no_replay': True}
    def save():
        helpers.persist_evidence(receipt_path, record)
    core = None
    try:
        save()
        seed = helpers.parse_fresh_seed(subprocess.check_output(
            [manifest['bootstrap'], str(protected)], text=True, timeout=30), protected)
        home = protected / 'work'
        home.mkdir(mode=0o700)
        profile = {key: seed[key] for key in ('database', 'gate', 'generation')}
        profile['owner'] = {'kind': config['harness'], 'principal': 'ci-browser-owner',
            'node': 'ci-controller', 'instance': config['instance'],
            'executable': manifest['node'], 'ahap_script': runner,
            'code_home': str(home), 'cwd': str(home), 'ahap_env': {
                'AHAP_BROWSER_TRANSPORT': 'mac-mini', 'AHAP_BROWSER_PAGE_ID': str(config['page_id']),
                'AHAP_BROWSER_ACCOUNT_SCOPE': config['account_scope']}}
        profile_path = Path(seed['profile_seed']).parent / 'profile.json'
        with os.fdopen(os.open(profile_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(profile, stream)
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'config'),
                   XDG_DATA_HOME=str(home/'data'), XDG_STATE_HOME=str(home/'state'), XDG_CACHE_HOME=str(home/'cache'))
        core = BrowserRpc(manifest['core'], profile_path, env)
        record['native_tools'] = core.preflight()
        helpers.validate_v1_public_contract(core.native_tool_catalog)
        record['status'] = 'PREFLIGHT_READY'
        record['profile'] = str(profile_path)
        save()
        if not run_case:
            return record
        # Caller supplies a verified blank, leased page. The pinned adapter
        # independently checks origin, blank route, draft and account before fill.
        markers = ['HERDER_V1_' + config['harness'].upper() + '_' + uuid.uuid4().hex for _ in range(2)]
        prompts = ['Reply with exactly this token and nothing else: ' + marker for marker in markers]
        keys = ['ci-browser-' + uuid.uuid4().hex for _ in range(2)]
        record.update(status='UNKNOWN', inputs=prompts, markers=markers, request_keys=keys)
        save()
        tasks = []
        session = None
        for index, prompt in enumerate(prompts):
            record['phase'] = 'create' if index == 0 else 'second_deliver'
            record['native_sends'] = index + 1  # attempts, not proof of acceptance
            save()
            call = helpers.rpc_tool(core, 'create' if index == 0 else 'deliver',
                {'action':'create','instance_ref':config['instance'],'prompt':prompt,'request_key':keys[index]}
                if index == 0 else {'action':'session','session_ref':session,'message':prompt,'mode':'queue','request_key':keys[index]})
            task_id = retain_mutation_reply(record, call, save)
            tasks.append(task_id)
            record['task_ids'] = tasks
            save()
            task = helpers.wait_task(core, task_id, timeout=120)
            record.setdefault('task_results', []).append(task)
            save()
            content = task.get('result', {}).get('structuredContent', {})
            if index == 0:
                session = content.get('create', {}).get('session_ref')
                if not session:
                    raise RuntimeError('create receipt omitted session_ref')
                record['session_ref'] = session
            if task.get('status') != 'completed':
                raise RuntimeError('browser task not completed; evidence preserved')
            receipt = helpers.task_delivery_receipt(task)
            record.setdefault('delivery_receipts', []).append(receipt)
            save()
            if not isinstance(receipt, dict) or receipt.get('outcome') != 'confirmed':
                raise RuntimeError('delivery not confirmed; do not replay')
            deadline = time.monotonic() + 150
            while True:
                rows = helpers.message_texts(helpers.rpc_tool(core, 'session', {'action':'messages','session_ref':session}))
                if ('user', prompt) in rows and ('assistant', markers[index]) in rows:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('exact user/assistant readback unavailable; do not resend')
                time.sleep(5)
        if len({r['native_receipt_id'] for r in record['delivery_receipts']}) != 2:
            raise RuntimeError('separate browser inputs lack distinct native receipts')
        record['checks'].update(create='PASS', second_deliver_same_session='PASS', read_both='PASS')
        exported = helpers.public_export_readiness(helpers.rpc_tool(core,'export',
            {'action':'export','session_ref':session,'format':'native'}), 'native')
        raw = exported.pop('_payload_bytes', None)
        record['export'] = exported
        if raw:
            transcript_path = root / 'native-transcript.json'
            transcript_path.write_bytes(raw)
            record['transcript_path'] = str(transcript_path)
        if exported['status'] != 'confirmed' or not raw or not all(m.encode() in raw for m in markers + [r['native_receipt_id'] for r in record['delivery_receipts']]):
            raise RuntimeError('full native export unproven')
        record['checks']['export_native_complete'] = 'PASS'
        search = helpers.search_marker_coverage(helpers.rpc_tool(core,'search',{'action':'search','query':markers[1]}),markers[1])
        record['search'] = search
        if search['status'] != 'confirmed':
            raise RuntimeError('search marker coverage unproven')
        record['checks']['search_with_coverage'] = 'PASS'
        projects = helpers.rpc_tool(core,'discover',{'action':'projects','instance_ref':config['instance']})
        record['projects'] = projects
        if projects.get('isError') or helpers._unsupported_receipt(projects):
            raise RuntimeError('public projects unavailable')
        project_rows = projects.get('structuredContent', {}).get('projects')
        if not isinstance(project_rows, list) or not project_rows or any(
                not isinstance(row, dict) or not row.get('project_ref') or row.get('source') not in
                ('native_project_inventory', 'authorized_native_session') for row in project_rows):
            raise RuntimeError('public projects provenance unproven')
        record['checks']['projects_with_provenance'] = 'PASS'
        core.close()
        core = BrowserRpc(manifest['core'], profile_path, env)
        core.preflight()
        rows = helpers.message_texts(helpers.rpc_tool(core,'session',{'action':'messages','session_ref':session}))
        if not all(('user',p) in rows and ('assistant',m) in rows for p,m in zip(prompts,markers)):
            raise RuntimeError('reopened readback incomplete')
        record['checks']['reopen_without_resend'] = 'PASS'
        record['status'] = 'PASS'
        save()
        return record
    except Exception as error:
        record['status'] = 'UNKNOWN' if record['native_sends'] else 'FAILED_PREMUTATION'
        record['error'] = str(error)[:1200]
        save()
        raise
    finally:
        if core is not None:
            # Preserve the result first, then archive only this run's issued chat.
            # Cleanup failure is distinct from test failure; neither loses evidence.
            if run_case and record.get('session_ref'):
                save()
                try:
                    cleanup = helpers.rpc_tool(core, 'session', {'action':'archive',
                        'session_ref':record['session_ref'], 'request_key':config['run_id']+'-archive'})
                    record['cleanup'] = cleanup
                    record['checks']['archive_test_chat'] = 'PASS' if cleanup.get('structuredContent', cleanup).get('archived') is True else 'INCOMPLETE'
                except Exception as cleanup_error:
                    record['cleanup'] = {'status':'UNKNOWN','error':str(cleanup_error)[:500]}
                    record['checks']['archive_test_chat'] = 'INCOMPLETE'
                if record['status'] == 'PASS' and record['checks']['archive_test_chat'] != 'PASS':
                    record['status'] = 'INCOMPLETE_CLEANUP'
                save()
            core.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--run-case', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(json.loads(Path(args.config).read_text()), args.run_case)))


if __name__ == '__main__':
    main()
