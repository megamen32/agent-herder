#!/usr/bin/env python3
"""Run the existing business acceptance over legacy MCP through the translator.

This is a wire consumer, not evidence of Codex model/approval behavior. No
2026 inline metadata or Tasks method is sent by this downstream client.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tests' / 'native'))
import ahap_opencode_stand as stand


class LegacyProcess(stand.RpcProcess):
    def __init__(self, binary, profile, env):
        runtime_env = dict(env, HERDER_NATIVE_COMMAND=str(binary))
        self.process = subprocess.Popen(
            [os.environ['HERDER_COMPAT_BINARY'], '--trusted-owner-profile', str(profile)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=runtime_env)
        self.next_id = 0
        self.buffer = ''
        initialized = super().request('initialize', {
            'protocolVersion': '2025-06-18', 'capabilities': {},
            'clientInfo': {'name': 'legacy-acceptance', 'version': '1'}})
        assert initialized['protocolVersion'] == '2025-06-18', initialized
        self.process.stdin.write(json.dumps({
            'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        self.process.stdin.flush()

    def request(self, method, params, timeout=stand.RPC_TIMEOUT):
        params = {k: v for k, v in params.items() if k != '_meta'}
        if method == 'tasks/get':
            result = super().request('tools/call', {
                'name': 'compat_task',
                'arguments': {'action': 'get', 'task_ref': params['taskId']}}, timeout)
            assert not result.get('isError'), result
            return result['structuredContent']
        result = super().request(method, params, timeout)
        if method == 'tools/call' and isinstance(result, dict):
            value = result.get('structuredContent', {})
            if value.get('native_task') is True:
                return {'resultType': 'task', 'taskId': value['task_ref']}
        return result


if __name__ == '__main__':
    os.environ['HERDER_COMPAT_BINARY'] = sys.argv.pop(1)
    stand.RpcProcess = LegacyProcess
    stand.main()
