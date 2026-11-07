#!/usr/bin/env python3
"""Run a command with a disposable profile and a loopback test-model endpoint."""
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile


def main():
    command = sys.argv[1:]
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("usage: python3 launch.py -- COMMAND [ARGS...]", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="herder-native-") as root:
        home = Path(root) / "home"
        home.mkdir(mode=0o700)
        for name in ("config", "cache", "data", "state", "tmp"):
            (home / name).mkdir(mode=0o700)
        env = {
            "HOME": str(home), "PATH": os.defpath,
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "XDG_DATA_HOME": str(home / "data"),
            "XDG_STATE_HOME": str(home / "state"),
            "TMPDIR": str(home / "tmp"),
        }
        server = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("test-model-server.py"))],
            env=env, stdout=subprocess.PIPE, text=True,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(server.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=10):
                    raise RuntimeError("test model did not start within 10 seconds")
                port = server.stdout.readline().strip()
            if not port.isdecimal() or not 0 < int(port) < 65536:
                raise RuntimeError("test model did not report a valid port")
            env["HERDER_TEST_MODEL_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
            return subprocess.run(command, env=env, check=False).returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            server.stdout.close()


if __name__ == "__main__":
    sys.exit(main())
