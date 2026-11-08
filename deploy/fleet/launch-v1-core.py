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
    return argv, dict(os.environ, HERDER_NATIVE_COMMAND=manifest['core']), {
        'manifest': str(manifest_path), 'manifest_sha256': config['manifest_sha256'],
        'source_commit': manifest['source_commit'], 'core_sha256': manifest['sha256']['core'],
        'profiles': profiles, 'argv': argv,
    }


def main():
    if sys.argv[1:] not in ([], ['--check']):
        raise ValueError('usage: agent-herder-v1 [--check]')
    selector = os.environ.get('HERDER_V1_ENTRY', str(Path.home() / '.config/agent-herder/v1-entry.json'))
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
