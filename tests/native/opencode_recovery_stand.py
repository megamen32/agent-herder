#!/usr/bin/env python3
"""Verify crash and quota recovery against a native OpenCode v2 in launch.py."""

import argparse
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import threading
import time
from urllib.error import URLError

from codex_recovery_stand import (
    ACCOUNT, FALLBACK_MODEL, MCP_META, OTHER_ACCOUNT, digest, http_fixture, make_authority,
    model_fixture, namespace, owner_client, private_write, quota_backup, require,
    session_tool, wait_for,
)
from opencode_mcp_create_stand import api

INSTANCE = "opencode-recovery-fixture"
CRASH_MODEL = "recover-after-crash"
QUOTA_MODEL = "terminal-quota"
FALLBACK_PROVIDER = "fixture-reserve"


def providers(model, token):
    entered = threading.Event()
    release = threading.Event()

    class Primary(model.Handler):
        received = []

        def chat(self, request, sequence):
            selected = request.get("model")
            self.received.append(selected)
            if selected == CRASH_MODEL and self.received.count(selected) == 1:
                entered.set()
                release.wait(30)
                return
            if selected == QUOTA_MODEL:
                error = {"error": {"type": "insufficient_quota", "code": "insufficient_quota",
                                   "message": "Fixture account quota exhausted"}}
                return self.reply(429, "application/json", json.dumps(error).encode())
            require(selected == CRASH_MODEL, "unexpected request on the primary route")
            return super().chat(request, sequence)

    class Reserve(model.Handler):
        received = []

        def chat(self, request, sequence):
            if request.get("model") != FALLBACK_MODEL or self.headers.get("Authorization") != "Bearer " + token:
                return self.reply(403, "text/plain", b"fixture reserve route did not match")
            self.received.append(request["model"])
            return super().chat(request, sequence)

    return Primary, Reserve, entered, release


def provider(endpoint, key, models):
    return {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
            "options": {"baseURL": endpoint, "apiKey": key},
            "models": {model: {"name": model} for model in models}}


@contextmanager
def opencode(binary, project, endpoint, env, log):
    with log.open("ab") as stderr:
        child = subprocess.Popen([str(binary), "serve", "--hostname", "127.0.0.1",
                                  "--port", endpoint.rsplit(":", 1)[1]], cwd=project,
                                 env=env, stdout=stderr, stderr=stderr)
        try:
            def ready():
                if child.poll() is not None:
                    raise RuntimeError("isolated OpenCode exited during startup")
                try:
                    status, schema = api(endpoint, "/openapi.json", timeout=2)
                    return status == 200 and "/api/session/{sessionID}/synthetic" in schema.get("paths", {})
                except (URLError, TimeoutError):
                    return False
            wait_for("native OpenCode v2 API did not start", ready)
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(5)


def call(endpoint, path, body=None, status=200):
    response, value = api(endpoint, path, body)
    require(response == status, f"unexpected native status {response} for {path}")
    return value.get("data", value) if isinstance(value, dict) else value


def seed(endpoint, project, model):
    row = call(endpoint, "/api/session", {"location": {"directory": str(project)},
               "model": {"providerID": "fixture-primary", "id": model}, "title": "Isolated recovery"})
    native_id = row["id"]
    prompt = call(endpoint, f"/api/session/{native_id}/prompt", {
        "text": "Continue this isolated fixture without tools", "delivery": "queue",
    })
    require(prompt["sessionID"] == native_id, "seed receipt points to another session")
    return native_id, prompt["id"]


def messages(endpoint, native_id):
    return call(endpoint, f"/api/session/{native_id}/message?limit=30&order=asc")


def durable(database, native_id):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        return conn.execute(
            """SELECT i.state, i.native_receipt, t.result_json
               FROM intents i JOIN session_bindings b ON b.session_ref=i.target
               JOIN tasks t ON t.task_id=i.task_id
               WHERE b.native_session_id=? AND i.request_key LIKE 'opencode-recovery:%'""",
            (native_id,),
        ).fetchall()


def verified(owner, endpoint, database, native_id, session_ref, original, answer, expected_provider, expected_model):
    def result():
        rows = durable(database, native_id)
        if len(rows) != 1 or rows[0][0] != "confirmed":
            return None
        packet = messages(endpoint, native_id)
        continuation = [m for m in packet if m.get("type") == "synthetic"
                        and m.get("metadata", {}).get("agentHerderInputId", "").startswith("opencode-recovery:")]
        assistant = [m for m in packet if m.get("type") == "assistant" and answer in json.dumps(m.get("content"))]
        if not assistant:
            return None
        require(len(continuation) == 1 and len(assistant) == 1, "native recovery was duplicated")
        receipt = json.loads(rows[0][1])
        require(receipt["address"]["native_session_id"] == native_id
                and receipt["native_id"] == continuation[0]["id"], "receipt did not bind the native inbox ID")
        require(any(m["id"] == original and m["type"] == "user" for m in packet),
                "the original user input is absent from the resumed session")
        require(assistant[0]["model"]["providerID"] == expected_provider
                and assistant[0]["model"]["id"] == expected_model, "recovery used a different model")
        response = owner.request("tools/call", {"_meta": MCP_META, "name": "session",
            "arguments": {"action": "messages", "session_ref": session_ref}})
        projection = response["structuredContent"]
        if response.get("isError") and projection.get("code") == "scope_unavailable":
            return None
        require(not response.get("isError"), f"native owner read failed: {projection}")
        require(answer in json.dumps(projection), "the native owner could not read back the reply")
        return receipt["native_id"]
    try:
        return wait_for("native OpenCode continuation did not complete", result, seconds=45)
    except TimeoutError as error:
        packet = messages(endpoint, native_id)
        raise RuntimeError(f"{error}; states={durable(database, native_id)}; "
                           f"packet={[m.get('type') for m in packet]}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode", type=Path, required=True)
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--schema-dir", type=Path, required=True)
    args = parser.parse_args()
    require(os.environ.get("HERDER_FIXTURE_PARENT_NET") not in (None, namespace())
            and {name for _, name in socket.if_nameindex()} == {"lo"},
            "run this fixture with tests/native/launch.py")
    os.umask(0o077)
    root = Path("/herder-owner-home")
    project = root / "project"
    project.mkdir()
    env = dict(os.environ, OPENCODE_SERVER_PASSWORD="fixture-only",
               OPENCODE_DISABLE_AUTOUPDATE="1", OPENCODE_DISABLE_MODELS_FETCH="1")
    with socket.socket() as port:
        port.bind(("127.0.0.1", 0))
        endpoint = f"http://127.0.0.1:{port.getsockname()[1]}"
    module = model_fixture()
    token = "fixture-" + secrets.token_hex(24)
    primary, reserve, entered, release = providers(module, token)
    with http_fixture(primary) as primary_url, http_fixture(reserve) as reserve_url:
        private_write(project / "opencode.json", json.dumps({"autoupdate": False, "provider": {
            "fixture-primary": provider(primary_url, "fixture-primary-only", [CRASH_MODEL, QUOTA_MODEL]),
            FALLBACK_PROVIDER: provider(reserve_url, token, [FALLBACK_MODEL]),
        }}))
        gate, database = make_authority(root, args.schema_dir)
        profile = root / "profile.json"
        # The native HTTP profile's executable field is a protected launcher
        # binding. OpenCode itself is the separately started HTTP server.
        owner = {"kind": "opencode", "principal": "fixture-owner", "node": "fixture-node",
                 "instance": INSTANCE, "code_home": str(root), "cwd": str(project), "executable": "/usr/bin/true",
                 "ahap_base_url": endpoint, "ahap_env": {"AHAP_OPENCODE_PASSWORD": "fixture-only"}}
        data = {"database": str(database), "gate": str(gate), "generation": "fixture", "owner": owner}
        private_write(profile, json.dumps(data))
        log = root / "opencode.log"
        with opencode(args.opencode, project, endpoint, env, log) as backend:
            crashed, crash_input = seed(endpoint, project, CRASH_MODEL)
            require(entered.wait(12), "the original native request never reached the model")
            backend.kill()
            backend.wait(6)
            release.set()

        with opencode(args.opencode, project, endpoint, env, log):
            cold = call(endpoint, f"/api/session/{crashed}")
            active = call(endpoint, "/api/session/active")
            require(crashed not in active, "the original native session is still running")
            print(json.dumps({"phase": "crashed_session", "outcome": cold.get("outcome"),
                              "busy_recorded": "busy" in cold["time"],
                              "packet": [m["type"] for m in messages(endpoint, crashed)]}), flush=True)
            exhausted, exhausted_input = seed(endpoint, project, QUOTA_MODEL)
            wait_for("native OpenCode did not record terminal quota exhaustion", lambda: (
                call(endpoint, f"/api/session/{exhausted}").get("outcome") == "failed"
                and exhausted not in call(endpoint, "/api/session/active")
            ), seconds=45)
            failures = primary.received.count(QUOTA_MODEL)
            require(failures > 0, "no quota failure reached the primary provider")
            with owner_client(args.core, profile, env) as provision:
                registered = [session_tool(provision, action="register", instance_ref=INSTANCE,
                              native_session_id=native_id, request_key=f"register-{native_id}")
                              for native_id in (crashed, exhausted)]
            refs = {r["address"]["native_session_id"]: r["session_ref"] for r in registered}
            require(set(refs) == {crashed, exhausted}, "registered session identities differ")
            wrong, exact = root / "foreign-quota.sqlite", root / "exact-quota.sqlite"
            quota_backup(wrong, token, OTHER_ACCOUNT)
            quota_backup(exact, token, ACCOUNT)
            route = {"workspace": str(project), "provider": FALLBACK_PROVIDER, "model": FALLBACK_MODEL,
                     "omniroute": {"upstream_provider": "codex", "account": ACCOUNT,
                                   "database": str(wrong), "endpoint": reserve_url}}
            owner["opencode_recovery"] = {"autopilot_state_dir": str(root), "fallback_routes": [route]}
            private_write(root / "session-autostart.json", json.dumps({
                "version": 8, "enabled": True, "waitForQuota": True, "fallbackForQuota": True, "sessions": [],
            }))
            private_write(profile, json.dumps(data))
            with owner_client(args.core, profile, env) as active:
                crashed_receipt = verified(active, endpoint, database, crashed, refs[crashed], crash_input,
                                            module.ANSWER, "fixture-primary", CRASH_MODEL)
            require(reserve.count == 0 and not durable(database, exhausted), "foreign quota authorized a recovery")

            route["omniroute"]["database"] = str(exact)
            private_write(profile, json.dumps(data))
            with owner_client(args.core, profile, env) as active:
                fallback_receipt = verified(active, endpoint, database, exhausted, refs[exhausted],
                                             exhausted_input, module.ANSWER, FALLBACK_PROVIDER, FALLBACK_MODEL)
            with owner_client(args.core, profile, env) as reopened:
                time.sleep(3)
                require(verified(reopened, endpoint, database, exhausted, refs[exhausted], exhausted_input,
                                 module.ANSWER, FALLBACK_PROVIDER, FALLBACK_MODEL) == fallback_receipt,
                        "owner restart did not retain the existing recovery")
            require(primary.received.count(CRASH_MODEL) == 2 and primary.received.count(QUOTA_MODEL) == failures
                    and reserve.count == 1 and reserve.received == [FALLBACK_MODEL], "model requests were repeated")
            print(json.dumps({"result": "verified", "opencode_sha256": digest(args.opencode),
                              "owner_sha256": digest(args.core), "crash_receipt": crashed_receipt,
                              "fallback_receipt": fallback_receipt, "fallback_requests": reserve.count,
                              "replayed": 0}), flush=True)


if __name__ == "__main__":
    main()
