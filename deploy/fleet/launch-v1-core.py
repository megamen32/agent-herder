#!/usr/bin/python3
"""Installed stdio entry: pinned manifest -> compat -> Rust core -> TS AHAP.

Selection is one private JSON file, not a legacy fleet current symlink.
This launcher never provisions stores, sends prompts or retries operations.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def digest(path):
    with open(path, 'rb') as stream:
        value = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
        return value.hexdigest()


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode):
        raise ValueError('configuration must be a canonical regular file')
    if info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError('configuration must be private and owned by this user')
    return json.loads(path.read_text())


def prepare(selector):
    config = private_json(selector)
    manifest_path = Path(config['manifest'])
    if digest(manifest_path) != config['manifest_sha256']:
        raise ValueError('manifest digest mismatch')
    manifest = json.loads(manifest_path.read_text())
    profiles = config['profiles']
    if not isinstance(profiles, list) or not profiles or len(set(profiles)) != len(profiles):
        raise ValueError('select a nonempty unique profile set')
    for key in ('core', 'compat', 'node', 'bootstrap'):
        if digest(manifest[key]) != manifest['sha256'][key]:
            raise ValueError('artifact digest mismatch: ' + key)
    if 'resource_bridge' in manifest:
        path = Path(manifest['resource_bridge'])
        if (not path.is_absolute() or path.resolve() != path or not os.access(path, os.X_OK)
                or digest(path) != manifest['sha256']['resource_bridge']):
            raise ValueError('resource bridge digest mismatch')
    if 'process_remote_bridge' in manifest:
        path = Path(manifest['process_remote_bridge'])
        info = path.lstat()
        if (not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1
                or digest(path) != manifest['sha256']['process_remote_bridge']):
            raise ValueError('process remote bridge digest mismatch')
    for kind, path in manifest['adapters'].items():
        if digest(path) != manifest['sha256']['adapters'][kind]:
            raise ValueError('adapter digest mismatch: ' + kind)
    # Explicit, immutable per-instance exceptions for a remote transport. A
    # wrapper can never change the executable or replace the canonical adapter.
    wrappers = manifest.get('remote_ahap_wrappers', [])
    if not isinstance(wrappers, list):
        raise ValueError('invalid remote wrappers')
    pinned = {}
    for item in wrappers:
        if not isinstance(item, dict) or set(item) != {'node', 'instance', 'kind', 'script', 'script_sha256', 'config_sha256'}:
            raise ValueError('invalid remote wrapper')
        identity = (item['node'], item['instance'], item['kind'])
        if any(not isinstance(v, str) or not v for v in identity) or identity in pinned:
            raise ValueError('invalid or duplicate remote identity')
        if item['kind'] not in manifest['adapters']:
            raise ValueError('unknown remote kind')
        script = Path(item['script'])
        if not script.is_absolute() or script.resolve() != script or digest(script) != item['script_sha256']:
            raise ValueError('remote wrapper digest mismatch')
        config_path = str(script) + '.json'
        companion = private_json(config_path)
        if (digest(config_path) != item['config_sha256'] or companion.get('nodeRef') != item['node']
                or companion.get('kind') != item['kind']):
            raise ValueError('remote configuration mismatch')
        pinned[identity] = str(script)
    process_env = {}
    if 'process_worker' in manifest or 'process_config' in manifest:
        for key in ('process_worker', 'process_config'):
            path = Path(manifest[key])
            if not path.is_absolute() or path.resolve() != path or digest(path) != manifest['sha256'][key]:
                raise ValueError('process artifact digest mismatch: ' + key)
        process = private_json(manifest['process_config'])
        if (process.get('version') != 1 or process.get('worker') != manifest['process_worker']
                or not isinstance(process.get('administrators'), list) or not process['administrators']):
            raise ValueError('invalid process configuration')
        process_env = {'HERDER_PROCESS_CONFIG': manifest['process_config']}
    argv = [manifest['compat']]
    for path in profiles:
        profile = private_json(path)
        owner = profile['owner']
        if owner['executable'] != manifest['node']:
            raise ValueError('profile does not select the installed executable')
        canonical = manifest['adapters'][owner['kind']]
        identity = (owner.get('node'), owner.get('instance'), owner['kind'])
        if owner['ahap_script'] != canonical and pinned.get(identity) != owner['ahap_script']:
            raise ValueError('profile does not select the installed artifact')
        argv.extend(['--trusted-owner-profile', path])
    env = dict(os.environ)
    # An inherited process config cannot override a manifest with no such feature.
    env.pop('HERDER_PROCESS_CONFIG', None)
    env.pop('HERDER_PROCESS_WORKER', None)
    env.update(process_env)
    env['HERDER_NATIVE_COMMAND'] = manifest['core']
    return argv, env, {
        'manifest': str(manifest_path), 'manifest_sha256': config['manifest_sha256'],
        'source_commit': manifest['source_commit'], 'core_sha256': manifest['sha256']['core'],
        'profiles': profiles, 'argv': argv,
        'process_worker_sha256': manifest.get('sha256', {}).get('process_worker'),
        'resource_bridge_sha256': manifest.get('sha256', {}).get('resource_bridge'),
        'process_remote_bridge_sha256': manifest.get('sha256', {}).get('process_remote_bridge'),
        'process_config_sha256': manifest.get('sha256', {}).get('process_config'),
    }



def process_wait_query(selector, request):
    selection = private_json(selector)
    manifest_path = selection['manifest']
    manifest = private_json(manifest_path)
    if digest(manifest_path) != selection['manifest_sha256']:
        raise ValueError('manifest digest mismatch')
    if 'process_config' not in manifest:
        print(json.dumps({'blocked': False, 'reason': 'process_wait_unconfigured',
                          'sessionRefs': [], 'ruleRefs': []}, sort_keys=True))
        return
    if 'process_wait_reader' not in manifest:
        print(json.dumps({'blocked': True, 'reason': 'process_wait_reader_unavailable',
                          'sessionRefs': [], 'ruleRefs': []}, sort_keys=True))
        return
    path = Path(manifest['process_wait_reader'])
    info = path.lstat()
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1
            or digest(path) != manifest['sha256']['process_wait_reader']):
        raise ValueError('process wait reader digest mismatch')
    os.execve(sys.executable, [sys.executable, str(path), '--selector', selector, '--query', request],
              dict(os.environ))


def main():
    selector = os.environ.get('HERDER_V1_ENTRY', str(Path.home() / '.config/agent-herder/v1-entry.json'))
    if len(sys.argv) == 3 and sys.argv[1] == '--process-wait-status':
        process_wait_query(selector, sys.argv[2])
        return
    if sys.argv[1:] not in ([], ['--check']):
        raise ValueError('usage: agent-herder-v1 [--check | --process-wait-status JSON]')
    argv, env, receipt = prepare(selector)
    if sys.argv[1:] == ['--check']:
        print(json.dumps(receipt, sort_keys=True))
        return
    os.execve(argv[0], argv, env)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo profile contents or environment values into MCP stderr.
        print('Herder V1 launcher failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
