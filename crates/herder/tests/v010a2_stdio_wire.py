"""Exercise the configured native server over a separate stdio process."""
import json
import os
import select
import subprocess
import sys
import tempfile

binary = os.path.abspath(sys.argv[1])
meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": {"name": "admin", "version": "1"}, "caller": "admin"}
config = {"local_node_id": "one", "nodes": [
    {"id": "one", "endpoint": "https://one.invalid", "authority": {"principal": "one", "secret_ref": "secret-one"}, "instances": []},
    {"id": "two", "endpoint": "https://two.invalid", "authority": {"principal": "two", "secret_ref": "secret-two"}, "instances": []},
]}
with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, "config.json")
    with open(path, "w") as f:
        json.dump(config, f)
    with subprocess.Popen([binary, "--config", path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1) as p:
        def call(i, name, arguments):
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"_meta": meta, "name": name, "arguments": arguments}}) + "\n")
            p.stdin.flush()
            assert select.select([p.stdout], [], [], 10)[0], p.stderr.read() if p.poll() is not None else "timeout"
            result = json.loads(p.stdout.readline())
            assert result["id"] == i, result
            return result["result"]
        nodes = call(1, "discover", {"action": "nodes"})
        assert nodes["isError"] and nodes["structuredContent"]["code"] == "unauthorized", nodes
        assert all(value not in json.dumps(nodes) for value in ('"id": "one"', '"id": "two"', "one.invalid", "two.invalid", "secret-")), nodes
        result = call(2, "deliver", {"action": "session", "session_ref": "s", "message": "m", "mode": "current", "request_key": "k"})
        assert result["isError"] and result["structuredContent"]["code"] == "unsupported" and result["structuredContent"]["effect"] == "none", result
        result = call(3, "discover", {"action": "instances"})
        assert result["isError"] and result["structuredContent"]["code"] == "unsupported" and result["structuredContent"]["effect"] == "none", result
        p.stdin.close()
        assert p.wait(timeout=10) == 0
    assert json.load(open(path)) == config
print("configured stdio: unknown caller denied node discovery; unconnected operations unsupported")
