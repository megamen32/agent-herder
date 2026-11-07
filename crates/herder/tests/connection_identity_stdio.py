"""Regression: untrusted claimed identity never authenticates a stdio connection.

This is a negative launcher test, not proof of an authenticated self binding.
Run: python3 crates/herder/tests/connection_identity_stdio.py PATH_TO_BINARY
"""
import json
import os
import select
import subprocess
import sys
import tempfile

binary = os.path.abspath(sys.argv[1])
config = {"local_node_id": "local", "nodes": [{"id": "local", "endpoint": "https://local.invalid", "authority": {"principal": "admin", "secret_ref": None}, "instances": []}]}


def call(process, number, caller, session, name, arguments):
    meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": caller, "version": "1"},
            "caller": caller, "principal": caller, "session_ref": session}
    request = {"jsonrpc": "2.0", "id": number, "method": "tools/call",
               "params": {"_meta": meta, "name": name, "arguments": arguments}}
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    assert select.select([process.stdout], [], [], 10)[0], "response timeout"
    response = json.loads(process.stdout.readline())
    assert response.get("id") == number, response
    result = response["result"]
    assert result["isError"] and result["structuredContent"]["effect"] == "none", result
    assert result["structuredContent"]["code"] in ("unauthorized", "unsupported"), result
    return result


with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, "config.json")
    with open(path, "w") as stream:
        json.dump(config, stream)
    processes = []
    try:
        for caller, session in (("alice", "alice-session"), ("bob", "bob-session")):
            env = dict(os.environ, HERDER_CALLER=caller, HERDER_SESSION_REF=session)
            processes.append(subprocess.Popen([binary, "--config", path], stdin=subprocess.PIPE,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              text=True, bufsize=1, env=env))
        for index, (process, caller, own, other) in enumerate((
            (processes[0], "alice", "alice-session", "bob-session"),
            (processes[1], "bob", "bob-session", "alice-session"),
        )):
            result = call(process, 10 + index, caller, own, "discover", {"action": "nodes"})
            assert "local.invalid" not in json.dumps(result)
            for n, target in enumerate((own, other)):
                call(process, 20 + n, caller, own, "session", {"action": "recent", "session_ref": target})
                call(process, 30 + n, caller, own, "deliver", {"action": "session", "session_ref": target, "message": "test", "mode": "current", "request_key": f"key-{index}-{n}"})
            # Changing a claim on an established connection does not create identity.
            call(process, 40, "admin", other, "discover", {"action": "nodes"})
        for process in processes:
            process.stdin.close()
            assert process.wait(timeout=10) == 0
        with open(path) as stream:
            assert json.load(stream) == config
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
print("PASS: two unbound launcher processes deny own/foreign reads and mutations despite spoofed metadata/env; effect=none")
