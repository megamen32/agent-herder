#!/usr/bin/env python3
"""Start disposable OpenCode and Herder inside launch.py's isolated sandbox."""
import json
import os
import pwd
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

from candidate_driver import validate_isolation


def require_sandbox(own_net, parent_net, home, candidate_readonly):
    path = Path(home)
    if (not parent_net or own_net == parent_net or not own_net or path.name != 'home'
            or path.parent.parent != Path('/tmp') or not path.parent.name.startswith('herder-native-model-')
            or candidate_readonly is not True):
        raise ValueError('verified isolated fixture namespace and read-only candidate required')


def diagnostic_tail(path):
    with path.open('rb') as source:
        source.seek(0, 2)
        source.seek(max(0, source.tell()-4096))
        return source.read(4096).decode(errors='replace')


def fixture_path():
    return '/usr/local/bin:/usr/bin:/bin'


def fixture_fleet_admission():
    # The host fleet ledger is deliberately absent in this isolated test stand.
    return 'retired'


def fixture_codex_config(base):
    return ('model = "herder-test"\nmodel_provider = "fixture"\n'
            '[model_providers.fixture]\nname = "fixture"\n' + f'base_url = "{base}"\n' +
            'wire_api = "responses"\n')


def fixture_peer(host, listen_port, username):
    return [{'hostId': host, 'sshHost': '127.0.0.1', 'nativeUser': username,
             'port': listen_port, 'python': '/usr/bin/python3'}]


def write_fixture_quota(home):
    state = home/'fixture-autopilot'
    state.mkdir()
    (state/'codex-quota-guard.json').write_text(json.dumps({'version': 1, 'policy': {'enabled': False,
        'minRemainingPercent': 20, 'onUnknown': 'block'}}))
    return state


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def ready(url, proc, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f'fixture process exited {proc.returncode}')
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200: return
        except OSError:
            time.sleep(.2)
    raise RuntimeError('fixture service readiness timeout')


def main():
    if len(sys.argv) != 4:
        raise ValueError('expected candidate root, absolute codex executable, absolute opencode executable')
    candidate, codex, opencode = map(Path, sys.argv[1:])
    if not all(p.is_absolute() and p.exists() for p in (candidate, codex, opencode)):
        raise ValueError('candidate and native executables must be absolute and present')
    home = Path(os.environ['HOME'])
    ns = os.stat('/proc/self/ns/net')
    require_sandbox(f'{ns.st_dev}:{ns.st_ino}', os.environ.get('HERDER_FIXTURE_PARENT_NET', ''),
                    str(home), bool(os.statvfs(candidate).f_flag & os.ST_RDONLY))
    def ip(*args): return json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', *args], text=True, timeout=5))
    validate_isolation(ip('link', 'show'), ip('-4', 'route', 'show'), ip('-6', 'route', 'show'),
                       str(home/'work'), 'http://127.0.0.1:1', os.environ['HERDER_TEST_MODEL_BASE_URL'].removesuffix('/v1'))
    project = home/'work'; project.mkdir()
    fixture = os.environ['HERDER_TEST_MODEL_BASE_URL']
    codex_home = home/'.codex'; codex_home.mkdir()
    (codex_home/'config.toml').write_text(fixture_codex_config(fixture))
    config = {'provider': {'fixture': {'npm': '@ai-sdk/openai-compatible', 'name': 'Fixture',
        'options': {'baseURL': fixture, 'apiKey': 'fixture-only'}, 'models': {'herder-test': {'name': 'Fixture'}}}},
        'model': 'fixture/herder-test', 'autoupdate': False}
    (project/'opencode.json').write_text(json.dumps(config))
    settings = home/'.local/state/agent-herder/settings'; settings.mkdir(parents=True)
    (settings/'projects.json').write_text(json.dumps([{'id': 'ci', 'name': 'CI', 'path': str(project)}]))
    open_port, herder_port = port(), port()
    quota_state = write_fixture_quota(home)
    env = dict(os.environ, PATH=fixture_path(), CODEX_HOME=str(codex_home), CODEX_BIN=str(codex), CODEX_CWD=str(project),
        HERDER_FIXTURE_KEY='fixture-only', OPENCODE_SERVER_PASSWORD='fixture-only',
        OPENCODE_URL=f'http://127.0.0.1:{open_port}', AGENT_HERDER_WEB_HOST='127.0.0.1',
        AGENT_HERDER_WEB_PORT=str(herder_port), AGENT_HERDER_HTTP_TOKEN='fixture-only', HERDER_CI_TOKEN='fixture-only',
        AGENT_HERDER_SINGLETON_LOCK=str(home/'instance.lock'), AGENT_HERDER_WORKLOAD_ISOLATION='off',
        AGENT_HERDER_AUTOPILOT_STATE_DIR=str(quota_state),
        AGENT_HERDER_FLEET_ADMISSION=fixture_fleet_admission(),
        AGENT_HERDER_FLEET_PEERS=json.dumps(fixture_peer(socket.gethostname(), herder_port, pwd.getpwuid(os.getuid()).pw_name)),
        ENABLE_CODEX='true', ENABLE_OPENCODE='true', ENABLE_CLAUDE='false', ENABLE_QODER='false',
        ENABLE_HERMES='false', ENABLE_ZCODE='false', ENABLE_MINIMAX_CODE='false', ENABLE_FAST_AGENT='false')
    children = []
    log_path = home/'herder.log'
    log = log_path.open('w')
    try:
        native = subprocess.Popen([str(opencode), 'serve', '--hostname', '127.0.0.1', '--port', str(open_port)],
                                  cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(native)
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            if native.poll() is not None: raise RuntimeError('OpenCode server exited')
            try:
                with socket.create_connection(('127.0.0.1', open_port), timeout=.2): break
            except OSError: time.sleep(.2)
        else: raise RuntimeError('OpenCode server readiness timeout')
        herder = subprocess.Popen(['node', str(candidate/'dist/index.js')], cwd=project, env=env,
                                  stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        children.append(herder)
        root = f'http://127.0.0.1:{herder_port}'
        ready(root+'/api/settings', herder)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('candidate_driver.py')), str(candidate/'dist'),
                        str(project), root, fixture.removesuffix('/v1'), str(codex), str(opencode)],
                       cwd=project, env=env, check=False, timeout=120)
        return result.returncode
    except Exception as error:
        log.flush()
        try:
            with urllib.request.urlopen(fixture.removesuffix('/v1')+'/_stats', timeout=3) as response:
                stats = response.read(1024).decode(errors='replace')
        except OSError:
            stats = 'unavailable'
        raise RuntimeError(f'{error}; fixture stats: {stats}; candidate log: {diagnostic_tail(log_path)}') from error
    finally:
        for child in reversed(children):
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        log.close()


if __name__ == '__main__': sys.exit(main())
