#!/usr/bin/env python3
"""Read canonical process waits without starting adapters, workers or schedulers."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys


def private(path, directory=False):
    p = Path(path)
    info = p.lstat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if (not p.is_absolute() or p.resolve(strict=True) != p or not expected
            or info.st_uid != os.getuid() or info.st_mode & 0o077
            or (not directory and info.st_nlink != 1)):
        raise ValueError("untrusted canonical path")
    return p, info


def document(path):
    p, _ = private(path)
    return json.loads(p.read_text())


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1048576), b""):
            h.update(part)
    return h.hexdigest()


def result(blocked, reason, sessions=(), rules=()):
    return {"blocked": blocked, "reason": reason, "sessionRefs": sorted(set(sessions)),
            "ruleRefs": sorted(set(rules)),
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}


def query_input(value):
    if (not isinstance(value, dict) or set(value) - {"harness", "nativeSessionId", "nodeRef"}
            or not {"harness", "nativeSessionId"}.issubset(value)):
        raise ValueError("invalid query shape")
    for key, text in value.items():
        if (not isinstance(text, str) or not text.strip() or len(text) > 4096
                or any(ord(c) < 32 for c in text)):
            raise ValueError("invalid query identity")
    return value


@contextlib.contextmanager
def authority(profile):
    db, db_info = private(profile["database"])
    gate, gate_info = private(profile["gate"])
    fd = os.open(gate, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    connection = None
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (gate_info.st_dev, gate_info.st_ino):
            raise ValueError("gate changed")
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=0.1)
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        row = connection.execute(
            "SELECT generation,gate_device,gate_inode,database_device,database_inode "
            "FROM humanstop_authority WHERE singleton=1").fetchone()
        expected = (profile["generation"], gate_info.st_dev, gate_info.st_ino,
                    db_info.st_dev, db_info.st_ino)
        if row != expected:
            raise ValueError("authority generation or pinned inode mismatch")
        yield connection
        if (db.lstat().st_dev, db.lstat().st_ino) != (db_info.st_dev, db_info.st_ino):
            raise ValueError("database changed")
        if (gate.lstat().st_dev, gate.lstat().st_ino) != (gate_info.st_dev, gate_info.st_ino):
            raise ValueError("gate changed")
    finally:
        if connection is not None:
            connection.close()
        os.close(fd)


def remote_completion(config, rule, directory, record, receipt):
    """Validate the original remote proof without contacting either executor."""
    request = record["request"]
    spec = request["request"]
    executor = spec["executor"]
    candidates = [item for item in config.get("remote_executors", [])
                  if item.get("executor_ref") == executor.get("executor_ref")]
    if len(candidates) != 1 or candidates[0] != executor:
        raise ValueError("remote executor installation changed")
    reference = record["execution_ref"]
    controller_node = config["node_ref"]
    executor_node = executor["node_ref"]
    payload = hashlib.sha256(json.dumps(request, ensure_ascii=False,
                                       separators=(",", ":")).encode()).hexdigest()
    if (payload != record["payload_hash"] or executor_node == controller_node
            or spec["principal_ref"] != rule["principal"]
            or spec["session_ref"] != rule["session_ref"]
            or spec["request_key"] != rule["request_key"]
            or record.get("request_key") != rule["request_key"]
            or record.get("process") is not None or record.get("observed_members") != []):
        raise ValueError("remote command binding changed")
    command = {key: spec[key] for key in ("principal_ref", "session_ref", "request_key", "argv", "cwd",
                                        "deadline_unix_ms", "stop_grace_ms")}
    remote_request = {"mode": "start", "request": command}
    command_hash = hashlib.sha256(json.dumps(remote_request, ensure_ascii=False,
                                            separators=(",", ":")).encode()).hexdigest()
    identity_hash = hashlib.sha256()
    for key in ("principal_ref", "session_ref", "request_key"):
        part = spec[key].encode()
        identity_hash.update(len(part).to_bytes(8, "big"))
        identity_hash.update(part)
    if reference != "exec-" + identity_hash.hexdigest():
        raise ValueError("remote execution key changed")
    control = document(directory / "remote-control.json")
    handle = control["handle"]
    observed = control["observation"]
    response = observed["response"]
    original_read = observed["request"]
    remote_observed = response["observation"]
    remote_record = remote_observed["snapshot"]["record"]
    source = remote_observed["source"]
    if (control.get("version") != 1 or control.get("controller_node_ref") != controller_node
            or control.get("execution_ref") != reference or control.get("controller_payload_hash") != payload
            or not isinstance(control.get("start_dispatched"), bool)
            or control["start_dispatched"] != (control.get("start_permit") is not None)
            or not isinstance(handle, dict) or handle.get("version") != 1
            or handle.get("controller_node_ref") != controller_node
            or handle.get("executor_node_ref") != executor_node
            or handle.get("executor_ref") != executor["executor_ref"]
            or handle.get("execution_ref") != reference
            or handle.get("controller_payload_hash") != payload
            or handle.get("command_hash") != command_hash
            or handle.get("worker_sha256") != executor["worker_sha256"]
            or handle.get("endpoint_config_sha256") != executor["endpoint_config_sha256"]
            or handle.get("root_device") != executor["root_device"]
            or handle.get("root_inode") != executor["root_inode"]
            or handle.get("deadline_unix_ms") != spec["deadline_unix_ms"]
            or not isinstance(handle.get("deadline_boot_ms"), int) or handle["deadline_boot_ms"] <= 0
            or not isinstance(handle.get("boot_id"), str) or not handle["boot_id"]
            or not isinstance(handle.get("nonce"), str) or not re.fullmatch(r"[0-9a-f]{64}", handle["nonce"])
            or remote_observed.get("handle") != handle):
        raise ValueError("remote execution handle changed")
    for envelope in (original_read, response):
        if (envelope.get("version") != 1 or envelope.get("controller_node_ref") != controller_node
                or envelope.get("executor_node_ref") != executor_node
                or envelope.get("executor_ref") != executor["executor_ref"]):
            raise ValueError("remote response route changed")
    request_id = original_read.get("request_id")
    if (not isinstance(request_id, str) or not re.fullmatch(r"[0-9a-f]{64}", request_id)
            or response.get("request_id") != request_id
            or remote_record.get("execution_ref") != reference or remote_record.get("node_ref") != executor_node
            or remote_record.get("principal_ref") != rule["principal"]
            or remote_record.get("session_ref") != rule["session_ref"]
            or remote_record.get("request_key") != rule["request_key"]
            or remote_record.get("payload_hash") != command_hash
            or remote_record.get("request") != remote_request
            or source.get("execution_ref") != reference or source.get("executor_node") != executor_node
            or source.get("request_digest") != command_hash):
        raise ValueError("remote response correlation changed")
    operation = original_read["operation"]
    if operation.get("action") == "prepare":
        if operation.get("controller_payload_hash") != payload or operation.get("command") != command:
            raise ValueError("remote prepare correlation changed")
    elif (operation.get("action") not in {"start", "status", "reconcile", "cancel"}
          or operation.get("handle") != handle):
        raise ValueError("remote read handle changed")
    if (not isinstance(receipt, dict) or receipt != remote_record.get("receipt")
            or receipt != document(directory / "receipt.json")
            or receipt.get("execution_ref") != reference or receipt.get("node_ref") != executor_node
            or not isinstance(control.get("terminal_observed_at_unix_ms"), int)
            or control["terminal_observed_at_unix_ms"] <= 0):
        raise ValueError("remote terminal receipt changed")
    return (receipt.get("tree_complete") is True and receipt.get("process_may_be_running") is False
            and record.get("finalization_pending") is False)


def execution(config, rule):
    reference = rule["execution_ref"]
    if not isinstance(reference, str) or not re.fullmatch(r"exec-[0-9a-f]{64}", reference):
        raise ValueError("invalid execution reference")
    root, _ = private(config["execution_root"], directory=True)
    if document(root / "store.json") != {"schema_version": 1, "node_ref": config["node_ref"]}:
        raise ValueError("execution store identity mismatch")
    directory, _ = private(root / reference, directory=True)
    record = document(directory / "record.json")
    if (record.get("schema_version") != 1 or record.get("execution_ref") != reference
            or record.get("node_ref") != config["node_ref"]
            or record.get("principal_ref") != rule["principal"]
            or record.get("session_ref") != rule["session_ref"]):
        raise ValueError("execution binding mismatch")
    receipt = record.get("receipt")
    if record.get("request", {}).get("mode") == "remote_start":
        # A pending remote execution cannot release the wait. Once terminal,
        # require its exact pinned executor proof, never a local node fallback.
        if not isinstance(receipt, dict):
            return False
        return remote_completion(config, rule, directory, record, receipt)
    complete = (isinstance(receipt, dict) and receipt.get("execution_ref") == reference
                and receipt.get("node_ref") == config["node_ref"]
                and receipt.get("tree_complete") is True
                and receipt.get("process_may_be_running") is False
                and record.get("finalization_pending") is False)
    return complete


def canonical_waits(connection, profile, query, session):
    """Read timer/session waits in the same authority; never run their driver."""
    owner = profile["owner"]
    scope = "automation:canonical-wait:" + owner["principal"]
    rows = connection.execute(
        "SELECT setting_key,value_json FROM settings WHERE scope=? AND setting_key LIKE 'rule:%'",
        (scope,)).fetchall()
    blocked = []
    for key, raw in rows:
        rule = json.loads(raw)
        reference = rule.get("rule_ref")
        expected = "wait-rule:" + hashlib.sha256(json.dumps(
            ["canonical-wait-v1", owner["principal"], rule.get("session_ref"), rule.get("request_key")],
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if (rule.get("version") != 1 or rule.get("principal") != owner["principal"]
                or not isinstance(rule.get("request_key"), str) or not rule["request_key"]
                or reference != expected or key != "rule:" + reference
                or rule.get("rule", {}).get("kind") not in {"timer", "session_completion"}):
            raise ValueError("invalid durable canonical wait")
        if rule.get("session_ref") != session:
            continue
        target = rule["target"]
        expected_owner = {"harness": owner.get("kind", "codex"), "native_session_id": query["nativeSessionId"],
                          "node_ref": owner["node"], "instance_ref": owner["instance"]}
        if (target.get("session_ref") != session or target.get("owner") != expected_owner
                or target.get("authority_generation") != profile["generation"]):
            raise ValueError("canonical wait owner changed")
        state_row = connection.execute("SELECT value_json FROM settings WHERE scope=? AND setting_key=?",
            (scope, "state:" + reference)).fetchone()
        if state_row is None:
            blocked.append(reference)
            continue
        state = json.loads(state_row[0])
        phase = state.get("phase")
        if (set(state) != {"phase", "detail", "delivery_task", "wake_cancelled", "cancel_generation",
                           "wake_message", "completed_dependencies", "completed_at"}
                or phase not in {"armed", "paused", "cancelled", "dispatching", "waiting_receipt",
                                 "delivery_unknown", "confirmed", "rejected"}
                or not isinstance(state["wake_cancelled"], bool)
                or type(state["cancel_generation"]) is not int or state["cancel_generation"] < 0
                or not isinstance(state["completed_dependencies"], dict)):
            raise ValueError("invalid canonical wait state")
        wake_key = "wait-wake:" + reference
        task = "mcp-delivery-task:" + hashlib.sha256(json.dumps(
            ["mcp-deliver-v1", owner["principal"], session, wake_key],
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if state["delivery_task"] not in {None, task}:
            raise ValueError("canonical wait delivery task changed")
        if phase not in {"confirmed", "cancelled"}:
            blocked.append(reference)
            continue
        # A phase label cannot hide an admitted/UNKNOWN native handoff.
        intents = connection.execute(
            "SELECT task_id,principal,target,request_key,state FROM intents WHERE task_id=? "
            "OR (principal=? AND target=? AND request_key=?)",
            (task, owner["principal"], session, wake_key)).fetchall()
        if (len(intents) > 1 or (intents and (intents[0][:4] != (task, owner["principal"], session, wake_key)
                or intents[0][4] not in {"prepared", "dispatching", "admitted", "unknown", "confirmed", "rejected"}))):
            raise ValueError("canonical wait intent mismatch")
        intent = intents[0][4] if intents else None
        complete = ((phase == "confirmed" and intent == "confirmed" and state["delivery_task"] == task)
                    or (phase == "cancelled" and state["wake_cancelled"] is True
                        and intent in {None, "confirmed", "rejected"}))
        if not complete:
            blocked.append(reference)
    return blocked


def inspect_profile(profile, query, config):
    owner = profile["owner"]
    with authority(profile) as connection:
        global_held = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL) "
            "OR EXISTS(SELECT 1 FROM holds WHERE session_ref='global' AND released_at IS NULL)").fetchone()[0]
        if global_held:
            return result(True, "human_stop_active")
        rows = connection.execute(
            "SELECT b.session_ref,s.authority_generation,s.scope_generation FROM session_bindings b "
            "LEFT JOIN humanstop_sessions s ON s.session_ref=b.session_ref "
            "WHERE b.node_ref=? AND b.instance_id=? AND b.native_session_id=?",
            (owner["node"], owner["instance"], query["nativeSessionId"])).fetchall()
        if not rows:
            return None
        if len(rows) != 1 or rows[0][1] != profile["generation"] or not rows[0][2]:
            raise ValueError("session authority binding mismatch")
        session = rows[0][0]
        scopes = {row[0] for row in connection.execute(
            "SELECT scope_ref FROM humanstop_scopes WHERE session_ref=?", (session,))}
        if not {"global", "session:" + session}.issubset(scopes):
            raise ValueError("session scope binding missing")
        held = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM humanstop_holds h JOIN humanstop_scopes s "
            "ON s.scope_ref=h.scope_ref WHERE s.session_ref=? AND h.released_at IS NULL) "
            "OR EXISTS(SELECT 1 FROM holds h WHERE h.released_at IS NULL AND "
            "(h.session_ref=? OR h.session_ref IN "
            "(SELECT scope_ref FROM humanstop_scopes WHERE session_ref=?)))",
            (session, session, session)).fetchone()[0]
        if held:
            return result(True, "human_stop_active", [session])
        scope = "automation:process-completion:" + owner["principal"]
        rules = connection.execute(
            "SELECT setting_key,value_json FROM settings WHERE scope=? AND setting_key LIKE 'rule:%'",
            (scope,)).fetchall()
        blocked = []
        for key, raw in rules:
            rule = json.loads(raw)
            if (rule.get("version") != 1 or rule.get("principal") != owner["principal"]
                    or key != "rule:" + rule.get("rule_ref", "")):
                raise ValueError("invalid durable process rule")
            if rule.get("session_ref") != session:
                continue
            state_row = connection.execute(
                "SELECT value_json FROM settings WHERE scope=? AND setting_key=?",
                (scope, "state:" + rule["rule_ref"])).fetchone()
            if state_row is None:
                blocked.append(rule["rule_ref"])
                continue
            state = json.loads(state_row[0])
            phase = state.get("phase")
            if phase not in {"prepared", "armed", "dispatching", "waiting_receipt", "delivery_unknown",
                             "ready", "confirmed", "cancelled", "paused", "rejected"}:
                raise ValueError("unknown wait state")
            # Receipt absence, unresolved descendants, or incomplete finalization
            # keep the session asleep even if wake authorization was cancelled.
            complete = execution(config, rule)
            if not complete or phase not in {"ready", "confirmed", "cancelled"}:
                blocked.append(rule["rule_ref"])
        blocked.extend(canonical_waits(connection, profile, query, session))
        return result(bool(blocked), "process_wait_active" if blocked else "no_process_wait",
                      [session], blocked)


def query(selector, request):
    request = query_input(request)
    selection = document(selector)
    manifest_path = selection["manifest"]
    manifest = document(manifest_path)
    if digest(manifest_path) != selection["manifest_sha256"]:
        raise ValueError("manifest digest mismatch")
    if "process_config" not in manifest:
        return result(False, "process_wait_unconfigured")
    config_path = manifest["process_config"]
    if digest(private(config_path)[0]) != manifest["sha256"]["process_config"]:
        raise ValueError("process config digest mismatch")
    config = document(config_path)
    if (config.get("version") != 1 or not config.get("node_ref")
            or not isinstance(config.get("administrators"), list)):
        raise ValueError("invalid trusted process configuration")
    profiles = selection["profiles"]
    if not isinstance(profiles, list) or not profiles or len(set(profiles)) != len(profiles):
        raise ValueError("invalid selected profile set")
    matches = []
    blocking_unmapped = []
    eligible = 0
    instances = set()
    for path in profiles:
        profile = document(path)
        owner = profile["owner"]
        identity = (owner["node"], owner["instance"], owner.get("kind", "codex"))
        if identity in instances or owner["principal"] not in config["administrators"]:
            raise ValueError("invalid selected owner")
        instances.add(identity)
        if identity[2] != request["harness"] or ("nodeRef" in request and identity[0] != request["nodeRef"]):
            continue
        eligible += 1
        found = inspect_profile(profile, request, config)
        if found is not None:
            if found["sessionRefs"]:
                matches.append(found)
            elif found["blocked"]:
                blocking_unmapped.append(found)
    if eligible == 0:
        return result(True, "harness_authority_not_configured")
    if len(matches) > 1:
        return result(True, "ambiguous_native_session")
    if blocking_unmapped:
        return blocking_unmapped[0]
    return matches[0] if matches else result(False, "native_session_not_registered")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selector", required=True)
    parser.add_argument("--query", required=True)
    args = parser.parse_args()
    try:
        value = query(args.selector, json.loads(args.query))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        # Unknown is a deferral; never leak SQL, commands, profiles or environment.
        value = result(True, "process_wait_unavailable")
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    main()
