#!/usr/bin/env python3
"""Run inside an isolated filesystem and private network namespace."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
import urllib.request

spec = importlib.util.spec_from_file_location('native_hermes_model', '/fixture/native-hermes-model.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
Handler, ThreadingHTTPServer = fixture.Handler, fixture.ThreadingHTTPServer

root = Path('/work')
home = root / '.hermes'
home.mkdir(parents=True, exist_ok=True)
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/v1'
(home / 'config.yaml').write_text(f'model:\n  provider: custom\n  default: herder-test\n  base_url: {url}\n')
env = {'HOME': str(root), 'HERMES_HOME': str(home), 'PATH': '/usr/bin:/bin', 'OPENAI_API_KEY': 'test-only', 'NO_COLOR': '1', 'PYTHONUNBUFFERED': '1', 'HERMES_HEALTH_MODEL': 'herder-test'}
python = '/home/roomhacker/.hermes/hermes-agent/venv/bin/python'
base = [python, '-m', 'hermes_cli.main']
version = subprocess.check_output(base + ['--version'], env=env, text=True, timeout=30).strip()
try:
    result = subprocess.run(base + ['chat', '-q', 'Reply with the test token.'], env=env, cwd=root, text=True, capture_output=True, timeout=90)
    before_herder = json.load(urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/_stats', timeout=5))
    herder = subprocess.run(['/usr/bin/node', '/fixture/native-hermes-herder.mjs'], env=env, cwd=root, text=True, capture_output=True, timeout=90)
    stats = json.load(urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/_stats', timeout=5))
    receipt = {'version': version, 'exit_code': result.returncode, 'stdout': result.stdout[-8000:], 'stderr': result.stderr[-4000:], 'fixture': stats, 'requests_before_herder': before_herder['requests'], 'herder_adapter_sha256': hashlib.sha256(Path('/fixture/herder/dist/adapters/hermes/adapter.js').read_bytes()).hexdigest(), 'herder': {'exit_code': herder.returncode, 'stdout': herder.stdout[-8000:], 'stderr': herder.stderr[-4000:]}, 'isolation': 'private network namespace, restricted filesystem, empty HOME'}
    receipt['ok'] = result.returncode == 0 and 'HERDER_TEST_MODEL_OK' in result.stdout and before_herder['requests'] > 0 and stats['requests'] > before_herder['requests'] and herder.returncode == 0
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    sys.exit(0 if receipt['ok'] else 1)
finally:
    server.shutdown()
