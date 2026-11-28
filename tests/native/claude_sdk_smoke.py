"""Exercise the compiled AHAP runner and real SDK with an offline Messages endpoint.

Run npm run build:core and npx tsc, then python3 tests/native/claude_sdk_smoke.py.
The child environment contains only fixture settings. The HTTP server discards
request headers and never logs prompts.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import time
import select


class MessagesFixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if urlparse(self.path).path.endswith("/count_tokens"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"input_tokens":20}')
            return

        message = dict(id="msg_fixture", type="message", role="assistant", model=request["model"],
                       content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=10, output_tokens=0))
        has_result = any(block.get("type") == "tool_result"
                         for message_item in request.get("messages", [])
                         for block in message_item.get("content", []) if isinstance(block, dict))
        if has_result:
            block = dict(type="text", text="")
            delta = dict(type="text_delta", text="HERDER_OK")
            stop_reason = "end_turn"
        else:
            block = dict(type="tool_use", id="toolu_fixture", name="Write", input={})
            delta = dict(type="input_json_delta", partial_json=json.dumps({
                "file_path": self.server.fixture_file, "content": "fixture",
            }))
            stop_reason = "tool_use"
        events = [
            ("message_start", dict(message=message)),
            ("content_block_start", dict(index=0, content_block=block)),
            ("content_block_delta", dict(index=0, delta=delta)),
            ("content_block_stop", dict(index=0)),
            ("message_delta", dict(delta=dict(stop_reason=stop_reason, stop_sequence=None), usage=dict(output_tokens=4))),
            ("message_stop", {}),
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event, body in events:
            data = json.dumps(dict(type=event, **body))
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())


def smoke():
    runner = Path(__file__).resolve().parents[2] / "dist" / "ahap-claude-runner.js"
    with ThreadingHTTPServer(("127.0.0.1", 0), MessagesFixture) as provider, tempfile.TemporaryDirectory() as work:
        provider.fixture_file = str(Path(work) / "denied.txt")
        Thread(target=provider.serve_forever, daemon=True).start()
        env = dict(PATH=os.environ["PATH"], CLAUDE_CONFIG_DIR=f"{work}/config",
                   AGENT_HERDER_AUTOPILOT_STATE_DIR=f"{work}/state", ANTHROPIC_API_KEY="fixture",
                   ANTHROPIC_BASE_URL=f"http://127.0.0.1:{provider.server_port}", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
        child = subprocess.Popen(["node", runner], cwd=work, env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        request_id = 0

        def call(method, **params):
            nonlocal request_id
            request_id += 1
            child.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)) + "\n")
            child.stdin.flush()
            assert select.select([child.stdout], [], [], 30)[0], f"{method} timed out"
            response = json.loads(child.stdout.readline())
            assert response["id"] == request_id and "error" not in response, method
            return response["result"]

        try:
            call("initialize", harness="claude", ahapVersion="0.1")
            call("init")
            session = call("createSession", options=dict(cwd=work, name="loopback", model="claude-sonnet-4-5",
                                                        permissionMode="default", effort="medium", thinkingBudget=4096))
            target = dict(id=session["id"])
            assert session["meta"]["ready"]
            assert session["meta"]["effectiveSettings"]["thinkingBudget"] == 4096
            assert call("stopSession", **target)["ok"]
            assert call("resumeSession", **target)["ok"]
            receipt = call("sendMessage", **target, options=dict(queue=True, inputId="smoke-key", message="Reply HERDER_OK"))
            assert receipt["admitted"]
            for _ in range(50):
                state = call("getPermissionState", **target)
                if state["pendingRequests"]:
                    break
                time.sleep(0.2)
            else:
                raise AssertionError("No native permission request")
            approval = state["pendingRequests"][0]
            assert approval["toolName"] == "Write" and approval["canRespond"]
            assert call("respondPermission", **target, permissionId=approval["id"], response="deny")["ok"]
            for _ in range(40):
                info = call("getSession", **target)
                if info["status"] == "idle" and info.get("lastMessage") == "HERDER_OK":
                    break
                time.sleep(0.25)
            else:
                raise AssertionError("No terminal progress digest")
            messages = call("getSessionMessages", **target, limit=10)
            assert any(row["role"] == "assistant" and row["text"] == "HERDER_OK" for row in messages)
            proof = call("getSessionMessages", **target, recoverInputId="smoke-key")
            assert len(proof) == 1 and proof[0]["id"] == receipt["nativeInputMessageId"]
            assert not Path(provider.fixture_file).exists()
            call("shutdown")
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            provider.shutdown()


if __name__ == "__main__":
    smoke()
    print("Claude SDK offline lifecycle passed")
