#!/usr/bin/env python3
"""One-shot isolated SDK proof; launch only through launch.py's netns."""
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 5:
    raise SystemExit('usage: owner_sdk_runner TEST_BINARY CODEX_BINARY HERDER_BINARY SDK_PROBE')
test, codex, herder, probe = (str(Path(p).resolve(strict=True)) for p in sys.argv[1:])
base = os.environ.get('HERDER_TEST_MODEL_BASE_URL', '')
if not base.startswith('http://127.0.0.1:') or not base.endswith('/v1'):
    raise SystemExit('isolated loopback model required')
# Scoped authority rejects writable ancestors such as /tmp.  This private
# directory lives only in launch.py's disposable bwrap filesystem.
protected_home = Path('/herder-owner-home')
protected_home.mkdir(mode=0o700)
env = dict(os.environ, HOME=str(protected_home), HERDER_TEST_CODEX_BIN=codex,
           HERDER_OWNER_NATIVE_BINARY=herder, HERDER_OWNER_SDK_PROBE=probe)
result = subprocess.run([test, '--ignored', '--exact',
                         'real_sdk_owner_stdio_create_task_and_reopened_messages', '--nocapture'],
                        env=env, check=False)
raise SystemExit(result.returncode)
