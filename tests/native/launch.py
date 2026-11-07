#!/usr/bin/env python3
"""Run a command with a disposable profile and a loopback test-model endpoint."""
import os
import json
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile


def candidate_mounts(release):
    release = Path(release)
    if not release.is_absolute() or release.is_symlink() or release.parent.name != 'releases':
        raise ValueError('candidate must be an absolute immutable releases directory')
    if not (release/'dist/index.js').is_file() or not (release/'package.json').is_file() or not (release/'node_modules').is_dir():
        raise ValueError('candidate bundle is incomplete')
    mounts = [release]
    store_root = (release.parent.parent/'shared-node-modules').resolve()
    modules = release/'node_modules'
    links = []
    for item in modules.iterdir():
        if item.is_symlink(): links.append(item)
        elif item.name.startswith('@') and item.is_dir():
            links.extend(p for p in item.iterdir() if p.is_symlink())
    stores = set()
    for link in links:
        resolved = link.resolve(strict=True)
        if resolved.is_relative_to(release): continue
        if not resolved.is_relative_to(store_root):
            raise ValueError('candidate dependency store is outside the release store')
        parts = resolved.relative_to(store_root).parts
        if len(parts) < 2:
            raise ValueError('invalid shared dependency path')
        stores.add(store_root/parts[0])
    return mounts + sorted(stores)


def sandbox_command(command, scratch, extra_ro=()):
    """Expose system runtime, fixture sources, selected installed CLI packages and scratch only."""
    bwrap = shutil.which('bwrap')
    if not bwrap:
        raise RuntimeError('filesystem isolation unavailable: bwrap missing')
    args = [bwrap, '--die-with-parent', '--unshare-pid', '--new-session',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc',
            '--ro-bind', str(Path(scratch)/'passwd'), '/etc/passwd']
    for system in ('/usr', '/bin', '/lib', '/lib64'):
        if Path(system).exists():
            args.extend(['--ro-bind', system, system])
    exposed = {Path(__file__).resolve().parent}
    for item in extra_ro:
        path = Path(item)
        if not path.is_absolute() or not path.is_dir() or path.is_symlink():
            raise ValueError('explicit read-only mount must be an existing absolute directory')
        exposed.add(path)
    links = {}
    # Node-based installed harnesses may live in a user's npm directory.
    # Expose that exact installed package, never the containing profile.
    for value in command:
        path = Path(value)
        if not path.is_absolute() or not path.exists():
            continue
        current = path
        for _ in range(16):
            if not current.is_symlink():
                break
            target = os.readlink(current)
            if not str(current).startswith('/usr/'):
                links[current] = target
            current = Path(os.path.normpath(target if os.path.isabs(target) else str(current.parent / target)))
        parts = path.resolve().parts
        if 'node_modules' in parts:
            index = parts.index('node_modules') + 1
            if index < len(parts):
                end = index + (2 if parts[index].startswith('@') else 1)
                if end <= len(parts):
                    exposed.add(Path(*parts[:end]))
    dirs = set()
    for path in [*exposed, *links, Path(scratch)]:
        for parent in path.parents:
            if str(parent) not in ('/', '/tmp', '/usr', '/bin', '/lib', '/lib64') and not str(parent).startswith('/usr/'):
                dirs.add(parent)
    for directory in sorted(dirs, key=lambda item: len(item.parts)):
        args.extend(['--dir', str(directory)])
    for path, target in links.items():
        args.extend(['--symlink', target, str(path)])
    for path in sorted(exposed):
        args.extend(['--ro-bind', str(path), str(path)])
    args.extend(['--bind', scratch, scratch, '--chdir', scratch, '--', *command])
    return args


def main():
    args = sys.argv[1:]
    if not args or args[0] != "--inside-netns":
        unshare = shutil.which("unshare")
        if not unshare:
            print("network namespace isolation unavailable: unshare missing", file=sys.stderr)
            return 2
        # Fail closed: both model and native client share a fresh network
        # namespace. The parent remains outside it, including its loopback.
        parent_net = os.stat('/proc/self/ns/net')
        parent_id = f'{parent_net.st_dev}:{parent_net.st_ino}'
        return subprocess.run([unshare, "--user", "--map-root-user", "--net", "--",
                               sys.executable, str(Path(__file__).resolve()), "--inside-netns", parent_id, *args], check=False).returncode
    try:
        own_net = os.stat('/proc/self/ns/net')
        if len(args) < 2 or f'{own_net.st_dev}:{own_net.st_ino}' == args[1]:
            raise RuntimeError('launcher is not in an isolated network namespace')
        ip = shutil.which('ip')
        if not ip:
            raise RuntimeError('ip command missing')
        links = json.loads(subprocess.check_output([ip, '-j', 'link', 'show'], text=True))
        routes4 = json.loads(subprocess.check_output([ip, '-j', '-4', 'route', 'show'], text=True))
        routes6 = json.loads(subprocess.check_output([ip, '-j', '-6', 'route', 'show'], text=True))
        if any(link.get('ifname') != 'lo' for link in links) or routes4 or routes6:
            raise RuntimeError('network namespace contains an external interface or route')
        subprocess.run([ip, 'link', 'set', 'lo', 'up'], check=True, stdout=subprocess.DEVNULL)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f'network namespace isolation unavailable: {error}', file=sys.stderr)
        return 2
    command = args[2:]
    scenario = 'text'
    if command[:1] == ['--scenario']:
        if len(command) < 3 or command[1] not in ('text', 'tool-call'):
            print('invalid fixture scenario', file=sys.stderr)
            return 2
        scenario, command = command[1], command[2:]
    extra_ro = []
    if command[:1] == ['--candidate']:
        if len(command) < 3:
            print('candidate path missing', file=sys.stderr)
            return 2
        try:
            extra_ro = candidate_mounts(command[1])
        except (OSError, ValueError) as error:
            print(f'candidate isolation unavailable: {error}', file=sys.stderr)
            return 2
        command = command[2:]
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("usage: python3 launch.py -- COMMAND [ARGS...]", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="herder-native-model-") as root:
        (Path(root)/'passwd').write_text(f'fixture:x:{os.getuid()}:{os.getgid()}:fixture:/nonexistent:/bin/false\n')
        home = Path(root) / "home"
        home.mkdir(mode=0o700)
        for name in ("config", "cache", "data", "state", "tmp"):
            (home / name).mkdir(mode=0o700)
        env = {
            "HOME": str(home), "PATH": os.defpath,
            "HERDER_FIXTURE_PARENT_NET": args[1],
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "XDG_DATA_HOME": str(home / "data"),
            "XDG_STATE_HOME": str(home / "state"),
            "TMPDIR": str(home / "tmp"),
        }
        try:
            model_cmd = sandbox_command([sys.executable, str(Path(__file__).with_name('test-model-server.py')), '--scenario', scenario], root)
            client_cmd = sandbox_command(command, root, extra_ro)
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 2
        server = subprocess.Popen(
            model_cmd,
            env=env, stdout=subprocess.PIPE, text=True,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(server.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=10):
                    raise RuntimeError("test model did not start within 10 seconds")
                port = server.stdout.readline().strip()
            if not port.isdecimal() or not 0 < int(port) < 65536:
                raise RuntimeError("test model did not report a valid port")
            env["HERDER_TEST_MODEL_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
            return subprocess.run(client_cmd, env=env, check=False).returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            server.stdout.close()


if __name__ == "__main__":
    sys.exit(main())
