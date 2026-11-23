#!/usr/bin/env python3
"""Verify crash, throttling, and quota recovery against a native OpenCode v2 in launch.py."""

import argparse
from contextlib import closing, contextmanager
import json
import os
import re
from pathlib import Path
import secrets
import signal
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
SHUTDOWN_MODEL = "recover-after-shutdown"
NATIVE_STOPPED_MODEL = "native-interrupt"
THROTTLED_MODEL = "temporary-rate-limit"
CHAIN_MODEL = "failed-primary-then-fallback"
UNKNOWN_FAILURE_MODEL = "unknown-terminal-native-failure"
STOPPED_MODEL = "human-stop"
QUESTION_MODEL = "pending-human-request"
AMBIGUOUS_MODEL = "legacy-delivery-unknown"
PROTECTED_MODELS = (STOPPED_MODEL, QUESTION_MODEL, AMBIGUOUS_MODEL)
QUOTA_MODEL = "terminal-quota"
FALLBACK_PROVIDER = "fixture-reserve"


def providers(model, token):
    interruptions = {name: (threading.Event(), threading.Event())
                     for name in (CRASH_MODEL, SHUTDOWN_MODEL, NATIVE_STOPPED_MODEL)}
    throttle_cleared = threading.Event()

    class Primary(model.Handler):
        received = []

        def chat(self, request, sequence):
            selected = request.get("model")
            self.received.append(selected)
            if selected in interruptions:
                if self.received.count(selected) == 1:
                    entered, release = interruptions[selected]
                    entered.set()
                    release.wait(30)
                    return
                return super().chat(request, sequence)
            if selected in (THROTTLED_MODEL, CHAIN_MODEL, UNKNOWN_FAILURE_MODEL, *PROTECTED_MODELS):
                if selected != CHAIN_MODEL and throttle_cleared.is_set():
                    return super().chat(request, sequence)
                if selected == UNKNOWN_FAILURE_MODEL:
                    error = json.dumps({"error": {"type": "provider.future-error",
                                                  "message": "Unknown terminal fixture failure"}}).encode()
                    self.send_response(418)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(error)))
                    self.send_header("x-should-retry", "false")
                    self.end_headers()
                    self.wfile.write(error)
                    return
                error = json.dumps({"error": {"type": "rate_limit_exceeded", "code": "rate_limit_exceeded",
                                              "message": "Temporary fixture throttle"}}).encode()
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(error)))
                # Make the original turn terminal immediately instead of waiting out OpenCode's retry budget.
                self.send_header("x-should-retry", "false")
                self.end_headers()
                self.wfile.write(error)
                return
            if selected == QUOTA_MODEL:
                error = {"error": {"type": "insufficient_quota", "code": "insufficient_quota",
                                   "message": "Fixture account quota exhausted"}}
                return self.reply(429, "application/json", json.dumps(error).encode())
            raise RuntimeError("unexpected request on the primary route")

    class Reserve(model.Handler):
        received = []

        def chat(self, request, sequence):
            if request.get("model") != FALLBACK_MODEL or self.headers.get("Authorization") != "Bearer " + token:
                return self.reply(403, "text/plain", b"fixture reserve route did not match")
            self.received.append(request["model"])
            return super().chat(request, sequence)

    return Primary, Reserve, interruptions, throttle_cleared


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


def seed_throttled(endpoint, project, primary, model):
    native_id, original = seed(endpoint, project, model)
    wait_for("native OpenCode did not record a terminal temporary 429", lambda: (
        any(m.get("type") == "idle" and m.get("outcome") == "failed"
            and (m.get("error") or {}).get("type") == "provider.rate-limit"
            and (m.get("error") or {}).get("status") == 429 for m in messages(endpoint, native_id))
        and native_id not in call(endpoint, "/api/session/active")
    ), seconds=15)
    require(primary.received.count(model) == 1, "expected a single terminal 429 per test chat")
    return native_id, original


def seed_unknown_terminal_failure(endpoint, project, primary):
    native_id, original = seed(endpoint, project, UNKNOWN_FAILURE_MODEL)
    wait_for("native OpenCode did not record the unknown terminal provider failure", lambda: (
        any(m.get("type") == "idle" and m.get("outcome") == "failed"
            for m in messages(endpoint, native_id))
        and native_id not in call(endpoint, "/api/session/active")
    ), seconds=15)
    terminal = next(m for m in messages(endpoint, native_id)
                    if m.get("type") == "idle" and m.get("outcome") == "failed")
    require((terminal.get("error") or {}).get("type") not in ("provider.rate-limit", "provider.quota"),
            f"fixture failure was normalized to a known class: {terminal}")
    require(primary.received.count(UNKNOWN_FAILURE_MODEL) == 1,
            "expected one initial unknown terminal failure per test chat")
    return native_id, original


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
    primary, reserve, interruptions, throttle_cleared = providers(module, token)
    with http_fixture(primary) as primary_url, http_fixture(reserve) as reserve_url:
        primary_models = [*interruptions, THROTTLED_MODEL, CHAIN_MODEL, UNKNOWN_FAILURE_MODEL,
                          QUOTA_MODEL, *PROTECTED_MODELS]
        private_write(project / "opencode.json", json.dumps({"autoupdate": False, "provider": {
            "fixture-primary": provider(primary_url, "fixture-primary-only", primary_models),
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
        interrupted = {}
        for name, termination in ((CRASH_MODEL, signal.SIGKILL), (SHUTDOWN_MODEL, signal.SIGTERM)):
            with opencode(args.opencode, project, endpoint, env, log) as backend:
                interrupted[name] = seed(endpoint, project, name)
                entered, release = interruptions[name]
                require(entered.wait(12), "the original native request never reached the model")
                backend.send_signal(termination)
                backend.wait(6)
                release.set()
        crashed, crash_input = interrupted[CRASH_MODEL]
        shutdown, shutdown_input = interrupted[SHUTDOWN_MODEL]

        with opencode(args.opencode, project, endpoint, env, log):
            cold = call(endpoint, f"/api/session/{crashed}")
            active = call(endpoint, "/api/session/active")
            require(crashed not in active and shutdown not in active, "an interrupted session is still running")
            print(json.dumps({"phase": "crashed_session", "outcome": cold.get("outcome"),
                              "busy_recorded": "busy" in cold["time"],
                              "packet": [m["type"] for m in messages(endpoint, crashed)]}), flush=True)
            shutdown_state = call(endpoint, f"/api/session/{shutdown}")
            shutdown_history = messages(endpoint, shutdown)
            require(not shutdown_state.get("outcome") and shutdown_state["time"].get("idle") is None
                    and any(m["type"] == "assistant" and (m.get("error") or {}).get("type") == "aborted"
                            for m in shutdown_history),
                    "SIGTERM did not record the unfinished native assistant step")

            native_stopped, _ = seed(endpoint, project, NATIVE_STOPPED_MODEL)
            entered, release = interruptions[NATIVE_STOPPED_MODEL]
            require(entered.wait(12), "the native interrupt fixture never reached the model")
            status, _ = api(endpoint, f"/api/session/{native_stopped}/interrupt", {}, timeout=10)
            require(200 <= status < 300, f"native interrupt refused with HTTP {status}")
            release.set()
            wait_for("native interrupt did not record its terminal outcome", lambda: (
                call(endpoint, f"/api/session/{native_stopped}").get("outcome") == "interrupted"
                and native_stopped not in call(endpoint, "/api/session/active")
            ), seconds=10)
            exhausted, exhausted_input = seed(endpoint, project, QUOTA_MODEL)
            wait_for("native OpenCode did not record terminal quota exhaustion", lambda: (
                call(endpoint, f"/api/session/{exhausted}").get("outcome") == "failed"
                and exhausted not in call(endpoint, "/api/session/active")
            ), seconds=45)
            failures = primary.received.count(QUOTA_MODEL)
            require(failures > 0, "no quota failure reached the primary provider")
            throttled, throttled_input = seed_throttled(endpoint, project, primary, THROTTLED_MODEL)
            chained, chained_input = seed_throttled(endpoint, project, primary, CHAIN_MODEL)
            unknown_failed, unknown_input = seed_unknown_terminal_failure(endpoint, project, primary)
            protected = {model: seed_throttled(endpoint, project, primary, model)[0]
                         for model in PROTECTED_MODELS}
            protected[NATIVE_STOPPED_MODEL] = native_stopped
            original_history = {sid: messages(endpoint, sid) for sid in protected.values()}
            throttle_cleared.set()
            sessions = (crashed, shutdown, exhausted, throttled, chained, unknown_failed, *protected.values())
            with owner_client(args.core, profile, env) as provision:
                registered = [session_tool(provision, action="register", instance_ref=INSTANCE,
                              native_session_id=native_id, request_key=f"register-{native_id}")
                              for native_id in sessions]
                refs = {r["address"]["native_session_id"]: r["session_ref"] for r in registered}
                require(set(refs) == set(sessions), "registered session identities differ")
                stopped = provision.request("tools/call", {
                    "_meta": MCP_META, "name": "stop",
                    "arguments": {"action": "stop", "session_ref": refs[protected[STOPPED_MODEL]],
                                  "request_key": "fixture-operator-stop"},
                })
                require(not stopped.get("isError") and stopped["structuredContent"]["hold"] == "active",
                        "OpenCode owner did not record the operator stop")
            wrong, exact = root / "foreign-quota.sqlite", root / "exact-quota.sqlite"
            quota_backup(wrong, token, OTHER_ACCOUNT)
            quota_backup(exact, token, ACCOUNT)
            route = {"workspace": str(project), "provider": FALLBACK_PROVIDER, "model": FALLBACK_MODEL,
                     "omniroute": {"upstream_provider": "codex", "account": ACCOUNT,
                                   "database": str(wrong), "endpoint": reserve_url}}
            # Exercise the same protected registries as a real legacy-to-Rust transfer.
            handoff = {"native_sessions": sessions}
            registries = {
                "activation_file": True,
                "human_stops": {"version": 1, "sessions": []},
                "choices": {"version": 1, "requests": []},
                "human_requests": {"version": 1, "requests": [
                    {"target": {"agent": "opencode", "sessionId": protected[QUESTION_MODEL]}, "status": "pending"},
                ]},
                "unfinished_sessions": {"version": 1, "sessions": [
                    {"harness": "opencode", "sessionId": protected[AMBIGUOUS_MODEL],
                     "quotaRecovery": {"state": "dispatching", "reasonCode": "delivery_unknown"}},
                ]},
            }
            for name, contents in registries.items():
                path = root / f"{name}.json"
                private_write(path, json.dumps(contents))
                handoff[name] = str(path)
            owner["opencode_recovery"] = {"autopilot_state_dir": str(root), "fallback_routes": [route],
                                         "legacy_handoff": handoff}
            private_write(root / "session-autostart.json", json.dumps({
                "version": 8, "enabled": True, "waitForQuota": True, "fallbackForQuota": True, "sessions": [],
            }))
            private_write(profile, json.dumps(data))
            with owner_client(args.core, profile, env) as active:
                crashed_receipt = verified(active, endpoint, database, crashed, refs[crashed], crash_input,
                                            module.ANSWER, "fixture-primary", CRASH_MODEL)
                shutdown_receipt = verified(active, endpoint, database, shutdown, refs[shutdown], shutdown_input,
                                             module.ANSWER, "fixture-primary", SHUTDOWN_MODEL)
                throttle_receipt = verified(active, endpoint, database, throttled, refs[throttled], throttled_input,
                                              module.ANSWER, "fixture-primary", THROTTLED_MODEL)
                unknown_receipt = verified(active, endpoint, database, unknown_failed, refs[unknown_failed], unknown_input,
                                           module.ANSWER, "fixture-primary", UNKNOWN_FAILURE_MODEL)
                require(primary.received.count(UNKNOWN_FAILURE_MODEL) == 2,
                        "unknown terminal failure was not retried exactly once on its saved route")
                throttle_history = messages(endpoint, throttled)
                require(not any(m.get("type") == "model-switched" for m in throttle_history),
                        "temporary 429 caused an OpenCode model selection")
                throttle_models = [m.get("model") for m in throttle_history if m.get("type") == "assistant"]
                require(len(throttle_models) == 2 and throttle_models[0] == throttle_models[1],
                        "OpenCode did not retain the exact original model variant")
                wait_for("OpenCode did not fail its same-route retry", lambda: (
                    primary.received.count(CHAIN_MODEL) == 2
                    and chained not in call(endpoint, "/api/session/active")
                ), seconds=45)
                chain_rows = durable(database, chained)
                require(len(chain_rows) == 1 and chain_rows[0][0] in ("admitted", "confirmed"),
                        "same-route retry was not recorded")
            require(reserve.count == 0 and not durable(database, exhausted),
                    "an unverified quota authorized a send")

            route["omniroute"]["database"] = str(exact)
            private_write(profile, json.dumps(data))
            with owner_client(args.core, profile, env) as active:
                def chained_done():
                    rows = durable(database, chained)
                    packet = messages(endpoint, chained)
                    inputs = [m for m in packet if m.get("type") == "synthetic"
                              and m.get("metadata", {}).get("agentHerderInputId", "").startswith("opencode-recovery:")]
                    answers = [m for m in packet if m.get("type") == "assistant"
                               and module.ANSWER in json.dumps(m.get("content"))]
                    if len(rows) != 2 or len(inputs) != 2 or len(answers) != 1:
                        return False
                    if any(row[0] != "confirmed" for row in rows):
                        return False
                    receipts = [json.loads(row[1]) for row in rows]
                    keys = [m["metadata"]["agentHerderInputId"] for m in inputs]
                    require({row["native_id"] for row in receipts} == {m["id"] for m in inputs}
                            and all(row["address"]["native_session_id"] == chained for row in receipts),
                            "staged receipts do not bind exact inputs in the same chat")
                    for key, stage in zip(keys, ("primary", "fallback")):
                        require(re.fullmatch(r"opencode-recovery:[0-9a-f]{64}:" + stage + r"(?::[0-9]+)?", key),
                                "wrong recovery stage key")
                    require(any(m["id"] == chained_input and m["type"] == "user" for m in packet),
                            "the original input is absent from the recovered session")
                    require(answers[0]["model"]["providerID"] == FALLBACK_PROVIDER, "wrong fallback route")
                    projection = active.request("tools/call", {"_meta": MCP_META, "name": "session",
                        "arguments": {"action": "messages", "session_ref": refs[chained]}})
                    if projection.get("isError") and projection["structuredContent"].get("code") == "scope_unavailable":
                        return False
                    require(not projection.get("isError") and module.ANSWER in json.dumps(projection["structuredContent"]),
                            "the owner did not read back the fallback response")
                    return inputs[1]["id"]
                fallback_receipt = wait_for("failed primary did not reach configured fallback", chained_done, seconds=60)
            with owner_client(args.core, profile, env) as reopened:
                time.sleep(3)
                require(verified(reopened, endpoint, database, throttled, refs[throttled], throttled_input,
                                 module.ANSWER, "fixture-primary", THROTTLED_MODEL) == throttle_receipt,
                        "owner restart did not retain the original-model recovery after 429")
                require(verified(reopened, endpoint, database, shutdown, refs[shutdown], shutdown_input,
                                 module.ANSWER, "fixture-primary", SHUTDOWN_MODEL) == shutdown_receipt,
                        "owner restart did not retain the recovery after SIGTERM")
            require(not durable(database, exhausted)
                    and primary.received.count(CRASH_MODEL) == 2 and primary.received.count(QUOTA_MODEL) == failures
                    and primary.received.count(THROTTLED_MODEL) == 2
                    and primary.received.count(UNKNOWN_FAILURE_MODEL) == 2
                    and primary.received.count(SHUTDOWN_MODEL) == 2
                    and primary.received.count(CHAIN_MODEL) == 2
                    and reserve.count == 1 and reserve.received == [FALLBACK_MODEL], "model requests were repeated")
            for model, sid in protected.items():
                require(primary.received.count(model) == 1 and not durable(database, sid)
                        and messages(endpoint, sid) == original_history[sid],
                        f"OpenCode recovery crossed the {model} guard")
            print(json.dumps({"result": "verified", "opencode_sha256": digest(args.opencode),
                              "owner_sha256": digest(args.core), "crash_receipt": crashed_receipt,
                              "shutdown_receipt": shutdown_receipt,
                              "unknown_terminal_receipt": unknown_receipt,
                              "same_model_429_receipt": throttle_receipt, "same_model_429_requests": 2,
                              "fallback_receipt": fallback_receipt, "fallback_requests": reserve.count,
                              "protected_continuations": {model: 0 for model in protected},
                              "replayed": 0}), flush=True)


if __name__ == "__main__":
    main()
