#!/usr/bin/env python3
"""Official local ZCode packaging journey in launch.py's loopback-only sandbox."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid

VERSION = '3.17.2'
REQUIRED_RUNTIME = ('node', 'zcode.cjs', 'server-cli.js', 'server-core.js', 'package.json')


def local_configuration(runtime=None, expected=None):
    if runtime is None and expected is None:
        return None
    if not runtime or not expected or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise ValueError('local ZCode runtime path and digest must be supplied together')
    root = Path(runtime)
    if not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError('local ZCode runtime must be an existing canonical directory')
    return {'mode': 'local', 'runtime': str(root), 'runtime_sha256': expected, 'version': VERSION}


def runtime_identity(runtime):
    root = Path(runtime)
    if not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError('official ZCode runtime directory unavailable')
    if any(not (root / name).is_file() or (root / name).is_symlink() for name in REQUIRED_RUNTIME):
        raise ValueError('official ZCode runtime capability files missing')
    if not os.access(root / 'node', os.X_OK):
        raise ValueError('official ZCode Node is not executable')
    if root.stat().st_mode & 0o022:
        raise ValueError('official runtime root is writable by another principal')
    entries, total = {}, 0
    for path in sorted(root.rglob('*')):
        before = path.lstat()
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve(strict=True).is_relative_to(root):
                raise ValueError('official runtime dependency escapes pinned directory')
            entries[name] = 'symlink:' + os.readlink(path)
        elif stat.S_ISREG(before.st_mode):
            if before.st_mode & 0o022:
                raise ValueError('official runtime is writable by another principal')
            value = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    value.update(block)
            after = path.lstat()
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('official runtime changed while hashing')
            entries[name] = value.hexdigest()
            total += before.st_size
        elif stat.S_ISDIR(before.st_mode):
            if before.st_mode & 0o022:
                raise ValueError('official runtime directory is writable by another principal')
        else:
            raise ValueError('unsupported official runtime file type')
        if len(entries) > 20000 or total > 1024 * 1024 * 1024:
            raise ValueError('official runtime inventory exceeds bound')
    encoded = ''.join(f'{name}\0{entries[name]}\n' for name in sorted(entries)).encode()
    return {'sha256': hashlib.sha256(encoded).hexdigest(), 'files': len(entries), 'bytes': total,
            'required': {name: entries[name] for name in REQUIRED_RUNTIME}}


def check_runtime(configuration):
    if configuration != local_configuration(configuration.get('runtime'), configuration.get('runtime_sha256')):
        raise ValueError('local ZCode configuration invalid')
    identity = runtime_identity(configuration['runtime'])
    if identity['sha256'] != configuration['runtime_sha256']:
        raise ValueError('official ZCode runtime digest mismatch')
    return identity


def terminate_owned(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
    return child.poll() is not None



def process_identity(pid, proc=Path('/proc')):
    try:
        fields = (proc / str(pid) / 'stat').read_text().rsplit(') ', 1)[1].split()
    except FileNotFoundError:
        return None
    return {'pid': pid, 'parent_pid': int(fields[1]), 'start_ticks': int(fields[19]),
            'state': fields[0], 'process_group': int(fields[2]), 'session': int(fields[3])}


def sqlite_snapshot(path):
    result = {}
    for item in (path, Path(str(path) + '-wal')):
        try:
            before = item.lstat()
        except FileNotFoundError:
            if item == path:
                raise ValueError('persisted fixture database missing')
            result[item.name] = None
            continue
        if not stat.S_ISREG(before.st_mode) or before.st_size > 64 * 1024 * 1024:
            raise ValueError('unexpected private native database file')
        raw = item.read_bytes()
        after = item.lstat()
        stamp = lambda value: [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns]
        if stamp(before) != stamp(after):
            raise ValueError('private native database changed during observation')
        result[item.name] = {'stamp': stamp(after), 'sha256': hashlib.sha256(raw).hexdigest()}
    return result



def index_snapshot(home):
    path = home / '.local/state/agent-herder/session-search/index.sqlite'
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        runs = [dict(row) for row in db.execute('SELECT * FROM search_run ORDER BY id LIMIT 5')]
        sources = [json.loads(row['receipt']) for row in db.execute("SELECT receipt FROM sources WHERE harness='zcode'")]
        owners = [dict(row) for row in db.execute('SELECT pid FROM search_owner LIMIT 5')]
    return {'path': str(path), 'runs': runs, 'sources': sources, 'owners': owners}


def namespace_process_inventory(database, proc=Path('/proc')):
    # Called only inside the already validated fresh launch.py PID/network sandbox.
    targets = {str(database), str(database) + '-wal', str(database) + '-shm'}
    entries = sorted((item for item in proc.iterdir() if item.name.isdigit()), key=lambda item: int(item.name))
    result = {'processes': [], 'truncated': len(entries) > 128}
    for entry in entries[:128]:
        try:
            identity = process_identity(int(entry.name), proc)
            if identity is None:
                continue
            row = {**identity, 'comm': (entry / 'comm').read_text().strip()[:120], 'native_fds': []}
            try:
                row['executable'] = os.readlink(entry / 'exe')[:1024]
            except OSError as error:
                row['executable_unavailable'] = type(error).__name__
            descriptors = list((entry / 'fd').iterdir())
            row['fd_inventory_truncated'] = len(descriptors) > 1024
            for fd in descriptors[:1024]:
                try:
                    target = os.readlink(fd)
                    if target.removesuffix(' (deleted)') not in targets:
                        continue
                    info = (entry / 'fdinfo' / fd.name).read_text()
                    flags = next(line.split(':', 1)[1].strip() for line in info.splitlines() if line.startswith('flags:'))
                    access = int(flags, 8) & os.O_ACCMODE
                    status = fd.stat()
                    row['native_fds'].append({'fd': int(fd.name), 'target': target, 'flags_octal': flags,
                        'access': {os.O_RDONLY: 'read_only', os.O_WRONLY: 'write_only', os.O_RDWR: 'read_write'}.get(access, 'unknown'),
                        'device': status.st_dev, 'inode': status.st_ino})
                except (OSError, ValueError, StopIteration) as error:
                    row['fd_observation_errors'] = row.get('fd_observation_errors', 0) + 1
            after = process_identity(int(entry.name), proc)
            row['identity_stable'] = after is not None and after['start_ticks'] == identity['start_ticks']
            result['processes'].append(row)
        except (OSError, ValueError, IndexError) as error:
            result['processes'].append({'pid': int(entry.name), 'observation_error': type(error).__name__})
    return result


def fixture_diagnostics(home):
    database = home / '.zcode/cli/db/db.sqlite'
    result = {'at_unix_ms': int(time.time() * 1000), 'native_database_path': str(database),
              'pid_namespace': os.readlink('/proc/self/ns/pid'), 'network_namespace': os.readlink('/proc/self/ns/net')}
    for name, observe in (
            ('native_database', lambda: sqlite_snapshot(database)),
            ('index', lambda: index_snapshot(home)),
            ('processes', lambda: namespace_process_inventory(database)),
            ('supervisor_status', lambda: json.loads((home / '.zcode/server/run/status.json').read_text()))):
        try:
            result[name] = observe()
        except Exception as error:
            result[name] = {'observation_error': type(error).__name__, 'detail': str(error)[:1000]}
    return result


def quiesce_for_persisted_search(runtime, home, project, server, native_env, observed):
    server_root = home / '.zcode/server'
    status = json.loads((server_root / 'run/status.json').read_text())
    if (server.poll() is not None or status.get('state') != 'ready'
            or status.get('version') != VERSION or type(status.get('pid')) is not int):
        raise ValueError('owned private official supervisor is not verified ready')
    supervisor, core = process_identity(server.pid), process_identity(status['pid'])
    if (supervisor is None or supervisor['parent_pid'] != os.getpid()
            or core is None or core['parent_pid'] != server.pid or native_env.get('ZCODE_SERVER_ROOT') != str(server_root)):
        raise ValueError('owned private runtime identity mismatch; no stop')
    command = [str(runtime / 'node'), str(runtime / 'server-cli.js'), 'stop', '--wait',
               '--server-root', str(server_root), '--json']
    result = subprocess.run(command, cwd=project, env=native_env, capture_output=True, text=True, timeout=30, check=False)
    observed['runtime_stop'] = {'command': command, 'returncode': result.returncode,
                               'stdout': result.stdout[-8000:], 'stderr': result.stderr[-8000:]}
    stopped = json.loads(result.stdout) if result.returncode == 0 else {}
    if (result.returncode or stopped.get('state') != 'stopped' or stopped.get('version') != VERSION
            or stopped.get('pid') is not None or stopped.get('runningTaskCount') != 0
            or stopped.get('serviceRegistered') is not False):
        raise ValueError('owned private official stop was not confirmed')
    server.wait(timeout=5)
    for identity in (supervisor, core):
        current = process_identity(identity['pid'])
        if current is not None and current['start_ticks'] == identity['start_ticks']:
            raise ValueError('owned private runtime remains alive after stop')
    database = home / '.zcode/cli/db/db.sqlite'
    for attempt in range(10):
        before = sqlite_snapshot(database)
        time.sleep(1)
        after = sqlite_snapshot(database)
        if before == after:
            return {'mode': 'persisted-after-official-shutdown', 'original_processes_gone': True,
                    'supervisor': supervisor, 'core': core, 'stop_status': stopped,
                    'database': str(database), 'stable_seconds': 1, 'stable_observation': after}
    raise ValueError('private native database did not become stable after official shutdown')


def run_zcode_candidate(release, source, configuration, *, evidence_directory=None):
    from candidate_driver import candidate_bundle_identity, candidate_store_identity
    from zcode_candidate_remote import tested_payload_digest
    release = Path(release)
    if (not re.fullmatch(r'[a-f0-9]{40}', source) or release.resolve(strict=True) != release
            or release.name != source):
        raise ValueError('exact candidate source directory required')
    runtime_before = check_runtime(configuration)
    bundle_before = candidate_bundle_identity(release)
    if bundle_before['source_sha'] != source:
        raise ValueError('candidate source manifest mismatch')
    payload_before, store_before = tested_payload_digest(release), candidate_store_identity(release)
    base = Path(__file__).resolve().parent
    for capability in ('unshare', 'bwrap', 'ip'):
        if not shutil.which(capability):
            raise ValueError('local ZCode isolation capability unavailable: ' + capability)
    command = [sys.executable, str(base / 'launch.py'), '--candidate', str(release),
               '--ro-bind', configuration['runtime'], '--', sys.executable, str(Path(__file__).resolve()),
               '--inside', str(release), source, configuration['runtime'], configuration['runtime_sha256']]
    if evidence_directory is None:
        evidence = Path(tempfile.mkdtemp(prefix='herder-zcode-gate-evidence-'))
    else:
        evidence = Path(evidence_directory)
        if not evidence.is_absolute() or evidence.parent.resolve(strict=True) != evidence.parent:
            raise ValueError('private fixture evidence parent must be canonical')
        evidence.mkdir(mode=0o700)
    write_private(evidence / 'intent.json', {'source': source, 'payload_sha256': payload_before,
                  'runtime': configuration, 'command': command})
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        try:
            stdout, stderr = child.communicate(timeout=210)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate_owned(child)
            stdout, stderr = child.communicate(timeout=5)
    finally:
        terminate_owned(child)
    observation = {'returncode': child.returncode, 'timed_out': timed_out,
                   'stdout': stdout[-64000:], 'stderr': stderr[-64000:]}
    failure = next((line[len('HERDER_ZCODE_FIXTURE_FAILURE '):] for line in reversed(stderr.splitlines())
                    if line.startswith('HERDER_ZCODE_FIXTURE_FAILURE ')), None)
    if failure:
        observation['fixture_failure'] = json.loads(failure)
    write_private(evidence / 'result.json', observation)
    if child.returncode or timed_out:
        detail = observation.get('fixture_failure', {}).get('error', stderr[-2400:])
        raise RuntimeError('local ZCode isolated journey failed; evidence=' + str(evidence)
                           + '; reason=' + str(detail)[-3000:])
    report = json.loads(stdout)
    report['execution_evidence'] = {'path': str(evidence / 'result.json'),
                                   'sha256': hashlib.sha256((evidence / 'result.json').read_bytes()).hexdigest()}
    if (runtime_before != check_runtime(configuration) or payload_before != tested_payload_digest(release)
            or bundle_before != candidate_bundle_identity(release) or store_before != candidate_store_identity(release)):
        raise ValueError('candidate or official runtime changed during local ZCode gate')
    if (report.get('source_sha') != source or report.get('local_runtime') != configuration
            or report.get('runtime_identity') != runtime_before
            or report.get('network') != 'private-loopback-only'
            or report.get('fresh_home') is not True or report.get('owned_processes_reaped') is not True):
        raise ValueError('local ZCode provenance or cleanup unverified')
    validate_local_report(report, payload_before)
    return report, payload_before


def validate_local_report(report, payload):
    from candidate_release_gate import validate_zcode_candidate
    row = validate_zcode_candidate(report, payload)
    quiet = report.get('source_quiescence', {})
    if (row.get('searchReadMode') != 'persisted-after-official-shutdown'
            or quiet.get('mode') != 'persisted-after-official-shutdown'
            or quiet.get('original_processes_gone') is not True or quiet.get('stable_seconds', 0) < 1
            or not quiet.get('stable_observation') or quiet.get('stop_status', {}).get('state') != 'stopped'):
        raise ValueError('persisted native search quiescence not proven')
    continuation = row.get('continuation')
    if (row.get('version') != VERSION or row['fixtureRequests'] < 3
            or not isinstance(continuation, dict) or continuation.get('confirmed') is not True
            or continuation.get('session_id') not in row['sessions']
            or row.get('deliveryMode') != 'immediate' or row.get('deferredQueueTested') is not False
            or continuation.get('mode') != 'immediate'
            or not isinstance(continuation.get('receipt'), dict)
            or continuation['receipt'].get('inputId') != continuation.get('input_id')
            or not continuation.get('input_id')
            or continuation['receipt'].get('ok') is not True or continuation['receipt'].get('pending') is True
            or not continuation['receipt'].get('nativeInputMessageId')
            or type(continuation.get('pages')) is not int or continuation['pages'] < 2):
        raise ValueError('official local continuation or version not proven')
    return row


def write_private(path, value):
    data = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def failure_observation(phase, observed, stats, log, error):
    diagnostics = observed.get('diagnostics')
    essential = {key: observed[key] for key in ('index_settings', 'executing_herder') if key in observed}
    observed = {key: value for key, value in observed.items() if key != 'diagnostics' and key not in essential}
    raw = json.dumps(observed, sort_keys=True)
    observed = observed if len(raw) <= 32000 else {'truncated': True, 'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'prefix': raw[:32000]}
    result = {'phase': phase, 'observed': observed, 'fixture_stats': stats,
              'log': log[-12000:], 'error_type': type(error).__name__, 'error': str(error)[-5000:]}
    result.update(essential)
    if diagnostics is not None:
        result['diagnostics'] = diagnostics
    if isinstance(error, subprocess.TimeoutExpired):
        child = {'timed_out': True, 'timeout_seconds': error.timeout}
        for name, value in (('stdout', error.stdout), ('stderr', error.stderr)):
            raw = value if isinstance(value, bytes) else (value or '').encode()
            child[name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                           'tail': raw[-8000:].decode(errors='replace'), 'truncated': len(raw) > 8000}
        result['subprocess'] = child
    if isinstance(error, urllib.error.HTTPError):
        raw = error.read(8001)
        result['http_error'] = {'status': error.code, 'url': error.url,
                                'body': raw[:8000].decode(errors='replace'), 'truncated': len(raw) > 8000}
    return result


def official_version(runtime):
    # The official product owns this supported JSON route; zcode.cjs is its bundled agent component.
    result = subprocess.run([str(Path(runtime) / 'node'), str(Path(runtime) / 'server-cli.js'),
                             'version', '--json'], capture_output=True, text=True, timeout=15, check=False)
    try:
        value = json.loads(result.stdout)
    except ValueError:
        value = None
    if result.returncode or value != {'product': 'zcode-server', 'version': VERSION}:
        raise ValueError('official ZCode version probe failed: exit=' + str(result.returncode)
                         + '; stdout=' + result.stdout[:300] + '; stderr=' + result.stderr[-700:])
    return value


def resident_source(meta, now=None):
    if meta.get('nativeStateObserved') is False:
        return None
    if meta.get('nativeLoaded') is True:
        return 'native_loaded'
    if 'nativeLoaded' in meta:
        return None
    if (meta.get('activityEvidence') != 'zcode-existing-native-snapshot'
            or meta.get('nativeActivityFresh') is not True
            or meta.get('nativeExecutor') != 'official-server'
            or meta.get('deliveryRoute') != 'official-server-ws'
            or type(meta.get('nativeRuntimePid')) is not int or meta['nativeRuntimePid'] <= 1
            or type(meta.get('nativeRuntimeGeneration')) is not int or meta['nativeRuntimeGeneration'] < 1):
        return None
    observed, expires = meta.get('activityObservedAt'), meta.get('activityExpiresAt')
    if not all(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value) for value in (observed, expires)):
        return None
    try:
        observed = datetime.fromisoformat(observed.replace('Z', '+00:00')).timestamp()
        expires = datetime.fromisoformat(expires.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None
    now = time.time() if now is None else now
    return 'official_existing_snapshot' if 0 <= now - observed <= 10 and now < expires <= observed + 30 else None


def verified_idle(api, sid, project, model, *, timeout=30, expected_receipt=None):
    deadline = time.monotonic() + timeout
    while True:
        session = api('/api/sessions/zcode/' + urllib.parse.quote(sid, safe='')).get('session', {})
        meta = session.get('meta', {})
        source = resident_source(meta)
        if (session.get('id') != sid or session.get('harness') != 'zcode'
                or session.get('cwd') != project or session.get('model') != model
                or source is None or meta.get('humanStopHeld') is not False or meta.get('humanStop') is True
                or meta.get('automationStop') or session.get('needsPermission') is not False
                or meta.get('pendingRequestIds') != [] or meta.get('permissionMode') != 'yolo'
                or ('permissionRulesRevision' in meta and type(meta['permissionRulesRevision']) is not int)
                or type(meta.get('nativeStateRevision')) is not int):
            raise ValueError('exact resident model/permission/stop/queue proof unavailable; no send')
        last = meta.get('nativeLastTurn')
        completed = expected_receipt is None
        if expected_receipt is not None and isinstance(last, dict):
            exact_input = last.get('userMessageId') == expected_receipt['nativeInputMessageId']
            if exact_input and (last.get('cancelledByUser') is True or last.get('status') in ('error', 'cancelled')):
                raise ValueError('delivered native turn did not complete successfully; no replay')
            completed = (exact_input and last.get('status') == 'completed'
                         and last.get('cancelledByUser') is False and last.get('pendingInput') is False
                         and type(last.get('completedAt')) is int and last['completedAt'] > 0
                         and isinstance(last.get('turnId'), str) and bool(last['turnId'])
                         and (not expected_receipt.get('turnId') or last['turnId'] == expected_receipt['turnId']))
        if (session.get('status') == 'idle' and meta.get('nativeStatus') == 'idle'
                and not meta.get('nativeActiveTurnId') and not meta.get('nativeActiveTurnKind') and completed):
            proof = {'native_state_revision': meta['nativeStateRevision'], 'model': model, 'resident_source': source,
                     'permission_mode': meta['permissionMode'], 'permission_revision': meta.get('permissionRulesRevision'),
                     'permission_revision_observed': 'permissionRulesRevision' in meta}
            if expected_receipt is not None:
                proof['completed_input_id'], proof['completed_turn_id'] = last['userMessageId'], last['turnId']
            return proof
        if session.get('status') not in ('running', 'idle') or time.monotonic() >= deadline:
            raise ValueError('resident session not verified idle with exact completed input; no send')
        time.sleep(.2)


def send_immediate(api, transcript, sid, marker, project, model, *, timeout=30):
    before = verified_idle(api, sid, project, model, timeout=timeout)
    # Ordinary published immediate HTTP input. Never claim the refused deferred-only queue capability.
    receipt = api('/api/sessions/zcode/' + urllib.parse.quote(sid, safe='') + '/message',
                  {'message': marker, 'mode': 'sync', 'inputId': marker, 'humanRequested': True})
    if (receipt.get('ok') is not True or receipt.get('pending') is True or receipt.get('notSubmitted') is True
            or receipt.get('inputId') != marker or not isinstance(receipt.get('nativeInputMessageId'), str)
            or not receipt['nativeInputMessageId']):
        raise ValueError('immediate native receipt unconfirmed; no replay: ' + json.dumps(receipt)[:4000])
    completed = verified_idle(api, sid, project, model, timeout=timeout, expected_receipt=receipt)
    deadline = time.monotonic() + timeout
    while True:
        try:
            pages = transcript('zcode', sid, marker)
            break
        except ValueError as error:
            if str(error) != 'exact input followed by fixture answer missing' or time.monotonic() >= deadline:
                raise
            time.sleep(.2)
    if type(pages) is not int or pages < 2:
        raise ValueError('immediate complete transcript unverified')
    after = verified_idle(api, sid, project, model, timeout=timeout, expected_receipt=receipt)
    if (before['model'], before['permission_mode'], before['permission_revision'], before['permission_revision_observed']) != (
            after['model'], after['permission_mode'], after['permission_revision'], after['permission_revision_observed']):
        raise ValueError('native model or permission changed during fixture input')
    return {'session_id': sid, 'receipt': receipt, 'input_id': marker, 'pages': pages,
            'confirmed': True, 'mode': 'immediate', 'idle_before': before, 'completed_before_transcript': completed, 'idle_after': after}


def run_local_journey(api, transcript, project, model):
    settings = api('/api/settings')
    if not any(p.get('path') == project for p in settings.get('projects', []) if isinstance(p, dict)):
        raise ValueError('exact fixture project not listed')
    before = api('/_stats')['requests']
    sessions = []
    for _ in range(2):
        marker = 'HERDER_CI_' + uuid.uuid4().hex
        created = api('/api/sessions', {'harness': 'zcode', 'name': marker, 'cwd': project, 'model': model})
        sid = created.get('sessionId') or (created.get('session') or {}).get('id')
        if not isinstance(sid, str) or not sid or sid in [s['id'] for s in sessions]:
            raise ValueError('fresh distinct native session ID missing; no replay')
        result = send_immediate(api, transcript, sid, marker, project, model)
        sessions.append({'id': sid, 'pages': result['pages'], 'marker': marker, 'delivery': result})
    deadline = time.monotonic() + 30
    while True:
        listing = api('/api/sessions?harness=zcode&limit=100').get('sessions', [])
        if all(any(s.get('id') == item['id'] and s.get('harness') == 'zcode'
                   for s in listing if isinstance(s, dict)) for item in sessions):
            break
        if time.monotonic() >= deadline:
            raise ValueError('both exact native sessions not listed')
        time.sleep(.2)
    return {'status': 'INCOMPLETE', 'harness': 'zcode', 'sessions': sessions,
            'fixtureRequests': api('/_stats')['requests'] - before, 'missing': ['search', 'installed-process']}


def continue_session(api, transcript, session, project, model):
    return send_immediate(api, transcript, session['id'], 'HERDER_CI_CONTINUE_' + uuid.uuid4().hex, project, model)


def inside(release, source, configuration):
    from candidate_driver import candidate_bundle_identity, candidate_store_identity, validate_isolation
    from candidate_stand import require_sandbox, port, ready, fixture_peer, write_fixture_quota, diagnostic_tail
    from herder_transcript_http import NoRedirect, read_transcript
    from search_proof import attach_search_proof
    from v1_zcode_stand import prepare_official_fixture, setup_official_project
    from zcode_candidate_remote import tested_payload_digest
    release, runtime, home = Path(release), Path(configuration['runtime']), Path(os.environ['HOME'])
    own = os.stat('/proc/self/ns/net')
    require_sandbox(f'{own.st_dev}:{own.st_ino}', os.environ.get('HERDER_FIXTURE_PARENT_NET', ''),
                    str(home), bool(os.statvfs(release).f_flag & os.ST_RDONLY))
    if not os.statvfs(runtime).f_flag & os.ST_RDONLY:
        raise ValueError('official runtime must be mounted read-only')
    def ip(*args):
        return json.loads(subprocess.check_output(['ip', '-j', *args], timeout=5))
    fixture = os.environ['HERDER_TEST_MODEL_BASE_URL']
    project = home / 'work'
    project.mkdir(mode=0o700)
    validate_isolation(ip('link', 'show'), ip('-4', 'route', 'show'), ip('-6', 'route', 'show'),
                       str(project), 'http://127.0.0.1:1', fixture.removesuffix('/v1'))
    runtime_before = check_runtime(configuration)
    bundle_before, store_before = candidate_bundle_identity(release), candidate_store_identity(release)
    payload_before = tested_payload_digest(release)
    if bundle_before['source_sha'] != source or release.name != source:
        raise ValueError('isolated candidate source mismatch')
    entry = prepare_official_fixture(home, runtime / 'zcode.cjs', fixture)
    # The official entry is byte-identical; its optional installed dependencies stay read-only.
    for name in ('node_modules', 'packages', 'tools'):
        if (runtime / name).exists():
            (entry.parent / name).symlink_to(runtime / name, target_is_directory=True)
    node = runtime / 'node'
    version = official_version(runtime)
    server_root = home / '.zcode/server'
    server_root.mkdir(mode=0o700, parents=True)
    native_env = dict(os.environ, ZCODE_DATA_BASE_DIR=str(home), ZCODE_SERVER_ROOT=str(server_root),
        ZCODE_SERVER_SKIP_SERVICE_REGISTRATION='1', ZCODE_SERVER_RUNTIME_ROOT=str(runtime),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=str(entry.parent / 'provider/zcode-builtin.json'),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=str(home / '.zcode/v2/provider_config.json'),
        ZCODE_AGENT_SERVER_COMMAND=str(node),
        ZCODE_AGENT_SERVER_ARGS_JSON=json.dumps([str(entry), 'app-server', '--stdio']))
    listen = port()
    settings = home / '.local/state/agent-herder/settings'
    settings.mkdir(parents=True)
    (settings / 'projects.json').write_text(json.dumps([{'id': 'ci', 'name': 'CI', 'path': str(project)}]))
    quota = write_fixture_quota(home)
    env = dict(native_env, PATH=str(runtime) + ':/usr/local/bin:/usr/bin:/bin',
        ZCODE_CWD=str(project), ZCODE_BIN=str(node), ZCODE_ARGS=json.dumps([str(entry), 'app-server', '--stdio']),
        AGENT_HERDER_WEB_HOST='127.0.0.1', AGENT_HERDER_WEB_PORT=str(listen),
        AGENT_HERDER_HTTP_TOKEN='fixture-only', HERDER_CI_TOKEN='fixture-only',
        AGENT_HERDER_SINGLETON_LOCK=str(home / 'instance.lock'), AGENT_HERDER_WORKLOAD_ISOLATION='off',
        AGENT_HERDER_AUTOPILOT_STATE_DIR=str(quota), AGENT_HERDER_FLEET_ADMISSION='retired',
        AGENT_HERDER_FLEET_PEERS=json.dumps(fixture_peer(socket.gethostname(), listen, pwd.getpwuid(os.getuid()).pw_name)),
        ENABLE_ZCODE='true', ENABLE_CODEX='false', ENABLE_OPENCODE='false', ENABLE_CLAUDE='false',
        ENABLE_QODER='false', ENABLE_HERMES='false', ENABLE_MINIMAX_CODE='false', ENABLE_FAST_AGENT='false')
    children, reaped = [], False
    observed, phase = {'created': [], 'last_job': None, 'last_delivery': None, 'selected_model': 'fixture/herder-test$disabled'}, 'supervisor_start'
    log_path = home / 'local-zcode-gate.log'
    with log_path.open('w') as log:
        try:
            server = subprocess.Popen([str(node), str(runtime / 'server-cli.js'), 'serve',
                '--server-root', str(server_root), '--json'], cwd=project, env=native_env,
                stdout=log, stderr=log, start_new_session=True)
            children.append(server)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError('official ZCode supervisor exited')
                try:
                    status = json.loads((server_root / 'run/status.json').read_text())
                    if status.get('state') == 'ready' and (server_root / 'run/control.sock').is_socket():
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError('official ZCode supervisor readiness timeout')
            phase = 'project_setup'
            setup = setup_official_project(node, home, project, home, release / 'dist')
            phase = 'herder_start'
            herder = subprocess.Popen([str(node), str(release / 'dist/index.js')], cwd=project, env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            children.append(herder)
            executable = Path(f'/proc/{herder.pid}/exe')
            executable_hash = hashlib.sha256()
            with executable.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    executable_hash.update(block)
            observed['executing_herder'] = {'process': process_identity(herder.pid),
                'executable': os.readlink(executable), 'sha256': executable_hash.hexdigest()}
            origin, model_origin = f'http://127.0.0.1:{listen}', fixture.removesuffix('/v1')
            ready(origin + '/api/settings', herder)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            def api(path, body=None, method=None):
                root = model_origin if path == '/_stats' else origin
                request = urllib.request.Request(root + path, data=json.dumps(body).encode() if body is not None else None,
                    method=method, headers={'Origin': origin, 'Content-Type': 'application/json'})
                try:
                    with opener.open(request, timeout=45) as response:
                        raw = response.read(4_000_001)
                except urllib.error.HTTPError as error:
                    raw = error.read(64000)
                    observed['http_error'] = {'path': path, 'status': error.code, 'body': raw.decode(errors='replace')}
                    raise ValueError('fixture HTTP ' + str(error.code) + ': ' + raw.decode(errors='replace')[:4000]) from error
                if len(raw) > 4_000_000:
                    raise ValueError('fixture response exceeds bound')
                result = json.loads(raw)
                if path == '/api/sessions' and body is not None:
                    observed['created'].append(result)
                if path.startswith('/api/jobs/'):
                    observed['last_job'] = result
                if path.endswith('/message'):
                    observed['last_delivery'] = result
                if path.startswith('/api/sessions/zcode/') and body is None and 'session' in result:
                    observed['last_session'] = result
                return result
            def transcript(harness, sid, marker):
                return read_transcript(origin, socket.gethostname(), harness, sid, marker, 'HERDER_TEST_MODEL_OK')
            requests_before = api('/_stats')['requests']
            phase = 'two_session_immediate_journey'
            journey = run_local_journey(api, transcript, str(project), 'fixture/herder-test$disabled')
            phase = 'same_session_immediate_continuation'
            continuation = continue_session(api, transcript, journey['sessions'][0], str(project), 'fixture/herder-test$disabled')
            phase = 'persisted_source_quiescence'
            observed['index_settings'] = [{'operation': 'pause', 'at_unix_ms': int(time.time() * 1000),
                'response': api('/api/settings/background-indexing', {'enabled': False}, method='PUT')}]
            quiescence = quiesce_for_persisted_search(runtime, home, project, server, native_env, observed)
            observed['source_quiescence'] = quiescence
            observed['diagnostics'] = {'before_scan': fixture_diagnostics(home)}
            # The first enabled ACK starts a scan; the second waits for that normal scan.
            for operation in ('start', 'await'):
                observed['index_settings'].append({'operation': operation, 'at_unix_ms': int(time.time() * 1000),
                    'response': api('/api/settings/background-indexing', {'enabled': True}, method='PUT')})
            observed['diagnostics']['after_scan_ack'] = fixture_diagnostics(home)
            phase = 'exact_session_search'
            search = subprocess.run([str(node), str(Path(__file__).with_name('herder_search.mjs')),
                str(release / 'dist'), origin, json.dumps([journey])], env=env, cwd=project,
                capture_output=True, text=True, timeout=60, check=False)
            observed['diagnostics']['after_search'] = fixture_diagnostics(home)
            if search.returncode:
                raise RuntimeError('ZCode exact session search failed: ' + search.stderr[-1200:])
            verified = attach_search_proof(journey, json.loads(search.stdout), socket.gethostname())
            if (runtime_before != check_runtime(configuration) or payload_before != tested_payload_digest(release)
                    or bundle_before != candidate_bundle_identity(release) or store_before != candidate_store_identity(release)):
                raise ValueError('isolated candidate identity changed')
            report = {'scope': 'isolated-candidate-only', 'status': 'PASS', 'artifact_consistent': True,
                'artifact_sha256': payload_before, 'source_sha': source, 'local_runtime': configuration,
                'runtime_identity': runtime_before, 'official_version': version, 'candidate_bundle': bundle_before, 'dependency_store': store_before,
                'network': 'private-loopback-only', 'fresh_home': True, 'project_id': setup['project_id'],
                'source_quiescence': quiescence, 'diagnostics': observed['diagnostics'],
                'index_settings': observed['index_settings'], 'executing_herder': observed['executing_herder'],
                'reports': [{'scope': 'zcode-official-project', 'version': VERSION, 'deliveryMode': 'immediate',
                    'deferredQueueTested': False, 'searchReadMode': 'persisted-after-official-shutdown',
                    'deliveries': [item['delivery'] for item in verified['sessions']],
                    'fixtureRequests': api('/_stats')['requests'] - requests_before, 'sessions': [s['id'] for s in verified['sessions']],
                    'transcriptPages': [s['pages'] for s in verified['sessions']],
                    'sessionsCreated': True, 'sessionsListed': True, 'sessionsSearched': verified['searchProven'],
                    'projectListed': True, 'answer': True, 'transcriptComplete': True,
                    'continuation': continuation}]}
        except Exception as error:
            if 'diagnostics' in observed and 'after_search' not in observed['diagnostics']:
                observed['diagnostics']['after_failure'] = fixture_diagnostics(home)
            log.flush()
            try:
                with urllib.request.urlopen(fixture.removesuffix('/v1') + '/_stats', timeout=3) as response:
                    stats = json.load(response)
            except Exception as observation_error:
                stats = {'unavailable': type(observation_error).__name__}
            failure = failure_observation(phase, observed, stats, diagnostic_tail(log_path), error)
            print('HERDER_ZCODE_FIXTURE_FAILURE ' + json.dumps(failure, sort_keys=True), file=sys.stderr, flush=True)
            raise RuntimeError('isolated ZCode fixture failed; structured evidence emitted before cleanup') from error
        finally:
            reaped = all([terminate_owned(child) for child in reversed(children)])
    if not reaped:
        raise RuntimeError('owned fixture child cleanup unverified')
    report['owned_processes_reaped'] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--runtime-digest')
    parser.add_argument('arguments', nargs='*')
    args = parser.parse_args()
    if args.runtime_digest:
        if args.inside or args.arguments:
            raise ValueError('runtime digest mode has no execution arguments')
        print(json.dumps(runtime_identity(args.runtime_digest), sort_keys=True))
        return 0
    if len(args.arguments) != 4:
        raise ValueError('release, source, official runtime and digest are required')
    release, source, runtime, expected = args.arguments
    configuration = local_configuration(runtime, expected)
    result = inside(release, source, configuration) if args.inside else run_zcode_candidate(release, source, configuration)[0]
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
