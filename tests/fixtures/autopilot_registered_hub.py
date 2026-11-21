"""Loopback-only GPTAdmin exec fixture forwarding to one already registered owner."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import threading

HOST = "fixture.gptadmin.bezrabotnyi.com"
AUTHORITY = "mcp:shell:fixture-node:AgentHerder"


def canonical_environment(stack, root, owner):
    assert Path("/etc").is_mount() and Path("/stand").is_mount()
    Path("/etc/hosts").write_text(f"127.0.0.1 localhost {HOST}\n::1 localhost\n")
    cert, key = root / "hub.pem", root / "hub.key"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-config", "/dev/null", "-subj", f"/CN={HOST}", "-addext", f"subjectAltName=DNS:{HOST}",
                    "-keyout", key, "-out", cert], check=True, capture_output=True)
    headers = {"Authorization": "Bearer " + secrets.token_hex(24)}
    calls = []
    unavailable = threading.Event()
    lock = threading.Lock()

    class Relay(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/mcp" or self.headers.get("Authorization") != headers["Authorization"]:
                self.send_error(401)
                return
            if unavailable.is_set():
                self.send_error(503)
                return
            frame = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if frame["method"] == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            if frame["method"] == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "fixture-hub", "version": "1"}}
            else:
                if frame["method"] != "tools/call" or frame["params"]["name"] != "exec":
                    self.send_error(404)
                    return
                match = re.fullmatch(r"return await mcp\.call\((.*)\);", frame["params"]["arguments"]["code"], re.S)
                assert match
                target, tool, args = json.loads("[" + match[1] + "]")
                if target != AUTHORITY:
                    # The rest of the rendered panel can ask for fleet inventory.
                    assert tool not in ("session", "automation"), (target, tool)
                    self.send_error(404)
                    return
                assert tool in ("discover", "session", "automation"), tool
                with lock:
                    calls.append((tool, args["action"]))
                    result = owner.tool(tool, **args)
            raw = json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), Relay))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    stack.callback(worker.join)
    stack.callback(server.shutdown)
    endpoint = f"https://{HOST}:{server.server_port}/mcp"
    binding, config = root / "fleet.json", root / "canonical.json"
    binding.write_text(json.dumps({"mcp": {"servers": {"gptadmin": {"url": endpoint, "headers": headers}}}}))
    pin = hashlib.sha256(json.dumps([endpoint, headers], separators=(",", ":")).encode()).hexdigest()
    retained = {"path": str(root / "retained.json"), "sha256": "0" * 64}
    config.write_text(json.dumps({"version": 1, "mode": "canonical", "epoch": "stand", "authority": AUTHORITY,
        "node_ref": "fixture-node", "writer_drain": retained,
        "resume_after": {"directory": str(root), "snapshot": retained["path"], "sha256": retained["sha256"]}}))
    return {"AGENT_HERDER_CANONICAL_MODE": "canonical", "AGENT_HERDER_CANONICAL_CONFIG": str(config),
            "AGENT_HERDER_CANONICAL_CONFIG_SHA256": hashlib.sha256(config.read_bytes()).hexdigest(),
            "AGENT_HERDER_FLEET_MESH_CONFIG": str(binding), "AGENT_HERDER_FLEET_CREDENTIAL_PIN": pin,
            "NODE_EXTRA_CA_CERTS": str(cert)}, calls, unavailable
