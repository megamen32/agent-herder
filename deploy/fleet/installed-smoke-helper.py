#!/usr/bin/python3 -I
"""Fixed installed smoke boundary. No caller-supplied paths, commands or prompts."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import time

INSTALL = Path('/opt/agent-herder-ci-smoke')
CONFIG = Path('/etc/agent-herder-ci-smoke')
STATE = Path('/var/lib/agent-herder-ci-smoke')
HELPER = Path('/usr/local/libexec/agent-herder-ci-smoke')
REQUEST_MAX = 4096
FILES = ('collector.cjs', 'bindings.cjs', 'candidate_release_gate.py', 'installed-public-core.py', 'public-rust-consumer.py', 'ci-browser-fixture.mjs')
SAFE_ENV = ('AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_EXTENSIONS',
            'AGENT_BROWSER_SESSION', 'AGENT_BROWSER_IDLE_TIMEOUT_MS')


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_input_key')
        result[key] = value
    return result


def request_input(raw):
    if len(raw) > REQUEST_MAX:
        raise ValueError('request_too_large')
    value = json.loads(raw, object_pairs_hook=unique)
    if (not isinstance(value, dict) or set(value) != {'run_id', 'expected_source_sha'}
            or not isinstance(value['run_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', value['run_id'])
            or not isinstance(value['expected_source_sha'], str)
            or not re.fullmatch(r'[0-9a-f]{40}', value['expected_source_sha'])):
        raise ValueError('invalid_request_identity')
    return value


def safe_read(path, *, owner, private=False, maximum=64 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner
                or stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022)):
            raise ValueError('file_authority_invalid')
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError('protected_input_too_large')
    return raw


def verify_install():
    manifest = json.loads(safe_read(CONFIG / 'install.json', owner=0, maximum=65536))
    account = pwd.getpwnam(manifest['runtime_owner'])
    if os.getuid() != account.pw_uid:
        raise ValueError('wrong_runtime_owner')
    if set(manifest['files']) != set(FILES):
        raise ValueError('fixed_installed_files_required')
    for name in FILES:
        raw = safe_read(INSTALL / name, owner=0)
        if hashlib.sha256(raw).hexdigest() != manifest['files'][name]:
            raise ValueError('installed_source_digest_mismatch')
    fixture_raw = safe_read(CONFIG / 'fixture.json', owner=account.pw_uid, private=True, maximum=1048576)
    if hashlib.sha256(fixture_raw).hexdigest() != manifest['fixture_sha256']:
        raise ValueError('approved_fixture_digest_mismatch')
    fixture = json.loads(fixture_raw)
    if (fixture.get('bindings_module') != str(INSTALL / 'bindings.cjs')
            or fixture.get('bindings_sha256') != manifest['files']['bindings.cjs']
            or fixture.get('collector_sha256') != manifest['files']['collector.cjs']
            or fixture.get('bindings', {}).get('public_bridge_path') != str(INSTALL / 'installed-public-core.py')
            or fixture.get('bindings', {}).get('public_bridge_sha256') != manifest['files']['installed-public-core.py']
            or fixture.get('public_core', {}).get('consumer_path') != str(INSTALL / 'public-rust-consumer.py')
            or fixture.get('public_core', {}).get('consumer_sha256') != manifest['files']['public-rust-consumer.py']
            or fixture.get('bindings', {}).get('browser_manager', {}).get('script_path') != str(INSTALL / 'ci-browser-fixture.mjs')
            or fixture.get('bindings', {}).get('browser_manager', {}).get('script_sha256') != manifest['files']['ci-browser-fixture.mjs']):
        raise ValueError('fixture_code_binding_mismatch')
    for directory in (STATE, STATE / 'requests', STATE / 'runs'):
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('private_run_root_invalid')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': account.pw_dir,
           'USER': account.pw_name, 'LOGNAME': account.pw_name,
           'XDG_RUNTIME_DIR': '/run/user/' + str(account.pw_uid),
           'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(account.pw_uid) + '/bus', 'NO_COLOR': '1'}
    extras = fixture.get('environment', {})
    if not isinstance(extras, dict) or any(k not in SAFE_ENV or not isinstance(v, str) or '\0' in v for k, v in extras.items()):
        raise ValueError('fixture_environment_invalid')
    env.update(extras)
    return account, fixture, env


def summary(report, request, exit_code):
    statuses = {'PASS', 'FAIL', 'UNKNOWN', 'BLOCKED', 'NOT_CREATED'}
    clean = lambda value: value if value in statuses else 'UNKNOWN'
    lanes = {}
    for name in ('chatgpt', 'zai', 'opencode', 'codex', 'zcode'):
        lane = report.get('lanes', {}).get(name, {})
        lanes[name] = {'checks': {key: clean(lane.get('checks', {}).get(key)) for key in (
            'create', 'reply', 'continue_same_session', 'read_both', 'vibe_session_visibility', 'open_details', 'owned_cleanup')}}
        code = lane.get('error_code')
        if isinstance(code, str) and re.fullmatch(r'[a-z_]{1,96}', code):
            lanes[name]['error_code'] = code
    result = {'mode': 'installed-browser', 'status': 'PASS' if exit_code == 0 and report.get('status') == 'PASS' else 'FAIL',
            'functional_status': clean(report.get('functional_status')),
            'global_inventory_status': report.get('global_inventory_status') if report.get('global_inventory_status') in ('VERIFIED', 'UNVERIFIED') else 'UNVERIFIED',
            'run_id': request['run_id'], 'source_sha': request['expected_source_sha'],
            'identity': clean(report.get('identity')), 'browser_cleanup': clean(report.get('browser_cleanup')),
            'lanes': lanes}
    code = report.get('error_code')
    if isinstance(code, str) and re.fullmatch(r'[a-z_]{1,96}', code): result['error_code'] = code
    if report.get('model_effects') in ('NOT_SUBMITTED', 'SUBMITTED_OR_UNKNOWN', 'UNKNOWN'):
        result['model_effects'] = report['model_effects']
    if isinstance(report.get('missing_harnesses'), list):
        result['missing_harnesses'] = [name for name in report['missing_harnesses'] if isinstance(name, str) and name in lanes]
    return result


def live_group_members(pgid):
    """This helper runs on Linux; ignore already exited, unreaped children."""
    members = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            if int(fields[2]) == pgid and fields[0] != 'Z':
                members.append(int(entry.name))
        except (OSError, ValueError, IndexError):
            pass
    return members


def run_owned_group(argv, env, *, timeout=1900, grace=10):
    """Own the whole collector group, including nested SDK/native readers.

    A timed out effect stays UNKNOWN in its private intent/receipt ledger.
    Neither this helper nor the workflow retries an accepted operation.
    """
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
    remaining = live_group_members(process.pid)
    terminated = bool(remaining)
    if remaining:
        # This group was created by this Popen, never supplied by the runner.
        for signum in (signal.SIGTERM, signal.SIGKILL):
            try: os.killpg(process.pid, signum)
            except ProcessLookupError: break
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline and live_group_members(process.pid):
                time.sleep(0.05)
            if not live_group_members(process.pid):
                break
    verified = not live_group_members(process.pid)
    try: process.wait(timeout=grace)
    except subprocess.TimeoutExpired: verified = False
    return {'returncode': process.returncode, 'timed_out': timed_out,
            'descendants_terminated': terminated, 'cleanup_verified': verified,
            'effect_outcome': 'UNKNOWN' if timed_out or terminated else 'FROM_PROTECTED_REPORT'}


def main():
    if len(sys.argv) != 1:
        raise ValueError('helper_accepts_no_arguments')
    request = request_input(sys.stdin.buffer.read(REQUEST_MAX + 1))
    account, fixture, env = verify_install()
    lock_fd = os.open(STATE / 'execution.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        request_path = STATE / 'requests' / (request['run_id'] + '.json')
        fd = os.open(request_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(request, stream); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        run_root = STATE / 'runs' / request['run_id']
        lifecycle = run_owned_group(
            ['/usr/bin/python3', '-I', str(INSTALL / 'candidate_release_gate.py'), '--installed-browser',
             str(INSTALL / 'collector.cjs'), str(CONFIG / 'fixture.json'), str(request_path), str(run_root)],
            env)
        lifecycle_path = STATE / 'requests' / (request['run_id'] + '.lifecycle.json')
        fd = os.open(lifecycle_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(lifecycle, stream); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        report = {}
        try: report = json.loads(safe_read(run_root / 'report.json', owner=account.pw_uid, private=True, maximum=1048576))
        except (OSError, ValueError): pass
        exit_code = lifecycle['returncode'] if lifecycle['cleanup_verified'] and not lifecycle['descendants_terminated'] else 2
        result = summary(report, request, exit_code)
        result['owned_process_cleanup'] = 'PASS' if lifecycle['cleanup_verified'] else 'FAIL'
        if lifecycle['timed_out'] or lifecycle['descendants_terminated']:
            result['error_code'] = 'owned_collector_timeout_or_incomplete_exit'
        print(json.dumps(result, sort_keys=True))
        return 0 if result['status'] == 'PASS' else 1
    finally:
        os.close(lock_fd)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        print(json.dumps({'mode': 'installed-browser', 'status': 'FAIL', 'error_code': 'fixed_helper_preflight_or_execution_failed'}))
        raise SystemExit(2)
