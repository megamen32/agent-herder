"""One new disposable registration, then public projects reads; never replay."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid

HELPERS = '/home/roomhacker/.codex/worktrees/ahap-opencode-consumer/agent-herder/tests/native'
sys.path.insert(0, HELPERS)
import ahap_opencode_stand as stand

core_path, runner, bootstrap_path, node, opencode = map(Path, sys.argv[1:])
receipt = {'status': 'PREMUTATION', 'source_commit': '7ee42db728ed50f731e80e61c2a7bb7ef1a7328c',
           'no_replay': True, 'public_create_submissions': 0, 'separate_deliver_submissions': 0}
def emit():
    print('D12_RECEIPT ' + json.dumps(receipt, sort_keys=True), flush=True)
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
expected = {'core': '71b357f8b710e0fe484d36c3f7c0a9124853940052aea4508a736d4c2b828569',
            'runner': 'af867ab7464b4ff75aee3f57a0fa3ef5da5d7947cdd7e8a6822787a8ffd00d45',
            'bootstrap': 'c6d5f2bc6844948674e02901821c8c56390efb706202771446bc4a68d6fb2fd7',
            'node': '81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90',
            'opencode': '25facd7099c19018e83dce858f3ab922cd2d49ad29b144bc36968418ca6eb5aa'}
actual = {name: digest(path) for name, path in zip(expected, [core_path, runner, bootstrap_path, node, opencode])}
assert actual == expected, actual
receipt['component_sha256'] = actual
base = os.environ['HERDER_TEST_MODEL_BASE_URL']
assert base.startswith('http://127.0.0.1:') and base.endswith('/v1')
origin = base.removesuffix('/v1')
def stats():
    with urllib.request.urlopen(origin + '/_stats', timeout=3) as response:
        return json.load(response)['requests']
protected = Path('/herder-owner-home')
project = protected / 'work'
project.mkdir(mode=0o700)
instance = 'd12-projects-' + uuid.uuid4().hex
url = 'http://127.0.0.1:' + str(stand.port())
stand.write_opencode_fixture(project, base)
seed = stand.parse_fresh_seed(subprocess.check_output([str(bootstrap_path), str(protected)], text=True, timeout=30), protected)
profile = Path(seed['profile_seed']).parent / 'profile.json'
stand.write_owner_profile(profile, seed, instance=instance, executable=node, runner_script=runner, opencode_url=url, project=project)
links = json.loads(subprocess.check_output(['ip', '-j', 'link', 'show'], text=True))
routes4 = json.loads(subprocess.check_output(['ip', '-j', '-4', 'route', 'show'], text=True))
routes6 = json.loads(subprocess.check_output(['ip', '-j', '-6', 'route', 'show'], text=True))
stand.validate_stand_isolation(links, routes4, routes6, str(project), url, origin)
receipt['isolation'] = {'interfaces': [v['ifname'] for v in links], 'routes4': routes4, 'routes6': routes6,
                        'home': str(protected), 'instance': instance, 'fresh_authority': seed}
env = dict(os.environ, HOME=str(protected), PATH=str(node.parent)+os.pathsep+stand.fixture_path(),
           PYTHONDONTWRITEBYTECODE='1', OPENCODE_SERVER_PASSWORD='fixture-only',
           AHAP_VERSION='0.1', AHAP_HARNESS='opencode', AHAP_OPENCODE_BASE_URL=url,
           AHAP_OPENCODE_PASSWORD='fixture-only')
server = subprocess.Popen([str(opencode), 'serve', '--hostname', '127.0.0.1', '--port', url.rsplit(':', 1)[1]],
                          cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
core = None
try:
    stand.wait_opencode(url, server)
    family = stand.detect_opencode_api_family(url)
    protocol = stand.probe_runner_protocol(node, runner, env)
    stand.require_runner_route_compat(family, protocol)
    stand.verify_opencode_fixture(url, base)
    receipt['api_family'] = family
    receipt['runner_protocol'] = protocol
    core = stand.RpcProcess(core_path, profile, env)
    stand.validate_v1_public_contract(core.preflight() and core.native_tool_catalog)
    request = {'action': 'projects', 'instance_ref': instance}
    before = stand.rpc_tool(core, 'discover', request)
    assert before.get('isError') is not True
    assert before['structuredContent']['projects'] == []
    assert stats() == 0
    receipt['before_registration'] = before
    marker = 'D12_PROJECTS_' + uuid.uuid4().hex
    key = 'd12-create-' + uuid.uuid4().hex
    receipt.update(status='CREATE_SUBMITTING', request_key=key, public_create_submissions=1)
    emit()  # Save the operation identity before its only submission.
    created = stand.rpc_tool(core, 'create', {'action': 'create', 'instance_ref': instance, 'prompt': marker, 'request_key': key})
    receipt['create'] = created
    emit()
    assert created.get('resultType') == 'task' and isinstance(created.get('taskId'), str)
    task = stand.wait_task(core, created['taskId'])
    receipt['task'] = task
    assert task['status'] == 'completed', task
    admission = stand.task_delivery_receipt(task)
    assert admission is not None, task
    session = task['result']['structuredContent']['create']['session_ref']
    native_id = stand.native_session_for(Path(seed['database']), session)
    receipt['completion'] = stand.wait_for_native_completion(url, native_id, marker, admission['native_receipt_id'], env)
    receipt['session_ref'] = session
    receipt['native_session_id'] = native_id
    sessions = stand.rpc_tool(core, 'sessions', {'action': 'list', 'instance_ref': instance})
    rows = sessions['structuredContent']['sessions']
    exact = [r for r in rows if r['session_ref'] == session]
    assert len(exact) == 1 and exact[0]['address']['native_session_id'] == native_id
    assert exact[0]['native']['cwd'] == str(project), exact
    receipt['registered_sessions'] = sessions
    after = stand.rpc_tool(core, 'discover', request)
    receipt['after_registration'] = after
    emit()
    def check_projects(result):
        assert result.get('isError') is not True, result
        value = result['structuredContent']
        assert len(value['projects']) >= 1, value
        assert value['complete'] is False and value['scope'] == 'authorized_registered_sessions', value
        assert any('not globally exhaustive' in s for s in value['limitations']), value
        assert all(p['project_ref'] == exact[0]['native']['cwd'] for p in value['projects']), value
        assert all(p['source'] in ('native_project_inventory', 'authorized_native_session') for p in value['projects']), value
        return value
    check_projects(after)
    count_before_reopen = stats()
    assert count_before_reopen == 1
    core.close()
    core = stand.RpcProcess(core_path, profile, env)
    core.preflight()
    reopened = stand.rpc_tool(core, 'discover', request)
    check_projects(reopened)
    receipt['after_core_reopen'] = reopened
    receipt['model_requests'] = stats()
    assert receipt['model_requests'] == count_before_reopen
    receipt['status'] = 'PASS_PROJECT_ATTRIBUTION'
except Exception as error:
    receipt['status'] = 'UNKNOWN_NO_REPLAY' if receipt['public_create_submissions'] else 'FAILED_PREMUTATION'
    receipt['error'] = str(error)
    raise
finally:
    if core is not None:
        core.close()
    if server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
    receipt['cleanup'] = {'opencode_stopped': server.poll() is not None, 'core_stopped': core is None or core.process.poll() is not None}
    emit()
