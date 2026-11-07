#!/usr/bin/env python3
"""Fail-closed preflight for the V1 ZCode public MCP lane.

Run only via launch.py; no create or send is performed by this preflight.
"""
import argparse
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

MANIFEST_SHA = 'a5d62e9d973f8b37aa7aee3a39e96dfa85aac86dc5dd50502ea30f47e3edf998'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_manifest(path):
    path = Path(path)
    if digest(path) != MANIFEST_SHA:
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
OFFICIAL_CLIENT_DIST = Path('/home/roomhacker/.codex/worktrees/herder-session-info/agent-herder/dist')
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


def setup_official_project(node, home, project, protected):
    evidence_path = protected / 'zcode-v1-project-setup.json'
    record = {'phase':'before_project_save', 'project_root':str(project),
              'result':'UNKNOWN', 'no_replay':True}
    persist_evidence(evidence_path, record)
    env = dict(os.environ, HOME=str(home))
    try:
        result = subprocess.run([str(node), '--input-type=module', '-e', OFFICIAL_PROJECT_JS,
                                 str(OFFICIAL_CLIENT_DIST), str(project)], env=env, cwd=project,
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
    manifest = validate_manifest(args.manifest)
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
    persist_evidence(protected / 'zcode-v1-run-identity.json', {'instance':instance, 'manifest_sha256':MANIFEST_SHA, 'phase':'before_project_setup', 'network':'loopback_only'})
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
        project_receipt = setup_official_project(node, home, project, protected)
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
                            'projects':projects, 'session_mutations':0, 'project_saves':1, 'manifest_sha256':MANIFEST_SHA})
        print(json.dumps({'models':models, 'projects':projects}, ensure_ascii=False), flush=True)
        if args.run_case:
            require_exact_project(project_receipt['native_project_tree'], str(project))
            exercise(client, protected, seed, tools, instance, home)

    finally:
        client.close()
    result = {'status':'PREFLIGHT_ONLY', 'manifest_sha256':MANIFEST_SHA,
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


def exercise(client, protected, seed, tools, instance, home):
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
                'model_before':stats(), 'manifest_sha256':MANIFEST_SHA, 'tools':tools}
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
            if marker in json.dumps(messages) and 'HERDER_TEST_MODEL_OK' in json.dumps(messages):
                break
            time.sleep(.5)
        else:
            evidence.update(phase='initial_read_unconfirmed', messages=messages, model_after=stats())
            persist_evidence(evidence_path, evidence)
            raise RuntimeError('initial assistant response not confirmed; do not resend')
        evidence.update(phase='initial_read_confirmed', messages=messages, model_after=stats(), result='PARTIAL')
        persist_evidence(evidence_path, evidence)
        raise RuntimeError('first exchange confirmed; subsequent scenario not yet implemented; retain root')
    except Exception as exc:
        evidence['error'] = str(exc)
        persist_evidence(evidence_path, evidence)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--run-case', action='store_true')
    args = parser.parse_args()
    run(args)


if __name__ == '__main__':
    main()
