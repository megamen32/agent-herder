#!/usr/bin/env python3
"""Bounded raw stdio client for V001; stdout is a JSONL wire receipt."""
import json
import pathlib
import queue
import subprocess
import sys
import threading


def main():
    binary = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else
                          "crates/herder/target/debug/herder-wire-probe").resolve()
    with subprocess.Popen([str(binary)], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as process:
        lines = queue.Queue()

        def read_stdout():
            for line in process.stdout:
                lines.put(line)
            lines.put(None)

        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()

        def exchange(request_id, method, **params):
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                    "name": "herder-v001-raw-probe", "version": "1.0.0"},
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            request = {"jsonrpc": "2.0", "id": request_id,
                       "method": method, "params": params}
            print(json.dumps({"sent": request}), flush=True)
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            line = lines.get(timeout=10)
            assert line is not None, "server closed stdout before response"
            response = json.loads(line)
            print(json.dumps({"received": response}), flush=True)
            assert response.get("jsonrpc") == "2.0", response
            assert response.get("id") == request_id, response
            assert "error" not in response, response
            result = response["result"]
            assert result.get("resultType") == "complete", result
            return result

        try:
            discovery = exchange(1, "server/discover")
            assert discovery["supportedVersions"] == ["2026-07-28"], discovery
            assert "tools" in discovery["capabilities"], discovery
            assert discovery["_meta"]["io.modelcontextprotocol/serverInfo"]["name"] == "herder-wire-probe"
            result = exchange(2, "tools/call", name="wire_probe", arguments={})
            assert result.get("isError") is False, result
            assert result["structuredContent"] == {"probe": "ok"}, result
            process.stdin.close()
            assert process.wait(timeout=10) == 0, process.returncode
            reader.join(timeout=1)
            assert not reader.is_alive(), "stdout reader did not finish"
            assert lines.get(timeout=1) is None, "unexpected extra stdout"
            print(json.dumps({"status": "PASS", "transport": "stdio",
                              "protocol": "2026-07-28", "requests": 2,
                              "server_exit": process.returncode}), flush=True)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
