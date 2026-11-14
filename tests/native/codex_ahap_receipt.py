#!/usr/bin/env python3
"""Prove the real Agent Herder Codex adapter through its AHAP consumer.

The child is the compiled AHAP facade over CodexAppServerAdapter. The driver
does one native delivery and only repeats read-only calls while waiting for the
durable transcript. An unknown delivery outcome fails without replay.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid


ANSWER = "HERDER_TEST_MODEL_OK"


def text_of(message):
    if isinstance(message, dict) and isinstance(message.get("text"), str):
        return message["text"]
    parts = message.get("parts") if isinstance(message, dict) else None
    if isinstance(parts, list):
        return "\n".join(part.get("text", "") for part in parts if isinstance(part, dict))
    return ""


def session_rows(value):
    if isinstance(value, dict) and isinstance(value.get("sessions"), list):
        return value["sessions"]
    if isinstance(value, list):
        return value
    raise RuntimeError("listSessions did not return a session list")


def main():
    if len(sys.argv) != 4:
        raise ValueError("expected absolute node, AHAP runner and Codex paths")
    node, runner, codex = map(Path, sys.argv[1:])
    if not all(path.is_absolute() for path in (node, runner, codex)):
        raise ValueError("node, AHAP runner and Codex paths must be absolute")
    base = os.environ.get("HERDER_TEST_MODEL_BASE_URL", "")
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.path != "/v1" or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise ValueError("isolated loopback model fixture required")

    home = Path(os.environ["HOME"])
    project = home / "work"
    project.mkdir(mode=0o700)
    codex_home = home / ".codex"
    codex_home.mkdir(mode=0o700)
    (codex_home / "config.toml").write_text(
        'model = "herder-test"\nmodel_provider = "fixture"\n'
        '[model_providers.fixture]\nname = "fixture"\n'
        f'base_url = "{base}"\nwire_api = "responses"\n'
        'requires_openai_auth = false\n'
    )
    env = dict(os.environ,
               HOME=str(home),
               CODEX_HOME=str(codex_home),
               AGENT_HERDER_WORKLOAD_ISOLATION="off",
               AHAP_VERSION="0.1",
               AHAP_HARNESS="codex",
               AHAP_CODEX_BIN=str(codex),
               AHAP_CODEX_CWD=str(project),
               AHAP_CODEX_MODEL="herder-test")
    child = subprocess.Popen(
        [str(node), str(runner)],
        cwd=project,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    serial = 0

    def request(method, params):
        nonlocal serial
        serial += 1
        request_id = serial
        child.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
        }) + "\n")
        child.stdin.flush()
        while True:
            line = child.stdout.readline()
            if not line:
                diagnostics = child.stderr.read()[-4000:]
                raise RuntimeError(f"AHAP consumer exited; outcome unknown, no replay: {diagnostics}")
            message = json.loads(line)
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(f"{method} failed: {message['error']}")
            return message.get("result")

    def fixture_requests():
        with urllib.request.urlopen(base[:-3] + "/_stats", timeout=5) as response:
            return json.load(response)["requests"]

    input_id = "ahap-codex-proof-" + uuid.uuid4().hex
    prompt = "AHAP_ADAPTER_READ_SEND_READBACK_" + uuid.uuid4().hex
    completed = False
    try:
        capabilities = request("initialize", {"harness": "codex", "ahapVersion": "0.1"})
        methods = set(capabilities.get("capabilities", {}).get("methods", []))
        required = {"init", "listSessions", "getSession", "getSessionMessages", "sendMessage"}
        if not required.issubset(methods):
            raise RuntimeError(f"Codex adapter readiness is incomplete: missing {sorted(required - methods)}")

        request("init", {})
        before = fixture_requests()
        listed_before = session_rows(request("listSessions", {"limit": 100}))
        created = request("createSession", {
            "options": {"name": "AHAP adapter proof", "cwd": str(project),
                        "model": "herder-test", "fullAccess": False},
        })
        session_id = created.get("id") if isinstance(created, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("createSession did not return a native session ID")

        # This is the only mutating consumer call in the proof.
        sent = request("sendMessage", {
            "id": session_id,
            "options": {"queue": False, "steer": False, "origin": "human",
                        "message": prompt, "inputId": input_id, "model": "herder-test"},
        })
        if (not isinstance(sent, dict) or sent.get("ok") is not True
                or sent.get("admitted") is not True
                or sent.get("inputId") != input_id
                or not isinstance(sent.get("turnId"), str) or not sent["turnId"]):
            raise RuntimeError(f"one send was not admitted with an exact turn receipt: {sent}")

        deadline = time.monotonic() + 30
        read_session = None
        read_messages = None
        while time.monotonic() < deadline:
            read_session = request("getSession", {"id": session_id})
            read_messages = request("getSessionMessages", {"id": session_id, "limit": 50})
            rows = read_messages if isinstance(read_messages, list) else []
            users = [row for row in rows if isinstance(row, dict) and row.get("role") == "user"
                     and text_of(row) == prompt]
            assistants = [row for row in rows if isinstance(row, dict) and row.get("role") == "assistant"
                          and text_of(row) == ANSWER]
            if len(users) == 1 and len(assistants) == 1:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("durable Codex message readback did not contain the exact user and answer")

        listed_after = session_rows(request("listSessions", {"limit": 100}))
        if not any(isinstance(row, dict) and row.get("id") == session_id for row in listed_after):
            raise RuntimeError("listSessions did not return the admitted native session")
        if not isinstance(read_session, dict) or read_session.get("id") != session_id:
            raise RuntimeError("getSession returned a different native identity")
        after = fixture_requests()
        if after - before != 1:
            raise RuntimeError(f"fake model observed {after - before} requests; expected exactly one")
        print(json.dumps({
            "scope": "Agent Herder AHAP consumer -> CodexAppServerAdapter -> real Codex app-server",
            "readiness": "confirmed",
            "listedBefore": len(listed_before),
            "nativeSessionId": session_id,
            "nativeTurnId": sent["turnId"],
            "inputId": input_id,
            "read": {"session": True, "messages": True, "exactUser": True, "exactAssistant": True},
            "send": {"attempts": 1, "admitted": True, "receipt": sent},
            "fixtureRequests": after - before,
            "readback": "confirmed",
        }))
        completed = True
    finally:
        if child.poll() is None:
            if completed:
                try:
                    request("shutdown", {})
                except Exception:
                    child.terminate()
            else:
                # A failed/timeout mutation is deliberately not followed by
                # another blocking protocol call. Terminate the disposable
                # child and leave the original outcome unknown for inspection.
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
