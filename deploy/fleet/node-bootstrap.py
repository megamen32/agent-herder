#!/usr/bin/env python3
"""Start only the owned bounded node; reuse native controls, keep secrets in memory."""
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import sys
import time

base = Path.home() / '.local/share/agent-herder/fleet'
config = json.loads((base / 'node-config.json').read_text())
manifest = json.loads((base / 'current/dist/fleet-deployment-manifest.json').read_text())
if manifest['source_sha'] != config['sourceSha'] or manifest.get('source_dirty'):
    sys.exit('Fleet node source identity mismatch')
if config['hostId'] != socket.gethostname():
    sys.exit('Fleet node native host identity mismatch')
node = Path(config['nodeBin'])
if not node.is_file() or not os.access(node, os.X_OK):
    sys.exit('Fleet node executable missing')
env = os.environ.copy()
state = Path.home() / '.local/state/agent-herder/fleet-node'
state.mkdir(mode=0o700, parents=True, exist_ok=True)
runtime = Path(env.get('XDG_RUNTIME_DIR', '/tmp')) / 'agent-herder-fleet'
runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
temp = runtime / 'tmp'
temp.mkdir(mode=0o700, exist_ok=True)
if shutil.disk_usage(base).free < 2 * 1024**3:
    sys.exit('Fleet node requires 2GiB disk reserve')
if sys.platform.startswith('linux'):
    mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(mem['MemAvailable'].split()[0]) * 1024 < 4 * 1024**3:
        sys.exit('Fleet node requires 4GiB host memory reserve')
harnesses = config['harnesses']
if not set(harnesses) <= {'codex', 'zcode', 'opencode'}:
    sys.exit('Unsupported fleet node adapter')
for name in ['CODEX', 'ZCODE', 'OPENCODE', 'CLAUDE', 'QODER', 'HERMES', 'FAST_AGENT']:
    env['ENABLE_' + name] = 'true' if name.lower().replace('_', '-') in harnesses else 'false'
if 'codex' in harnesses:
    pointer = Path(config['codexSocket'])
    if not stat.S_ISSOCK(pointer.stat().st_mode):
        sys.exit('Fleet node managed Codex socket missing')
    env['CODEX_APP_SERVER_SOCKET'] = str(pointer)
    env['CODEX_TRANSPORT'] = 'app-server'
    env['CODEX_BIN'] = config['codexBin']
    env['CODEX_CWD'] = str(Path.home())
if 'opencode' in harnesses:
    pid = int(config['opencodePid'])
    proc = Path('/proc') / str(pid)
    args = (proc / 'cmdline').read_bytes().split(b'\0')
    if b'serve' not in args:
        sys.exit('Fleet node expected existing OpenCode serve')
    port = args[args.index(b'--port') + 1].decode() if b'--port' in args else '4096'
    if port != str(config['opencodePort']):
        sys.exit('Fleet node native OpenCode port changed')
    values = dict(entry.split(b'=', 1) for entry in (proc / 'environ').read_bytes().split(b'\0') if b'=' in entry)
    env['OPENCODE_URL'] = 'http://127.0.0.1:' + port
    # No token file, command argument or cross-host credential copy.
    for name in ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']:
        if name.encode() in values:
            env[name] = values[name.encode()].decode()
if 'zcode' in harnesses:
    env['ZCODE_SERVER_NODE'] = config['zcodeNode']
    env['ZCODE_SERVER_ENTRY'] = config['zcodeEntry']
    env['ZCODE_CWD'] = str(Path.home())
registry = state / 'adapters.json'
registry.write_text(json.dumps({'version': 1, 'enabled': {name: name in harnesses for name in ['codex', 'opencode', 'zcode', 'claude', 'qoder', 'hermes', 'fast-agent', 'chatgpt']}}))
env.update(AGENT_HERDER_WEB_PORT=str(config.get('webPort', 18789)), AGENT_HERDER_WEB_HOST='0.0.0.0', AGENT_HERDER_ADAPTER_REGISTRY=str(registry), AGENT_HERDER_AUTOPILOT_STATE_DIR=str(state / 'autopilot'),
           AGENT_HERDER_HUMAN_REQUEST_STORE=str(state / 'human-requests.json'),
           AGENT_HERDER_SINGLETON_LOCK=str(runtime / 'node.lock'), TMPDIR=str(temp))
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
