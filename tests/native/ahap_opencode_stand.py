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
from opencode_receipt import summarize_native_messages, v22_fixture_verified


ANSWER = "HERDER_TEST_MODEL_OK"
RPC_TIMEOUT = 15
TASK_TIMEOUT = 75
MCP_PROTOCOL_VERSION = "2026-07-28"
PINNED_NATIVE_OPENCODE_SHA256 = "25facd7099c19018e83dce858f3ab922cd2d49ad29b144bc36968418ca6eb5aa"


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
    client.native_tool_catalog = tools
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


def _schema_literals(value):
    literals = set()
    if isinstance(value, dict):
        enum_values = value.get("enum")
        if isinstance(enum_values, list):
            literals.update(item for item in enum_values if isinstance(item, str))
        if isinstance(value.get("const"), str):
            literals.add(value["const"])
        for child in value.values():
            literals.update(_schema_literals(child))
    elif isinstance(value, list):
        for child in value:
            literals.update(_schema_literals(child))
    return literals


def _schema_field_literals(value, field):
    literals = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == field:
                literals.update(_schema_literals(child))
            else:
                literals.update(_schema_field_literals(child, field))
    elif isinstance(value, list):
        for child in value:
            literals.update(_schema_field_literals(child, field))
    return literals


def validate_v1_public_contract(tools):
    """Reject an old/incomplete artifact before any native mutation."""
    by_name = {tool["name"]: tool for tool in tools if isinstance(tool, dict)}
    required = {"discover": {"action": {"projects"}},
                "deliver": {"action": {"session"}},
                "search": {"action": {"search"}},
                "export": {"action": {"export"}, "format": {"native", "common"}}}
    missing = []
    schema_audit = {}
    for name, fields in required.items():
        tool = by_name.get(name)
        if not isinstance(tool, dict):
            missing.append(f"tool {name} is not advertised")
            continue
        schema = tool.get("inputSchema") if isinstance(tool, dict) else None
        schema_audit[name] = {}
        for field, expected in fields.items():
            actual = _schema_field_literals(schema, field)
            schema_audit[name][field] = sorted(actual) if actual else "not-enumerated"
            if actual and not expected <= actual:
                missing.append(f"{name}.{field}={sorted(expected)} (advertised {sorted(actual)})")
    if missing:
        raise RuntimeError("V1 public MCP contract missing before mutation: " + "; ".join(missing))
    return schema_audit


def _structured_content(result):
    return result.get("structuredContent") if isinstance(result, dict) else None


def _unsupported_receipt(result):
    payload = _structured_content(result)
    return (isinstance(payload, dict) and payload.get("code") == "unsupported"
            and payload.get("effect") == "none")


def public_export_readiness(result, expected_format="native"):
    """Validate V1 export metadata and decode its lossless byte payload."""
    if not isinstance(result, dict):
        return {"status": "unknown", "response": result}
    payload = _structured_content(result)
    if _unsupported_receipt(result):
        return {"status": "unsupported", "receipt": payload}
    if result.get("isError") is True:
        return {"status": "error", "receipt": payload, "response": result}
    if not isinstance(payload, dict):
        return {"status": "unknown", "response": result}
    encoded, source, complete = (payload.get("bytes_base64"), payload.get("source"),
                                 payload.get("complete"))
    if (not isinstance(encoded, str) or not isinstance(source, (str, dict, list))
            or not source or not isinstance(complete, bool)):
        return {"status": "unverified", "response": result}
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        return {"status": "unverified", "response": result, "reason": "invalid bytes_base64"}
    if not raw or complete is not True:
        return {"status": "unverified", "complete": complete, "source": source,
                "payload_length_bytes": len(raw)}
    return {"status": "confirmed", "format": expected_format, "complete": True,
            "source": source, "payload_sha256": hashlib.sha256(raw).hexdigest(),
            "payload_length_bytes": len(raw), "_payload_bytes": raw,
            "_payload_base64": encoded}


def public_common_export_status(result):
    if _unsupported_receipt(result):
        return {"status": "unsupported", "expected": True,
                "receipt": _structured_content(result)}
    if isinstance(result, dict) and result.get("isError") is True:
        return {"status": "unexpected_error", "expected": False,
                "receipt": _structured_content(result)}
    return {"status": "unexpectedly_supported", "expected": False,
            "receipt": _structured_content(result)}


def search_marker_coverage(result, marker):
    if not isinstance(result, dict) or result.get("isError") is True:
        return {"status": "error", "coverage": None, "marker_found": False}
    payload = _structured_content(result)
    target = payload if payload is not None else result
    coverage_values = []
    searchable_strings = []
    def collect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "coverage" and isinstance(child, str):
                    coverage_values.append(child)
                if key in ("query", "request", "search_term"):
                    continue
                if isinstance(child, str):
                    searchable_strings.append(child)
                else:
                    collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(target)
    coverage = coverage_values[0] if coverage_values else None
    found = any(marker in item for item in searchable_strings)
    return {"status": "confirmed" if found and coverage == "complete" else "unverified",
            "coverage": coverage, "marker_found": found}


def task_delivery_receipt(task):
    task_result = task.get("result", {}) if isinstance(task, dict) else {}
    payload = task_result.get("structuredContent") if isinstance(task_result, dict) else None
    candidates = []
    def collect(value):
        if isinstance(value, dict):
            if isinstance(value.get("native_receipt_id"), str):
                candidates.append(value)
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(payload)
    confirmed = [item for item in candidates if item.get("outcome") == "confirmed"]
    return confirmed[0] if len(confirmed) == 1 else None


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


def native_api_read_detail(root, path, password="fixture-only"):
    """Read one native JSON response without conflating JSON null and malformed data."""
    authorization = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(root + path, headers={"Authorization": "Basic " + authorization})
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            raw = response.read(2_000_000)
            try:
                return response.status, json.loads(raw), True
            except (ValueError, UnicodeError):
                return response.status, None, False
    except urllib.error.HTTPError as error:
        raw = error.read(4096)
        try:
            return error.code, json.loads(raw), True
        except (ValueError, UnicodeError):
            return error.code, None, False


def native_message_id_from_receipt(receipt):
    if not isinstance(receipt, str) or not receipt:
        return None
    prefix = "ahap-receipt:v1:"
    if not receipt.startswith(prefix):
        return receipt
    try:
        payload = json.loads(receipt[len(prefix):])
    except (TypeError, ValueError):
        return None
    if (not isinstance(payload, dict) or payload.get("kind") != "message"
            or not isinstance(payload.get("native_id"), str) or not payload["native_id"]):
        return None
    return payload["native_id"]


def completed_message_pair(value, marker, expected_receipt_id):
    rows = value.get("data") if isinstance(value, dict) else value
    if not isinstance(rows, list) or not isinstance(expected_receipt_id, str) or not expected_receipt_id:
        return None
    expected_native_id = native_message_id_from_receipt(expected_receipt_id)
    user_index = None
    user_id = None
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        info = row.get("info") if isinstance(row.get("info"), dict) else {}
        role = row.get("role") or info.get("role") or row.get("type")
        row_id = row.get("id") or info.get("id")
        if role == "user" and isinstance(row_id, str) and marker in json.dumps(row):
            user_index, user_id = index, row_id
    if user_index is None:
        return None
    for row in reversed(rows[user_index + 1:]):
        if not isinstance(row, dict):
            continue
        info = row.get("info") if isinstance(row.get("info"), dict) else {}
        role = row.get("role") or info.get("role") or row.get("type")
        row_id = row.get("id") or info.get("id")
        if role == "assistant" and isinstance(row_id, str) and ANSWER in json.dumps(row):
            timing = row.get("time") or info.get("time") or {}
            completed = timing.get("completed") if isinstance(timing, dict) else None
            finish = row.get("finish") or info.get("finish")
            parent_id = row.get("parentID") or info.get("parentID")
            if (not isinstance(completed, (int, float)) or isinstance(completed, bool)
                    or completed <= 0 or finish == "error" or row.get("error") or info.get("error")
                    or (parent_id is not None and parent_id != user_id)):
                continue
            return {"status": "confirmed" if user_id == expected_native_id else "receipt_mismatch",
                    "user_message_id": user_id, "assistant_message_id": row_id,
                    "assistant_parent_id": parent_id, "assistant_finish": finish,
                    "assistant_completed_at": completed}
    return None


def wait_for_native_completion(root, native_session_id, marker, expected_receipt_id, env, timeout=40):
    api_family = detect_opencode_api_family(root, env.get("OPENCODE_SERVER_PASSWORD", "fixture-only"))
    v22 = api_family == "v22"
    prefix = "/session/" if v22 else "/api/session/"
    path = prefix + urllib.parse.quote(native_session_id, safe="") + "/message"
    if not v22:
        path += "?limit=100&order=asc"
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        status, last = native_api_read(root, path, env.get("OPENCODE_SERVER_PASSWORD", "fixture-only"))
        pair = completed_message_pair(last, marker, expected_receipt_id) if status == 200 else None
        if pair and pair["status"] == "receipt_mismatch":
            raise RuntimeError("completed assistant has an exact marker but its user ID differs from the Task receipt: "
                               f"expected={expected_receipt_id} observed={pair['user_message_id']}")
        if pair and pair["status"] == "confirmed":
            return {"api_family": api_family,
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


def artifact_identity(args):
    core_path = Path(args.core).resolve(strict=True)
    manifest_path = core_path.parent.parent / "manifest.json"
    manifest_visible = manifest_path.is_file()
    manifest_bytes = manifest_path.read_bytes() if manifest_visible else None
    manifest = json.loads(manifest_bytes) if manifest_visible else {}
    component_paths = {"core": Path(args.core).resolve(strict=True),
                       "adapter": Path(args.runner).resolve(strict=True),
                       "opencode": Path(args.opencode).resolve(strict=True)}
    declared_paths = {"core": manifest.get("core"), "adapter": manifest.get("adapter"),
                      "opencode": manifest.get("opencode")}
    declared_hashes = manifest.get("sha256", {})
    source_commit = manifest.get("source_commit")
    if source_commit is not None and (not isinstance(source_commit, str) or not source_commit):
        raise ValueError("artifact manifest source_commit identity is malformed")
    actual_hashes = {}
    for name, path in component_paths.items():
        actual = sha256_file(path)
        if manifest_visible and name in ("core", "adapter"):
            if declared_paths.get(name) != str(path) or declared_hashes.get(name) != actual:
                raise ValueError(f"{name} path/hash does not match the mounted immutable artifact manifest")
        elif manifest_visible and name == "opencode":
            if declared_paths.get(name) is not None:
                if declared_paths[name] != str(path) or declared_hashes.get(name) != actual:
                    raise ValueError("opencode path/hash does not match the mounted immutable artifact manifest")
            elif actual != PINNED_NATIVE_OPENCODE_SHA256:
                raise ValueError("external OpenCode does not match the pinned fixture accepted for V1")
        actual_hashes[name] = actual
    auxiliary_hashes = {}
    for name in ("bootstrap", "node"):
        path = Path(getattr(args, name)).resolve(strict=True)
        actual = sha256_file(path)
        expected_path = manifest.get(name)
        expected_hash = declared_hashes.get(name)
        if manifest_visible and (expected_path != str(path) or expected_hash != actual):
            raise ValueError(f"{name} path/hash does not match the mounted immutable artifact manifest")
        auxiliary_hashes[name] = actual
    versions = {}
    for name, executable in (("node", args.node), ("opencode", args.opencode)):
        option = "--version"
        result = subprocess.run([str(executable), option], text=True, capture_output=True,
                                check=False, timeout=10)
        if result.returncode:
            raise ValueError(f"could not read {name} version from immutable fixture")
        version_lines = (result.stdout or result.stderr).strip().splitlines()
        if not version_lines:
            raise ValueError(f"{name} version command returned empty output")
        versions[name] = version_lines[0]
    path_parts = set(core_path.parts)
    inferred_stage = ("candidate" if "releases" in path_parts else
                      "installed" if path_parts.intersection({"installed", "current"}) else "unknown")
    stage = os.environ.get("HERDER_ARTIFACT_STAGE", inferred_stage)
    if stage not in ("candidate", "installed", "unknown"):
        raise ValueError("HERDER_ARTIFACT_STAGE must be candidate or installed")
    return {"stage": stage, "source_commit": source_commit,
            "manifest_path": str(manifest_path), "manifest_visible": manifest_visible,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest() if manifest_bytes else None,
            "identity_status": "complete" if manifest_visible else "runner_join_required",
            "core_sha256": actual_hashes["core"], "runner_sha256": actual_hashes["adapter"],
            "opencode_sha256": actual_hashes["opencode"],
            "node_sha256": auxiliary_hashes["node"], "bootstrap_sha256": auxiliary_hashes["bootstrap"],
            "node_version": versions["node"], "opencode_version": versions["opencode"]}


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
    v22 = api_family == "v22"
    if v22:
        status, provider = native_api_read(root, "/provider", password)
        if status != 200 or not v22_fixture_verified(provider, model_url):
            raise RuntimeError("OpenCode 2 fixture provider verification failed; no Task created")
        return "v22"
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
    return "v2"


def detect_opencode_api_family(root, password="fixture-only"):
    deadline = time.monotonic() + 20
    status, body, valid_json = native_api_read_detail(root, "/api/config", password)
    while status == 503 and time.monotonic() < deadline:
        time.sleep(0.2)
        status, body, valid_json = native_api_read_detail(root, "/api/config", password)
    if status == 404:
        health_status, health_body, health_json = native_api_read_detail(root, "/api/health", password)
        if health_status == 200 and health_json and isinstance(health_body, dict):
            return "v22"
        raise RuntimeError("OpenCode API protocol probe returned 404 without verified v22 health; refusing create/send")
    if status == 200:
        if not valid_json:
            raise RuntimeError("OpenCode API protocol probe returned malformed JSON; refusing create/send")
        if body is None:
            return "v22"
        if isinstance(body, (dict, list)):
            return "v2"
        raise RuntimeError("OpenCode API protocol probe returned an unknown config shape; refusing create/send")
    raise RuntimeError(f"OpenCode read-only protocol probe failed: HTTP {status}")


def probe_runner_protocol(node, runner, env):
    """Read nativeProtocol from the exact runner's read-only AHAP initialize response."""
    runner = str(Path(runner).resolve(strict=True))
    process = subprocess.Popen([node, runner], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
    try:
        request = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"harness": "opencode", "ahapVersion": "0.1"}}
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        if not select.select([process.stdout], [], [], 10)[0]:
            raise RuntimeError("exact AHAP runner initialize timed out before create/send")
        line = process.stdout.readline()
        try:
            response = json.loads(line)
        except (ValueError, TypeError):
            raise RuntimeError("exact AHAP runner initialize returned invalid JSON; refusing create/send") from None
        if not isinstance(response, dict) or response.get("id") != 1 or "error" in response:
            raise RuntimeError("exact AHAP runner initialize failed; refusing create/send")
        result = response.get("result")
        capabilities = result.get("capabilities") if isinstance(result, dict) else None
        family = capabilities.get("nativeProtocol") if isinstance(capabilities, dict) else None
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        if process.stdin:
            process.stdin.close()
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()
    if family not in {"v2", "v22"}:
        raise RuntimeError("exact AHAP runner selected an unknown startup protocol; refusing create/send")
    return family


def require_runner_route_compat(api_family, runner_protocol):
    if runner_protocol not in {"v2", "v22"}:
        raise RuntimeError("exact AHAP runner startup protocol is unknown; refusing create/send")
    if api_family not in {"v2", "v22"}:
        raise RuntimeError("OpenCode server protocol is unknown; refusing create/send")
    if api_family != runner_protocol:
        raise RuntimeError(
            f"AHAP runner selected {runner_protocol}, but read-only OpenCode probe found server {api_family}; "
            "refusing create/send before any session mutation"
        )


def run_case(args):
    base = os.environ.get("HERDER_TEST_MODEL_BASE_URL", "")
    if not base.startswith("http://127.0.0.1:") or not base.endswith("/v1"):
        raise ValueError("isolated loopback model from tests/native/launch.py is required")
    identity = artifact_identity(args)
    run_id = str(uuid.uuid4())
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
                "run_id": run_id, "stage": identity["stage"], "artifact": identity,
                "instance_ref": args.instance,
                "scenarios": {"projects": "UNKNOWN", "create_deliver_read": "UNKNOWN",
                    "second_same_session_deliver": "UNKNOWN", "export_native": "UNKNOWN",
                    "export_common": "UNKNOWN", "search_marker_coverage": "UNKNOWN",
                    "restart_no_resend": "UNKNOWN"},
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
        runner_protocol = probe_runner_protocol(args.node, args.runner, env)
        require_runner_route_compat(api_family, runner_protocol)
        probe_shapes = {}
        for probe_path in ("/api/config", "/api/health", "/global/health"):
            probe_status, probe_body = native_api_read(opencode_url, probe_path)
            probe_shapes[probe_path] = {"http_status": probe_status,
                                        "json_shape": redacted_json_shape(probe_body)}
        verify_opencode_fixture(opencode_url, base)
        with urllib.request.urlopen(model_origin + "/_stats", timeout=3) as response:
            model_requests_before = json.loads(response.read(4096))["requests"]
        evidence.update({"phase": "ready", "run_id": run_id, "artifact": identity,
                         "instance_ref": args.instance, "api_family": api_family,
                         "runner_protocol": runner_protocol,
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
        v1_schema_audit = validate_v1_public_contract(core.native_tool_catalog)
        projects_arguments = {"action": "projects", "instance_ref": args.instance}
        projects_wire = rpc_tool(core, "discover", projects_arguments)
        project_payload = _structured_content(projects_wire)
        has_project_response = (isinstance(project_payload, (dict, list))
                                or isinstance(projects_wire, dict)
                                and isinstance(projects_wire.get("content"), list)
                                and bool(projects_wire["content"]))
        if (not isinstance(projects_wire, dict) or projects_wire.get("isError") is True
                or _unsupported_receipt(projects_wire) or not has_project_response):
            evidence["scenarios"]["projects"] = (
                "UNSUPPORTED" if _unsupported_receipt(projects_wire) else "FAIL")
            evidence["projects"] = {"request": projects_arguments, "wire": projects_wire,
                                     "status": evidence["scenarios"]["projects"]}
            persist_evidence(evidence_path, evidence)
            raise RuntimeError(f"V1 projects discovery failed before mutation: {projects_wire}")
        evidence["scenarios"]["projects"] = "PASS"
        evidence.update({"phase": "v1_readiness_complete", "projects": {
            "request": projects_arguments, "status": "confirmed", "wire": projects_wire},
            "v1_schema_audit": v1_schema_audit})
        persist_evidence(evidence_path, evidence)
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
                              "api_family": api_family, "runner_protocol": runner_protocol,
                              "mcp_inline_ready": True,
                              "native_tools": available_tools,
                              "v1_public_contract": True,
                              "run_id": run_id, "stage": identity["stage"],
                              "artifact": identity, "instance_ref": args.instance,
                              "projects_discovery": "confirmed",
                              "native_mutations": 0, "model_requests_preflight": requests_during_init,
                              "opencode_sha256": evidence["opencode_sha256"],
                              "read_only_http_probes": probe_shapes,
                              "namespace_euid": evidence["namespace_euid"],
                              "namespace_paths": evidence["namespace_paths"],
                              "profile": str(profile_path), "opencode_url": opencode_url},
                             sort_keys=True), flush=True)
            return
        marker_one = "AHAP_OPENCODE_FIXTURE_1_" + uuid.uuid4().hex
        marker_two = "AHAP_OPENCODE_FIXTURE_2_" + uuid.uuid4().hex
        request_one = "ahap-opencode-create-" + uuid.uuid4().hex
        request_two = "ahap-opencode-deliver-" + uuid.uuid4().hex
        evidence.update({"phase": "create_submitted", "inputs": [marker_one, marker_two],
                         "request_keys": [request_one, request_two], "mutation_started": True,
                         "scenarios": {"projects": "PASS", "create_deliver_read": "UNKNOWN",
                             "second_same_session_deliver": "UNKNOWN", "export_native": "UNKNOWN",
                             "export_common": "UNKNOWN", "search_marker_coverage": "UNKNOWN",
                             "restart_no_resend": "UNKNOWN"},
                         "stage": identity["stage"], "source_commit": identity["source_commit"],
                         "manifest_sha256": identity["manifest_sha256"], "run_id": run_id,
                         "instance_ref": args.instance})
        persist_evidence(evidence_path, evidence)
        created = rpc_tool(core, "create", {"action": "create", "instance_ref": args.instance,
                            "prompt": marker_one, "request_key": request_one})
        task_id_one = created.get("taskId") if isinstance(created, dict) else None
        if not isinstance(task_id_one, str) or created.get("resultType") != "task":
            raise RuntimeError(f"create did not return a Task: {created}")
        task_one = wait_task(core, task_id_one)
        receipt_one = task_delivery_receipt(task_one)
        result_one = task_one.get("result", {}).get("structuredContent", {})
        session = result_one.get("create", {}).get("session_ref") if isinstance(result_one, dict) else None
        if task_one.get("status") != "completed" or not isinstance(session, str) or not receipt_one:
            raise RuntimeError(f"create Task lacks a confirmed session/receipt: {task_one}")
        session_one = native_session_for(Path(seed["database"]), session)
        completion_one = wait_for_native_completion(opencode_url, session_one, marker_one,
                                                    receipt_one["native_receipt_id"], env)

        delivered = rpc_tool(core, "deliver", {"action": "session", "session_ref": session,
                              "message": marker_two, "mode": "queue", "request_key": request_two})
        task_id_two = delivered.get("taskId") if isinstance(delivered, dict) else None
        if not isinstance(task_id_two, str) or delivered.get("resultType") != "task":
            raise RuntimeError(f"second same-session deliver did not return a Task: {delivered}")
        task_two = wait_task(core, task_id_two)
        receipt_two = task_delivery_receipt(task_two)
        if task_two.get("status") != "completed" or not receipt_two:
            raise RuntimeError(f"second deliver Task lacks a confirmed receipt: {task_two}")
        session_two = native_session_for(Path(seed["database"]), session)
        if session_two != session_one:
            raise RuntimeError("second delivery changed the native session identity")
        completion_two = wait_for_native_completion(opencode_url, session_two, marker_two,
                                                    receipt_two["native_receipt_id"], env)
        if receipt_one["native_receipt_id"] == receipt_two["native_receipt_id"]:
            raise RuntimeError("separate same-session deliveries reused a native user message id")

        native_read = rpc_tool(core, "session", {"action": "messages", "session_ref": session})
        native_rows = [row for row in message_records(native_read)
                       if row.get("role") in ("user", "assistant")]
        expected_pairs = [(marker_one, receipt_one["native_receipt_id"], completion_one),
                          (marker_two, receipt_two["native_receipt_id"], completion_two)]
        native_pairs = []
        for marker, user_id, completion in expected_pairs:
            user_row = next((row for row in native_rows if row.get("role") == "user"
                             and row.get("id") == user_id and row.get("text") == marker), None)
            assistant_id = completion.get("assistant_message_id")
            assistant_row = next((row for row in native_rows if row.get("role") == "assistant"
                                  and row.get("id") == assistant_id and row.get("text") == ANSWER), None)
            if not user_row or not assistant_row:
                raise RuntimeError("native readback lacks an exact user/assistant pair for a confirmed receipt")
            native_pairs.append({"user_message_id": user_id, "assistant_message_id": assistant_id,
                                 "input": marker, "reply": ANSWER})
        evidence["scenarios"]["create_deliver_read"] = "PASS"
        evidence["scenarios"]["second_same_session_deliver"] = "PASS"
        evidence.update({"task_ids": [task_id_one, task_id_two], "session_ref": session,
                         "native_pairs": native_pairs, "receipts": [receipt_one, receipt_two]})
        persist_evidence(evidence_path, evidence)

        export_arguments = {"action": "export", "session_ref": session, "format": "native"}
        export_wire = rpc_tool(core, "export", export_arguments)
        export_result = public_export_readiness(export_wire, "native")
        export_bytes = export_result.pop("_payload_bytes", None)
        export_base64 = export_result.pop("_payload_base64", None)
        export_check = {"request": export_arguments, **export_result}
        if export_base64 is not None:
            export_check["bytes_base64"] = export_base64
        evidence["public_export"] = export_check
        evidence["scenarios"]["export_native"] = export_result["status"].upper()
        persist_evidence(evidence_path, evidence)
        if (export_result["status"] != "confirmed" or export_bytes is None
                or not all(value.encode("utf-8") in export_bytes for value in
                           [marker_one, marker_two, receipt_one["native_receipt_id"],
                            receipt_two["native_receipt_id"], completion_one["assistant_message_id"],
                            completion_two["assistant_message_id"]])):
            export_check["status"] = "unverified"
            export_check["transcript_correlated"] = False
            raise RuntimeError(f"native export is incomplete or does not contain exact native transcript identities: {export_check}")
        export_check["transcript_correlated"] = True
        evidence["scenarios"]["export_native"] = "PASS"
        evidence["public_export"] = export_check

        common_arguments = {"action": "export", "session_ref": session, "format": "common"}
        common_result = public_common_export_status(rpc_tool(core, "export", common_arguments))
        evidence["common_export"] = {"request": common_arguments, **common_result}
        evidence["scenarios"]["export_common"] = ("UNSUPPORTED" if common_result["expected"]
                                                    else common_result["status"].upper())
        persist_evidence(evidence_path, evidence)
        if common_result["expected"] is not True:
            raise RuntimeError(f"common export did not return the explicit unsupported contract: {common_result}")
        common_result["request"] = common_arguments

        search_arguments = {"action": "search", "query": marker_two}
        search_wire = rpc_tool(core, "search", search_arguments)
        search_result = {"request": search_arguments,
                         **search_marker_coverage(search_wire, marker_two), "wire": search_wire}
        evidence["search"] = search_result
        evidence["scenarios"]["search_marker_coverage"] = search_result["status"].upper()
        persist_evidence(evidence_path, evidence)
        if search_result["status"] != "confirmed":
            raise RuntimeError(f"search did not prove complete marker coverage: {search_result}")
        evidence.update({"phase": "public_v1_readback", "session_ref": session,
                         "task_ids": [task_id_one, task_id_two], "receipts": [receipt_one, receipt_two],
                         "native_pairs": native_pairs, "native_completion": [completion_one, completion_two],
                         "public_export": export_check, "common_export": common_result,
                         "search": search_result, "native_session_id": session_one})
        persist_evidence(evidence_path, evidence)

        stats_url = model_origin + "/_stats"
        with urllib.request.urlopen(stats_url, timeout=3) as response:
            requests_before_restart = json.loads(response.read(4096)).get("requests") - model_requests_before
        if requests_before_restart != 2:
            raise RuntimeError(f"expected exactly two fixture model requests before restart, got {requests_before_restart}")
        core.close()
        core = None
        reopened = RpcProcess(args.core, profile_path, env)
        reopened.preflight()
        validate_v1_public_contract(reopened.native_tool_catalog)
        reopened_tasks = [wait_task(reopened, task_id) for task_id in (task_id_one, task_id_two)]
        reopened_read = rpc_tool(reopened, "session", {"action": "messages", "session_ref": session})
        reopened_rows = [row for row in message_records(reopened_read)
                         if row.get("role") in ("user", "assistant")]
        for marker, user_id, completion in expected_pairs:
            if not any(row.get("role") == "user" and row.get("id") == user_id
                       and row.get("text") == marker for row in reopened_rows):
                raise RuntimeError("reopened native transcript lost a confirmed user message")
            if not any(row.get("role") == "assistant"
                       and row.get("id") == completion.get("assistant_message_id")
                       and row.get("text") == ANSWER for row in reopened_rows):
                raise RuntimeError("reopened native transcript lost the exact assistant reply")
        if any(task.get("status") != "completed" for task in reopened_tasks):
            raise RuntimeError("reopened Tasks did not preserve both completed delivery receipts")
        export_after = public_export_readiness(rpc_tool(reopened, "export", export_arguments), "native")
        after_bytes = export_after.pop("_payload_bytes", None)
        export_after.pop("_payload_base64", None)
        if (export_after.get("status") != "confirmed" or after_bytes is None
                or hashlib.sha256(after_bytes).hexdigest() != export_check["payload_sha256"]
                or export_after.get("source") != export_check["source"]):
            raise RuntimeError("native export bytes/source changed after core restart")
        search_after = search_marker_coverage(rpc_tool(reopened, "search", search_arguments), marker_two)
        if search_after["status"] != "confirmed":
            raise RuntimeError(f"search lost marker coverage after restart: {search_after}")
        with urllib.request.urlopen(stats_url, timeout=3) as response:
            requests_after_restart = json.loads(response.read(4096)).get("requests") - model_requests_before
        if requests_after_restart != requests_before_restart:
            raise RuntimeError("core restart caused a replayed model send")
        evidence["scenarios"]["restart_no_resend"] = "PASS"
        case_status = "PASS"
        evidence.update({"phase": "completed", "result": case_status,
                         "report_schema": "ahap-opencode-v1",
                         "run_id": run_id, "stage": identity["stage"], "artifact": identity,
                         "scenarios": {"projects": "PASS", "create_deliver_read": "PASS",
                             "second_same_session_deliver": "PASS", "export_native": "PASS",
                             "export_common": "UNSUPPORTED", "search_marker_coverage": "PASS",
                             "restart_no_resend": "PASS"},
                         "task_ids": [task_id_one, task_id_two], "session_ref": session,
                         "native_pairs": native_pairs, "public_export": export_check,
                         "common_export": common_result, "search": search_result,
                         "search_after_restart": search_after,
                         "reopened_task_statuses": [task.get("status") for task in reopened_tasks],
                         "model_requests_before_restart": requests_before_restart,
                         "model_requests_after_restart": requests_after_restart,
                         "model_requests_delta": requests_after_restart,
                         "native_session_id": session_one,
                         "restart": {"core_reopened": True, "tasks_completed": True,
                                     "native_export_sha256_unchanged": True,
                                     "search_coverage_preserved": True,
                                     "model_requests_before": requests_before_restart,
                                     "model_requests_after": requests_after_restart,
                                     "resend_count": 0},
                         "evidence_path": str(evidence_path),
                         "cleanup": {"opencode_server_shutdown": "finally",
                                     "disposable_fixture_cleanup_owner": "launcher"}})
        persist_evidence(evidence_path, evidence)
        print(json.dumps({"status": case_status, "harness": "opencode", "native_tools": available_tools,
            "report_schema": "ahap-opencode-v1",
            "api_family": api_family, "runner_protocol": runner_protocol,
            "v1_schema_audit": v1_schema_audit,
            "task_ids": [task_id_one, task_id_two], "session_ref": session,
            "inputs": [marker_one, marker_two], "request_keys": [request_one, request_two],
            "receipts": [receipt_one, receipt_two], "native_pairs": native_pairs,
            "native_completion": [completion_one, completion_two],
            "native_readback": native_rows, "reopened_readback": reopened_rows,
            "reopened_task_statuses": [task.get("status") for task in reopened_tasks],
            "projects": evidence.get("projects"), "model_requests": requests_after_restart,
            "model_requests_delta": requests_after_restart,
            "public_export": export_check, "common_export": common_result,
            "search": search_result, "search_after_restart": search_after,
            "run_id": run_id, "stage": identity["stage"], "artifact": identity,
            "instance_ref": args.instance, "scenarios": evidence["scenarios"],
            "restart": evidence["restart"], "evidence_path": str(evidence_path),
            "cleanup": evidence["cleanup"], "profile": str(profile_path),
            "opencode_url": opencode_url}, sort_keys=True), flush=True)
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
        evidence["cleanup"] = {"opencode_server_stopped": server.poll() is not None,
                                "launcher_cleanup": "after_stand_exit"}
        persist_evidence(evidence_path, evidence)


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
