#!/usr/bin/env python3
"""Build a new immutable V1 bundle with only compat replaced; never install it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def digest(path):
    with open(path, 'rb') as stream:
        value = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
        return value.hexdigest()


def derive(base, expected, compat, commit, output):
    if digest(base) != expected:
        raise ValueError('base manifest digest mismatch')
    manifest = json.loads(base.read_text())
    if not output.is_absolute() or output.parent.resolve() != output.parent:
        raise ValueError('output must be canonical and absolute')
    components = {k: manifest[k] for k in ('core', 'bootstrap', 'node', 'compat')}
    components.update({'adapter:' + k: v for k, v in manifest['adapters'].items()})
    expected_hashes = {}
    for key, path in components.items():
        wanted = manifest['sha256']['adapters'][key[8:]] if key.startswith('adapter:') else manifest['sha256'][key]
        expected_hashes[key] = wanted
        if digest(path) != wanted:
            raise ValueError('base component digest mismatch: ' + key)
    compat_hash = digest(compat)
    output.mkdir(mode=0o700)  # Exclusive: never modify an existing artifact.
    fixture = output / 'fixture'
    fixture.mkdir(mode=0o700)
    paths = {}
    for key, original in components.items():
        source = compat if key == 'compat' else Path(original)
        target = fixture / Path(original).name
        wanted = compat_hash if key == 'compat' else expected_hashes[key]
        if not target.exists():
            shutil.copyfile(source, target)
            target.chmod(0o400 if key.startswith('adapter:') else 0o500)
        if digest(target) != wanted or digest(source) != wanted:
            raise ValueError('component changed during copy: ' + key)
        paths[original] = str(target)
    def rewrite(value):
        if isinstance(value, str):
            return paths.get(value, value)
        if isinstance(value, list):
            return [rewrite(v) for v in value]
        if isinstance(value, dict):
            return {k: rewrite(v) for k, v in value.items()}
        return value
    result = rewrite(manifest)
    result['artifact_root'] = str(output)
    result['sha256']['compat'] = compat_hash
    result['build_inputs']['binary_sha256']['compat'] = compat_hash
    result['build_inputs']['source_commit_role'] = 'base source for unchanged components; compat has explicit component provenance'
    result['derived_from'] = {'manifest': str(base), 'manifest_sha256': expected}
    result['component_provenance'] = {'unchanged_source_commit': manifest['source_commit'], 'compat_source_commit': commit}
    target = output / 'manifest.json'
    with target.open('x') as stream:
        stream.write(json.dumps(result, indent=2) + '\n')
    target.chmod(0o400)
    fixture.chmod(0o500)
    output.chmod(0o500)
    return {'manifest': str(target), 'manifest_sha256': digest(target), 'compat_sha256': compat_hash}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', type=Path, required=True)
    p.add_argument('--base-sha256', required=True)
    p.add_argument('--compat', type=Path, required=True)
    p.add_argument('--compat-source-commit', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(derive(a.base, a.base_sha256, a.compat, a.compat_source_commit, a.output)))
