"""Direct, side-effect-free JSON-RPC check of the native stdio binary."""
import json
import select
import subprocess
import sys

binary = sys.argv[1]
meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name": "wire-test", "version": "1"}}

with subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1) as p:
    def request(i, method, params):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
        p.stdin.flush()
        assert select.select([p.stdout], [], [], 10)[0], f"timeout: {method}"
        response = json.loads(p.stdout.readline())
        assert response["id"] == i, response
        return response

    r = request(1, "server/discover", {"_meta": meta})
    assert "result" in r, r
    assert "2026-07-28" in json.dumps(r), r
    r = request(2, "tools/list", {"_meta": meta})
    assert len(r["result"]["tools"]) == 14, r
    assert "resource" in [x["name"] for x in r["result"]["tools"]]
    assert "workspace" not in [x["name"] for x in r["result"]["tools"]]
    assert "error" in request(3, "tools/call", {"name": "discover", "arguments": {"action": "nodes"}})
    old = dict(meta, **{"io.modelcontextprotocol/protocolVersion": "2025-06-18"})
    assert "error" in request(4, "tools/call", {"_meta": old, "name": "discover", "arguments": {"action": "nodes"}})
    assert "error" in request(5, "tools/call", {"_meta": meta, "name": "deliver", "arguments": {"action": "session", "session_ref": "s", "message": "m", "mode": "current", "request_key": "k", "extra": 1}})
    assert "error" in request(6, "tools/call", {"_meta": meta, "name": "workspace", "arguments": {"action": "list"}})
    r = request(7, "tools/call", {"_meta": meta, "name": "deliver", "arguments": {"action": "session", "session_ref": "s", "message": "m", "mode": "current", "request_key": "k"}})
    assert r["result"]["isError"] is True and r["result"]["structuredContent"]["effect"] == "none" and r["result"]["structuredContent"]["code"] == "unsupported", r
    p.stdin.close()
    assert p.wait(timeout=10) == 0
with subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as p:
    legacy = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "old-client", "version": "1"}}}
    p.stdin.write(json.dumps(legacy) + "\n")
    p.stdin.flush()
    assert select.select([p.stdout], [], [], 10)[0], "legacy initialize timed out"
    assert json.loads(p.stdout.readline())["error"]["code"] == -32022
    p.stdin.close()
    p.wait(timeout=10)
print("native stdio wire: discover, 14 tools, metadata/version, strict input, unsupported, EOF OK")
