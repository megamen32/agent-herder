#!/usr/bin/env python3
"""Prove OpenCode model -> MCP create -> native OpenCode session readback.

The stand deliberately drives the public MCP server through OpenCode's own
MCP connection. It does not call Herder's create tool to start the journey;
the fake model must select the namespaced MCP tool first.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import sqlite3
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from candidate_stand import fixture_path
from ahap_opencode_stand import (
    RpcProcess,
    artifact_identity,
    detect_opencode_api_family,
    inline_client_meta,
    native_api_read,
    native_session_for,
    parse_fresh_seed,
    persist_evidence,
    probe_runner_protocol,
    rpc_tool,
    require_runner_route_compat,
    verify_trusted_path,
    wait_opencode,
    write_owner_profile,
)

INSTANCE = "opencode-mcp-fixture"
HOST_ID = "isolated-opencode-mcp-node"
CREATE_TOOL = "herder_native_stdio_create"
CREATE_PROMPT = "OPENCODE_MCP_CREATE_FIXTURE"
CREATE_REQUEST_KEY = "opencode-mcp-create-once"
ANSWER = "HERDER_TEST_MODEL_OK"


def api(root, path, body=None, password="fixture-only", timeout=20):
    auth = base64.b64encode(f"opencode:{password}".encode()).decode()
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Basic " + auth}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(root + path, data=data, headers=headers,
                                     method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(2_000_000)
            try:
                return response.status, json.loads(raw) if raw else None
            except (ValueError, UnicodeError):
                return response.status, raw.decode(errors="replace")
    except urllib.error.HTTPError as error:
        raw = error.read(4096)
        try:
            return error.code, json.loads(raw)
        except (ValueError, UnicodeError):
            return error.code, raw.decode(errors="replace")


def write_fixture(project, model_url, core, profile, opencode_url):
    config = {
        "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
                    "options": {"baseURL": model_url, "apiKey": "fixture-only"},
                    "models": {"herder-test": {"name": "Fixture"}}}},
        "model": "fixture/herder-test",
        "autoupdate": False,
        "permissions": [{"action": CREATE_TOOL, "resource": "*", "effect": "allow"}],
        "mcp": {"servers": {"herder_native_stdio": {
            "type": "local",
            "command": [str(core), "--trusted-owner-profile", str(profile)],
            "cwd": str(project),
            "codemode": False,
            "protocol": "2026-07-28",
            "disabled": False,
        }}},
    }
    (project / "opencode.json").write_text(json.dumps(config, separators=(",", ":")))


def stats(model_origin):
    with urllib.request.urlopen(model_origin + "/_stats", timeout=5) as response:
        return json.loads(response.read(4096))


def wait_for_answer(root, session_id, timeout=75):
    deadline = time.monotonic() + timeout
    path = "/api/session/" + urllib.parse.quote(session_id, safe="") + "/message?limit=100&order=asc"
    last = None
    while time.monotonic() < deadline:
        status, body = api(root, path)
        last = body
        if status == 200 and ANSWER in json.dumps(body):
            return body
        if "provider.no-route" in json.dumps(body):
            raise RuntimeError("fake provider rejected OpenCode turn")
        time.sleep(0.25)
    raise TimeoutError("OpenCode MCP create turn did not reach the fake-model answer: "
                       + json.dumps(last)[:2000])


def database_receipt(database):
    uri = Path(database).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=2) as connection:
        row = connection.execute(
            "SELECT i.task_id,i.state,t.status,t.result_json,i.native_receipt "
            "FROM intents i JOIN tasks t ON t.task_id=i.task_id "
            "WHERE i.request_key=?", (CREATE_REQUEST_KEY,)).fetchone()
        counts = connection.execute(
            "SELECT (SELECT count(*) FROM tasks),(SELECT count(*) FROM intents),"
            "(SELECT count(*) FROM session_bindings)").fetchone()
    if not row:
        raise RuntimeError("OpenCode MCP create did not leave a durable intent")
    root_task_id, intent_state, root_task_status, root_result, native_receipt = row
    if not native_receipt:
        raise RuntimeError("OpenCode MCP create did not leave the native create receipt")
    root_receipt = json.loads(native_receipt)
    session_ref = root_receipt.get("session_ref")
    if not isinstance(session_ref, str) or not session_ref:
        raise RuntimeError("durable create receipt has no session_ref")
    marker = f'%"kind":"fresh_create_prompt_v1"%'
    session_marker = f'%"session_ref":"{session_ref}"%'
    with sqlite3.connect(uri, uri=True, timeout=2) as connection:
        aggregate = connection.execute(
            "SELECT task_id,status,result_json FROM tasks "
            "WHERE task_id<>? AND result_json LIKE ? AND result_json LIKE ? "
            "ORDER BY updated_at DESC LIMIT 1",
            (root_task_id, marker, session_marker),
        ).fetchone()
    if not aggregate:
        raise RuntimeError("durable create aggregate has no exact session binding")
    task_id, task_status, raw_result = aggregate
    result = json.loads(raw_result) if raw_result else None
    if not isinstance(result, dict) or result.get("kind") != "fresh_create_prompt_v1":
        raise RuntimeError("durable create aggregate has an invalid record")
    native_session_id = native_session_for(Path(database), session_ref)
    return {"task_id": task_id, "intent_state": intent_state, "root_task_status": root_task_status,
            "task_status": task_status,
            "result": result, "native_receipt": native_receipt,
            "session_ref": session_ref, "native_session_id": native_session_id,
            "counts": {"tasks": counts[0], "intents": counts[1], "bindings": counts[2]}}


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def stop_owner_process(core, profile):
    """Stop only the Herder MCP child, keeping the native OpenCode server alive."""
    core = str(Path(core).resolve())
    profile = str(Path(profile).resolve())

    def matches():
        found = []
        for entry in Path("/proc").glob("[0-9]*"):
            try:
                raw = (entry / "cmdline").read_bytes()
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if core.encode() in raw and profile.encode() in raw:
                found.append(int(entry.name))
        return found

    pids = matches()
    if not pids:
        raise RuntimeError("OpenCode did not leave an owned Herder process to restart")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and matches():
        time.sleep(0.05)
    for pid in matches():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--opencode", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--bootstrap", required=True)
    args = parser.parse_args(argv)
    for name in ("core", "runner", "opencode", "node", "bootstrap"):
        value = Path(getattr(args, name))
        if not value.is_absolute() or not value.exists():
            parser.error(f"{name} must be an existing absolute path")
        setattr(args, name, verify_trusted_path(value))

    model_url = os.environ.get("HERDER_TEST_MODEL_BASE_URL", "")
    if not model_url.startswith("http://127.0.0.1:") or not model_url.endswith("/v1"):
        raise ValueError("isolated fake model endpoint is required")
    identity = artifact_identity(args)
    protected = Path("/herder-owner-home")
    project = protected / "work"
    project.mkdir(mode=0o700)
    model_origin = model_url.removesuffix("/v1")
    opencode_port = 0
    with __import__("socket").socket() as listener:
        listener.bind(("127.0.0.1", 0))
        opencode_port = listener.getsockname()[1]
    opencode_url = f"http://127.0.0.1:{opencode_port}"
    bootstrap = subprocess.run([str(args.bootstrap), str(protected)], text=True,
                               capture_output=True, check=False, timeout=30)
    if bootstrap.returncode:
        raise RuntimeError("owner bootstrap failed: " + bootstrap.stderr[-1000:])
    seed = parse_fresh_seed(bootstrap.stdout, protected)
    profile_path = Path(seed["profile_seed"]).parent / "profile.json"
    profile = write_owner_profile(profile_path, seed, instance=INSTANCE, host_id=HOST_ID,
                                  executable=args.node, runner_script=args.runner,
                                  opencode_url=opencode_url, project=project)
    write_fixture(project, model_url, args.core, profile_path, opencode_url)
    evidence_path = protected / "opencode-mcp-create-evidence.json"
    evidence = {"phase": "preflight", "result": "not_started", "no_replay": True,
                "artifact": identity, "instance_ref": INSTANCE, "tool": CREATE_TOOL,
                "request_key": CREATE_REQUEST_KEY, "prompt": CREATE_PROMPT,
                "profile": str(profile_path), "opencode_url": opencode_url}
    persist_evidence(evidence_path, evidence)
    env = dict(os.environ, HOME=str(protected),
               PATH=str(Path(args.node).parent) + os.pathsep + fixture_path(),
               OPENCODE_SERVER_PASSWORD="fixture-only",
               AHAP_VERSION="0.1", AHAP_HARNESS="opencode",
               AHAP_OPENCODE_BASE_URL=opencode_url,
               AHAP_OPENCODE_PASSWORD="fixture-only")
    server = subprocess.Popen([str(args.opencode), "serve", "--hostname", "127.0.0.1",
                               "--port", str(opencode_port)], cwd=project, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    core = None
    try:
        wait_opencode(opencode_url, server)
        api_family = detect_opencode_api_family(opencode_url)
        runner_protocol = probe_runner_protocol(args.node, args.runner, env)
        require_runner_route_compat(api_family, runner_protocol)
        status, models = native_api_read(opencode_url, "/api/model")
        if status != 200 or "herder-test" not in json.dumps(models):
            raise RuntimeError("OpenCode fixture provider was not ready")
        before = stats(model_origin)
        evidence.update({"phase": "ready", "api_family": api_family,
                         "runner_protocol": runner_protocol, "model_before": before})
        persist_evidence(evidence_path, evidence)
        created_status, created = api(opencode_url, "/api/session", {
            "title": "OpenCode MCP create fixture",
            "location": {"directory": str(project)},
            "model": {"providerID": "fixture", "id": "herder-test"},
        })
        if created_status != 200 or not isinstance(created, dict):
            raise RuntimeError(f"OpenCode native session create failed: {created_status} {created}")
        session_id = (created.get("data") or {}).get("id")
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("OpenCode did not return a native session id")
        prompt_status, prompt_result = api(
            opencode_url, "/api/session/" + urllib.parse.quote(session_id, safe="") + "/prompt",
            {"text": "Call the Herder create MCP tool exactly once, then return the tool result.",
             "delivery": "queue"}, timeout=45)
        if prompt_status not in (200, 202):
            raise RuntimeError(f"OpenCode prompt admission failed: {prompt_status} {prompt_result}")
        evidence.update({"phase": "opencode_prompt_admitted", "native_session_id": session_id,
                         "prompt_response": prompt_result, "mutation_started": True})
        persist_evidence(evidence_path, evidence)
        native_messages = wait_for_answer(opencode_url, session_id)
        after = stats(model_origin)
        names = [name for row in after.get("tool_request_tools", []) for name in row]
        calls = after.get("tool_calls", [])
        if not any(CREATE_TOOL in row for row in after.get("tool_request_tools", [])
                   if isinstance(row, list)):
            raise RuntimeError(f"fake model never received the Herder MCP tool: {after}")
        matching_calls = [call for call in calls
                          if isinstance(call, dict) and call.get("name") == CREATE_TOOL]
        if len(matching_calls) != 1:
            raise RuntimeError(f"fake model did not emit the namespaced Herder create call: {after}")
        try:
            tool_arguments = json.loads(matching_calls[0]["arguments"])
        except (KeyError, TypeError, ValueError):
            raise RuntimeError(f"fake model emitted malformed Herder create arguments: {after}") from None
        if tool_arguments != {"action": "create", "instance_ref": INSTANCE,
                              "prompt": CREATE_PROMPT, "request_key": CREATE_REQUEST_KEY}:
            raise RuntimeError(f"fake model emitted unexpected Herder create arguments: {after}")
        model_requests = after.get("requests") - before.get("requests", 0)
        if model_requests < 2:
            raise RuntimeError(f"expected the tool round and a final model round, got {after}")
        evidence.update({"phase": "model_tool_call_confirmed", "model_after": after,
                         "model_tool_request_tools": names, "model_tool_calls": calls,
                         "opencode_messages": native_messages})
        persist_evidence(evidence_path, evidence)

        # Restart only Herder's owner process. The native OpenCode server must
        # stay alive so its exact session and messages remain independently
        # readable after the Herder process is replaced.
        stop_owner_process(args.core, profile_path)
        time.sleep(0.5)
        receipt = database_receipt(Path(seed["database"]))
        if receipt["task_status"] != "completed" or receipt["intent_state"] not in ("admitted", "confirmed"):
            raise RuntimeError(f"durable create receipt is not confirmed: {receipt}")
        evidence.update({"phase": "durable_receipt_confirmed", "receipt": receipt})
        persist_evidence(evidence_path, evidence)

        core = RpcProcess(args.core, profile_path, env)
        core.preflight()
        read = rpc_tool(core, "session", {"action": "messages", "session_ref": receipt["session_ref"]})
        read_text = json.dumps(read)
        if CREATE_PROMPT not in read_text or ANSWER not in read_text:
            raise RuntimeError("readback after OpenCode restart lacks exact prompt/answer")
        native_read = rpc_tool(core, "session", {
            "action": "messages", "session_ref": receipt["native_session_id"]
        })
        native_payload = (native_read.get("structuredContent", native_read)
                          if isinstance(native_read, dict) else native_read)
        if (not isinstance(native_payload, dict)
                or native_payload.get("requested_reference") != receipt["native_session_id"]
                or native_payload.get("reference_kind") != "native_session_id"
                or native_payload.get("native_session_id") != receipt["native_session_id"]
                or CREATE_PROMPT not in json.dumps(native_read)
                or ANSWER not in json.dumps(native_read)):
            raise RuntimeError(f"native ses_ readback did not resolve to the registered session: {native_read}")
        counts_before = receipt["counts"]
        if database_receipt(Path(seed["database"]))["counts"] != counts_before:
            raise RuntimeError("native session readback changed durable rows")
        replay = rpc_tool(core, "create", {"action": "create", "instance_ref": INSTANCE,
                                             "prompt": CREATE_PROMPT,
                                             "request_key": CREATE_REQUEST_KEY})
        replay_text = json.dumps(replay)
        if receipt["task_id"] not in replay_text:
            raise RuntimeError("same-key create replay did not return the original durable task")
        counts_replay = database_receipt(Path(seed["database"]))["counts"]
        if counts_replay != counts_before:
            raise RuntimeError(f"same-key replay created new durable rows: {counts_before} -> {counts_replay}")
        conflict = rpc_tool(core, "create", {"action": "create", "instance_ref": INSTANCE,
                                               "prompt": CREATE_PROMPT + "-changed",
                                               "request_key": CREATE_REQUEST_KEY})
        conflict_task = conflict.get("taskId") if isinstance(conflict, dict) else None
        conflict_result = conflict
        if isinstance(conflict_task, str):
            conflict_result = core.request(
                "tasks/get", {"_meta": inline_client_meta(), "taskId": conflict_task}
            )
        if "idempotency_conflict" not in json.dumps(conflict_result):
            raise RuntimeError(f"changed create payload was not rejected: {conflict}")
        counts_after = database_receipt(Path(seed["database"]))["counts"]
        if (counts_after["intents"] != counts_before["intents"]
                or counts_after["bindings"] != counts_before["bindings"]
                or counts_after["tasks"] != counts_before["tasks"] + 1):
            raise RuntimeError(
                "replay/conflict changed native durable rows unexpectedly: "
                f"{counts_before} -> {counts_after}"
            )
        evidence.update({"phase": "restart_readback_and_no_replay", "readback": read,
                         "native_readback": native_read,
                         "replay": replay, "conflict": conflict_result,
                         "counts_before": counts_before, "counts_after": counts_after,
                         "result": "PASS"})
        persist_evidence(evidence_path, evidence)
        print(json.dumps({"status": "PASS", "scope": "OpenCode model -> MCP create -> native readback",
                          "artifact": identity, "api_family": api_family,
                          "runner_protocol": runner_protocol, "tool": CREATE_TOOL,
                          "model_requests": after["requests"] - before["requests"],
                          "session_ref": receipt["session_ref"],
                          "native_session_id": receipt["native_session_id"],
                          "replay": "same_task", "conflict": "idempotency_conflict",
                          "readback": "confirmed", "native_readback": "confirmed",
                          "evidence_path": str(evidence_path)},
                         sort_keys=True), flush=True)
    finally:
        if core is not None:
            core.close()
        stop(server)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, TimeoutError, json.JSONDecodeError) as error:
        print(f"OpenCode MCP create stand failed: {error}", file=sys.stderr)
        sys.exit(2)
