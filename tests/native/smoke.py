#!/usr/bin/env python3
"""Exercise the launcher as a child and verify profile cleanup."""
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory() as parent, tempfile.TemporaryDirectory(prefix='.herder-fs-probe-', dir=Path.home()) as host_home_probe, socket.socket() as host_listener:
        host_listener.bind(('127.0.0.1', 0))
        host_listener.listen()
        host_port = str(host_listener.getsockname()[1])
        secret = Path(parent) / "unrelated-secret-sentinel"
        secret.write_text("fixture sentinel; never a real credential")
        home_secret = Path(host_home_probe) / "unrelated-secret-sentinel"
        home_secret.write_text("fixture sentinel; never a real credential")
        code = r'''
import json, os, pathlib, socket, sys, urllib.request
home = pathlib.Path(os.environ['HOME'])
assert home.is_dir() and not (home / '.ssh').exists()
assert 'NATIVE_SHOULD_NOT_LEAK' not in os.environ
assert not pathlib.Path(sys.argv[1]).exists(), 'launcher exposes unrelated host files'
assert not pathlib.Path(sys.argv[3]).exists(), 'launcher exposes unrelated home files'
print('PROFILE_PATH=' + str(home))
try:
    socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=1)
except OSError:
    pass
else:
    raise AssertionError('launcher can reach host loopback')
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
        result = subprocess.run([sys.executable, str(HERE / "launch.py"), "--", sys.executable, "-c", code, str(secret), host_port, str(home_secret)], env=env, text=True, capture_output=True, check=False)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        assert result.returncode == 0, result.returncode
        marker = next(line.removeprefix('PROFILE_PATH=') for line in result.stdout.splitlines() if line.startswith('PROFILE_PATH='))
        assert not Path(marker).exists(), "temporary profile not removed"
        print("environment isolation and profile cleanup: OK")


if __name__ == "__main__":
    main()
