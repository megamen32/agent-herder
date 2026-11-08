#!/usr/bin/env python3
"""Validate an already packaged candidate without native harness init or sends.

Usage: python3 deploy/fleet/test-build-v1-core.py /absolute/candidate/manifest.json
Only AHAP initialize is sent. OpenCode's startup GET /api/config uses a local
fixture; configured native executables are tripwires and browser uses a fake pin.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    manifest_path = Path(sys.argv[1]).resolve(strict=True)
    manifest = json.loads(manifest_path.read_text())
    artifact = Path(manifest["artifact_root"])
    assert manifest_path == artifact / "manifest.json"
    components = ["core", "bootstrap", "node", "adapter"] + (["compat"] if manifest.get("compat") else [])
    for key in components:
        assert digest(manifest[key]) == manifest["sha256"][key], key
    for harness, path in manifest["adapters"].items():
        assert digest(path) == manifest["sha256"]["adapters"][harness], harness
    assert manifest["adapter"] == manifest["adapters"]["opencode"]
    before = {str(p): (digest(p), p.stat().st_mtime_ns) for p in artifact.rglob("*") if p.is_file()}
    builder = Path(__file__).with_name("build-v1-core.py")
    duplicate = subprocess.run([sys.executable, str(builder), "--output", str(artifact),
                               "--source-sha", manifest["source_commit"], "--node", manifest["node"]],
                              capture_output=True, text=True, timeout=10)
    assert duplicate.returncode != 0 and "already exists" in duplicate.stderr, duplicate.stderr
    assert before == {str(p): (digest(p), p.stat().st_mtime_ns) for p in artifact.rglob("*") if p.is_file()}

    requests = []

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            requests.append(("GET", self.path))
            self.send_response(200 if self.path == "/api/config" else 500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def do_POST(self):
            requests.append(("POST", self.path))
            self.send_error(500, "Native mutations forbidden in initialize check")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    initialized = {}
    try:
        with tempfile.TemporaryDirectory(prefix="C14-initialize-", dir=artifact.parent) as temporary:
            root = Path(temporary)
            marker = root / "native-command-was-called"
            tripwire = root / "forbidden-native"
            tripwire.write_text("#!/usr/bin/python3\nfrom pathlib import Path\nPath(" + repr(str(marker))
                                + ").write_text('forbidden')\nraise SystemExit(99)\n")
            tripwire.chmod(0o700)
            for harness in ["opencode", "zcode", "codex", "chatgpt", "zai"]:
                home = root / harness
                home.mkdir(mode=0o700)
                env = {"PATH": os.defpath, "HOME": str(home), "AHAP_VERSION": "0.1", "AHAP_HARNESS": harness,
                       "AHAP_OPENCODE_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                       "AHAP_CODEX_BIN": str(tripwire), "AHAP_CODEX_CWD": str(home),
                       "AHAP_ZCODE_SERVER_NODE": str(tripwire), "AHAP_ZCODE_SERVER_ENTRY": str(tripwire),
                       "AHAP_ZCODE_CWD": str(home),
                       "AHAP_BROWSER_TRANSPORT": "direct-cdp", "AHAP_BROWSER_PAGE_ID": "1",
                       "AHAP_BROWSER_ACCOUNT_SCOPE": "a" * 64,
                       "AHAP_BROWSER_CDP_WS_URL": f"ws://127.0.0.1:{server.server_port}/forbidden-browser",
                       "AHAP_BROWSER_CDP_CONTEXT_ID": "fixture-context", "AHAP_BROWSER_CDP_TARGET_ID": "fixture-target"}
                request = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"harness": harness, "ahapVersion": "0.1"}}
                result = subprocess.run([manifest["node"], manifest["adapters"][harness]],
                                        input=json.dumps(request) + "\n", text=True,
                                        capture_output=True, cwd=home, env=env, timeout=20)
                assert result.returncode == 0, (harness, result.stderr)
                replies = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                assert len(replies) == 1, (harness, replies)
                reply = replies[0]
                assert reply["id"] == 1 and reply["result"]["harness"] == harness, reply
                assert "sendMessage" in reply["result"]["capabilities"]["methods"], reply
                initialized[harness] = reply["result"]["capabilities"]
                assert not marker.exists(), "initialize launched a native executable"
            assert requests == [("GET", "/api/config")], requests
            if manifest.get("compat"):
                launch = manifest.get("launch_compat") or {}
                assert launch.get("env", {}).get("HERDER_NATIVE_COMMAND") == manifest["core"], launch
                assert launch.get("argv") == [manifest["compat"], "--trusted-owner-profile",
                                              "{protected_owner_profile}"], launch
                # The native core resolves identity against an existing private
                # HOME, like every real profile consumer. The probe profile must
                # also exist: a missing file fails with ENOENT before the trust
                # check, while an existing file with group/other permissions
                # reaches the exact untrusted-profile rejection.
                probe_home = root / "compat-probe-home"
                probe_home.mkdir(mode=0o700)
                untrusted_profile = root / "untrusted-profile"
                untrusted_profile.write_text("{}")
                untrusted_profile.chmod(0o644)
                # The exact packaged core must reject the untrusted profile
                # before any MCP traffic. Empty stdout proves the legacy edge
                # never served a session; the quoted core rejection proves the
                # translator forwarded launcher argv instead of dropping it.
                probe = subprocess.run(
                    [manifest["compat"], "--trusted-owner-profile", str(untrusted_profile)],
                    input="", text=True, capture_output=True, timeout=20,
                    env={"PATH": os.defpath, "HOME": str(probe_home),
                         "HERDER_NATIVE_COMMAND": manifest["core"]})
                assert probe.returncode != 0, (probe.returncode, probe.stdout)
                assert probe.stdout.strip() == "", probe.stdout
                assert "invalid or untrusted scoped launch profile" in probe.stderr, probe.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    checks = ["all-component-hashes", "duplicate-refusal-unchanged-bytes",
              "five-harness-initialize", "zero-native-executable-launches",
              "zero-native-mutations", "zero-browser-connections"]
    if manifest.get("compat"):
        checks.append("compat-forwards-trusted-profile-argv")
    print(json.dumps({"result": "PASS", "manifest_sha256": digest(manifest_path),
                      "checks": checks,
                      "capabilities": initialized}))


if __name__ == "__main__":
    main()
