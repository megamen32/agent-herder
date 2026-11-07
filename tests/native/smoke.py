#!/usr/bin/env python3
"""Exercise the launcher as a child and verify profile cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory() as parent:
        marker = Path(parent) / "profile-path"
        code = r'''
import json, os, pathlib, sys, urllib.request
home = pathlib.Path(os.environ['HOME'])
assert home.is_dir() and not (home / '.ssh').exists()
assert 'NATIVE_SHOULD_NOT_LEAK' not in os.environ
pathlib.Path(sys.argv[1]).write_text(str(home))
base = os.environ['HERDER_TEST_MODEL_BASE_URL']
assert base.startswith('http://127.0.0.1:')
with urllib.request.urlopen(base + '/models') as r:
    assert json.load(r)['data'][0]['id'] == 'herder-test'
for endpoint in ('responses', 'chat/completions'):
    for stream in (False, True):
        req = urllib.request.Request(base + '/' + endpoint,
            json.dumps({'model': 'herder-test', 'stream': stream}).encode(),
            {'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as r:
            assert b'HERDER_TEST_MODEL_OK' in r.read()
with urllib.request.urlopen(base.removesuffix('/v1') + '/_stats') as r:
    assert json.load(r)['requests'] == 4
print('models, responses, chat and streams: OK; requests=4')
'''
        env = dict(os.environ, NATIVE_SHOULD_NOT_LEAK="secret-sentinel")
        result = subprocess.run([sys.executable, str(HERE / "launch.py"), "--", sys.executable, "-c", code, str(marker)], env=env, check=False)
        assert result.returncode == 0, result.returncode
        assert not Path(marker.read_text()).exists(), "temporary profile not removed"
        print("environment isolation and profile cleanup: OK")


if __name__ == "__main__":
    main()
