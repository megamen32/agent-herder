#!/usr/bin/python3
"""Launch the pinned CI Chrome while allowing extensions installed in its profile."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

CONFIG_PATH = Path('/etc/agent-herder-ci-smoke/browser-fixture.json')
ALLOWLIST = '--disable-extensions-except'


def without_extension_allowlist(argv):
    """Remove only the exact Chrome allowlist switch, preserving all other tokens."""
    result = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == ALLOWLIST:
            if index + 1 >= len(argv) or argv[index + 1].startswith('--'):
                raise ValueError('extension_allowlist_value_required')
            index += 2
        elif value.startswith(ALLOWLIST + '='):
            index += 1
        else:
            result.append(value)
            index += 1
    return result


def argument_values(argv, flag):
    values = []
    for index, value in enumerate(argv):
        if value == flag:
            if index + 1 >= len(argv):
                raise ValueError('browser_argument_value_required')
            values.append(argv[index + 1])
        elif value.startswith(flag + '='):
            values.append(value[len(flag) + 1:])
    return values


def executable_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def exec_browser(config, argv):
    browser = config['browser']
    if config.get('schema') != 'agent-herder.ci-browser-fixture.v1' or config.get('runtime_uid') != os.getuid():
        raise ValueError('fixture_runtime_principal_mismatch')
    executable = browser['chrome_executable']
    if not os.path.isabs(executable) or executable_hash(executable) != browser['chrome_sha256']:
        raise ValueError('fixture_executable_digest_mismatch')
    expected_extensions = [browser['extensions_path'], *browser.get('extra_extension_paths', [])]
    loaded = [entry for value in argument_values(argv, '--load-extension') for entry in value.split(',')]
    if (argument_values(argv, '--user-data-dir') != [browser['profile_path']]
            or len(loaded) != len(expected_extensions) or set(loaded) != set(expected_extensions)
            or argument_values(argv, '--type')):
        raise ValueError('fixture_browser_profile_mismatch')
    filtered = without_extension_allowlist(argv)
    # exec keeps the original PID and parent. The fixture still attests the actual
    # Chrome executable/hash, the daemon parent, profile and exact load paths.
    os.execv(executable, [executable, *filtered])


def load_config():
    for parent in CONFIG_PATH.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('protected_fixture_parent_required')
    info = CONFIG_PATH.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o037:
        raise ValueError('protected_fixture_file_required')
    return json.loads(CONFIG_PATH.read_text())


if __name__ == '__main__':
    try:
        exec_browser(load_config(), sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
