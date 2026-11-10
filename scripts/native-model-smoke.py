#!/usr/bin/env python3
"""Run real CLI model requests against the local fixture in an isolated network.

This is a provider compatibility probe, not the Herder release acceptance gate.
It never reuses a user's home, credentials, sessions, or native sockets.
"""
import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ANSWER = "HERDER_TEST_MODEL_OK"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inside-netns", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--opencode", default="opencode")
    parser.add_argument("--herder-dist", help="Run the additional isolated Herder artifact probe against this dist directory")
    args = parser.parse_args()
    if not args.inside_netns:
        unshare = shutil.which("unshare")
        if not unshare:
            raise SystemExit("FAIL: unshare is required for network isolation")
        command = [unshare, "--user", "--map-root-user", "--net", sys.executable, __file__, "--inside-netns", "--codex", args.codex, "--opencode", args.opencode]
        if args.herder_dist:
            command += ["--herder-dist", args.herder_dist]
        os.execvp(unshare, command)

    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, capture_output=True)
    interfaces = [item["ifname"] for item in json.loads(subprocess.check_output(["ip", "-j", "link", "show"], text=True))]
    if interfaces != ["lo"]:
        raise SystemExit(f"FAIL: network namespace is not isolated: {interfaces}")
    binaries = {}
    for name in ("codex", "opencode"):
        path = shutil.which(getattr(args, name))
        if not path:
            raise SystemExit(f"FAIL: {name} executable not found")
        binaries[name] = os.path.realpath(path)
    # The fleet OpenCode wrapper resolves its binary relative to HOME; resolve
    # its known executable before replacing HOME, without reading that home.
    if pathlib.Path(binaries["opencode"]).name != "opencode-real":
        fleet_binary = pathlib.Path.home() / ".local/share/opencode-runtime/bin/opencode-real"
        if fleet_binary.exists():
            binaries["opencode"] = str(fleet_binary.resolve())

    with tempfile.TemporaryDirectory(prefix="herder-native-model-") as tmp:
        root = pathlib.Path(tmp)
        for name in ("home", "codex-home", "work", "config", "data", "cache", "autopilot"):
            (root / name).mkdir()
        # A separate user/network namespace has no user systemd bus. The
        # product's documented direct-spawn mode applies only to this test
        # instance; it never changes the installed service's environment.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"), "CODEX_HOME": str(root / "codex-home"), "OPENCODE_SERVER_PASSWORD": "isolated-test-only", "AGENT_HERDER_AUTOPILOT_STATE_DIR": str(root / "autopilot"), "AGENT_HERDER_WORKLOAD_ISOLATION": "off", "LANG": "C.UTF-8"}
        # The fake provider has no account quota. This policy lives exclusively
        # in the temporary test state and never touches the production guard.
        (root / "autopilot/codex-quota-guard.json").write_text(json.dumps({"version": 1, "policy": {"enabled": False, "minRemainingPercent": 20, "onUnknown": "block"}}))
        server = subprocess.Popen([sys.executable, str(HERE / "test-model-server.py")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        try:
            port = int(server.stdout.readline().strip())
            base = f"http://127.0.0.1:{port}/v1"
            (root / "codex-home/config.toml").write_text(f'model = "herder-test"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "{base}"\nwire_api = "responses"\n')
            config = {"provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Local fixture", "options": {"baseURL": base, "apiKey": "fixture"}, "models": {"herder-test": {"name": "Herder test"}}}}, "model": "fixture/herder-test", "autoupdate": False}
            (root / "work/opencode.json").write_text(json.dumps(config))
            results = []
            commands = {"codex": [binaries["codex"], "exec", "--skip-git-repo-check", "Return a marker."], "opencode": [binaries["opencode"], "run", "--standalone", "--format", "json", "-m", "fixture/herder-test", "Return a marker."]}
            for name, command in commands.items():
                version = subprocess.run([binaries[name], "--version"], env=env, cwd=root / "work", capture_output=True, text=True, timeout=10, check=True).stdout.strip()
                before = stats(port)
                start = time.monotonic()
                result = subprocess.run(command, env=env, cwd=root / "work", input="", capture_output=True, text=True, timeout=60)
                after = stats(port)
                if result.returncode != 0 or ANSWER not in result.stdout or after <= before:
                    print(json.dumps({"harness": name, "status": "FAIL", "exit": result.returncode, "fixture_requests": after - before, "stderr": result.stderr[-2000:]}, ensure_ascii=False), file=sys.stderr)
                    return 1
                results.append({"harness": name, "version": version, "status": "PASS", "fixture_requests": after - before, "seconds": round(time.monotonic() - start, 3)})
            print(json.dumps({"scope": "native-provider-compatibility-only", "network": "private-loopback", "results": results}, ensure_ascii=False))
            if args.herder_dist:
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0))
                    open_code_port = listener.getsockname()[1]
                native = subprocess.Popen([binaries["opencode"], "serve", "--hostname", "127.0.0.1", "--port", str(open_code_port)], env=env, cwd=root / "work", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    for _ in range(100):
                        try:
                            with socket.create_connection(("127.0.0.1", open_code_port), timeout=0.1):
                                break
                        except OSError:
                            if native.poll() is not None:
                                raise RuntimeError("OpenCode server exited before listening")
                            time.sleep(0.1)
                    else:
                        raise RuntimeError("OpenCode server did not listen")
                    subprocess.run(["node", str(HERE / "native-herder-probe.mjs"), args.herder_dist, str(root / "work"), f"http://127.0.0.1:{open_code_port}"], env=env, cwd=root / "work", check=True, timeout=120)
                finally:
                    native.terminate()
                    try:
                        native.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        native.kill()
                        native.wait()
            return 0
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def stats(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/_stats", timeout=5) as response:
        return json.load(response)["requests"]


if __name__ == "__main__":
    sys.exit(main())
