#!/usr/bin/env python3
"""Run real codex exec against an isolated recording MCP server; no user credentials."""
import json, os, pathlib, subprocess, tempfile

HERE = pathlib.Path(__file__).resolve().parent
for mode in ('strict', 'legacy', 'future'):
    with tempfile.TemporaryDirectory(prefix='v003-codex-') as tmp:
        home = pathlib.Path(tmp)
        trace = HERE / (mode + '-trace.jsonl')
        trace.unlink(missing_ok=True)
        config = f'''model = "probe-model"
model_provider = "probe"
[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:9/v1"
env_key = "V003_FAKE_KEY"
wire_api = "responses"
[mcp_servers.v003]
command = "python3"
args = [{json.dumps(str(HERE / 'server.py'))}]
[mcp_servers.v003.env]
PROBE_TRACE = {json.dumps(str(trace))}
PROBE_MODE = {json.dumps(mode)}
'''
        (home / 'config.toml').write_text(config)
        env = {**os.environ, 'CODEX_HOME':tmp, 'HOME':tmp, 'V003_FAKE_KEY':'test-only'}
        try:
            run = subprocess.run(['codex','exec','--ephemeral','--skip-git-repo-check','--json','-C',tmp,'Say hello.'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=8)
            result = {'exit_code':run.returncode, 'stdout':run.stdout, 'stderr':run.stderr}
        except subprocess.TimeoutExpired as e:
            result = {'timeout_seconds':8, 'stdout':(e.stdout or b'').decode() if isinstance(e.stdout,bytes) else e.stdout, 'stderr':(e.stderr or b'').decode() if isinstance(e.stderr,bytes) else e.stderr}
        (HERE / (mode + '-client.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(mode, 'trace:', trace.exists(), 'result:', result.get('exit_code', 'timeout'))
