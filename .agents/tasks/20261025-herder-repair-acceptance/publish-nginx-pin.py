"""Publish only the owner-approved vhost pin atop remote main.

An alternate Git index preserves the divergent checkout, its index and foreign
WIP. No branch, worktree, reset, stash or foreign commit is published. The
manifest projection changes only this vhost's own checksum and size.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path('/home/roomhacker/ServersAdministartion')
SITE = 'nginx-dev/state/files/sites-available/agent.bezrabotnyi.com'
MANIFEST = 'nginx-dev/state/manifest.json'
SHA = '478e22b965013faf7d43d30df92f626ab5ceb3df'
OLD = '9d2abbe3b8c1f10026f8ebaf5dfed018884a127d'

def git(*args, data=None, env=None):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], input=data, env=env)

base = git('rev-parse', 'origin/main').decode().strip()
previous = git('show', f'{base}:{SITE}')
assert previous.count(OLD.encode()) == 3, 'Remote vhost changed; review again'
expected = previous.replace(OLD.encode(), SHA.encode())
assert (ROOT / SITE).read_bytes() == expected, 'Working vhost differs from reviewed three-line change'
manifest = json.loads(git('show', f'{base}:{MANIFEST}'))
entry = next(e for e in manifest['entries'] if e['path'] == 'sites-available/agent.bezrabotnyi.com')
entry['sha256'] = hashlib.sha256(expected).hexdigest()
entry['size'] = len(expected)
projected = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()

with tempfile.TemporaryDirectory(prefix='herder-pin-index-') as directory:
    env = {**os.environ, 'GIT_INDEX_FILE': str(Path(directory) / 'index')}
    git('read-tree', base, env=env)
    for path, content in [(SITE, expected), (MANIFEST, projected)]:
        blob = git('hash-object', '-w', '--stdin', data=content).decode().strip()
        git('update-index', '--add', '--cacheinfo', f'100644,{blob},{path}', env=env)
    tree = git('write-tree', env=env).decode().strip()
    changed = git('diff', '--name-only', base, tree).decode().splitlines()
    assert sorted(changed) == sorted([SITE, MANIFEST]), changed
    print(git('diff', '--stat', base, tree).decode())
    commit = git('commit-tree', tree, '-p', base, data=b'fix(agent-herder): publish compact queue and permission UI 478e22b\n').decode().strip()
    print('Reviewed source commit:', commit, flush=True)
    git('push', 'origin', f'{commit}:refs/heads/main')
    print('Published:', commit)
