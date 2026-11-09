#!/usr/bin/python3
"""Reviewable, reversible provisioning for the dedicated installed browser CI job.

Default --plan is read-only. --install needs root and reviewed bundle/fixture
inputs. Registration uses the official GitHub API; its short-lived token is
passed through the runner's documented ACTIONS_RUNNER_INPUT_TOKEN environment.
No personal browser or native service is started by this installer.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
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


def install(args):
    if os.geteuid() != 0 or os.uname().machine != 'x86_64':
        raise ValueError('root_linux_x64_required')
    if not re.fullmatch(r'[0-9a-f]{40}', args.reviewed_source_sha or ''):
        raise ValueError('reviewed_source_sha_required')
    owner = pwd.getpwnam(args.runtime_owner)
    inputs = {'collector.cjs': Path(args.collector), 'bindings.cjs': Path(args.bindings),
              'candidate_release_gate.py': Path(__file__).resolve().parents[2] / 'tests/native/candidate_release_gate.py',
              'installed-public-core.py': Path(__file__).resolve().parents[2] / 'tests/native/installed-public-core.py',
              'public-rust-consumer.py': Path(__file__).resolve().parents[2] / 'tests/v1-restored-workflows/noticeplace-native-canary.py',
              'ci-browser-fixture.mjs': Path(args.browser_manager)}
    helper_source = Path(__file__).with_name('installed-smoke-helper.py')
    for path in [*inputs.values(), helper_source, Path(args.fixture), Path(args.node)]:
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ValueError('explicit_regular_install_input_required')
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
        archive = Path(temp) / RUNNER_ASSET
        with urllib.request.urlopen(RUNNER_URL, timeout=120) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        if digest(archive) != RUNNER_SHA256:
            raise ValueError('runner_download_digest_mismatch')
        execute(['/usr/sbin/useradd', '--system', '--create-home', '--home-dir', str(RUNNER_HOME),
                 '--shell', '/usr/sbin/nologin', RUNNER_USER])
        runner = pwd.getpwnam(RUNNER_USER)
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
        with tarfile.open(archive) as payload:
            for member in payload.getmembers():
                parts = Path(member.name).parts
                if member.name.startswith('/') or '..' in parts or member.isdev():
                    raise ValueError('unsafe_official_runner_archive')
            payload.extractall(RUNNER_ROOT, filter='data')
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
    unit = ('[Unit]\nDescription=Agent Herder installed browser CI runner\nAfter=network-online.target\nWants=network-online.target\n'
            '[Service]\nUser=' + RUNNER_USER + '\nWorkingDirectory=' + str(RUNNER_ROOT)
            + '\nExecStart=' + str(RUNNER_ROOT / 'runsvc.sh')
            + '\nEnvironment=HOME=' + str(RUNNER_HOME)
            + '\nUMask=0077\nRestart=always\nRestartSec=10\nTimeoutStopSec=90\nKillMode=mixed\n'
            '[Install]\nWantedBy=multi-user.target\n')
    write_owned(Path('/etc/systemd/system') / UNIT, unit)
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
    except (ValueError, KeyError, RuntimeError, OSError, subprocess.TimeoutExpired):
        print('Dedicated CI runner provisioning failed; no credentials are logged', file=sys.stderr)
        raise SystemExit(2)
