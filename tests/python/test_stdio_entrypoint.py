"""Build with tsc first, then run this isolated direct/symlink MCP startup regression.

Only temporary HOME/state is used. All adapters are disabled; a child-only
preload rejects network connections. No live service or browser is contacted.
"""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[2] / "dist/index.js"


class TestStdioEntrypoint(unittest.TestCase):
    def startup(self, symlink):
        self.assertTrue(ENTRYPOINT.is_file(), "Build TypeScript before this integration test")
        with tempfile.TemporaryDirectory(prefix="herder-stdio-main-") as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            preload = root / "deny-network.mjs"
            preload.write_text(
                'import net from "node:net";\n'
                'net.Socket.prototype.connect = function () { throw new Error("network_disabled_for_stdio_fixture"); };\n'
                'globalThis.fetch = async () => { throw new Error("network_disabled_for_stdio_fixture"); };\n'
            )
            launch = ENTRYPOINT
            if symlink:
                launch = root / "registered" / "dist" / "index.js"
                launch.parent.mkdir(parents=True)
                launch.symlink_to(ENTRYPOINT)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home),
                   "XDG_CONFIG_HOME": str(home / ".config"),
                   "XDG_STATE_HOME": str(home / ".local/state")}
            for adapter in ("OPENCODE", "CLAUDE", "CLAUDE_SDK", "CODEX", "QODER",
                            "HERMES", "ZCODE", "FAST_AGENT", "MINIMAX_CODE"):
                env["ENABLE_" + adapter] = "false"
            with tempfile.TemporaryFile() as errors:
                process = subprocess.Popen(
                    ["node", "--import", str(preload), str(launch)],
                    cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=errors)
                selector = selectors.DefaultSelector()
                selector.register(process.stdout, selectors.EVENT_READ)
                buffer = b""

                def send(value):
                    process.stdin.write((json.dumps(value) + "\n").encode())
                    process.stdin.flush()

                def response(expected_id):
                    nonlocal buffer
                    deadline = time.monotonic() + 25
                    while time.monotonic() < deadline:
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            if not line.strip():
                                continue
                            message = json.loads(line)
                            if message.get("id") == expected_id:
                                self.assertNotIn("error", message)
                                return message["result"]
                        if not selector.select(max(0, deadline - time.monotonic())):
                            break
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            errors.seek(0)
                            self.fail("stdio exited before reply: " + errors.read(2000).decode(errors="replace"))
                        buffer += chunk
                    self.fail("stdio response timed out")

                try:
                    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                        "protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": {"name": "isolated-entrypoint-regression", "version": "1"}}})
                    self.assertIn("serverInfo", response(1))
                    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
                    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
                    names = {tool["name"] for tool in response(2)["tools"]}
                    self.assertIn("project_release_lease", names)
                    self.assertIn("fleet_node_info", names)
                    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                          "params": {"name": "fleet_node_info", "arguments": {}}})
                    info = response(3)
                    self.assertFalse(info.get("isError", False))
                    identity = json.loads(info["content"][0]["text"])
                    self.assertGreater(identity["generation"], 0)
                    self.assertIsNone(process.poll())
                finally:
                    selector.close()
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    process.stdin.close()
                    process.stdout.close()

    def test_direct_launch_initializes_and_lists_tools(self):
        self.startup(False)

    def test_registered_symlink_launch_initializes_and_lists_tools(self):
        self.startup(True)


if __name__ == "__main__":
    unittest.main()
