#!/usr/bin/env python3
"""Run one isolated Rust AHAP -> TS OpenCode adapter -> OpenCode business case.

This is an entrypoint for tests/native/launch.py, not a standalone public test.
The prepared profile seed must name a fresh v3/v4 database and pinned gate
created by the existing owner fixture. This script writes the protected owner
profile and never bootstraps or migrates authority state itself.
"""
import argparse
import json
import os
from pathlib import Path
import select
import sqlite3
import socket
import subprocess
import sys
import time
import base64
import hashlib
import stat
import urllib.error
import urllib.parse
import urllib.request
import uuid

from candidate_stand import fixture_path
from opencode_receipt import complete_native_readback, summarize_native_messages, v22_fixture_verified


ANSWER = "HERDER_TEST_MODEL_OK"
RPC_TIMEOUT = 15
TASK_TIMEOUT = 75
MCP_PROTOCOL_VERSION = "2026-07-28"


def inline_client_meta():
    return {"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {
                "extensions": {"io.modelcontextprotocol/tasks": {}}},
            "io.modelcontextprotocol/clientInfo": {"name": "ahap-opencode-fixture", "version": "1"}}


def probe_native_tools(client):
    result = client.request("tools/list", {"_meta": inline_client_meta()})
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list):
        raise RuntimeError("native MCP tools/list returned no tool catalogue")
    names = [entry.get("name") for entry in tools if isinstance(entry, dict)]
    if len(names) != len(tools) or any(not isinstance(name, str) or not name for name in names):
        raise RuntimeError("native MCP tools/list returned malformed tool names")
    if len(set(names)) != len(names):
        raise RuntimeError("native MCP tools/list returned duplicate tool names")
    return names


class RpcProcess:
    def __init__(self, binary, profile, env):
        self.process = subprocess.Popen(
            [str(binary), "--trusted-owner-profile", str(profile)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=env,
        )
        self.next_id = 0
        self.buffer = ""

    def request(self, method, params, timeout=RPC_TIMEOUT):
        if self.process.poll() is not None:
            raise RuntimeError(f"native core exited early: {self.process.returncode}")
        self.next_id += 1
        request_id = self.next_id
        payload = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method,
                              "params": params}, separators=(",", ":"))
        self.process.stdin.write(payload + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            if "\n" in self.buffer:
                line, self.buffer = self.buffer.split("\n", 1)
                if not line.strip():
                    continue
                response = json.loads(line)
                if response.get("id") is None:  # progress/task notifications
                    continue
                if response.get("id") != request_id:
                    raise RuntimeError(f"native MCP response id mismatch for {method}")
                if "error" in response:
                    raise RuntimeError(f"native MCP {method} failed: {response['error']}")
                return response.get("result")
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], max(0, remaining))[0]:
                raise TimeoutError(f"native MCP request timed out: {method}")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                diagnostic = self.process.stderr.read(4096)
                raise RuntimeError(f"native core closed stdout during {method}: {diagnostic[-2000:]}")
            self.buffer += chunk.decode("utf-8")

    def preflight(self):
        return probe_native_tools(self)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()


def rpc_tool(client, name, arguments, tasks=True):
    meta = inline_client_meta()
    if not tasks:
        meta["io.modelcontextprotocol/clientCapabilities"]["extensions"] = {}
    return client.request("tools/call", {"_meta": meta, "name": name, "arguments": arguments})


def task_get(client, task_id):
    return client.request("tasks/get", {"_meta": inline_client_meta(), "taskId": task_id})


def wait_task(client, task_id, timeout=TASK_TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = task_get(client, task_id)
        status = result.get("status")
        if status in ("completed", "failed", "cancelled"):
            return result
        time.sleep(0.25)
    raise TimeoutError(f"Task did not reach a terminal status within {timeout}s")


def message_texts(value):
    return [(row["role"], text) for row in message_records(value)
            for text in (row.get("text"), row.get("content")) if isinstance(text, str)]


def message_records(value):
    found = []
    if isinstance(value, dict):
        if value.get("role") in ("user", "assistant"):
            found.append(value)
        for child in value.values():
            found.extend(message_records(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(message_records(child))
    return found


def validate_stand_isolation(links, routes4, routes6, project, opencode_url, model_url):
    if [item.get("ifname") for item in links] != ["lo"] or routes4 or routes6:
        raise ValueError("private loopback-only network required")
    if not Path(project).is_absolute() or not str(project).startswith("/herder-owner-home/"):
        raise ValueError("owner project must be inside the protected fixture home")
    for value in (opencode_url, model_url):
        url = urllib.parse.urlsplit(value)
        if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
                or url.username or url.password or url.query or url.fragment):
            raise ValueError("OpenCode and model origins must be loopback HTTP")


def native_session_for(database, session_ref):
    uri = Path(database).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=2) as connection:
        row = connection.execute(
            "SELECT native_session_id FROM session_bindings WHERE session_ref=?", (session_ref,)
        ).fetchone()
    if not row or not isinstance(row[0], str) or not row[0]:
        raise RuntimeError("session binding did not expose the exact native OpenCode session")
    return row[0]


def native_api_read(root, path, password="fixture-only"):
    authorization = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(root + path, headers={"Authorization": "Basic " + authorization})
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            raw = response.read(2_000_000)
            try:
                body = json.loads(raw) if raw else None
            except (ValueError, UnicodeError):
                body = None
            return response.status, body
    except urllib.error.HTTPError as error:
        body = error.read(4096)
        try:
            detail = json.loads(body)
        except (ValueError, UnicodeError):
            detail = body.decode(errors="replace")
        return error.code, detail


def completed_message_pair(value, marker):
    if not complete_native_readback(value, marker):
        return None
    rows = value.get("data") if isinstance(value, dict) else value
    if not isinstance(rows, list):
        return None
    user = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        info = row.get("info") if isinstance(row.get("info"), dict) else {}
        role = row.get("role") or info.get("role") or row.get("type")
        row_id = row.get("id") or info.get("id")
        if role == "user" and isinstance(row_id, str) and marker in json.dumps(row):
            user = row
            continue
        if role == "assistant" and user is not None and isinstance(row_id, str) and ANSWER in json.dumps(row):
            timing = row.get("time") or info.get("time") or {}
            completed = timing.get("completed") if isinstance(timing, dict) else None
            finish = row.get("finish") or info.get("finish")
            if isinstance(completed, (int, float)) and not isinstance(completed, bool) and completed > 0 \
                    and finish != "error" and not row.get("error") and not info.get("error"):
                return {"user_message_id": user.get("id") or user.get("info", {}).get("id"),
                        "assistant_message_id": row_id,
                        "assistant_parent_id": row.get("parentID") or info.get("parentID"),
                        "assistant_finish": finish, "assistant_completed_at": completed}
    return None


def wait_for_native_completion(root, native_session_id, marker, expected_receipt_id, env, timeout=40):
    status, config = native_api_read(root, "/api/config")
    v22 = status == 404 or (status == 200 and config is None)
    prefix = "/session/" if v22 else "/api/session/"
    path = prefix + urllib.parse.quote(native_session_id, safe="") + "/message"
    if not v22:
        path += "?limit=100&order=asc"
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        status, last = native_api_read(root, path, env.get("OPENCODE_SERVER_PASSWORD", "fixture-only"))
        pair = completed_message_pair(last, marker) if status == 200 else None
        if pair and pair["user_message_id"] == expected_receipt_id:
            return {"api_family": "provider-session" if v22 else "api-session",
                    "session_id": native_session_id,
                    "messages": summarize_native_messages(last), **pair}
        if status not in (200, 404, 503):
            raise RuntimeError(f"OpenCode native read failed: HTTP {status}: {last}")
        time.sleep(0.25)
    raise TimeoutError("assistant did not reach native completed state: " +
                       json.dumps(summarize_native_messages(last), sort_keys=True))


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def persist_evidence(path, record):
    if path.is_symlink():
        raise ValueError("evidence path must not be a symlink")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(record, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def redacted_json_shape(value, depth=0):
    if depth >= 4:
        return "nested"
    if isinstance(value, dict):
        return {key: redacted_json_shape(child, depth + 1) for key, child in value.items()}
    if isinstance(value, list):
        return {"type": "array", "length": len(value),
                "item": redacted_json_shape(value[0], depth + 1) if value else None}
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "unknown"


def namespace_path_facts(value):
    path = Path(value)
    facts = []
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
            facts.append({"path": str(current), "uid": info.st_uid, "gid": info.st_gid,
                          "mode": oct(stat.S_IMODE(info.st_mode)),
                          "type": "symlink" if stat.S_ISLNK(info.st_mode) else
                                  "directory" if stat.S_ISDIR(info.st_mode) else
                                  "file" if stat.S_ISREG(info.st_mode) else "other"})
        except OSError as error:
            facts.append({"path": str(current), "error": type(error).__name__})
            break
    try:
        facts.append({"resolved": str(path.resolve(strict=True))})
    except OSError as error:
        facts.append({"resolved_error": type(error).__name__})
    return facts


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def wait_opencode(url, process, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"OpenCode server exited: {process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", int(url.rsplit(":", 1)[1])), timeout=0.2):
                return
        except OSError:
            time.sleep(0.2)
    raise TimeoutError("OpenCode server readiness timeout")


def write_opencode_fixture(project, model_url):
    config = {
        "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
                    "options": {"baseURL": model_url, "apiKey": "fixture-only"},
                    "models": {"herder-test": {"name": "Fixture"}}}},
        "model": "fixture/herder-test", "autoupdate": False,
    }
    (project / "opencode.json").write_text(json.dumps(config))


def write_owner_profile(path, seed, *, instance, executable, runner_script, opencode_url, project):
    if set(seed) != {"database", "gate", "generation", "profile_seed"}:
        raise ValueError("profile seed must contain only database, gate, generation, profile_seed")
    root = path.parent
    for key in ("database", "gate"):
        target = Path(seed[key])
        if not target.is_absolute() or target.parent != root or not target.is_file():
            raise ValueError(f"profile seed {key} must be a protected sibling file")
    if path.exists() or path.is_symlink():
        raise ValueError("owner profile path must be unused")
    executable = verify_trusted_path(executable)
    runner_script = verify_trusted_path(runner_script)
    project = verify_trusted_path(project, directory=True)
    profile = {
        "database": seed["database"], "gate": seed["gate"], "generation": seed["generation"],
        "owner": {"kind": "opencode", "principal": "isolated-opencode-owner",
                  "node": "isolated-native-node", "instance": instance,
                  "executable": str(executable), "ahap_script": str(runner_script),
                  "ahap_base_url": opencode_url, "code_home": str(project), "cwd": str(project)},
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(profile, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    return profile


def parse_fresh_seed(raw, protected_home):
    seed = json.loads(raw)
    if not isinstance(seed, dict) or set(seed) != {"database", "gate", "generation", "profile_seed"}:
        raise ValueError("fixture bootstrap returned an invalid fresh authority receipt")
    authority = Path(protected_home).resolve(strict=True) / "authority"
    for key in ("database", "gate", "profile_seed"):
        path = Path(seed[key])
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise ValueError(f"fixture bootstrap {key} must be a protected regular file")
        if path.resolve(strict=True).parent != authority or path.stat().st_mode & 0o077:
            raise ValueError(f"fixture bootstrap {key} escaped the owner-only authority directory")
    if not isinstance(seed["generation"], str) or not seed["generation"]:
        raise ValueError("fixture bootstrap omitted authority generation")
    return seed


def verify_trusted_path(value, *, directory=False):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("trusted owner code paths must be absolute")
    resolved = path.resolve(strict=True)
    metadata = resolved.stat()
    if (directory and not stat.S_ISDIR(metadata.st_mode)) or (not directory and not stat.S_ISREG(metadata.st_mode)):
        raise ValueError("trusted owner code path has the wrong file type")
    uid = os.getuid()
    for ancestor in (resolved, *resolved.parents):
        info = ancestor.stat()
        # launch.py maps the caller to uid 0; read-only host bind mounts whose
        # owners are outside that user namespace appear as the overflow uid.
        if info.st_uid not in (0, uid, 65534) or info.st_mode & 0o022:
            raise ValueError("trusted owner code path has an untrusted ancestor")
    return resolved


def verify_opencode_fixture(root, model_url, password="fixture-only"):
    api_family = detect_opencode_api_family(root, password)
    v22 = api_family == "provider-session"
    if v22:
        status, provider = native_api_read(root, "/provider", password)
        if status != 200 or not v22_fixture_verified(provider, model_url):
            raise RuntimeError("OpenCode 2 fixture provider verification failed; no Task created")
        return "provider-session"
    status, models = native_api_read(root, "/api/model", password)
    if status != 200 or "herder-test" not in json.dumps(models):
        raise RuntimeError("OpenCode fixture model verification failed; no Task created")
    body = json.dumps({"integrationID": "fixture",
                       "value": {"type": "key", "key": "fixture-only"}, "activate": True}).encode()
    auth = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(root + "/api/credential", data=body,
        headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            credential_status = response.status
    except urllib.error.HTTPError as error:
        credential_status = error.code
    status, provider = native_api_read(root, "/api/provider/fixture", password)
    info = provider.get("data", provider) if isinstance(provider, dict) else {}
    if (credential_status != 200 or status != 200 or info.get("activation") != "enabled"
            or not isinstance(info.get("settings"), dict)
            or info["settings"].get("baseURL") != model_url):
        observed_base_url = (info.get("settings", {}).get("baseURL")
                             if isinstance(info.get("settings"), dict) else None)
        raise RuntimeError(
            "OpenCode fixture provider activation failed; no Task created "
            f"(credential_http={credential_status}, provider_http={status}, "
            f"activation={info.get('activation')!r}, model_base_url_matches={observed_base_url == model_url})"
        )
    return "api-session"


def detect_opencode_api_family(root, password="fixture-only"):
    deadline = time.monotonic() + 20
    status, body = native_api_read(root, "/api/config", password)
    while status == 503 and time.monotonic() < deadline:
        time.sleep(0.2)
        status, body = native_api_read(root, "/api/config", password)
    if status == 404:
        return "provider-session"
    if status == 200:
        return "api-session"
    raise RuntimeError(f"OpenCode read-only protocol probe failed: HTTP {status}")


def require_runner_route_compat(api_family, pinned_protocol="v2"):
    expected = {"v1": "api-session", "v2": "api-session"}.get(pinned_protocol)
    if expected is None:
        raise ValueError("AHAP runner must pin a known OpenCode API protocol")
    if api_family != expected:
        raise RuntimeError(
            f"AHAP runner pinned {pinned_protocol} expects /api routes, but read-only OpenCode probes found "
            f"{api_family}; refusing create/send before any session mutation"
        )


def run_case(args):
    base = os.environ.get("HERDER_TEST_MODEL_BASE_URL", "")
    if not base.startswith("http://127.0.0.1:") or not base.endswith("/v1"):
        raise ValueError("isolated loopback model from tests/native/launch.py is required")
    home = Path(os.environ["HOME"])
    protected = Path("/herder-owner-home")
    if not protected.is_dir() or protected.stat().st_mode & 0o077:
        raise ValueError("owner fixture protected-home mount missing")
    ns = os.stat("/proc/self/ns/net")
    project = protected / "work"
    project.mkdir(mode=0o700)
    model_origin = base.removesuffix("/v1")
    opencode_port = port()
    opencode_url = f"http://127.0.0.1:{opencode_port}"
    write_opencode_fixture(project, base)
    bootstrap = subprocess.run([args.bootstrap, str(protected)], text=True, capture_output=True,
                               check=False, timeout=30)
    if bootstrap.returncode:
        raise RuntimeError("owner SDK fixture bootstrap failed: " + bootstrap.stderr[-1000:])
    seed = parse_fresh_seed(bootstrap.stdout, protected)
    seed_path = Path(seed["profile_seed"])
    authority_home = seed_path.parent
    if authority_home.stat().st_mode & 0o077:
        raise ValueError("fresh authority directory must be owner-only")
    profile_path = authority_home / "profile.json"
    profile = write_owner_profile(profile_path, seed, instance=args.instance,
        executable=args.node, runner_script=args.runner, opencode_url=opencode_url, project=project)
    evidence_path = protected / "ahap-opencode-evidence.json"
    evidence = {"phase": "isolated-preflight", "result": "not_started", "no_replay": True,
                "profile": str(profile_path), "opencode_url": opencode_url,
                "fixture_model": model_origin}
    persist_evidence(evidence_path, evidence)
    validate_stand_isolation(
        json.loads(subprocess.check_output(["ip", "-j", "link", "show"], text=True, timeout=5)),
        json.loads(subprocess.check_output(["ip", "-j", "-4", "route", "show"], text=True, timeout=5)),
        json.loads(subprocess.check_output(["ip", "-j", "-6", "route", "show"], text=True, timeout=5)),
        str(project), opencode_url, model_origin,
    )
    env = dict(os.environ, HOME=str(protected), PATH=str(Path(args.node).parent) + os.pathsep + fixture_path(),
               OPENCODE_SERVER_PASSWORD="fixture-only",
               AHAP_VERSION="0.1", AHAP_HARNESS="opencode", AHAP_OPENCODE_BASE_URL=opencode_url,
               AHAP_OPENCODE_PASSWORD="fixture-only")
    server = subprocess.Popen([args.opencode, "serve", "--hostname", "127.0.0.1", "--port", str(opencode_port)],
        cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    core = None
    reopened = None
    try:
        wait_opencode(opencode_url, server)
        api_family = detect_opencode_api_family(opencode_url)
        require_runner_route_compat(api_family)
        probe_shapes = {}
        for probe_path in ("/api/config", "/api/health", "/global/health"):
            probe_status, probe_body = native_api_read(opencode_url, probe_path)
            probe_shapes[probe_path] = {"http_status": probe_status,
                                        "json_shape": redacted_json_shape(probe_body)}
        verify_opencode_fixture(opencode_url, base)
        with urllib.request.urlopen(model_origin + "/_stats", timeout=3) as response:
            model_requests_before = json.loads(response.read(4096))["requests"]
        evidence.update({"phase": "ready", "api_family": api_family,
                         "model_requests_before": model_requests_before,
                         "opencode_sha256": sha256_file(args.opencode),
                         "read_only_http_probes": probe_shapes,
                         "namespace_euid": os.geteuid(),
                         "namespace_paths": {
                             "profile": namespace_path_facts(profile_path),
                             "database": namespace_path_facts(seed["database"]),
                             "gate": namespace_path_facts(seed["gate"]),
                             "executable": namespace_path_facts(profile["owner"]["executable"]),
                             "ahap_script": namespace_path_facts(profile["owner"]["ahap_script"]),
                         }})
        persist_evidence(evidence_path, evidence)
        core = RpcProcess(args.core, profile_path, env)
        available_tools = core.preflight()
        if args.preflight_only:
            with urllib.request.urlopen(model_origin + "/_stats", timeout=3) as response:
                requests_after_init = json.loads(response.read(4096))["requests"]
            requests_during_init = requests_after_init - model_requests_before
            if requests_during_init != 0:
                raise RuntimeError(f"read-only preflight unexpectedly called the fixture model: {requests_during_init}")
            evidence.update({"phase": "core_preflight_complete", "result": "PREMUTATION_READY",
                             "mcp_inline_ready": True, "native_tools": available_tools,
                             "native_mutations": 0,
                             "model_requests_preflight": requests_during_init})
            persist_evidence(evidence_path, evidence)
            print(json.dumps({"status": "PREFLIGHT_READY", "harness": "opencode",
                              "api_family": api_family, "mcp_inline_ready": True,
                              "native_tools": available_tools,
                              "native_mutations": 0, "model_requests_preflight": requests_during_init,
                              "opencode_sha256": evidence["opencode_sha256"],
                              "read_only_http_probes": probe_shapes,
                              "namespace_euid": evidence["namespace_euid"],
                              "namespace_paths": evidence["namespace_paths"],
                              "profile": str(profile_path), "opencode_url": opencode_url},
                             sort_keys=True), flush=True)
            return
        marker = "AHAP_OPENCODE_FIXTURE_" + uuid.uuid4().hex
        request_key = "ahap-opencode-" + uuid.uuid4().hex
        evidence.update({"phase": "create_submitted", "input": marker, "request_key": request_key,
                         "mutation_started": True})
        persist_evidence(evidence_path, evidence)
        created = rpc_tool(core, "create", {"action": "create", "instance_ref": args.instance,
                            "prompt": marker, "request_key": request_key})
        if created.get("resultType") != "task":
            raise RuntimeError(f"create did not return a Task: {created}")
        task_id = created.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise RuntimeError("create returned no task id")
        evidence.update({"phase": "task_pending", "task_id": task_id})
        persist_evidence(evidence_path, evidence)
        task = wait_task(core, task_id)
        if task.get("status") != "completed":
            raise RuntimeError(f"create/delivery Task did not complete: {task}")
        task_result = task.get("result", {})
        content = task_result.get("structuredContent", {}) if isinstance(task_result, dict) else {}
        session = content.get("create", {}).get("session_ref")
        receipt = content.get("prompt", {})
        receipt_id = receipt.get("native_receipt_id")
        if (not isinstance(session, str) or receipt.get("outcome") != "confirmed"
                or not isinstance(receipt_id, str) or not receipt_id):
            raise RuntimeError(f"Task has no confirmed queue delivery receipt: {task}")
        evidence.update({"phase": "delivery_confirmed", "task_id": task_id,
                         "task_status": task.get("status"), "session_ref": session,
                         "native_receipt_id": receipt_id, "delivery_receipt": receipt})
        persist_evidence(evidence_path, evidence)
        native_session_id = native_session_for(Path(seed["database"]), session)
        native_completion = wait_for_native_completion(opencode_url, native_session_id, marker,
                                                       receipt_id, env)
        before_reopen = rpc_tool(core, "session", {"action": "messages", "session_ref": session})
        messages = message_texts(before_reopen)
        records = message_records(before_reopen)
        user_view = next((item for item in records if item.get("role") == "user"
                          and item.get("text") == marker), None)
        if not user_view or user_view.get("id") != receipt_id:
            raise RuntimeError("core native readback did not return the exact message named by its receipt")
        assistant_view = next((item for item in records if item.get("role") == "assistant"
                               and item.get("text") == ANSWER), None)
        if (assistant_view and assistant_view.get("nativeParentMessageId")
                and assistant_view["nativeParentMessageId"] != receipt_id):
            raise RuntimeError("assistant parent linkage points to a different native input")
        if ("user", marker) not in messages or ("assistant", ANSWER) not in messages:
            raise RuntimeError(f"native transcript did not contain exact input and model answer: {messages}")
        evidence.update({"phase": "assistant_confirmed", "native_session_id": native_session_id,
                         "native_completion": native_completion, "messages": messages})
        persist_evidence(evidence_path, evidence)
        core.close()
        core = None
        reopened = RpcProcess(args.core, profile_path, env)
        reopened.preflight()
        reopened_task = wait_task(reopened, task_id)
        after_reopen = rpc_tool(reopened, "session", {"action": "messages", "session_ref": session})
        reopened_messages = message_texts(after_reopen)
        if reopened_task.get("status") != "completed" or ("user", marker) not in reopened_messages or ("assistant", ANSWER) not in reopened_messages:
            raise RuntimeError("reopened Task/transcript did not preserve the completed result")
        stats_url = model_origin + "/_stats"
        with urllib.request.urlopen(stats_url, timeout=3) as response:
            stats = json.loads(response.read(4096))
        requests = stats.get("requests") - model_requests_before
        if requests != 1:
            raise RuntimeError(f"expected exactly one deterministic model request for this case, got {requests}")
        evidence.update({"phase": "completed", "result": "PASS", "task_id": task_id,
                         "task_status": task.get("status"), "session_ref": session,
                         "native_receipt_id": receipt_id, "input": marker, "assistant": ANSWER,
                         "native_completion": native_completion,
                         "reopened_task_status": reopened_task.get("status"),
                         "model_requests": requests, "messages": reopened_messages})
        persist_evidence(evidence_path, evidence)
        print(json.dumps({"status": "PASS", "harness": "opencode", "native_tools": available_tools,
            "api_family": api_family,
            "task_id": task_id, "task_status": task.get("status"), "session_ref": session,
            "input": marker, "delivery_receipt": receipt, "native_receipt_id": receipt_id,
            "assistant": ANSWER, "native_completion": native_completion,
            "reopened_task_status": reopened_task.get("status"), "model_requests": requests,
            "profile": str(profile_path), "opencode_url": opencode_url}, sort_keys=True), flush=True)
    except Exception as error:
        evidence.update({"phase": evidence.get("phase", "preflight_failed"),
                         "result": "UNKNOWN" if evidence.get("mutation_started") else "FAILED_PREMUTATION",
                         "error": str(error)[:2000], "no_replay": True})
        try:
            with urllib.request.urlopen(model_origin + "/_stats", timeout=3) as response:
                evidence["model_requests_at_failure"] = json.loads(response.read(4096)).get("requests")
        except OSError:
            evidence["model_requests_at_failure"] = "unavailable"
        persist_evidence(evidence_path, evidence)
        raise
    finally:
        if reopened is not None:
            reopened.close()
        if core is not None:
            core.close()
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, help="immutable herder_native_stdio path")
    parser.add_argument("--runner", required=True, help="immutable AHAP OpenCode runner bundle path")
    parser.add_argument("--opencode", required=True, help="real OpenCode executable")
    parser.add_argument("--node", default="/usr/bin/node", help="Node executable recorded in owner profile")
    parser.add_argument("--bootstrap", required=True, help="fresh authority bootstrap built against the owner SDK fixture library")
    parser.add_argument("--preflight-only", action="store_true",
                        help="stop after read-only inline MCP tools/list; do not call create or send")
    parser.add_argument("--instance", default="opencode-fixture")
    args = parser.parse_args(argv)
    for name in ("core", "runner", "opencode", "node", "bootstrap"):
        path = Path(getattr(args, name))
        if not path.is_absolute() or not path.exists():
            parser.error(f"{name} must be an existing absolute path")
    for name in ("core", "runner", "opencode", "node", "bootstrap"):
        try:
            setattr(args, name, verify_trusted_path(getattr(args, name)))
        except (OSError, ValueError) as error:
            parser.error(f"{name} is not a trusted immutable fixture path: {error}")
    run_case(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, TimeoutError, json.JSONDecodeError) as error:
        print(f"AHAP OpenCode stand failed: {error}", file=sys.stderr)
        sys.exit(2)
