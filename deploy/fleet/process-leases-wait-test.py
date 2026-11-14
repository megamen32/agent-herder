#!/usr/bin/env python3
"""Read-only process wait gate checks against private canonical SQLite fixtures."""
import copy
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).with_name("process-leases-wait-status.py")
LAUNCHER = Path(__file__).with_name("launch-v1-core.py")


def write(path, value, mode=0o600):
    path.write_text(json.dumps(value) if not isinstance(value, str) else value)
    path.chmod(mode)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class WaitGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="herder-wait-gate-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reader = self.root / "reader.py"
        self.reader.write_bytes(SOURCE.read_bytes())
        self.reader.chmod(0o500)
        self.launcher = self.root / "agent-herder-v1"
        self.launcher.write_bytes(LAUNCHER.read_bytes())
        self.launcher.chmod(0o500)
        self.executions = self.root / "executions"
        self.executions.mkdir(mode=0o700)
        write(self.executions / "store.json", {"schema_version": 1, "node_ref": "executor"})
        self.config = self.root / "config.json"
        write(self.config, {"version": 1, "node_ref": "executor", "worker": "/fixture/worker",
                           "execution_root": str(self.executions), "administrators": ["alice"]})
        self.profile = self.profile_for("local", "profile")
        self.manifest = self.root / "manifest.json"
        write(self.manifest, {"process_config": str(self.config),
                             "process_wait_reader": str(self.reader),
                             "sha256": {"process_config": sha(self.config), "process_wait_reader": sha(self.reader)}})
        self.selector = self.root / "selector.json"
        self.select([self.profile])
        self.rule_ref = "process-rule:" + "a" * 64
        self.execution_ref = "exec-" + "a" * 64

    def profile_for(self, suffix, instance, node="node"):
        gate = self.root / (suffix + ".gate")
        write(gate, "")
        db = self.root / (suffix + ".db")
        with sqlite3.connect(db) as c:
            c.executescript("""
                CREATE TABLE humanstop_authority(singleton,generation,gate_device,gate_inode,database_device,database_inode);
                CREATE TABLE session_bindings(session_ref,node_ref,instance_id,native_session_id);
                CREATE TABLE humanstop_sessions(session_ref,authority_generation,scope_generation);
                CREATE TABLE humanstop_scopes(session_ref,scope_ref);
                CREATE TABLE humanstop_holds(scope_ref,reason,created_at,released_at);
                CREATE TABLE holds(session_ref,released_at);
                CREATE TABLE settings(scope,setting_key,value_json);
                CREATE TABLE intents(task_id,principal,target,request_key,state);
            """)
            c.execute("INSERT INTO humanstop_authority VALUES(1,?,?,?,?,?)",
                ("generation", gate.stat().st_dev, gate.stat().st_ino, db.stat().st_dev, db.stat().st_ino))
            c.execute("INSERT INTO session_bindings VALUES(?,?,?,?)", ("session", node, instance, "native"))
            c.execute("INSERT INTO humanstop_sessions VALUES(?,?,?)", ("session", "generation", "scope-generation"))
            c.executemany("INSERT INTO humanstop_scopes VALUES(?,?)", [("session", "global"), ("session", "session:session")])
        db.chmod(0o600)
        profile = self.root / (suffix + ".profile.json")
        write(profile, {"database": str(db), "gate": str(gate), "generation": "generation",
                        "owner": {"principal": "alice", "node": node, "instance": instance, "kind": "codex"}})
        return profile

    def select(self, profiles):
        write(self.selector, {"manifest": str(self.manifest), "manifest_sha256": sha(self.manifest),
                              "profiles": list(map(str, profiles))})

    def add_rule(self, phase="armed", complete=False, pending=False, with_state=True, intent="auto"):
        rule = {"version": 1, "rule_ref": self.rule_ref, "principal": "alice",
                "session_ref": "session", "execution_ref": self.execution_ref, "request_key": "fixture-process"}
        if intent == "auto":
            intent = "confirmed" if phase == "confirmed" else None
        wake_key = "process-wake:" + self.rule_ref
        task = "mcp-delivery-task:" + hashlib.sha256(json.dumps(
            ["mcp-deliver-v1", "alice", "session", wake_key], separators=(",", ":")).encode()).hexdigest()
        state = {"phase": phase, "detail": None, "delivery_task": task if intent is not None else None,
                 "wake_cancelled": phase == "cancelled", "cancel_generation": 1 if phase == "cancelled" else 0,
                 "wake_message": None}
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("DELETE FROM settings")
            c.execute("DELETE FROM intents")
            c.execute("INSERT INTO settings VALUES(?,?,?)",
                ("automation:process-completion:alice", "rule:" + self.rule_ref, json.dumps(rule)))
            if with_state:
                c.execute("INSERT INTO settings VALUES(?,?,?)",
                    ("automation:process-completion:alice", "state:" + self.rule_ref, json.dumps(state)))
            if intent is not None:
                c.execute("INSERT INTO intents VALUES(?,?,?,?,?)", (task, "alice", "session", wake_key, intent))
        directory = self.executions / self.execution_ref
        directory.mkdir(mode=0o700, exist_ok=True)
        receipt = {"execution_ref": self.execution_ref, "node_ref": "executor",
                   "tree_complete": True, "process_may_be_running": False} if complete else None
        write(directory / "record.json", {"schema_version": 1, "execution_ref": self.execution_ref,
              "node_ref": "executor", "principal_ref": "alice", "session_ref": "session",
              "request_key": "fixture-process", "receipt": receipt, "finalization_pending": pending})

    def query(self, **changes):
        request = {"harness": "codex", "nativeSessionId": "native", **changes}
        result = subprocess.run([sys.executable, str(self.launcher), "--process-wait-status", json.dumps(request)],
            env={**os.environ, "HERDER_V1_ENTRY": str(self.selector)}, capture_output=True, text=True, timeout=5)
        if result.returncode:
            return {"blocked": True, "reason": "launcher_refused"}
        return json.loads(result.stdout)

    def snapshot(self):
        return {str(p.relative_to(self.root)): sha(p) for p in self.root.rglob("*") if p.is_file()}

    def test_registration_without_state_already_blocks_before_armed_response(self):
        self.add_rule(with_state=False)
        self.assertTrue(self.query()["blocked"])

    def test_wait_states_retain_sleep_until_confirmed_terminal(self):
        for phase in ("prepared", "armed", "dispatching", "waiting_receipt", "delivery_unknown", "paused", "rejected"):
            with self.subTest(phase=phase):
                self.add_rule(phase=phase, complete=True)
                self.assertTrue(self.query()["blocked"])

    def test_complete_ready_confirmed_and_cancelled_clear_gate(self):
        for phase in ("ready", "confirmed", "cancelled"):
            with self.subTest(phase=phase):
                self.add_rule(phase=phase, complete=True)
                self.assertFalse(self.query()["blocked"])
                self.add_rule(phase=phase, complete=True, pending=True)
                self.assertTrue(self.query()["blocked"])
                self.add_rule(phase=phase, complete=False)
                self.assertTrue(self.query()["blocked"])

    def test_process_terminal_phase_requires_original_delivery_intent(self):
        for phase in ("ready", "confirmed", "cancelled"):
            for intent in ("prepared", "dispatching", "admitted", "unknown"):
                with self.subTest(phase=phase, intent=intent):
                    self.add_rule(phase=phase, complete=True, intent=intent)
                    before = self.snapshot()
                    self.assertTrue(self.query()["blocked"])
                    self.assertEqual(self.snapshot(), before)
        self.add_rule(phase="confirmed", complete=True, intent=None)
        self.assertTrue(self.query()["blocked"])
        for intent in (None, "confirmed", "rejected"):
            self.add_rule(phase="cancelled", complete=True, intent=intent)
            self.assertFalse(self.query()["blocked"])
        for changed in ("target", "task_id"):
            self.add_rule(phase="cancelled", complete=True, intent="confirmed")
            with sqlite3.connect(self.root / "local.db") as c:
                c.execute("UPDATE intents SET " + changed + "='foreign'")
            self.assertTrue(self.query()["blocked"])
        for field, value in (("delivery_task", "foreign-task"), ("wake_cancelled", False)):
            self.add_rule(phase="cancelled", complete=True)
            with sqlite3.connect(self.root / "local.db") as c:
                raw = c.execute("SELECT value_json FROM settings WHERE setting_key=?",
                                ("state:" + self.rule_ref,)).fetchone()[0]
                state = json.loads(raw)
                state[field] = value
                c.execute("UPDATE settings SET value_json=? WHERE setting_key=?",
                          (json.dumps(state), "state:" + self.rule_ref))
            self.assertTrue(self.query()["blocked"])

    def test_process_cancelled_unknown_survives_released_human_stop(self):
        self.add_rule(phase="cancelled", complete=True, intent="unknown")
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("INSERT INTO humanstop_holds VALUES('global','human','now',NULL)")
        self.assertEqual(self.query()["reason"], "human_stop_active")
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("UPDATE humanstop_holds SET released_at='later'")
        before = self.snapshot()
        self.assertTrue(self.query()["blocked"])
        self.assertEqual(self.snapshot(), before)

    def test_process_receipt_request_key_cannot_be_substituted(self):
        self.add_rule(phase="ready", complete=True)
        path = self.executions / self.execution_ref / "record.json"
        record = json.loads(path.read_text())
        record["request_key"] = "other-operation"
        write(path, record)
        self.assertTrue(self.query()["blocked"])

    def test_unrelated_native_session_is_unblocked_after_verified_absence(self):
        self.add_rule()
        self.assertFalse(self.query(nativeSessionId="unrelated")["blocked"])
        self.assertTrue(self.query(harness="opencode")["blocked"])
        self.assertEqual(self.query(nodeRef="different-node")["reason"], "harness_authority_not_configured")

    def test_ambiguous_native_id_is_blocked_but_exact_node_profile_is_required(self):
        other = self.profile_for("remote", "different-profile", node="remote-node")
        self.select([self.profile, other])
        self.add_rule()
        self.assertEqual(self.query()["reason"], "ambiguous_native_session")
        self.assertFalse(self.query(nodeRef="remote-node")["blocked"])
        self.assertTrue(self.query(nodeRef="node")["blocked"])

    def test_human_stop_survives_completed_process(self):
        self.add_rule(phase="confirmed", complete=True)
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("INSERT INTO humanstop_holds VALUES('global','human','now',NULL)")
        self.assertEqual(self.query()["reason"], "human_stop_active")
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("UPDATE humanstop_holds SET released_at='later'")
        self.assertFalse(self.query()["blocked"])

    def test_global_stop_blocks_unregistered_native_identity(self):
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("INSERT INTO humanstop_holds VALUES('global','human','now',NULL)")
        self.assertEqual(self.query(nativeSessionId="unregistered")["reason"], "human_stop_active")
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("UPDATE humanstop_holds SET released_at='later'")
        self.assertFalse(self.query(nativeSessionId="unregistered")["blocked"])

    def test_global_hold_from_unmapped_profile_cannot_be_masked_by_a_mapped_profile(self):
        other = self.profile_for("remote", "different-profile", node="remote-node")
        self.select([self.profile, other])
        with sqlite3.connect(self.root / "remote.db") as c:
            c.execute("UPDATE session_bindings SET native_session_id='another-native'")
            c.execute("INSERT INTO humanstop_holds VALUES('global','human','now',NULL)")
        self.assertEqual(self.query()["reason"], "human_stop_active")
        self.assertFalse(self.query(nodeRef="node")["blocked"])

    def test_unknown_execution_and_corrupt_store_defer(self):
        self.add_rule(phase="confirmed", complete=True)
        write(self.executions / "store.json", {"schema_version": 1, "node_ref": "other"})
        self.assertTrue(self.query()["blocked"])

    def test_read_does_not_modify_canonical_state_or_create_a_registry(self):
        self.add_rule()
        before = self.snapshot()
        self.assertTrue(self.query()["blocked"])
        self.assertEqual(self.snapshot(), before)

    def test_gate_contention_and_generation_mismatch_defer(self):
        with (self.root / "local.gate").open() as gate:
            fcntl.flock(gate.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(self.query()["blocked"])
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("UPDATE humanstop_authority SET generation='changed'")
        self.assertTrue(self.query()["blocked"])

    def test_reader_or_config_tampering_is_blocked(self):
        self.reader.chmod(0o700)
        self.reader.write_bytes(self.reader.read_bytes() + b"\n# changed\n")
        self.assertEqual(self.query()["reason"], "launcher_refused")

    def test_legacy_manifest_is_supported_without_starting_runtime(self):
        write(self.manifest, {})
        self.select([self.profile])
        self.assertEqual(self.query(), {"blocked": False, "reason": "process_wait_unconfigured",
                                       "ruleRefs": [], "sessionRefs": []})

    def add_canonical_wait(self, phase="armed", kind="timer", intent=None, with_state=True):
        reference = "wait-rule:" + hashlib.sha256(json.dumps(
            ["canonical-wait-v1", "alice", "session", "fixture-wait"], separators=(",", ":")).encode()).hexdigest()
        wake_key = "wait-wake:" + reference
        task = "mcp-delivery-task:" + hashlib.sha256(json.dumps(
            ["mcp-deliver-v1", "alice", "session", wake_key], separators=(",", ":")).encode()).hexdigest()
        rule = {"version": 1, "rule_ref": reference, "principal": "alice", "session_ref": "session",
                "request_key": "fixture-wait", "rule": {"kind": kind}, "target": {
                    "session_ref": "session", "authority_generation": "generation", "owner": {
                        "harness": "codex", "native_session_id": "native", "node_ref": "node", "instance_ref": "profile"}}}
        state = {"phase": phase, "detail": None, "delivery_task": task if intent is not None else None,
                 "wake_cancelled": phase == "cancelled", "cancel_generation": 1 if phase == "cancelled" else 0,
                 "wake_message": None, "completed_dependencies": {}, "completed_at": None}
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("DELETE FROM settings")
            c.execute("DELETE FROM intents")
            c.execute("INSERT INTO settings VALUES(?,?,?)", ("automation:canonical-wait:alice", "rule:" + reference, json.dumps(rule)))
            if with_state:
                c.execute("INSERT INTO settings VALUES(?,?,?)", ("automation:canonical-wait:alice", "state:" + reference, json.dumps(state)))
            if intent is not None:
                c.execute("INSERT INTO intents VALUES(?,?,?,?,?)", (task, "alice", "session", wake_key, intent))
        return reference

    def test_timer_and_session_wait_registration_suppress_legacy_local_judges(self):
        for kind in ("timer", "session_completion"):
            for phase in ("armed", "paused", "dispatching", "waiting_receipt", "delivery_unknown", "rejected"):
                with self.subTest(kind=kind, phase=phase):
                    ref = self.add_canonical_wait(kind=kind, phase=phase)
                    self.assertEqual(self.query()["ruleRefs"], [ref])
                    self.assertFalse(self.query(nativeSessionId="unrelated")["blocked"])
            self.add_canonical_wait(kind=kind, with_state=False)
            self.assertTrue(self.query()["blocked"])

    def test_canonical_terminal_phase_requires_exact_intent_and_preserves_unknown(self):
        self.add_canonical_wait(phase="confirmed")
        self.assertTrue(self.query()["blocked"])
        self.add_canonical_wait(phase="confirmed", intent="confirmed")
        before = self.snapshot()
        self.assertFalse(self.query()["blocked"])
        self.assertEqual(self.snapshot(), before)
        self.add_canonical_wait(phase="cancelled")
        self.assertFalse(self.query()["blocked"])
        for intent in ("prepared", "dispatching", "admitted", "unknown"):
            self.add_canonical_wait(phase="cancelled", intent=intent)
            self.assertTrue(self.query()["blocked"])
        self.add_canonical_wait(phase="confirmed", intent="confirmed")
        with sqlite3.connect(self.root / "local.db") as c:
            c.execute("UPDATE intents SET target='foreign-session'")
        self.assertTrue(self.query()["blocked"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
