#!/usr/bin/env python3
"""Opt-in real native process lease canary with private authority and durable effect receipts.

The selected installed harness is reused only for newly created QA sessions.
No shared Herder selector or ownership store is modified. Effects are checkpointed
before admission and are never replayed automatically after an uncertain result.
Native acceptance currently requires an explicit reviewed local ZCode full-history
proof. Other harnesses stop before admission until a complete reader is proven.
"""
import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

MARKER = "PROCESS_LEASES_V1"
NATIVE_HISTORY_CONTRACT = "zcode-session-read-current-conversation-v1"
NATIVE_EXPORT_SOURCE = {"kind": "native-api", "location": "zcode app-server session/read", "format": "json"}
# ZCode persists these two accounting parts for an ordinary model turn. They
# are not tool calls. Other part types remain outside this QA acceptance.
QA_REPLY_PARTS = {"text", "reasoning", "step-start", "step-finish"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def create(path, value, mode=0o600):
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as out:
        out.write(data); out.flush(); os.fsync(out.fileno())


def save(path, value):
    fd, name = tempfile.mkstemp(prefix=".canary-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, indent=2, sort_keys=True); out.write("\n")
            out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(name): os.unlink(name)


def check(ok, reason):
    if not ok: raise RuntimeError(reason)


def private_json(path):
    path = Path(path)
    check(path.is_absolute() and path.resolve(strict=True) == path, "noncanonical private QA evidence")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        check(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
              and not info.st_mode & 0o077 and info.st_size <= 8 * 1024 * 1024, "untrusted private QA evidence")
        data = stream.read(8 * 1024 * 1024 + 1)
        after = os.fstat(stream.fileno())
    check(len(data) == info.st_size and (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
          == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "QA evidence changed during read")
    return json.loads(data), hashlib.sha256(data).hexdigest()


def native_server_observation(pid):
    """Read only the already reviewed native server and its non-secret route."""
    proc = Path("/proc") / str(pid)
    raw = (proc / "stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    argv = [arg.decode() for arg in (proc / "cmdline").read_bytes().split(b"\0") if arg]
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
    return {"pid": pid, "start_ticks": fields[19], "state": fields[0], "uid": proc.stat().st_uid,
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "exe": os.readlink(proc / "exe"), "entry": argv[1] if len(argv) > 1 else None,
            "agent_command": env.get(b"ZCODE_AGENT_SERVER_COMMAND", b"").decode(),
            "agent_args": json.loads(env.get(b"ZCODE_AGENT_SERVER_ARGS_JSON", b"null"))}


def validate_history_proof(kind, source_commit, owner, reference):
    """A reviewed local ZCode reader is the only complete reader proven here.

    The source review is independent of the old QA session named in its evidence.
    Its release and server identity still have to match before any new effect.
    No other harness inherits completeness from a bounded messages response.
    """
    check(kind == "zcode", "unsupported_native_acceptance: no reviewed complete reader for " + str(kind))
    check(isinstance(reference, dict) and reference.get("contract") == NATIVE_HISTORY_CONTRACT
          and isinstance(reference.get("path"), str) and isinstance(reference.get("sha256"), str)
          and re.fullmatch(r"[0-9a-f]{64}", reference["sha256"]),
          "unsupported_native_acceptance: explicit reviewed native history proof required")
    proof, digest = private_json(reference["path"])
    check(digest == reference["sha256"], "native history review digest changed")
    conclusion = proof.get("conclusion", {})
    check(proof.get("version") == 1 and proof.get("kind") == "herder-zcode-native-history-source-review"
          and proof.get("source_commit") == source_commit and conclusion.get("read_route_suitable_for_qa") is True
          and conclusion.get("hidden_default_message_limit") is False
          and conclusion.get("not_a_tail_length_inference") is True, "unsupported_native_history_review")
    check(sys.platform == "linux" and owner.get("node") == os.uname().nodename
          and owner.get("kind") == kind
          and owner.get("ahap_env", {}).get("AHAP_ZCODE_TRANSPORT") == "official-server",
          "unsupported_native_acceptance: reviewed reader is local Linux official-server only")
    model = owner.get("ahap_env", {}).get("AHAP_ZCODE_CREATE_MODEL")
    check(isinstance(model, str) and model, "explicit unchanged native model required")
    release = proof.get("installed_release", {})
    release_root = Path(release.get("root", ""))
    check(release_root.is_absolute() and release_root.resolve(strict=True) == release_root,
          "native release root changed")
    paths = {name: str(release_root / name) for name in
             ("runtime/node", "runtime/server-core.js", "runtime/zcode.cjs", "manifest.json")}
    files = release.get("files", [])
    check(isinstance(files, list) and len(files) == 4
          and {entry.get("path") for entry in files} == set(paths.values()), "native release inventory incomplete")
    for entry in files:
        path = Path(entry["path"]); info = path.lstat()
        maximum = 256 * 1024 * 1024 if entry["path"] == paths["runtime/node"] else 64 * 1024 * 1024
        check(path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
              and info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022
              and info.st_size <= maximum and sha(path) == entry.get("sha256"), "native release file pin changed")
    servers = [item for item in proof.get("observed_processes", []) if item.get("entry") == paths["runtime/server-core.js"]]
    check(len(servers) == 1 and type(servers[0].get("pid")) is int, "native server identity evidence missing")
    expected = servers[0]; actual = native_server_observation(expected["pid"])
    check(actual["uid"] == os.getuid() and actual["state"] != "Z"
          and all(actual.get(key) == expected.get(key) for key in ("pid", "boot_id", "start_ticks"))
          and actual["exe"] == paths["runtime/node"] and actual["entry"] == paths["runtime/server-core.js"]
          and actual["agent_command"] == paths["runtime/node"]
          and actual["agent_args"] == [paths["runtime/zcode.cjs"], "app-server", "--stdio"],
          "native history server or exact agent route changed")
    return reference


def require_history_reader(state):
    check(state.get("kind") == "zcode", "unsupported_native_acceptance: no reviewed complete reader for " + str(state.get("kind")))
    check(isinstance(state.get("native_history"), dict)
          and state["native_history"].get("contract") == NATIVE_HISTORY_CONTRACT,
          "unsupported_native_acceptance: explicit reviewed native history proof required")
    profile, profile_hash = private_json(state["profile"])
    check(profile_hash == state.get("profile_sha256"), "prepared QA profile changed or has no reader proof")
    manifest = json.loads(Path(state["base_manifest"]).read_text())
    check(sha(state["base_manifest"]) == state["base_manifest_sha256"]
          and manifest["source_commit"] == state["source_commit"]
          and profile["owner"]["ahap_script"] == manifest["adapters"]["zcode"]
          and sha(profile["owner"]["ahap_script"]) == manifest["sha256"]["adapters"]["zcode"],
          "unsupported_native_acceptance: exact reviewed local adapter required")
    return validate_history_proof(state["kind"], state["source_commit"], profile["owner"], state.get("native_history"))


def parse_native_export(value, session_ref, native_session_id):
    """Full current conversation, with native identities and no tail inference.

    Adapted from the reviewed existing-session QA helper, with its source proof
    recorded in native-history-source-proof.json (SHA256 e499a03f...e81d74).
    This does not claim a forensic archive of removed rewind branches.
    """
    check(isinstance(value, dict) and value.get("session_ref") == session_ref
          and value.get("format") == "native" and value.get("encoding") == "base64"
          and value.get("complete") is True, "native_export_incomplete_or_misbound")
    check(value.get("source") == NATIVE_EXPORT_SOURCE and value.get("timestampCoverage") == "native",
          "unsupported_native_export_source")
    encoded = value.get("bytes_base64")
    check(isinstance(encoded, str) and len(encoded) <= 24 * 1024 * 1024, "native_export_bytes_missing_or_unbounded")
    try:
        raw = base64.b64decode(encoded, validate=True)
        snapshot = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise RuntimeError("invalid_native_export_encoding") from error
    check(isinstance(snapshot, dict), "native_export_snapshot_not_object")
    session = snapshot.get("session", snapshot)
    check(isinstance(session, dict) and session.get("sessionId") == native_session_id
          and snapshot.get("sessionId", native_session_id) == native_session_id, "native_export_session_mismatch")
    source_rows = snapshot.get("messages")
    check(isinstance(source_rows, list) and len(source_rows) <= 10000, "native_export_messages_unavailable_or_unbounded")
    rows = []
    for message in source_rows:
        check(isinstance(message, dict), "invalid_native_message")
        info = message.get("info"); parts = message.get("parts")
        check(isinstance(info, dict) and isinstance(parts, list), "native_message_shape_unsupported")
        native_id = info.get("messageId"); role = info.get("role")
        check(isinstance(native_id, str) and re.fullmatch(r"msg_[A-Za-z0-9_-]+", native_id)
              and role in {"user", "assistant", "system", "developer", "tool"}, "native_message_identity_missing")
        check(info.get("sessionId", native_session_id) == native_session_id, "native_message_session_mismatch")
        check(all(isinstance(part, dict) and isinstance(part.get("type"), str) for part in parts),
              "native_message_parts_unsupported")
        texts = [part.get("text") for part in parts if part["type"] == "text"]
        check(all(isinstance(text, str) for text in texts), "native_message_text_invalid")
        anchor = info.get("anchor") or {}; metadata = info.get("metadata") or {}
        check(isinstance(anchor, dict) and isinstance(metadata, dict), "native_message_correlation_invalid")
        row = {"id": native_id, "nativeMessageId": native_id, "role": role, "text": "\n".join(texts),
               "part_types": [part["type"] for part in parts]}
        for target, source in (("parentMessageId", info.get("parentMessageId")),
                               ("sourceCommandId", anchor.get("sourceCommandId")), ("inputId", metadata.get("inputId"))):
            if source is not None:
                check(isinstance(source, str) and source, "native_message_correlation_invalid")
                row[target] = source
        rows.append(row)
    check(len({row["id"] for row in rows}) == len(rows), "duplicate_native_message_ids")
    return {"complete": True, "scope": "current_native_conversation", "source": NATIVE_EXPORT_SOURCE,
            "timestampCoverage": "native", "raw_sha256": hashlib.sha256(raw).hexdigest(), "raw_bytes": len(raw),
            "message_count": len(rows), "native_session_id": native_session_id}, rows


class MCP:
    def __init__(self, root, state):
        self.root = root
        self.state = state
        self.history_reader = None
        self.seq = 0
        self.buffer = b""
        self.err = open(root / "native-mcp.stderr.log", "ab")
        self.proc = subprocess.Popen(
            [sys.executable, state["launcher"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.err, bufsize=0, start_new_session=True,
            env=dict(os.environ, HERDER_V1_ENTRY=str(root / "selector.json")))
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "process-lease-canary", "version": "1"}})
        self.notify("notifications/initialized", {})
        self.tools = self.rpc("tools/list", {})["tools"]

    def notify(self, method, params):
        self.proc.stdin.write((json.dumps({"jsonrpc":"2.0", "method":method, "params":params})+"\n").encode())
        self.proc.stdin.flush()

    def rpc(self, method, params):
        self.seq += 1; ident = self.seq
        self.proc.stdin.write((json.dumps({"jsonrpc":"2.0", "id":ident, "method":method, "params":params})+"\n").encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                result = json.loads(line)
                if result.get("id") != ident: continue
                if "error" in result: raise RuntimeError("RPC error: " + json.dumps(result["error"])[:500])
                return result.get("result", {})
            wait = max(0, deadline-time.monotonic())
            if not select.select([self.proc.stdout], [], [], wait)[0]: break
            data = os.read(self.proc.stdout.fileno(), 65536)
            if not data: raise RuntimeError("candidate MCP exited; inspect private stderr")
            self.buffer += data
        raise TimeoutError("MCP timeout: effect UNKNOWN, no replay")

    def call(self, name, args):
        read_only = (name, args.get("action")) in {
            ("automation", "get"), ("resource", "get"),
            ("session", "messages"), ("sessions", "list"), ("compat_task", "get"), ("automation", "wait_status")}
        read_only = read_only or (name == "export" and args.get("action") == "export"
            and args.get("format") == "native" and isinstance(args.get("session_ref"), str)
            and bool(args["session_ref"]) and set(args) == {"action", "session_ref", "format"})
        retry_deadline = time.monotonic()+150
        while True:
            value = self.rpc("tools/call", {"name": name, "arguments": args})
            if not value.get("isError"): break
            detail = value.get("structuredContent")
            # A canonical writer may hold the gate during a bounded native
            # admission. Retry this read only; never retry a possible effect.
            if read_only and isinstance(detail, dict) and detail.get("effect") == "none" and detail.get("code") == "scope_unavailable" and time.monotonic()<retry_deadline:
                time.sleep(0.5);continue
            raise RuntimeError("tool "+name+" failed: "+json.dumps(detail or value.get("content"))[:1000])
        data = value.get("structuredContent")
        if isinstance(data, dict): return data
        for part in value.get("content", []):
            if part.get("type") == "text":
                try:
                    data = json.loads(part["text"])
                    if isinstance(data, dict): return data
                except ValueError: pass
        return value

    def close(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try: self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL); self.proc.wait(timeout=5)
        self.err.close()


def effect(client, root, state, label, tool, args):
    check(label not in state["effects"], label+" was already attempted; inspect receipt, no replay")
    state["effects"][label] = {"status": "UNKNOWN", "tool": tool,
                               "request_key": args.get("request_key"), "started_at": time.time()}
    save(root / "checkpoint.json", state)
    value = client.call(tool, args)
    state["effects"][label].update(status="returned", result=value)
    save(root / "checkpoint.json", state)
    return value


def task_ref(value):
    return value.get("task_ref") or value.get("taskId") or value.get("_herder_create_task") or value.get("_herder_delivery_task")


def observe_task(client, root, state, label, timeout=180):
    admission = state["effects"][label]["result"]
    ref = task_ref(admission)
    check(ref, "missing durable task reference")
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        value = client.call("compat_task", {"action": "get", "task_ref": ref})
        state["effects"][label]["observed_task"] = value
        save(root/"checkpoint.json", state)
        if value.get("status") == "completed":
            result = value.get("result") or {}
            completed = result.get("structuredContent") or result
            # Creation and first prompt are different effects. Preserve a
            # confirmed native identity even when admission or the model fails.
            session = completed.get("create", {}).get("session_ref") or completed.get("session_ref")
            if label == "create_session" and session:
                with sqlite3.connect("file:"+state["database"]+"?mode=ro", uri=True) as db:
                    rows = db.execute("SELECT native_session_id,node_ref,instance_id FROM session_bindings WHERE session_ref=?",
                                      (session,)).fetchall()
                check(len(rows) == 1, "confirmed create has no exact durable native binding")
                state["session_ref"] = session
                state["native_session_id"],state["native_node_ref"],state["native_instance_id"] = rows[0]
                save(root/"checkpoint.json", state)
            check(not result.get("isError"), "native task completed with an error")
            return completed
        if value.get("status") in ("failed", "cancelled"):
            raise RuntimeError("native task "+value["status"])
        time.sleep(3)
    raise TimeoutError("native task has no terminal receipt; no replay")


def messages(client, session):
    state = client.state
    check(session == state.get("session_ref") and state.get("native_session_id"), "exact native history binding missing")
    if client.history_reader is None:
        client.history_reader = require_history_reader(state)
    value = client.call("export", {"action": "export", "session_ref": session, "format": "native"})
    proof, rows = parse_native_export(value, session, state["native_session_id"])
    # Native read plus optional indexing in this private authority. The full
    # export is retained so the ID/count proof remains independently reviewable.
    artifact = client.root / ("native-export-" + str(time.time_ns()) + ".json")
    create(artifact, value)
    proof.update(export_artifact=str(artifact), export_artifact_sha256=sha(artifact))
    return proof, rows


def profile_owner(state):
    profile, digest = private_json(state["profile"])
    check(digest == state.get("profile_sha256") and profile["database"] == state["database"]
          and profile["generation"] == state["generation"], "original QA authority/profile changed")
    return profile["owner"]


def exact_message_receipt(state, request_key):
    owner = profile_owner(state)
    with sqlite3.connect("file:" + state["database"] + "?mode=ro", uri=True) as db:
        rows = db.execute("SELECT task_id,principal,target,state,native_receipt FROM intents WHERE request_key=?",
                          (request_key,)).fetchall()
    check(len(rows) == 1 and rows[0][1] == owner["principal"] and rows[0][2] == state["session_ref"]
          and rows[0][3] == "confirmed" and rows[0][4], "exact canonical native delivery receipt missing")
    receipt = json.loads(rows[0][4])
    address = {"instance": {"node": owner["node"], "instance_id": owner["instance"]},
               "native_session_id": state["native_session_id"]}
    check(receipt.get("version") == 1 and receipt.get("request_key") == request_key
          and receipt.get("target_ref") == state["session_ref"] and receipt.get("principal") == owner["principal"]
          and receipt.get("address") == address, "native_receipt_binding_mismatch")
    encoded = receipt.get("native_id", ""); prefix = "ahap-receipt:v1:"
    check(isinstance(encoded, str) and encoded.startswith(prefix), "native_message_receipt_required")
    native = json.loads(encoded[len(prefix):])
    check(native.get("kind") == "message" and isinstance(native.get("native_id"), str)
          and re.fullmatch(r"msg_[A-Za-z0-9_-]+", native["native_id"]), "exact_native_message_id_required")
    return {"task_ref": rows[0][0], "message_id": native["native_id"], "request_key": request_key, "receipt": receipt}


def initial_prompt_key(state):
    # Exact Rust scoped_stop/create_prompt.rs::delivery_identifiers contract.
    # Use the admitted create key, never a new key after a missing ACK.
    owner = profile_owner(state)
    key = state["effects"]["create_session"]["request_key"]
    check(isinstance(key, str) and key, "original create key missing")
    value = ["create-prompt-v1", owner["principal"], {"node": owner["node"], "instance_id": owner["instance"]}, key]
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return "create-prompt:" + hashlib.sha256(encoded).hexdigest()


def assert_native_idle(client, session):
    state = client.state
    check(session == state.get("session_ref"), "native idle target mismatch")
    listing = client.call("sessions", {"action": "list"})
    selected = [row for row in listing.get("sessions", []) if row.get("session_ref") == session]
    check(listing.get("native_coverage_complete") is True and len(selected) == 1, "native_status_incomplete")
    native = selected[0].get("native", {})
    check(native.get("id") == state["native_session_id"] and native.get("harness") == state["kind"]
          and native.get("status") == "idle" and native.get("needsPermission") is not True, "native_session_not_idle")
    configured = profile_owner(state)["ahap_env"]["AHAP_ZCODE_CREATE_MODEL"]
    models = [value for value in (native.get("model"), (native.get("meta") or {}).get("model")) if value is not None]
    check(models and all(value == configured for value in models), "native_model_not_exactly_pinned")
    return native


def native_baseline(client, state):
    assert_native_idle(client, state["session_ref"])
    page, rows = messages(client, state["session_ref"])
    return {"ids": [row["id"] for row in rows], "assistant_ids": [row["id"] for row in rows if row["role"] == "assistant"],
            "history_complete": True, "history": page, "idle": True}


def verify_reply_rows(rows, baseline_ids, receipt_id, marker, expected_assistant_ids):
    check(isinstance(baseline_ids, list) and len(set(baseline_ids)) == len(baseline_ids), "invalid native baseline")
    check(set(baseline_ids).issubset({row["id"] for row in rows}), "native_history_lost_baseline_messages")
    added = [row for row in rows if row["id"] not in baseline_ids]
    users = [row for row in added if row["role"] == "user"]
    assistants = [row for row in added if row["role"] == "assistant"]
    check(len(users) == 1 and users[0]["id"] == receipt_id, "unexpected_native_input_count_or_binding")
    check(len(assistants) == 1 and [assistants[0]["id"]] == expected_assistant_ids
          and assistants[0]["text"].strip() == marker, "unexpected_native_assistant_turns")
    check(len(added) == 2 and assistants[0].get("parentMessageId") == users[0]["id"], "native_reply_parent_mismatch")
    check(all(set(row["part_types"]) <= QA_REPLY_PARTS for row in added), "unexpected_native_tool_or_attachment")
    return {"native_user_ids": [users[0]["id"]], "native_assistant_ids": [assistants[0]["id"]],
            "native_parent_message_id": assistants[0]["parentMessageId"],
            "native_part_types": {row["id"]: row["part_types"] for row in added}}


def wait_marker(client, session, marker, timeout=120):
    deadline = time.monotonic()+timeout
    idle_since = None; previous = None; samples = []
    while time.monotonic()<deadline:
        page, rows = messages(client, session)
        found = [x for x in rows if x.get("role") == "assistant" and x.get("text", "").strip() == marker]
        check(len(found) <= 1, "multiple native assistant replies for one expected continuation")
        if found:
            # A first streamed answer can precede another native turn promoted
            # from the same inbox item. Wait for stable native idle, then inspect
            # the history again before claiming a single continuation.
            listing = client.call("sessions", {"action":"list"})
            selected = [row for row in listing.get("sessions", []) if row.get("session_ref")==session]
            native = selected[0].get("native") if len(selected)==1 else None
            idle = (listing.get("native_coverage_complete") is True and isinstance(native,dict)
                    and native.get("id") == client.state["native_session_id"] and native.get("harness") == client.state["kind"]
                    and native.get("status")=="idle" and native.get("needsPermission") is not True and page.get("complete") is True)
            if idle:
                now = time.monotonic(); wall = int(time.time() * 1000)
                if idle_since is None or (previous is not None and now - previous > 5):
                    idle_since = now; samples = []
                previous = now; samples.append({"monotonic": now, "observed_at_unix_ms": wall})
                if now - idle_since >= 15:
                    return {"count":len(found), "ids":[x.get("id") for x in found],
                            "text":[x.get("text") for x in found], "history_complete":page.get("complete"),
                            "native_idle_confirmed":True, "history": page, "idle_window_ms": int((now-idle_since)*1000),
                            "idle_observed_from_unix_ms": samples[0]["observed_at_unix_ms"], "idle_observed_until_unix_ms": wall,
                            "idle_observation_count": len(samples), "max_observation_gap_ms": max(
                                (int((b["monotonic"]-a["monotonic"])*1000) for a,b in zip(samples,samples[1:])), default=0)}
            else: idle_since = None; previous = None; samples = []
        else: idle_since = None; previous = None; samples = []
        time.sleep(2)
    raise TimeoutError("native assistant marker and stable idle missing; no resend")


def verify_reply(client, state, baseline, request_key, marker, timeout=120):
    stable = wait_marker(client, state["session_ref"], marker, timeout)
    receipt = exact_message_receipt(state, request_key)
    page, rows = messages(client, state["session_ref"])
    check(page.get("complete") is True, "final_history_incomplete")
    proof = verify_reply_rows(rows, baseline["ids"], receipt["message_id"], marker, stable["ids"])
    assert_native_idle(client, state["session_ref"])
    require_history_reader(state)
    return {**stable, **proof, "marker": stable, "receipt": receipt, "complete_history": True, "final_history": page,
            "final_idle_observed_at_unix_ms": int(time.time()*1000)}


def prepare(args):
    root = args.root
    check(root.is_absolute() and root.resolve() == root and root.parent.is_dir(), "canonical existing parent required")
    if not root.exists(): root.mkdir(mode=0o700)
    check(root.stat().st_uid == os.getuid() and not root.stat().st_mode & 0o077, "private canary root required")
    check(not (root/"checkpoint.json").exists(), "canary already prepared")
    manifest_path = args.manifest
    manifest = json.loads(manifest_path.read_text())
    for key in ("core", "compat", "node", "bootstrap", "process_worker", "process_config"):
        check(sha(manifest[key]) == manifest["sha256"][key], "artifact digest mismatch: "+key)
    base = json.loads(args.profile.read_text())
    migration_profile = None
    if "adapter_migration" in manifest:
        helper_path = Path(__file__).resolve().parents[2]/"deploy/fleet/process-leases-candidate.py"
        spec = importlib.util.spec_from_file_location("process_lease_candidate", helper_path)
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        # Validate the complete old/new component and profile transition.
        # This reads staged payloads and never creates live authority files.
        candidate.check_candidate(manifest_path.parent/"selector.json",
                                  manifest_path.parent/"fixture/launch-v1-core.py")
        migration = candidate.read_json(manifest["adapter_migration"])
        rows = [row for row in migration["profiles"] if row["previous_path"] == str(args.profile)]
        check(len(rows) <= 1, "ambiguous migrated profile")
        if rows:
            migration_profile = rows[0]
            check(sha(args.profile) == migration_profile["previous_sha256"], "original profile changed")
            check(sha(migration_profile["payload"]) == migration_profile["payload_sha256"], "staged profile changed")
            base = candidate.read_json(migration_profile["payload"])
    kind = base["owner"]["kind"]
    check(kind in ("codex", "opencode", "zcode", "chatgpt", "zai", "hermes"), "unsupported explicit harness")
    proof_path = getattr(args, "native_history_proof", None)
    history = {"contract": NATIVE_HISTORY_CONTRACT, "path": str(proof_path) if proof_path else None,
               "sha256": getattr(args, "native_history_proof_sha256", None)}
    validate_history_proof(kind, manifest["source_commit"], base["owner"], history)
    remote = base["owner"]["ahap_script"] != manifest["adapters"][kind]
    check(not remote, "unsupported_native_acceptance: no reviewed remote complete reader")
    check(sha(base["owner"]["ahap_script"]) == manifest["sha256"]["adapters"][kind], "adapter digest mismatch")
    protected = root/"herder-owner-home"
    protected.mkdir(mode=0o700)
    out = subprocess.run([manifest["bootstrap"], str(protected)], check=True, capture_output=True, text=True, timeout=30)
    seed = json.loads(out.stdout)
    work = root/"work";work.mkdir(mode=0o700)
    create(work/"AGENTS.md", b"QA fixture only. The only authorized task is to echo the exact requested marker and end the turn. Do not use tools, read other workspaces, change files, or start agents.\n")
    create(work/"hello.c", b'#include <stdio.h>\nint main(void) { puts("PROCESS_BUILD_OK"); return 0; }\n')
    build_source = """import os,subprocess,time
from pathlib import Path
root=Path(__file__).parent
fd=os.open(root/'build-started',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.write(fd,b'one build\\\\n');os.close(fd)
subprocess.run(['/usr/bin/cc',str(root/'hello.c'),'-o',str(root/'hello')],check=True)
out=subprocess.check_output([str(root/'hello')],text=True).strip()
assert out=='PROCESS_BUILD_OK'
print(out,flush=True)
time.sleep(40)
print('PROCESS_BUILD_FINISHED',flush=True)
"""
    create(work/"build.py", build_source.encode())
    for argv in (["git","init","--quiet"], ["git","add","AGENTS.md","hello.c","build.py"],
                 ["git","-c","user.name=Herder QA","-c","user.email=qa@localhost","-c","core.hooksPath=/dev/null","commit","--quiet","-m","Process lease canary fixture"]):
        subprocess.run(argv, cwd=work, check=True, capture_output=True)
    owner = copy.deepcopy(base["owner"])
    if not remote:
        owner["cwd"] = str(work)
        if kind == "zcode": owner.setdefault("ahap_env", {})["AHAP_ZCODE_CWD"] = str(work)
        if kind == "codex": owner.setdefault("ahap_env", {})["AHAP_CODEX_CWD"] = str(work)
    profile = Path(seed["profile_seed"]).parent/"profile.json"
    create(profile, {k:seed[k] for k in ("database","gate","generation")} | {"owner":owner})
    config = json.loads(Path(manifest["process_config"]).read_text())
    config.update(execution_root=str(root/"executions"), administrators=[owner["principal"]])
    config["resources"].update(root=str(root/"resources"), storage_id="qa-process-"+root.name)
    for directory in (root/"executions",root/"resources",root/"resources/resources"): directory.mkdir(mode=0o700)
    create(root/"resources/storage.json", {"schema":"v1","storage_id":config["resources"]["storage_id"]})
    create(root/"process-runtime.json", config, 0o400)
    isolated = copy.deepcopy(manifest)
    isolated["process_config"] = str(root/"process-runtime.json")
    isolated["sha256"]["process_config"] = sha(root/"process-runtime.json")
    # A candidate that carries the wait reader is tested with the same pinned helper.
    create(root/"manifest.json", isolated, 0o400)
    create(root/"selector.json", {"manifest":str(root/"manifest.json"),"manifest_sha256":sha(root/"manifest.json"),"profiles":[str(profile)]}, 0o400)
    state = {"version":1,"status":"prepared","run":root.name,"effects":{},
             "source_commit":manifest["source_commit"],"base_manifest":str(manifest_path),"base_manifest_sha256":sha(manifest_path),
             "base_profile":str(args.profile),"base_profile_sha256":sha(args.profile),
             "profile":str(profile),"profile_sha256":sha(profile),"database":seed["database"],"generation":seed["generation"],
             "native_history":history,
             "instance_ref":owner["instance"],"kind":kind,"work":str(work),
             "launcher":str(manifest_path.parent/"fixture/launch-v1-core.py"),
             "resource_ref":"qa:process-build:"+root.name,"storage_id":config["resources"]["storage_id"]}
    if migration_profile:
        state["adapter_profile_migration"] = {key:migration_profile[key] for key in
            ("kind","previous_path","previous_sha256","path","sha256","payload","payload_sha256")}
        state["adapter_migration_sha256"] = manifest["sha256"]["adapter_migration"]
    create(root/"checkpoint.json", state)
    return state


def session_start(client, root, state):
    require_history_reader(state)
    marker = "READY_"+MARKER
    prompt = ("This is a disposable test session for Agent Herder. Do not use tools, inspect files, contact anyone, or start work. "
              "Reply exactly "+marker+" and end this turn. When a later process completion receipt arrives, "
              "reply exactly RESUMED_"+MARKER+" exit=0 and end the turn. Never continue a repository task.")
    result = effect(client,root,state,"create_session","create",{"action":"create","instance_ref":state["instance_ref"],
        "prompt":prompt,"request_key":state["run"]+"-create"})
    state["create_admission"] = result;save(root/"checkpoint.json",state)
    completed = observe_task(client,root,state,"create_session")
    session = completed.get("create", {}).get("session_ref") or completed.get("session_ref")
    check(session, "native create receipt has no session reference")
    state["session_ref"] = session;save(root/"checkpoint.json",state)
    with sqlite3.connect("file:"+state["database"]+"?mode=ro", uri=True) as db:
        rows=db.execute("SELECT native_session_id,node_ref,instance_id FROM session_bindings WHERE session_ref=?",(session,)).fetchall()
    check(len(rows)==1, "exact native session binding missing")
    state["native_session_id"],state["native_node_ref"],state["native_instance_id"]=rows[0]
    # This was a newly created native session. Its original create-prompt ACK
    # must account for exactly one user and one assistant, with no prior IDs.
    state["initial_reply"] = verify_reply(client,state,{"ids":[]},initial_prompt_key(state),marker)
    state["status"]="session_ready";save(root/"checkpoint.json",state)


def run_process(client,root,state):
    require_history_reader(state)
    check(state.get("status")=="session_ready", "exact initial assistant reply required")
    check(not {"resource_register", "resource_claim", "process_wait"}.intersection(state["effects"]),
          "process was already attempted; preserve the original baseline and inspect receipts, no replay")
    state["before_wait_native"] = native_baseline(client,state)
    save(root/"checkpoint.json",state)
    resource=state["resource_ref"]
    descriptor=effect(client,root,state,"resource_register","resource",{"action":"register","resource_ref":resource,
        "scope":{"type":"global"},"kind":{"type":"other","name":"build"},"external_ref":"fixture:"+state["run"],
        "authority_ref":state["storage_id"]})
    state["descriptor"]=descriptor
    expires=int(time.time())+15
    claim=effect(client,root,state,"resource_claim","resource",{"action":"claim","resource_ref":resource,
        "purpose":"Only this QA build","request_key":state["run"]+"-claim","expires_at":"unix-seconds:"+str(expires)})
    state["initial_claim"]=claim;save(root/"checkpoint.json",state)
    current=client.call("resource",{"action":"get","resource_ref":resource})
    state["initial_resource"]=current
    claim_id=(current.get("claim") or {}).get("claim_id") or claim.get("claim_id")
    revision=(current.get("resource") or {}).get("revision") or descriptor.get("revision")
    check(claim_id and revision,"canonical resource/claim receipt missing")
    rule={"kind":"process_completion","execution":{"mode":"start","argv":[sys.executable,str(root/"work/build.py")],
        "cwd":state["work"],"deadline_unix_ms":int(time.time()*1000)+180000,"stop_grace_ms":1000},
        "bindings":[{"resource_ref":resource,"claim_id":claim_id,"revision":revision,"ttl_seconds":15,"on_exit":"release"}],
        "wake_message":"The supervised QA build has finished. Do not use tools. Reply exactly RESUMED_"+MARKER+" exit=0 and end."}
    admission=effect(client,root,state,"process_wait","automation",{"action":"create","session_ref":state["session_ref"],
        "rule":rule,"request_key":state["run"]+"-process"})
    state["process_admission"]=admission
    state["rule_ref"]=admission.get("rule_ref")
    state["status"]="process_registered";save(root/"checkpoint.json",state)
    check(state["rule_ref"],"durable rule reference missing")
    time.sleep(4)
    state["before_restart"]=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
    save(root/"checkpoint.json",state)
    client.close()
    time.sleep(18)
    client=MCP(root,state)
    state["renewed_resource"]=client.call("resource",{"action":"get","resource_ref":resource})
    state["after_restart"]=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
    renewed=(state["renewed_resource"].get("claim") or {}).get("expires_at")
    check(renewed and renewed.startswith("unix-seconds:") and int(renewed.split(":")[1])>int(time.time()),
          "worker did not renew the claim while core was absent")
    check(Path(state["work"],"build-started").read_text()=="one build\\n","build start receipt mismatch")
    state["renewal_after_core_restart"]=True;save(root/"checkpoint.json",state)
    return client


def observe(client,root,state):
    check(state.get("rule_ref") and state.get("session_ref"), "existing process receipt required")
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        value=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
        state["process_observed"]=value;save(root/"checkpoint.json",state)
        # Read the persisted wait state without guessing a tool response projection.
        with sqlite3.connect("file:"+state["database"]+"?mode=ro",uri=True) as db:
            entries=db.execute("SELECT setting_key,value_json FROM settings WHERE setting_key LIKE 'state:process-rule:%'").fetchall()
        states=[json.loads(v) for k,v in entries if state["rule_ref"] in k]
        if states and states[0].get("phase")=="confirmed":break
        if states and states[0].get("phase") in ("rejected","cancelled"):
            raise RuntimeError("wake requires reconciliation: "+states[0]["phase"])
        time.sleep(3)
    else:raise TimeoutError("automatic wake receipt not confirmed")
    state["wait_state"]=states[0]
    baseline = state.get("before_wait_native")
    check(isinstance(baseline,dict) and baseline.get("history_complete") is True,
          "original pre-effect native baseline missing; cannot infer continuation count")
    state["wake_reply"]=verify_reply(client,state,baseline,"process-wake:"+state["rule_ref"],"RESUMED_"+MARKER+" exit=0")
    state["terminal_resource"]=client.call("resource",{"action":"get","resource_ref":state["resource_ref"]})
    check(state["terminal_resource"].get("claim") is None,"claim not released after complete process tree")
    check(state["wake_reply"]["count"]==1,"unexpected multiple native assistant wake replies")
    state["artifact_sha256"]=sha(root/"work/hello")
    with sqlite3.connect("file:"+state["database"]+"?mode=ro",uri=True) as db:
        intents=db.execute("SELECT task_id,state,native_receipt FROM intents WHERE request_key=?",
                           ("process-wake:"+state["rule_ref"],)).fetchall()
    check(len(intents)==1 and intents[0][1]=="confirmed" and intents[0][2],"exact canonical native delivery receipt missing")
    state["wake_intents"]=[{"task_id":x[0],"state":x[1],"native_receipt":json.loads(x[2])} for x in intents]
    state["status"]="PASS";save(root/"checkpoint.json",state)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--action",choices=["prepare","preflight","start-session","reconcile-session","run-process","observe","archive"],required=True)
    parser.add_argument("--manifest",type=Path)
    parser.add_argument("--profile",type=Path)
    parser.add_argument("--native-history-proof",type=Path,
                        help="Private reviewed complete-reader source proof, required when preparing native acceptance")
    parser.add_argument("--native-history-proof-sha256",
                        help="Explicit SHA256 of the reviewed native history proof")
    args=parser.parse_args();root=args.root;client=None
    state=None
    try:
        if args.action=="prepare":
            check(args.manifest and args.profile,"prepare needs explicit manifest/profile")
            state=prepare(args)
        else:
            state=json.loads((root/"checkpoint.json").read_text())
            # Every action starts a runtime that can drive existing admitted
            # work. Even preflight/archive must not bypass reader admission.
            require_history_reader(state)
            client=MCP(root,state)
            if args.action=="preflight":
                state["preflight"]={"tools":[x["name"] for x in client.tools],
                    "instances":client.call("discover",{"action":"instances"})}
                save(root/"checkpoint.json",state)
            elif args.action=="start-session":session_start(client,root,state)
            elif args.action=="reconcile-session":
                # Reconcile the original operation, without a second create or
                # prompt key. Runtime startup can advance existing admitted work.
                completed = observe_task(client,root,state,"create_session",timeout=30)
                check(state.get("session_ref"), "create identity remains unknown")
                state["initial_reply"] = verify_reply(client,state,{"ids":[]},initial_prompt_key(state),"READY_"+MARKER,timeout=30)
                state["status"]="session_ready";save(root/"checkpoint.json",state)
            elif args.action=="run-process":
                client=run_process(client,root,state);observe(client,root,state)
            elif args.action=="observe":observe(client,root,state)
            elif args.action=="archive":
                check(state.get("status")=="PASS","archive only verified completed QA")
                state["archive"]=effect(client,root,state,"archive","session",{"action":"archive","session_ref":state["session_ref"],"request_key":state["run"]+"-archive"})
                save(root/"checkpoint.json",state)
        print(json.dumps({"status":state["status"],"checkpoint":str(root/"checkpoint.json"),
            "session_ref":state.get("session_ref"),"native_session_id":state.get("native_session_id"),
            "rule_ref":state.get("rule_ref"),"source_commit":state["source_commit"]},sort_keys=True))
    except Exception as error:
        if state:
            state["last_error"]={"action":args.action,"type":type(error).__name__,"message":str(error)[:1200],"at":time.time()}
            save(root/"checkpoint.json",state)
        print(json.dumps({"status":"INCOMPLETE","error_type":type(error).__name__,"error":str(error)[:1200]}),file=sys.stderr)
        raise
    finally:
        if client:client.close()


if __name__=="__main__":
    main()
