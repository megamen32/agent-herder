#!/usr/bin/python3
"""Reviewable, reversible provisioning for the dedicated installed browser CI job.

Default --plan is read-only. --install needs root and reviewed bundle/fixture
inputs. Registration uses the official GitHub API; its short-lived token is
passed through the runner's documented ACTIONS_RUNNER_INPUT_TOKEN environment.
No personal browser or native service is started by this installer.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

REPOSITORY = 'megamen32/agent-herder'
RUNNER_USER = 'agent-herder-ci'
RUNNER_NAME = 'herder-installed-server100'
RUNNER_LABEL = 'agent-herder-installed-server100'
RUNNER_HOME = Path('/var/lib/agent-herder-ci-runner')
RUNNER_ROOT = Path('/opt/agent-herder-ci-runner')
INSTALL = Path('/opt/agent-herder-ci-smoke')
CONFIG = Path('/etc/agent-herder-ci-smoke')
STATE = Path('/var/lib/agent-herder-ci-smoke')
HELPER = Path('/usr/local/libexec/agent-herder-ci-smoke')
SUDOERS = Path('/etc/sudoers.d/agent-herder-ci-smoke')
UNIT = 'agent-herder-installed-ci.service'
# Verified from official repos/actions/runner/releases/latest, 2026-11-08 UTC.
RUNNER_VERSION = '2.338.2'
RUNNER_ASSET = 'actions-runner-linux-x64-' + RUNNER_VERSION + '.tar.gz'
RUNNER_SHA256 = 'baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40'
RUNNER_URL = 'https://github.com/actions/runner/releases/download/v' + RUNNER_VERSION + '/' + RUNNER_ASSET


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def safe_runner_archive_filter(member, destination):
    """Keep data-filter protection while fixing the old symlink anchor bug."""
    if member.name.startswith('/') or '..' in Path(member.name).parts or member.isdev():
        raise ValueError('unsafe_official_runner_archive')
    if not member.issym():
        return tarfile.data_filter(member, destination)
    if os.path.isabs(member.linkname):
        raise ValueError('unsafe_official_runner_symlink')
    root = os.path.realpath(destination)
    # Resolve the parent before the new link. An existing destination symlink
    # must never supply the anchor for a replacement link's relative target.
    target = os.path.realpath(os.path.join(root, os.path.dirname(member.name), member.linkname))
    if os.path.commonpath([root, target]) != root:
        raise ValueError('unsafe_official_runner_symlink')
    filtered = copy.copy(tarfile.tar_filter(member, destination))
    filtered.uid = filtered.gid = filtered.uname = filtered.gname = None
    filtered.mode = None
    return filtered


def extract_runner_archive(archive, destination):
    if digest(archive) != RUNNER_SHA256:
        raise ValueError('runner_download_digest_mismatch')
    with tarfile.open(archive) as payload:
        payload.extractall(destination, filter=safe_runner_archive_filter)


def runner_tree_digest(root):
    """Hash contents, links, ownership and modes without following symlinks."""
    root = Path(root)
    pending = [root]
    records = []
    while pending:
        path = pending.pop()
        info = path.lstat()
        record = {'path': str(path.relative_to(root)), 'mode': stat.S_IMODE(info.st_mode),
                  'uid': info.st_uid, 'gid': info.st_gid}
        if stat.S_ISDIR(info.st_mode):
            record['kind'] = 'directory'
            pending.extend(sorted(path.iterdir(), reverse=True))
        elif stat.S_ISREG(info.st_mode):
            record.update(kind='file', sha256=digest(path))
        elif stat.S_ISLNK(info.st_mode):
            record.update(kind='symlink', target=os.readlink(path))
        else:
            raise ValueError('unexpected_partial_runner_file_type')
        records.append(record)
    return hashlib.sha256(json.dumps(records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_resume_binding(plan, failed, intent, current):
    user = current.get('runner_user', {})
    if (plan.get('version') != 1 or failed.get('status') != 'FAILED' or failed.get('exit_code') != 1
            or failed.get('timed_out') is not False or failed.get('error_class') is not None
            or failed.get('install_manifest_exists') is not False
            or failed.get('intent_sha256') != plan.get('original_intent_sha256')
            or failed.get('reviewed_source_sha') != intent.get('reviewed_source_sha')
            or intent.get('action') != 'provision_dedicated_installed_ci_runner'
            or intent.get('prior_install') != 'ABSENT' or intent.get('shared_runtime_mutations') is not False
            or current != plan.get('partial_state') or current.get('registration_markers') != []
            or user.get('name') != RUNNER_USER or user.get('uid') != plan.get('runner_uid')
            or not isinstance(user.get('uid'), int) or user['uid'] <= 0
            or user.get('home') != str(RUNNER_HOME) or user.get('shell') != '/usr/sbin/nologin'):
        raise ValueError('owned_partial_resume_binding_mismatch')


def claim_resume(directory, record):
    path = Path(directory) / 'resume-intent.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(record, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(directory, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def protected_resume_bytes(path, expected):
    path = Path(path)
    info = path.lstat()
    parent = path.parent.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600
            or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) != 0o700
            or not re.fullmatch(r'[a-f0-9]{64}', expected or '') or digest(path) != expected):
        raise ValueError('protected_resume_evidence_required')
    return path.read_bytes()


def partial_install_state(owner, files, helper_source, fixture_raw):
    runner = pwd.getpwnam(RUNNER_USER)
    root_info = RUNNER_ROOT.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != 0 or root_info.st_mode & 0o022:
        raise ValueError('owned_partial_runner_root_required')
    expected = [(INSTALL / name, value, 0, 0o644) for name, value in files.items()]
    expected += [(HELPER, digest(helper_source), 0, 0o755),
                 (CONFIG / 'fixture.json', hashlib.sha256(fixture_raw).hexdigest(), owner.pw_uid, 0o600)]
    for path, value, uid, mode in expected:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode
                or digest(path) != value):
            raise ValueError('owned_partial_installed_input_changed')
    markers = [str(path) for path in [CONFIG / 'install.json', SUDOERS,
               Path('/etc/systemd/system') / UNIT,
               *[RUNNER_ROOT / name for name in ('.runner', '.credentials', '.credentials_rsaparams', '.service')]]
               if path.exists() or path.is_symlink()]
    return {'runner_user': {'name': runner.pw_name, 'uid': runner.pw_uid, 'gid': runner.pw_gid,
                            'home': runner.pw_dir, 'shell': runner.pw_shell},
            'runner_tree_sha256': runner_tree_digest(RUNNER_ROOT), 'installed_files': files,
            'helper_sha256': digest(helper_source), 'fixture_sha256': hashlib.sha256(fixture_raw).hexdigest(),
            'registration_markers': markers}


def prepare_owned_resume(args, owner, files, helper_source, fixture_raw):
    path = Path(args.resume_plan)
    plan = json.loads(protected_resume_bytes(path, args.resume_plan_sha256))
    if plan.get('reviewed_source_sha') != args.reviewed_source_sha:
        raise ValueError('resume_reviewed_source_mismatch')
    directory = path.parent
    failed = json.loads(protected_resume_bytes(directory / 'receipt.json', plan.get('failed_receipt_sha256')))
    intent = json.loads(protected_resume_bytes(directory / 'intent.json', plan.get('original_intent_sha256')))
    original = json.loads(protected_resume_bytes(directory / 'packet.json', intent.get('packet_sha256')))
    source = json.loads(protected_resume_bytes(directory / 'source-freeze.json', original.get('source_freeze_sha256')))
    log = protected_resume_bytes(directory / 'provision.log', failed.get('log_sha256')).decode(errors='replace')
    if ("tarfile.LinkOutsideDestinationError: './externals/node20/bin/corepack'" not in log
            or original.get('reviewed_source_sha') != failed.get('reviewed_source_sha')
            or {name: item['sha256'] for name, item in original['artifact_inputs'].items()} != files
            or source['files']['deploy/fleet/installed-smoke-helper.py'] != digest(helper_source)):
        raise ValueError('recorded_pre_registration_failure_required')
    current = partial_install_state(owner, files, helper_source, fixture_raw)
    validate_resume_binding(plan, failed, intent, current)
    archive = directory / 'official-runner-v2.338.2.tar.gz'
    protected_resume_bytes(archive, RUNNER_SHA256)
    claim_resume(directory, {'status': 'DISPATCH_INTENT', 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            'resume_plan_sha256': args.resume_plan_sha256,
                            'original_receipt_sha256': plan['failed_receipt_sha256'],
                            'reviewed_source_sha': args.reviewed_source_sha, 'no_replay': True})
    return archive


def execute(argv, *, user=None, env=None, cwd=None, timeout=120):
    command = (['/usr/sbin/runuser', '-u', user, '--'] if user else []) + list(argv)
    result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Do not echo config.sh output, gh tokens, environment or command args.
        raise RuntimeError('provision_command_failed')
    return result.stdout


def gh(owner, path, method='GET'):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': pwd.getpwnam(owner).pw_dir}
    return json.loads(execute(['/usr/bin/gh', 'api', '--method', method, path], user=owner, env=env))


def write_owned(path, data, mode=0o644, uid=0, gid=0):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('refuse_symlink_destination')
    tmp = path.with_name(path.name + '.provision-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
            stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    except BaseException:
        try: tmp.unlink()
        except FileNotFoundError: pass
        raise


def plan():
    return {'mode': 'plan', 'repository': REPOSITORY, 'runner_name': RUNNER_NAME,
            'runner_label': RUNNER_LABEL, 'runner_user': RUNNER_USER,
            'version': RUNNER_VERSION, 'asset_sha256': RUNNER_SHA256,
            'service': UNIT, 'helper': str(HELPER), 'fixture': str(CONFIG / 'fixture.json'),
            'registration': 'not_performed', 'native_effects': 'not_performed'}


def runner_service_unit():
    return ('[Unit]\nDescription=Agent Herder installed browser CI runner\nAfter=network-online.target\nWants=network-online.target\n'
            '[Service]\nUser=' + RUNNER_USER + '\nWorkingDirectory=' + str(RUNNER_ROOT)
            + '\nExecStart=' + str(RUNNER_ROOT / 'bin/runsvc.sh')
            + '\nEnvironment=HOME=' + str(RUNNER_HOME)
            + '\nUMask=0077\nRestart=always\nRestartSec=10\nTimeoutStopSec=90\nKillMode=mixed\n'
            '[Install]\nWantedBy=multi-user.target\n')


def install(args):
    if os.geteuid() != 0 or os.uname().machine != 'x86_64':
        raise ValueError('root_linux_x64_required')
    if not re.fullmatch(r'[0-9a-f]{40}', args.reviewed_source_sha or ''):
        raise ValueError('reviewed_source_sha_required')
    owner = pwd.getpwnam(args.runtime_owner)
    resuming = bool(args.resume_plan or args.resume_plan_sha256)
    if resuming and not (args.resume_plan and args.resume_plan_sha256):
        raise ValueError('explicit_reviewed_resume_plan_required')
    inputs = {'collector.cjs': Path(args.collector), 'bindings.cjs': Path(args.bindings),
              'candidate_release_gate.py': Path(__file__).resolve().parents[2] / 'tests/native/candidate_release_gate.py',
              'installed-public-core.py': Path(__file__).resolve().parents[2] / 'tests/native/installed-public-core.py',
              'public-rust-consumer.py': Path(__file__).resolve().parents[2] / 'tests/v1-restored-workflows/noticeplace-native-canary.py',
              'ci-browser-fixture.mjs': Path(args.browser_manager)}
    helper_source = Path(__file__).with_name('installed-smoke-helper.py')
    for path in [*inputs.values(), helper_source, Path(args.fixture), Path(args.node)]:
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ValueError('explicit_regular_install_input_required')
    if not resuming:
        if any(path.exists() for path in (CONFIG / 'install.json', RUNNER_ROOT, HELPER, SUDOERS, Path('/etc/systemd/system') / UNIT)):
            raise ValueError('existing_install_refused_use_reviewed_refresh_or_remove')
        try: pwd.getpwnam(RUNNER_USER)
        except KeyError: pass
        else: raise ValueError('existing_os_user_refused')
    existing = gh(args.runtime_owner, 'repos/' + REPOSITORY + '/actions/runners')
    if any(r.get('name') == RUNNER_NAME for r in existing.get('runners', [])):
        raise ValueError('existing_runner_name_refused')
    release = gh(args.runtime_owner, 'repos/actions/runner/releases/tags/v' + RUNNER_VERSION)
    asset = next((a for a in release.get('assets', []) if a.get('name') == RUNNER_ASSET), None)
    if not asset or asset.get('browser_download_url') != RUNNER_URL or asset.get('digest') != 'sha256:' + RUNNER_SHA256:
        raise ValueError('official_runner_release_digest_mismatch')
    fixture = json.loads(Path(args.fixture).read_text())
    # The private fixture is supplied by the owner after actual QA auth and
    # native/provider/process-identity preflight; the installer does not invent it.
    if (fixture.get('qa', {}).get('isolated') is not True
            or fixture.get('qa', {}).get('human_delivery') is not False
            or set(fixture.get('lanes', {})) != {'chatgpt','zai','opencode','codex','zcode'}
            or not re.fullmatch(r'[0-9a-f]{64}', fixture.get('expected_artifact_sha256', ''))):
        raise ValueError('approved_complete_fixture_required')
    files = {name: digest(path) for name, path in inputs.items()}
    fixture.update(node_executable=str(Path(args.node).resolve()), node_sha256=digest(args.node),
                   collector_sha256=files['collector.cjs'], bindings_module=str(INSTALL / 'bindings.cjs'),
                   bindings_sha256=files['bindings.cjs'])
    if not isinstance(fixture.get('bindings'), dict):
        raise ValueError('concrete_runtime_bindings_required')
    fixture['bindings'].update(public_bridge_path=str(INSTALL / 'installed-public-core.py'),
                               public_bridge_sha256=files['installed-public-core.py'])
    if not isinstance(fixture.get('public_core'), dict):
        raise ValueError('maintained_public_consumer_configuration_required')
    fixture['public_core'].update(consumer_path=str(INSTALL / 'public-rust-consumer.py'),
                                  consumer_sha256=files['public-rust-consumer.py'])
    manager = fixture['bindings'].get('browser_manager')
    config_path = CONFIG / 'browser-fixture.json'
    info = config_path.lstat()
    if (not isinstance(manager, dict) or manager.get('config_path') != str(config_path)
            or not config_path.is_file() or config_path.is_symlink() or info.st_uid != 0
            or info.st_gid != owner.pw_gid or info.st_mode & 0o777 != 0o640
            or digest(config_path) != manager.get('config_sha256')):
        raise ValueError('reviewed_managed_browser_configuration_required')
    manager.update(script_path=str(INSTALL / 'ci-browser-fixture.mjs'), script_sha256=files['ci-browser-fixture.mjs'])
    fixture_raw = (json.dumps(fixture, indent=2) + '\n').encode()
    with tempfile.TemporaryDirectory(prefix='herder-ci-runner-') as temp:
        if resuming:
            archive = prepare_owned_resume(args, owner, files, helper_source, fixture_raw)
        else:
            archive = Path(temp) / RUNNER_ASSET
            with urllib.request.urlopen(RUNNER_URL, timeout=120) as response, archive.open('wb') as target:
                shutil.copyfileobj(response, target)
            if digest(archive) != RUNNER_SHA256:
                raise ValueError('runner_download_digest_mismatch')
            execute(['/usr/sbin/useradd', '--system', '--create-home', '--home-dir', str(RUNNER_HOME),
                     '--shell', '/usr/sbin/nologin', RUNNER_USER])
        runner = pwd.getpwnam(RUNNER_USER)
        if not resuming:
            for directory in (INSTALL, CONFIG, STATE, STATE / 'requests', STATE / 'runs', RUNNER_ROOT):
                if directory.is_symlink():
                    raise ValueError('refuse_symlink_directory')
                directory.mkdir(parents=True, exist_ok=True)
            for directory in (STATE, STATE / 'requests', STATE / 'runs'):
                os.chown(directory, owner.pw_uid, owner.pw_gid); os.chmod(directory, 0o700)
            os.chmod(INSTALL, 0o755); os.chmod(CONFIG, 0o755)
            for name, path in inputs.items():
                write_owned(INSTALL / name, path.read_bytes())
            write_owned(HELPER, helper_source.read_bytes(), mode=0o755)
            write_owned(CONFIG / 'fixture.json', fixture_raw, mode=0o600, uid=owner.pw_uid, gid=owner.pw_gid)
        extract_runner_archive(archive, RUNNER_ROOT)
        execute(['/bin/chown', '-R', RUNNER_USER + ':' + RUNNER_USER, str(RUNNER_ROOT)])
        registration = gh(args.runtime_owner, 'repos/' + REPOSITORY + '/actions/runners/registration-token', 'POST')
        token = registration.get('token')
        if not isinstance(token, str) or not token:
            raise ValueError('registration_token_missing')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(RUNNER_HOME),
               'ACTIONS_RUNNER_INPUT_TOKEN': token}
        execute([str(RUNNER_ROOT / 'config.sh'), '--unattended', '--url', 'https://github.com/' + REPOSITORY,
                 '--name', RUNNER_NAME, '--labels', RUNNER_LABEL, '--work', '_work'],
                user=RUNNER_USER, env=env, cwd=RUNNER_ROOT)
        registration.clear(); env.pop('ACTIONS_RUNNER_INPUT_TOKEN', None); token = None
    actual = gh(args.runtime_owner, 'repos/' + REPOSITORY + '/actions/runners')
    matches = [r for r in actual.get('runners', []) if r.get('name') == RUNNER_NAME
               and RUNNER_LABEL in [label.get('name') for label in r.get('labels', [])]]
    if len(matches) != 1:
        raise ValueError('registered_runner_identity_unconfirmed')
    rule = ('# agent-herder installed browser CI, fixed no-argument helper only\n'
            + RUNNER_USER + ' ALL=(' + owner.pw_name + ') NOPASSWD: NOSETENV: ' + str(HELPER) + ' ""\n')
    validate = CONFIG / 'sudoers.validate'
    write_owned(validate, rule, mode=0o440)
    execute(['/usr/sbin/visudo', '-cf', str(validate)])
    write_owned(SUDOERS, rule, mode=0o440); validate.unlink()
    write_owned(Path('/etc/systemd/system') / UNIT, runner_service_unit())
    manifest = {'version': 1, 'repository': REPOSITORY, 'runtime_owner': owner.pw_name,
                'runner_id': matches[0]['id'], 'runner_name': RUNNER_NAME, 'runner_label': RUNNER_LABEL,
                'runner_uid': runner.pw_uid, 'reviewed_source_sha': args.reviewed_source_sha,
                'runner_version': RUNNER_VERSION, 'runner_sha256': RUNNER_SHA256,
                'files': files, 'fixture_sha256': hashlib.sha256(fixture_raw).hexdigest()}
    write_owned(CONFIG / 'install.json', json.dumps(manifest, indent=2) + '\n')
    execute(['/bin/systemctl', 'daemon-reload'])
    execute(['/bin/systemctl', 'enable', '--now', UNIT])
    print(json.dumps({'mode':'installed','runner_id':matches[0]['id'],'runner_name':RUNNER_NAME,
                      'label':RUNNER_LABEL,'service':UNIT,'native_effects':'not_performed'}))


def remove(args):
    if os.geteuid() != 0:
        raise ValueError('root_required')
    manifest = json.loads((CONFIG / 'install.json').read_text())
    if manifest.get('repository') != REPOSITORY or manifest.get('runner_name') != RUNNER_NAME:
        raise ValueError('owned_install_marker_required')
    actual = gh(manifest['runtime_owner'], 'repos/' + REPOSITORY + '/actions/runners')
    matches = [r for r in actual.get('runners', []) if r.get('id') == manifest['runner_id']]
    if matches and matches[0].get('name') != RUNNER_NAME:
        raise ValueError('runner_identity_changed')
    execute(['/bin/systemctl', 'disable', '--now', UNIT])
    if matches:
        # Empty 204 response is intentionally not JSON-decoded.
        execute(['/usr/bin/gh', 'api', '--method', 'DELETE', 'repos/' + REPOSITORY + '/actions/runners/' + str(manifest['runner_id'])],
                user=manifest['runtime_owner'], env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':pwd.getpwnam(manifest['runtime_owner']).pw_dir})
    SUDOERS.unlink(missing_ok=True)
    (Path('/etc/systemd/system') / UNIT).unlink(missing_ok=True)
    execute(['/bin/systemctl', 'daemon-reload'])
    print(json.dumps({'mode':'removed','runner_registration':'removed','service':'removed',
                      'private_evidence':'retained','runner_user_and_files':'retained'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--plan', action='store_true')
    modes.add_argument('--install', action='store_true')
    modes.add_argument('--remove', action='store_true')
    for name in ('collector','bindings','browser-manager','fixture','node','reviewed-source-sha'):
        parser.add_argument('--' + name)
    parser.add_argument('--resume-plan')
    parser.add_argument('--resume-plan-sha256')
    parser.add_argument('--runtime-owner', default='roomhacker')
    args = parser.parse_args()
    if args.install:
        if any(getattr(args, name) is None for name in ('collector','bindings','browser_manager','fixture','node','reviewed_source_sha')):
            parser.error('--install requires reviewed collector, bindings, browser manager, fixture, node and source SHA')
        install(args)
    elif args.remove: remove(args)
    else: print(json.dumps(plan(), sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (ValueError, KeyError, RuntimeError, OSError, subprocess.TimeoutExpired, tarfile.TarError):
        print('Dedicated CI runner provisioning failed; no credentials are logged', file=sys.stderr)
        raise SystemExit(2)
