#!/usr/bin/env python3
"""Real stdio MCP completion-wake acceptance against two isolated fake AHAP owners.

No network or model provider is configured. The child process and all fixture
state live in a private temporary directory; only native fake AHAP methods run.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import shutil
import sqlite3
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "crates/herder/target/debug/herder_native_stdio"
AHAP_EXECUTABLE = Path("/usr/bin/python3").resolve()
PRINCIPAL = "automation-wire-owner"
NODE = "wire-node"
GENERATION = "automation-wire-generation"
META = {"io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},
        "io.modelcontextprotocol/clientInfo":{"name":"automation-wire-fixture","version":"1"}}


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def bootstrap(root: Path) -> tuple[Path, Path, list[Path]]:
    """Build an exact fresh v3 authority store, same as scoped Rust fixtures."""
    db_path, gate_path = root / "state.db", root / "gate"
    con = sqlite3.connect(db_path)
    version = [1]
    con.create_function("herder_writer_version", 0, lambda: version[0], deterministic=True)
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript((ROOT / "crates/herder/src/store/schema.sql").read_text())
    for n, migration in ((2, "migration_v1_v2.sql"), (3, "migration_v2_v3.sql")):
        con.executescript((ROOT / "crates/herder/src/store" / migration).read_text())
        version[0] = n
    con.close()
    os.chmod(db_path, 0o600)
    fd = os.open(gate_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    os.close(fd)
    db_stat, gate_stat = db_path.stat(), gate_path.stat()
    con = sqlite3.connect(db_path)
    con.create_function("herder_writer_version", 0, lambda: 3, deterministic=True)
    con.execute("PRAGMA foreign_keys=ON")
    con.execute(
        "INSERT INTO humanstop_authority(singleton,generation,gate_device,gate_inode,database_device,database_inode,created_at) VALUES(1,?,?,?,?,?,?)",
        (GENERATION, gate_stat.st_dev, gate_stat.st_ino, db_stat.st_dev, db_stat.st_ino, "fixture-bootstrap"),
    )
    con.commit()
    con.close()

    profiles: list[Path] = []
    check(AHAP_EXECUTABLE.is_file() and AHAP_EXECUTABLE.stat().st_mode & 0o022 == 0,
          f"canonical fixture interpreter is not trusted: {AHAP_EXECUTABLE}")
    py = str(AHAP_EXECUTABLE)
    for index in (1, 2):
        instance_dir = root / f"fake-{index}"
        instance_dir.mkdir(mode=0o700)
        runner = instance_dir / "ahap.py"
        runner.write_text(FAKE_AHAP)
        runner.chmod(0o600)
        profile = root / f"owner-{index}.json"
        profile.write_text(json.dumps({
            "database": str(db_path), "gate": str(gate_path), "generation": GENERATION,
            "owner": {
                "principal": PRINCIPAL, "node": NODE, "instance": f"instance-{index}",
                "executable": py, "code_home": str(instance_dir), "cwd": str(instance_dir),
                "kind": "opencode", "ahap_script": str(runner),
                "ahap_base_url": "http://127.0.0.1:9", "ahap_env": {},
            },
        }))
        profile.chmod(0o600)
        profiles.append(profile)
    return db_path, gate_path, profiles


FAKE_AHAP = r'''import json, pathlib, sys
here = pathlib.Path(__file__).parent
state_path = here / "native-state.json"
if state_path.exists(): state = json.loads(state_path.read_text())
else: state = {"next": 1, "sessions": {}, "wake_calls": [], "messages": {}}
def save(): state_path.write_text(json.dumps(state))
for line in sys.stdin:
    req = json.loads(line); method = req.get("method"); p = req.get("params", {})
    if state_path.exists(): state = json.loads(state_path.read_text())
    if method == "initialize":
        result = {"harness":"opencode","capabilities":{"methods":["init","createSession","sendMessage","getSession","getSessionMessages"],"deliveryModes":["start"]}}
    elif method == "init": result = None
    elif method == "createSession":
        n = state["next"]; state["next"] += 1; sid = f"instance-1-session-{n}" if "fake-1" in str(here) else f"instance-2-session-{n}"
        state["sessions"][sid] = {"id":sid,"harness":"opencode","status":"idle","meta":{}}
        save(); result = {"id":sid,"harness":"opencode"}
    elif method == "getSession":
        sid = p.get("id"); result = state["sessions"].get(sid)
        if result is None: result = {"id":sid,"harness":"opencode","status":"idle","meta":{}}
    elif method == "sendMessage":
        sid = p.get("id"); opts = p.get("options", {}); msg = opts.get("message", "")
        native_id = f"fake-input-{state['next']}-{sid}"; state["next"] += 1
        state["messages"].setdefault(sid, []).append({"id":native_id,"role":"user","text":msg,"inputId":opts.get("inputId")})
        if msg.startswith("WAKE-WIRE-"):
            state["wake_calls"].append({"session":sid,"message":msg,"inputId":opts.get("inputId")}); save()
        else: save()
        result = {"ok":True,"admitted":True,"nativeInputMessageId":native_id,"inputId":opts.get("inputId"),"sessionId":sid,"harness":"opencode"}
    elif method == "getSessionMessages": result = state["messages"].get(p.get("id"), [])
    else: raise RuntimeError("unsupported fake AHAP method: " + str(method))
    print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":result}), flush=True)
'''


class Mcp:
    def __init__(self, profiles: list[Path]):
        args = [str(BIN)]
        for profile in profiles:
            args += ["--trusted-owner-profile", str(profile)]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.next_id = 1
        self.initialize()

    def rpc(self, method: str, params: dict | None = None) -> dict:
        ident = self.next_id; self.next_id += 1
        packet = {"jsonrpc":"2.0","id":ident,"method":method}
        if params is not None: packet["params"] = params
        self.proc.stdin.write(json.dumps(packet) + "\n"); self.proc.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read()
                raise AssertionError(f"MCP server exited during {method}: {err}")
            value = json.loads(line)
            if value.get("id") == ident:
                check("error" not in value, f"{method} JSON-RPC error: {value}")
                return value["result"]
        raise AssertionError(f"timed out waiting for MCP {method}")

    def initialize(self) -> None:
        discovery = self.rpc("server/discover", {"_meta":META})
        check("result" in discovery or "serverInfo" in discovery or isinstance(discovery, dict), f"public discover failed: {discovery}")
        self.tools = {tool["name"] for tool in self.rpc("tools/list", {"_meta":META}).get("tools", [])}
        check({"automation","create","stop"}.issubset(self.tools), f"public MCP tools missing: {self.tools}")

    def call(self, name: str, arguments: dict) -> dict:
        result = self.rpc("tools/call", {"_meta":META,"name":name,"arguments":arguments})
        check(not result.get("isError"), f"{name} returned MCP error: {result}")
        structured = result.get("structuredContent")
        return structured if isinstance(structured, dict) else result

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait(timeout=5)


def create_root(mcp: Mcp, db: Path, root: Path, profile_index: int, instance: str, key: str) -> str:
    created = mcp.call("create", {"action":"create","instance_ref":instance,
        "prompt":"WIRE-FIXTURE-NO-MODEL","request_key":key})
    check(created.get("resultType") == "task" and isinstance(created.get("taskId"), str),
          f"public create did not return its durable task handle: {created}")
    state_file = root / f"fake-{profile_index}" / "native-state.json"
    sessions = json.loads(state_file.read_text())["sessions"]
    native_id = max(sessions, key=lambda value: int(value.rsplit("-", 1)[1]))
    con = sqlite3.connect(db)
    row = con.execute("SELECT session_ref FROM session_bindings WHERE native_session_id=?", (native_id,)).fetchone()
    con.close()
    check(row is not None and row[0], f"public create task produced no bound session for {native_id}")
    return row[0]


def find_key(value, keys: set[str]):
    if isinstance(value, dict):
        for key in keys:
            if key in value and isinstance(value[key], str): return value[key]
        for child in value.values():
            found = find_key(child, keys)
            if found: return found
    elif isinstance(value, list):
        for child in value:
            found = find_key(child, keys)
            if found: return found
    elif isinstance(value, str):
        try: return find_key(json.loads(value), keys)
        except (ValueError, TypeError): pass
    return None


def main() -> None:
    check(BIN.is_file() and os.access(BIN, os.X_OK), f"required already-built binary missing: {BIN}")
    home = Path.home() / ".codex"
    root = Path(tempfile.mkdtemp(prefix="herder-automation-wire-", dir=home))
    root.chmod(0o700)
    server = None
    try:
        db, gate, profiles = bootstrap(root)
        server = Mcp(profiles)
        # Use both profile routes in the same public MCP process, while keeping
        # the wake's parent and child on one instance (the currently supported
        # core contract).
        parent = create_root(server, db, root, 1, "instance-1", "root-parent")
        child = create_root(server, db, root, 1, "instance-1", "root-child")
        other_owner = create_root(server, db, root, 2, "instance-2", "root-other-owner")
        check(other_owner, "second profile create did not resolve")

        # Feed the exact native projection emitted by CodexAppServerAdapter:
        # no synthetic nativeStateObserved=true is added on successful reads.
        child_state = root / "fake-1" / "native-state.json"
        state = json.loads(child_state.read_text())
        child_native_id = max(json.loads(child_state.read_text())["sessions"], key=lambda value: int(value.rsplit("-", 1)[1]))
        state["sessions"][child_native_id]["meta"]["nativeLastTurn"] = {"turnId":"wire-turn-1","status":"completed"}
        child_state.write_text(json.dumps(state))

        created = server.call("automation", {"action":"create","session_ref":parent,
            "rule":{"kind":"child_completion","child_ref":child,"wake_message":"WAKE-WIRE-RESUME"},
            "request_key":"automation-rule-key"})
        rule_ref = created.get("rule_ref")
        check(isinstance(rule_ref, str) and rule_ref.startswith("completion-rule:"), f"automation create failed: {created}")
        changed_rule = server.rpc("tools/call", {"_meta":META,"name":"automation","arguments":{
            "action":"create","session_ref":parent,
            "rule":{"kind":"child_completion","child_ref":child,"wake_message":"WAKE-WIRE-CHANGED"},
            "request_key":"automation-rule-key"}})
        check(changed_rule.get("isError") is True
              and changed_rule.get("structuredContent", {}).get("code") == "idempotency_conflict",
              f"same owner request key with changed rule payload must conflict: {changed_rule}")
        reconciled = server.call("automation", {"action":"reconcile","rule_ref":rule_ref,
            "child_ref":child,"event_id":"wire-turn-1"})
        receipt = find_key(reconciled, {"_herder_delivery_task"})
        check(receipt, f"reconcile did not return durable delivery task receipt: {reconciled}")
        check(len(json.loads(child_state.read_text())["wake_calls"]) == 1, "expected exactly one parent wake native send")
        con = sqlite3.connect(db)
        stored_receipt = con.execute("SELECT i.state,i.native_receipt,t.status FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE t.task_id=?", (receipt,)).fetchone()
        con.close()
        check(stored_receipt is not None and stored_receipt[0] in ("admitted", "confirmed") and stored_receipt[1],
              f"public wake returned a task without its durable native receipt: {stored_receipt}")

        server.close(); server = None
        server = Mcp(profiles)
        replay = server.call("automation", {"action":"reconcile","rule_ref":rule_ref,
            "child_ref":child,"event_id":"wire-turn-1"})
        replay_receipt = replay.get("delivery", {}).get("taskId")
        check(replay_receipt == receipt, f"restart replay did not read the original task receipt: {replay}")
        check(replay.get("delivery", {}).get("taskId") == receipt, f"restart readback did not return original durable task receipt: {replay}")
        check(len(json.loads(child_state.read_text())["wake_calls"]) == 1, "restart duplicate caused an additional native send")

        stop = server.call("stop", {"action":"stop","session_ref":parent,"request_key":"humanstop-parent"})
        check(not stop.get("code") == "unauthorized", f"HumanStop request rejected unexpectedly: {stop}")
        state = json.loads(child_state.read_text())
        state["sessions"][child_native_id]["meta"]["nativeLastTurn"] = {"turnId":"wire-turn-2","status":"completed"}
        child_state.write_text(json.dumps(state))
        held = server.rpc("tools/call", {"_meta":META,"name":"automation","arguments":{"action":"reconcile",
            "rule_ref":rule_ref,"child_ref":child,"event_id":"wire-turn-2"}})
        held_data = held.get("structuredContent", {})
        check(held_data.get("delivery", {}).get("isError") is True
              and held_data.get("delivery", {}).get("structuredContent", {}).get("code") == "delivery_blocked",
              f"HumanStop should refuse subsequent wake: {held}")
        check(len(json.loads(child_state.read_text())["wake_calls"]) == 1, "HumanStop negative attempted another native send")

        print(json.dumps({"status":"PASS","transport":"public MCP stdio","profiles":2,
            "parent_session_ref":parent,"child_session_ref":child,"other_owner_session_ref":other_owner,
            "rule_ref":rule_ref,"delivery_task_ref":receipt,"wake_native_sends":1,
            "restart_duplicate_added_sends":0,"humanstop_added_sends":0,
            "durable_native_intent_state":stored_receipt[0]}, sort_keys=True))
    finally:
        if server is not None: server.close()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__": main()
