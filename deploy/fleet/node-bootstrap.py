#!/usr/bin/env python3
"""Start only the owned bounded node; reuse native controls, keep secrets in memory.

The native OpenCode is joined, never replaced: a recorded pid that is gone is a
state, not a failure. The node finds the live OpenCode for its own port and
records that pid; when nothing of OpenCode survived, the node starts it and
only a real failure stops the node.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import time

PROC_ROOT = Path('/proc')
OPENCODE_START_SECONDS = 30
OPENCODE_POLL_SECONDS = 0.25


def fail(message):
    """One clear reason for the operator; a stale native pid is never one of them."""
    sys.exit(message)


def process_alive(pid, proc_root=PROC_ROOT):
    """Liveness is a state, not an exception: a missing pid is simply not alive."""
    if type(pid) is not int or pid <= 1:
        return False
    return (proc_root / str(pid)).is_dir()


def process_cmdline(pid, proc_root=PROC_ROOT):
    try:
        raw = (proc_root / str(pid) / 'cmdline').read_bytes()
    except OSError:
        return []
    return [part.decode('utf8', 'replace') for part in raw.split(b'\0') if part]


def process_uid(pid, proc_root=PROC_ROOT):
    try:
        for line in (proc_root / str(pid) / 'status').read_text().splitlines():
            if line.startswith('Uid:'):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def process_environ(pid, proc_root=PROC_ROOT):
    try:
        raw = (proc_root / str(pid) / 'environ').read_bytes()
    except OSError:
        return {}
    values = {}
    for entry in raw.split(b'\0'):
        if b'=' not in entry:
            continue
        name, _, value = entry.partition(b'=')
        values[name.decode('utf8', 'replace')] = value.decode('utf8', 'replace')
    return values


def opencode_serve_port(args):
    """The port of an OpenCode serve command line; None when it is not one."""
    if not args or 'serve' not in args:
        return None
    if not any('opencode' in Path(arg).name for arg in args[:2]):
        return None
    if '--port' not in args:
        return '4096'
    index = args.index('--port') + 1
    return args[index] if index < len(args) else None


def port_listening(port, proc_root=PROC_ROOT):
    """A LISTEN socket on this TCP port, read from the kernel tables."""
    wanted = format(port, '04X')
    for name in ('net/tcp', 'net/tcp6'):
        try:
            lines = (proc_root / name).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 4 or fields[3] != '0A':
                continue
            if fields[1].rsplit(':', 1)[-1] == wanted:
                return True
    return False


def candidate_opencode_pids(port, proc_root=PROC_ROOT):
    """Every own process that serves OpenCode on this exact port."""
    pids = []
    try:
        entries = sorted(proc_root.iterdir())
    except OSError:
        return pids
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if opencode_serve_port(process_cmdline(pid, proc_root)) != str(port):
            continue
        if process_uid(pid, proc_root) != os.getuid():
            continue
        pids.append(pid)
    return pids


def find_opencode(port, proc_root=PROC_ROOT):
    """The live OpenCode for this port, adopted only after it is proven to serve it."""
    for pid in candidate_opencode_pids(port, proc_root):
        if port_listening(port, proc_root):
            return pid
    return None


def opencode_binary(config):
    """The native OpenCode binary: the declared path, the PATH, then the known installs."""
    declared = config.get('opencodeBin')
    if isinstance(declared, str) and declared.strip():
        path = Path(declared).expanduser()
        return path if path.is_file() and os.access(path, os.X_OK) else None
    found = shutil.which('opencode')
    if found:
        return Path(found)
    home = Path.home()
    for candidate in (home / '.npm-global/bin/opencode', home / '.local/bin/opencode',
                      home / '.opencode/bin/opencode', Path('/usr/local/bin/opencode'),
                      Path('/usr/bin/opencode')):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def opencode_credentials(config):
    """Credentials for a self started OpenCode: the protected pointer, then this environment."""
    values = {}
    pointer = config.get('opencodeEnvFile')
    if isinstance(pointer, str) and pointer:
        try:
            text = Path(pointer).expanduser().read_text()
        except OSError:
            text = ''
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            name, _, value = line.partition('=')
            name = name.strip()
            value = value.strip().strip('"').strip("'")
            if name in ('OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME') and value:
                values[name] = value
    for name in ('OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'):
        if name not in values and os.environ.get(name):
            values[name] = os.environ[name]
    return values


def start_opencode(port, config, proc_root=PROC_ROOT):
    """Start the native OpenCode when nothing of it survived."""
    binary = opencode_binary(config)
    if binary is None:
        fail('Fleet node could not start OpenCode on port %s: the opencode binary was not found' % port)
    environment = os.environ.copy()
    environment.update(opencode_credentials(config))
    argv = [str(binary), 'serve', '--hostname', '127.0.0.1', '--port', str(port)]
    try:
        started = subprocess.Popen(argv, cwd=str(Path.home()), env=environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
    except (OSError, ValueError) as error:
        fail('Fleet node could not start OpenCode on port %s: %s' % (port, type(error).__name__))
    deadline = time.monotonic() + OPENCODE_START_SECONDS
    while time.monotonic() < deadline:
        pid = find_opencode(port, proc_root)
        if pid is not None:
            return pid
        if started.poll() is not None:
            fail('Fleet node could not start OpenCode on port %s: the process exited with %s'
                 % (port, started.returncode))
        time.sleep(OPENCODE_POLL_SECONDS)
    fail('Fleet node could not start OpenCode on port %s: the port did not open in %d seconds'
         % (port, OPENCODE_START_SECONDS))


def record_opencode_pid(config_path, config, pid):
    """The node records the live pid it actually works with."""
    if config.get('opencodePid') == pid:
        return
    updated = dict(config)
    updated['opencodePid'] = pid
    try:
        temporary = config_path.with_suffix('.json.new')
        temporary.write_text(json.dumps(updated, indent=1) + '\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, config_path)
    except OSError as error:
        print('opencode pid record failed: ' + type(error).__name__)
        return
    config['opencodePid'] = pid


def resolve_opencode(config, proc_root=PROC_ROOT, start=True):
    """The native OpenCode this node works with.

    A recorded pid that is gone is a state: the live OpenCode for the same port
    is adopted, and only a missing OpenCode is started.
    """
    port = config.get('opencodePort')
    if type(port) is not int or not 1 <= port <= 65535:
        fail('Fleet node native OpenCode port is not configured')
    recorded = config.get('opencodePid')
    if process_alive(recorded, proc_root):
        actual = opencode_serve_port(process_cmdline(recorded, proc_root))
        if actual == str(port):
            return recorded, port
        if actual is not None:
            fail('Fleet node native OpenCode port changed')
        # The recorded pid belongs to another process now: treat it as stale.
    pid = find_opencode(port, proc_root)
    if pid is not None:
        return pid, port
    if candidate_opencode_pids(port, proc_root):
        fail('Fleet node found an OpenCode for port %s that is not serving it' % port)
    if not start:
        fail('Fleet node has no live OpenCode serve on port %s' % port)
    return start_opencode(port, config, proc_root), port


def opencode_environment(config, config_path, proc_root=PROC_ROOT, start=True):
    """The OpenCode URL and the credentials of the live OpenCode, read from its process."""
    pid, port = resolve_opencode(config, proc_root, start)
    values = process_environ(pid, proc_root)
    environment = {'OPENCODE_URL': 'http://127.0.0.1:' + str(port)}
    # No token file, command argument or cross-host credential copy.
    for name in ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']:
        if name in values:
            environment[name] = values[name]
    record_opencode_pid(config_path, config, pid)
    return pid, environment


def main():
    base = Path.home() / '.local/share/agent-herder/fleet'
    config_path = base / 'node-config.json'
    config = json.loads(config_path.read_text())
    manifest = json.loads((base / 'current/dist/fleet-deployment-manifest.json').read_text())
    if manifest['source_sha'] != config['sourceSha'] or manifest.get('source_dirty'):
        fail('Fleet node source identity mismatch')
    if config['hostId'] != socket.gethostname():
        fail('Fleet node native host identity mismatch')
    node = Path(config['nodeBin'])
    if not node.is_file() or not os.access(node, os.X_OK):
        fail('Fleet node executable missing')
    env = os.environ.copy()
    state = Path.home() / '.local/state/agent-herder/fleet-node'
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    runtime = Path(env.get('XDG_RUNTIME_DIR', '/tmp')) / 'agent-herder-fleet'
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = runtime / 'tmp'
    temp.mkdir(mode=0o700, exist_ok=True)
    if shutil.disk_usage(base).free < 2 * 1024**3:
        fail('Fleet node requires 2GiB disk reserve')
    if sys.platform.startswith('linux'):
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        if int(mem['MemAvailable'].split()[0]) * 1024 < 4 * 1024**3:
            fail('Fleet node requires 4GiB host memory reserve')
    harnesses = config['harnesses']
    if not set(harnesses) <= {'codex', 'zcode', 'opencode', 'minimax-code'}:
        fail('Unsupported fleet node adapter')
    for name in ['CODEX', 'ZCODE', 'OPENCODE', 'CLAUDE', 'QODER', 'HERMES', 'FAST_AGENT', 'MINIMAX_CODE']:
        env['ENABLE_' + name] = 'true' if name.lower().replace('_', '-') in harnesses else 'false'
    if 'codex' in harnesses:
        pointer = Path(config['codexSocket'])
        if not stat.S_ISSOCK(pointer.stat().st_mode):
            fail('Fleet node managed Codex socket missing')
        env['CODEX_APP_SERVER_SOCKET'] = str(pointer)
        env['CODEX_TRANSPORT'] = 'app-server'
        env['CODEX_BIN'] = config['codexBin']
        env['CODEX_CWD'] = str(Path.home())
    if 'opencode' in harnesses:
        check_only = sys.argv[1:] == ['--check']
        _pid, native = opencode_environment(config, config_path, start=not check_only)
        env.update(native)
    if 'zcode' in harnesses:
        env['ZCODE_SERVER_NODE'] = config['zcodeNode']
        env['ZCODE_SERVER_ENTRY'] = config['zcodeEntry']
        env['ZCODE_CWD'] = str(Path.home())
    registry = state / 'adapters.json'
    registry.write_text(json.dumps({'version': 1, 'enabled': {name: name in harnesses for name in ['codex', 'opencode', 'zcode', 'claude', 'qoder', 'hermes', 'fast-agent', 'chatgpt', 'minimax-code']}}))
    env.update(AGENT_HERDER_WEB_PORT=str(config.get('webPort', 18789)), AGENT_HERDER_WEB_HOST='0.0.0.0', AGENT_HERDER_ADAPTER_REGISTRY=str(registry), AGENT_HERDER_AUTOPILOT_STATE_DIR=str(state / 'autopilot'),
               AGENT_HERDER_HUMAN_REQUEST_STORE=str(state / 'human-requests.json'),
               AGENT_HERDER_SINGLETON_LOCK=str(runtime / 'node.lock'), TMPDIR=str(temp))
    # The node serves GET/PUT /api/automation/launch-policy from the autopilot state
    # directory. Seed the document at deploy time so the node has a policy version
    # to confirm and the endpoint answers instead of "absent". A seeding failure
    # must not take the node down: the node still runs, it just has no policy.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import launch_policy_seed
        _models, _document = launch_policy_seed.default_models()
        _receipt = launch_policy_seed.seed(str(state), harnesses, _models,
                                            _document.get('preferredHarness'), _document.get('fallbackModels'))
    except Exception as exc:  # noqa: BLE001
        print('launch-policy seed failed: ' + str(exc))

    if sys.argv[1:] == ['--check']:
        print(json.dumps({'hostId': socket.gethostname(), 'sourceSha': config['sourceSha'], 'harnesses': harnesses,
                          'nativeCodexSocket': 'codex' in harnesses, 'secretsPrinted': False}))
        sys.exit(0)
    # Dedicated watchdog only inspects/stops this node on owned storage exhaustion.
    watch = os.fork()
    if watch == 0:
        parent = os.getppid()
        while True:
            time.sleep(10)
            if os.getppid() != parent:
                os._exit(0)
            for folder, limit in [(temp, 128 * 1024**2), (state, 64 * 1024**2)]:
                total = 0
                for directory, _, files in os.walk(folder, followlinks=False):
                    for name in files:
                        try:
                            path = Path(directory) / name
                            if not path.is_symlink(): total += path.stat().st_size
                        except OSError: pass
                        if total > limit:
                            os.kill(parent, 15)
                            os._exit(75)
        os._exit(0)
    # index.js validates argv against import.meta.url; Node resolves a symlinked main file.
    entry = (base / 'current/dist/index.js').resolve(strict=True)
    os.chdir((base / 'current').resolve(strict=True))
    os.execve(str(node), [str(node), str(entry)], env)


if __name__ == '__main__':
    main()
