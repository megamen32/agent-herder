#!/usr/bin/env python3
"""Fail-closed preflight for the V1 ZCode public MCP lane.

Run only via launch.py; no create or send is performed by this preflight.
"""
import argparse
import base64
import re
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import time
import uuid
import urllib.request
import urllib.parse
from pathlib import Path
import subprocess
import sys

from ahap_opencode_stand import RpcProcess, parse_fresh_seed, persist_evidence, validate_stand_isolation, rpc_tool, wait_task, message_texts




def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_manifest(path, expected_sha):
    path = Path(path)
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha) or digest(path) != expected_sha:
        raise ValueError('unexpected candidate manifest digest')
    data = json.loads(path.read_text())
    root = Path(data['artifact_root']).resolve(strict=True)
    for key in ('core', 'bootstrap', 'node', 'zcode'):
        value = data['adapters']['zcode'] if key == 'zcode' else data[key]
        expected = data['sha256']['adapters']['zcode'] if key == 'zcode' else data['sha256'][key]
        target = Path(value).resolve(strict=True)
        if not target.is_relative_to(root) or not target.is_file() or digest(target) != expected:
            raise ValueError('candidate artifact mismatch: ' + key)
    return data


def prepare_official_fixture(home, official_entry, model_url):
    url = urllib.parse.urlsplit(model_url)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/v1' or url.query or url.fragment or url.username or url.password):
        raise ValueError('fixture model must be isolated loopback HTTP')
    home = Path(home)
    folder = home / 'official-runtime'
    folder.mkdir(mode=0o700)
    entry = folder / 'zcode.cjs'
    shutil.copyfile(official_entry, entry)
    if digest(entry) != digest(official_entry):
        raise ValueError('official entry copy mismatch')
    provider = folder / 'provider'
    provider.mkdir(mode=0o700)
    builtin = {'schemaVersion': 1, 'revision': 1, 'config': {
        'providerConfigRules': {'templateRules': [], 'providerRules': []},
        'modelConfigRules': {'modelRules': [], 'modelApiRules': [], 'providerSiteRules': [],
                             'templateModelRules': [], 'builtinProviderModelRules': []}}}
    model = {'enabled': True, 'properties': {
        'requiresMfjsToolSchema': False, 'contextWindow': 32000,
        'inputFormat': {'supportsText': True, 'supportsImage': False, 'supportsVideo': False,
                        'supportsAudio': False, 'supportsPdf': False},
        'outputFormat': {'supportsText': True}, 'supportsToolCall': True,
        'supportsJsonSchemaOutput': False, 'supportsNativeWebSearch': False,
        'supportsMidConversationSystem': True},
        'optionSpecs': {'reasoningLevel': {'values': ['disabled'], 'map': '{}'},
                        'maxOutputTokens': {'max': 1024, 'map': '{}'}}}
    personal = {'schemaVersion': 1, 'config': {'providerOrder': ['fixture'],
        'providerConfigRules': {'providerRules': [{'providerId': 'fixture', 'providerName': 'fixture',
            'config': {'group': 'standard-personal', 'access': {'type': 'api-key', 'apiKey': 'fixture'},
                       'api': {'type': 'openai-responses', 'baseUrl': model_url},
                       'personalModelIds': ['herder-test'], 'modelOrder': ['herder-test']}}]},
        'modelConfigRules': {'providerModelRules': [{'providerId': 'fixture', 'modelId': 'herder-test',
                                                     'config': model}], 'manualProviderModelRules': []}}}
    (provider / 'zcode-builtin.json').write_text(json.dumps(builtin))
    config = home / '.zcode/v2'
    config.mkdir(mode=0o700, parents=True)
    (config / 'provider_config.json').write_text(json.dumps(personal))
    return entry


def require_exact_project(tree, root):
    projects = tree.get('projects') if isinstance(tree, dict) else None
    if not isinstance(projects, list):
        raise ValueError('official project tree is invalid')
    matches = [item for item in projects if isinstance(item, dict) and
               any(isinstance(r, dict) and r.get('rootPath') == root
                   for r in item.get('roots', []) if isinstance(item.get('roots'), list))]
    if len(matches) != 1 or not isinstance(matches[0].get('id'), str) or not matches[0]['id']:
        raise ValueError('official project tree must contain exactly one matching root')
    return matches[0]['id']


# Existing Herder protocol client used by the retained official ZCode probe.

OFFICIAL_PROJECT_JS = r"""
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [dist, root] = process.argv.slice(1);
const {ZcodeAppServerClient} = await import(pathToFileURL(join(dist, 'adapters/zcode-protocol.js')));
const {connectZcodeOfficialWebSocket} = await import(pathToFileURL(join(dist, 'adapters/zcode-server-control.js')));
const client = new ZcodeAppServerClient({command:'unused', connectWebSocket:connectZcodeOfficialWebSocket});
try {
  await client.start();
  const before = await client.call('project', 'readTree', []);
  if (!Array.isArray(before.projects)) throw Error('invalid native project tree');
  const matches = before.projects.filter(item => item.roots?.some(r => r.rootPath === root));
  if (matches.length !== 0) throw Error('fresh fixture project root already registered');
  const saved = await client.call('project', 'saveProject', [{name:'Herder CI', roots:[root], primaryRoot:root}]);
  const after = await client.call('project', 'readTree', []);
  process.stdout.write(JSON.stringify({before, saved, after}) + '\n');
} finally { await client.close(); }
"""


def setup_official_project(node, home, project, protected, client_dist):
    evidence_path = protected / 'zcode-v1-project-setup.json'
    record = {'phase':'before_project_save', 'project_root':str(project),
              'result':'UNKNOWN', 'no_replay':True}
    persist_evidence(evidence_path, record)
    env = dict(os.environ, HOME=str(home))
    try:
        result = subprocess.run([str(node), '--input-type=module', '-e', OFFICIAL_PROJECT_JS,
                                 str(client_dist), str(project)], env=env, cwd=project,
                                text=True, capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise RuntimeError('official project setup failed: ' + result.stderr[-1200:])
        output = json.loads(result.stdout)
        project_id = require_exact_project(output['after'], str(project))
        record.update(phase='project_verified', result='CONFIRMED', project_id=project_id,
                      native_project_tree=output['after'])
        persist_evidence(evidence_path, record)
        return record
    except Exception as exc:
        record['error'] = str(exc)[:1500]
        persist_evidence(evidence_path, record)
        raise


def run(args):
    manifest = validate_manifest(args.manifest, args.manifest_sha256)
    runtime = Path(args.runtime).resolve(strict=True)
    node, entry = runtime / 'node', runtime / 'zcode.cjs'
    if not all(p.is_file() for p in (node, entry, runtime / 'server-cli.js', runtime / 'server-core.js')):
        raise ValueError('official ZCode runtime is incomplete')
    base = os.environ.get('HERDER_TEST_MODEL_BASE_URL', '')
    if not base.startswith('http://127.0.0.1:') or not base.endswith('/v1'):
        raise ValueError('isolated fixture model is required')
    protected = Path('/herder-owner-home')
    if not protected.is_dir() or protected.stat().st_mode & 0o077:
        raise ValueError('protected fixture home missing')
    instance = 'zcode-ci-' + uuid.uuid4().hex
    persist_evidence(protected / 'zcode-v1-run-identity.json', {'instance':instance, 'manifest_sha256':args.manifest_sha256, 'phase':'before_project_setup', 'network':'loopback_only'})
    project = protected / 'work'
    project.mkdir(mode=0o700)
    links = json.loads(subprocess.check_output(['ip', '-j', 'link', 'show']))
    route4 = json.loads(subprocess.check_output(['ip', '-j', '-4', 'route', 'show']))
    route6 = json.loads(subprocess.check_output(['ip', '-j', '-6', 'route', 'show']))
    validate_stand_isolation(links, route4, route6, str(project), base[:-3], base[:-3])
    home = protected / 'supervisor'
    home.mkdir(mode=0o700)
    copied_entry = prepare_official_fixture(home, entry, base)
    server_root = home / '.zcode/server'
    server_root.mkdir(mode=0o700, parents=True)
    server_env = dict(os.environ, HOME=str(home), ZCODE_DATA_BASE_DIR=str(home),
        ZCODE_SERVER_ROOT=str(server_root), ZCODE_SERVER_SKIP_SERVICE_REGISTRATION='1',
        ZCODE_SERVER_RUNTIME_ROOT=str(runtime),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=str(copied_entry.parent / 'provider/zcode-builtin.json'),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=str(home / '.zcode/v2/provider_config.json'),
        ZCODE_AGENT_SERVER_COMMAND=str(node),
        ZCODE_AGENT_SERVER_ARGS_JSON=json.dumps([str(copied_entry), 'app-server', '--stdio']))
    log = (protected / 'zcode-supervisor.log').open('w')
    server = subprocess.Popen([str(node), str(runtime / 'server-cli.js'), 'serve',
        '--server-root', str(server_root), '--json'], cwd=project, env=server_env,
        stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f'official supervisor exited {server.returncode}')
            try:
                status = json.loads((server_root / 'run/status.json').read_text())
                if status.get('state') == 'ready' and (server_root / 'run/control.sock').is_socket():
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('official supervisor readiness timeout')
        project_receipt = setup_official_project(node, home, project, protected, Path(args.client_dist))
        run_public(args, manifest, protected, project, home, runtime, server_root, project_receipt, instance)
    finally:
        try:
            os.killpg(server.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            server.wait()
        log.close()


def run_public(args, manifest, protected, project, home, runtime, server_root, project_receipt, instance):
    node, entry = runtime / 'node', runtime / 'zcode.cjs'
    bootstrap = subprocess.run([manifest['bootstrap'], str(protected)], capture_output=True, text=True, check=True, timeout=30)
    seed = parse_fresh_seed(bootstrap.stdout, protected)
    profile = Path(seed['profile_seed']).parent / 'zcode-profile.json'
    value = {'database': seed['database'], 'gate': seed['gate'], 'generation': seed['generation'],
             'owner': {'kind':'zcode', 'principal':'isolated-zcode-owner', 'node':'isolated-native-node',
                       'instance':instance, 'executable':manifest['node'],
                       'ahap_script':manifest['adapters']['zcode'], 'code_home':str(home), 'cwd':str(project),
                       'ahap_env':{'AHAP_ZCODE_TRANSPORT':'official-server', 'AHAP_ZCODE_CWD':str(project)}}}
    fd = os.open(profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    client = RpcProcess(manifest['core'], profile, dict(os.environ))
    try:
        tools = client.preflight()
        models = rpc_tool(client, 'discover', {'action':'models', 'instance_ref':instance})
        projects = rpc_tool(client, 'discover', {'action':'projects', 'instance_ref':instance})
        persist_evidence(protected / 'zcode-v1-receipt.json', {'phase':'read_only', 'models':models,
                            'projects':projects, 'session_mutations':0, 'project_saves':1, 'manifest_sha256':args.manifest_sha256})
        print(json.dumps({'models':models, 'projects':projects}, ensure_ascii=False), flush=True)
        if args.run_case:
            require_exact_project(project_receipt['native_project_tree'], str(project))
            exercise(client, protected, seed, tools, instance, home, args.manifest_sha256, manifest['core'], profile)
            return

    finally:
        client.close()
    result = {'status':'PREFLIGHT_ONLY', 'manifest_sha256':args.manifest_sha256,
              'runtime_node_sha256':digest(node), 'runtime_entry_sha256':digest(entry),
              'mcp_tools':tools, 'session_mutations':0, 'project_saves':1, 'model_requests':'not measured',
              'project_receipt':project_receipt,
              'project_id':project_receipt['project_id'], 'project_root':str(project),
              'limitation':'Only initialization was tested.'}
    print(json.dumps(result, sort_keys=True), flush=True)
    return result


def classify_create_task(task):
    content = task.get('result', {}).get('structuredContent', {})
    create, prompt = content.get('create', {}), content.get('prompt', {})
    return {'session_ref':create.get('session_ref') if create.get('effect') == 'confirmed' else None,
            'prompt_effect':prompt.get('effect') or prompt.get('outcome'),
            'retry':prompt.get('retry')}


def read_promoted_input(database, native_id, source_id):
    if not Path(database).is_file():
        return None
    with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        row = conn.execute('select id,status,promoted_message_id from session_input where session_id=? and id=?',
                           (native_id, 'queue_' + source_id)).fetchone()
    if not row:
        return None
    return {'input_id':row[0], 'status':row[1], 'message_id':row[2]}


def read_terminal_assistant(database, native_id, input_message_id):
    if not input_message_id or not Path(database).is_file():
        return None
    with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        rows = conn.execute('select id,data from message where session_id=? order by sequence', (native_id,)).fetchall()
    for message_id, raw in rows:
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if (value.get('role') == 'assistant' and value.get('parentID') == input_message_id
                and isinstance(value.get('time'), dict) and value['time'].get('completed')):
            return {'message_id':message_id, 'parent_id':input_message_id,
                    'error':value.get('error'), 'completed_at':value['time']['completed']}
    return None


def reconcile_unknown(seed, home, session_ref):
    with sqlite3.connect(Path(seed['database']).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        binding = conn.execute('select native_session_id from session_bindings where session_ref=?', (session_ref,)).fetchone()
        intents = conn.execute("select request_key,state,native_receipt from intents where target=? and request_key like 'create-prompt:%'", (session_ref,)).fetchall()
    if not binding or len(intents) != 1:
        return {'status':'unresolved', 'reason':'exact binding or prompt intent absent or ambiguous'}
    key, state, receipt = intents[0]
    source_id = 'agent-herder:auto:' + key
    native_db = home / '.zcode/cli/db/db.sqlite'
    admission = read_promoted_input(native_db, binding[0], source_id)
    assistant = read_terminal_assistant(native_db, binding[0], admission.get('message_id') if admission else None)
    return {'status':'native_input_observed' if admission else 'unresolved', 'native_session_id':binding[0],
            'prompt_intent_key':key, 'authority_state':state, 'authority_receipt':receipt,
            'source_command_id':source_id, 'native_input':admission, 'native_assistant':assistant, 'no_replay':True}


def exercise(client, protected, seed, tools, instance, home, manifest_sha256, core, profile):
    evidence_path = protected / 'zcode-v1-receipt.json'
    model_origin = os.environ['HERDER_TEST_MODEL_BASE_URL'][:-3]
    def stats():
        with urllib.request.urlopen(model_origin + '/_stats', timeout=3) as response:
            return json.load(response)
    tag = uuid.uuid4().hex
    marker = 'HERDER_ZCODE_FIRST_' + tag
    request_key = 'zcode-v1-create-' + tag
    evidence = {'phase':'before_create', 'result':'UNKNOWN', 'mutation_started': True,
                'first_marker':marker, 'create_key':request_key, 'instance':instance,
                'model_before':stats(), 'manifest_sha256':manifest_sha256, 'tools':tools}
    persist_evidence(evidence_path, evidence)
    try:
        created = rpc_tool(client, 'create', {'action':'create', 'instance_ref':instance,
                           'prompt':marker, 'request_key':request_key})
        evidence.update(phase='create_response', create_response=created)
        persist_evidence(evidence_path, evidence)
        if created.get('resultType') != 'task' or not created.get('taskId'):
            raise RuntimeError('create did not return a task; inspect receipt, do not replay')
        task_id = created['taskId']
        evidence.update(phase='create_task_pending', create_task_id=task_id)
        persist_evidence(evidence_path, evidence)
        task = wait_task(client, task_id)
        evidence.update(phase='create_task_terminal', create_task=task, model_after=stats())
        persist_evidence(evidence_path, evidence)
        content = task.get('result', {}).get('structuredContent', {})
        classification = classify_create_task(task)
        session = classification['session_ref']
        prompt = content.get('prompt', {})
        evidence.update(session_ref=session, prompt_classification=classification)
        persist_evidence(evidence_path, evidence)
        if task.get('status') != 'completed' or not session or classification['prompt_effect'] != 'confirmed':
            if session and classification['prompt_effect'] == 'unknown':
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    reconciliation = reconcile_unknown(seed, home, session)
                    evidence.update(phase='unknown_read_reconciliation', reconciliation=reconciliation,
                                    model_after=stats())
                    persist_evidence(evidence_path, evidence)
                    if reconciliation.get('native_assistant'):
                        break
                    time.sleep(.25)
            raise RuntimeError('create or initial delivery unconfirmed; inspect exact receipt, do not replay')
        evidence.update(phase='create_confirmed', session_ref=session, prompt_receipt=prompt)
        persist_evidence(evidence_path, evidence)
        deadline = time.monotonic()+45
        while time.monotonic() < deadline:
            messages = rpc_tool(client, 'session', {'action':'messages', 'session_ref':session})
            if ('user', marker) in message_texts(messages) and ('assistant', 'HERDER_TEST_MODEL_OK') in message_texts(messages):
                break
            time.sleep(.5)
        else:
            evidence.update(phase='initial_read_unconfirmed', messages=messages, model_after=stats())
            persist_evidence(evidence_path, evidence)
            raise RuntimeError('initial assistant response not confirmed; do not resend')
        evidence.update(phase='initial_read_confirmed', messages=messages, model_after=stats(), result='PARTIAL')
        persist_evidence(evidence_path, evidence)
        second_marker = 'HERDER_ZCODE_SECOND_' + tag
        second_key = 'zcode-v1-second-' + tag
        evidence.update(phase='before_second_send', second_marker=second_marker, second_key=second_key, result='UNKNOWN')
        persist_evidence(evidence_path, evidence)
        second = rpc_tool(client, 'deliver', {'action':'session', 'session_ref':session,
                          'message':second_marker, 'mode':'queue', 'request_key':second_key})
        evidence.update(phase='second_response', second_response=second)
        persist_evidence(evidence_path, evidence)
        if second.get('resultType') != 'task' or not second.get('taskId'):
            raise RuntimeError('second delivery missing task; do not replay')
        second_task = wait_task(client, second['taskId'])
        evidence.update(phase='second_terminal', second_task=second_task)
        persist_evidence(evidence_path, evidence)
        outcome = second_task.get('result', {}).get('structuredContent', {})
        if second_task.get('status') != 'completed' or second_task.get('result', {}).get('isError') or outcome.get('outcome') != 'confirmed' or not outcome.get('native_receipt_id') or outcome.get('native_receipt_id') == prompt.get('native_receipt_id'):
            raise RuntimeError('second delivery not confirmed; do not replay')
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            messages=rpc_tool(client,'session',{'action':'messages','session_ref':session})
            records=messages.get('structuredContent',{}).get('page',{}).get('messages',[])
            if (any(r.get('role')=='user' and r.get('text')==marker for r in records)
                and any(r.get('role')=='user' and r.get('text')==second_marker for r in records)
                and sum(r.get('role')=='assistant' and r.get('text')=='HERDER_TEST_MODEL_OK' for r in records)>=2):
                break
            time.sleep(.5)
        else:
            raise RuntimeError('second native answer not confirmed; do not replay')
        evidence.update(phase='both_read', messages=messages, second_outcome=outcome, model_after=stats())
        persist_evidence(evidence_path,evidence)
        for name,arguments in [('export',{'action':'export','session_ref':session,'format':'native'}),
                               ('search',{'action':'search','query':marker}),
                               ('discover',{'action':'projects','instance_ref':instance})]:
            result=rpc_tool(client,name,arguments)
            evidence[name]=result
            persist_evidence(evidence_path,evidence)
        exported=evidence['export'].get('structuredContent', {})
        decoded=base64.b64decode(exported.get('bytes_base64',''), validate=True).decode()
        if exported.get('complete') is not True or marker not in decoded or second_marker not in decoded:
            raise RuntimeError('native export incomplete or missing exact messages')
        search=evidence['search'].get('structuredContent', {})
        if search.get('complete') is not True or not any(hit.get('session_ref') == session for hit in search.get('hits', [])):
            raise RuntimeError('search coverage or session hit missing')
        project_view=evidence['discover'].get('structuredContent', {})
        if not any(row.get('project_ref') == '/herder-owner-home/work' and row.get('source') == 'authorized_native_session' for row in project_view.get('projects', [])):
            raise RuntimeError('authorized project provenance missing')
        evidence.update(phase='read_checks_completed', result='PARTIAL')
        persist_evidence(evidence_path,evidence)
        client.close()
        reopened=RpcProcess(core, profile, dict(os.environ))
        try:
            reopened.preflight()
            after=rpc_tool(reopened,'session',{'action':'messages','session_ref':session})
            rows=after.get('structuredContent',{}).get('page',{}).get('messages',[])
            if (not any(r.get('role')=='user' and r.get('text')==marker for r in rows)
                    or not any(r.get('role')=='user' and r.get('text')==second_marker for r in rows)
                    or sum(r.get('role')=='assistant' and r.get('text')=='HERDER_TEST_MODEL_OK' for r in rows)<2):
                raise RuntimeError('reopened public session missing exact messages')
            evidence.update(phase='complete',result='PASS',reopen=after,no_resend=True)
            persist_evidence(evidence_path,evidence)
            print(json.dumps({'status':'PASS','session_ref':session,'evidence':evidence},sort_keys=True),flush=True)
            # launch.py retains the protected root only on nonzero exit.
            raise SystemExit(3)
        finally:
            reopened.close()
    except Exception as exc:
        evidence['error'] = str(exc)
        persist_evidence(evidence_path, evidence)
        raise


def config_argv(config):
    from runner_config import ConfigError, file_path, required_string
    capabilities = config.get('capabilities', {})
    if capabilities.get('os') != 'linux' or capabilities.get('backend') != 'linux-netns-bwrap':
        raise ConfigError('ZCode fixture requires linux-netns-bwrap')
    import platform
    if platform.system().lower() != 'linux' or capabilities.get('arch','').lower() != platform.machine().lower():
        raise ConfigError('configured host architecture does not match')
    for binary in ('unshare', 'bwrap', 'ip'):
        if not shutil.which(binary):
            raise ConfigError('missing isolation tool: ' + binary)
    python=file_path(required_string(config,'python','config'),'python',executable=True)
    launcher=file_path(required_string(config,'launcher','config'),'launcher')
    stand=file_path(required_string(config,'stand','config'),'stand')
    manifest=file_path(required_string(config,'manifest','config'),'manifest')
    expected=required_string(config,'manifest_sha256','config')
    data=validate_manifest(manifest,expected)
    runtime=Path(required_string(config,'zcode_runtime','config')).resolve(strict=True)
    client=Path(required_string(config,'zcode_client_dist','config')).resolve(strict=True)
    for p in (runtime/'node',runtime/'zcode.cjs',runtime/'server-cli.js',runtime/'server-core.js',client/'adapters/zcode-protocol.js',client/'adapters/zcode-server-control.js',client.parent/'package.json',client.parent/'node_modules/ws'):
        if not p.exists(): raise ConfigError('required ZCode fixture component missing: '+str(p))
    retained=Path(required_string(config,'retain_root','config'))
    if not retained.is_absolute() or retained.exists() or retained.is_symlink():
        raise ConfigError('retain_root must be an unused absolute path')
    argv=[python,launcher,'--retain-on-failure',str(retained)]
    for path in (Path(data['artifact_root']),runtime.parent,client,client.parent/'node_modules/ws',client.parent/'package.json'):
        argv.extend(['--ro-bind',str(path)])
    argv.extend(['--',python,stand,'--manifest',manifest,'--manifest-sha256',expected,'--runtime',str(runtime),'--client-dist',str(client),'--run-case'])
    return {'argv':argv,'manifest_sha256':expected,'source_commit':data.get('source_commit')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--manifest')
    parser.add_argument('--runtime')
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--client-dist')
    parser.add_argument('--run-case', action='store_true')
    args = parser.parse_args()
    if args.config and args.dry_run:
        print(json.dumps(config_argv(json.loads(Path(args.config).read_text())),sort_keys=True))
        return
    if not all((args.manifest,args.manifest_sha256,args.runtime,args.client_dist)):
        parser.error('manifest, manifest-sha256, runtime and client-dist are required')
    run(args)


if __name__ == '__main__':
    main()
