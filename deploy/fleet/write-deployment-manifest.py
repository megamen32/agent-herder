#!/usr/bin/env python3
"""Pin compiler inputs, write an honest exact-output manifest, verify before activation."""
import argparse
import hashlib
import json
import pathlib
import subprocess

EXCLUDED = {'fleet-deployment-manifest.json'}
INPUTS = {'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

def inputs(root):
    names = git(root, 'ls-files', '-z').split('\0')
    return {name: sha(root / name) for name in names if name and
            (name.startswith(('src/', 'public/', 'packages/')) or name in INPUTS or name.startswith('tsconfig.'))}

def outputs(dist):
    result = {}
    for path in sorted(dist.rglob('*')):
        if path.is_symlink():
            raise ValueError('Compiler output contains a symlink')
        if path.is_file() and path.relative_to(dist).as_posix() not in EXCLUDED:
            result[path.relative_to(dist).as_posix()] = sha(path)
    if 'index.js' not in result or 'web/index.html' not in result:
        raise ValueError('Both backend and frontend compiler outputs are required')
    return result

def capture(root, receipt):
    pins = inputs(root)
    source_sha = git(root, 'rev-parse', 'HEAD')
    dirty = any(hashlib.sha256(subprocess.check_output(['git', '-C', str(root), 'show', f'{source_sha}:{name}'])).hexdigest() != value for name, value in pins.items())
    data = {'source_sha': source_sha, 'source_dirty': dirty, 'checkout_dirty': bool(git(root, 'status', '--porcelain')), 'source_pins': pins}
    receipt.write_text(json.dumps(data, indent=2) + '\n')

def write(root, dist, receipt):
    data = json.loads(receipt.read_text())
    if data['source_pins'] != inputs(root):
        raise ValueError('Compiler inputs changed during build; do not activate')
    if len(data['source_sha']) != 40:
        raise ValueError('Full source commit required')
    manifest = {**data, 'input_kind': 'pinned-canonical-checkout', 'checkout_wip_preserved': True,
                'backend_only': False, 'frontend_built': True, 'built_input_count': len(data['source_pins']), 'payload': outputs(dist)}
    (dist / 'fleet-deployment-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest

def verify(root, dist):
    data = json.loads((dist / 'fleet-deployment-manifest.json').read_text())
    if data['source_pins'] != inputs(root) or data['payload'] != outputs(dist):
        raise ValueError('Source or compiled output differs from manifest; do not activate')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'write', 'verify'])
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--dist', type=pathlib.Path)
    parser.add_argument('--receipt', type=pathlib.Path)
    args = parser.parse_args()
    if args.action == 'capture': capture(args.root, args.receipt)
    elif args.action == 'write': write(args.root, args.dist, args.receipt)
    else: verify(args.root, args.dist)
