#!/usr/bin/env python3
"""Durable rollout contracts using isolated fixtures and fake native ownership."""
import argparse
import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).parent


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(HERE / filename))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


rollout = load("process_leases_rollout", "process-leases-rollout.py")
fixture_module = load("process_leases_fixture", "process-leases-test.py")
candidate = rollout.candidate


def tools_schema(process=True):
    values = ["create"]
    if process:
        values += ["process_completion", "reconcile_process", "cancel_execution"]
    return [
        {"name": "automation", "inputSchema": {"oneOf": [{"const": value} for value in values]}},
        {"name": "resource", "inputSchema": {"properties": {"action": {"enum": ["claim", "bind"] if process else ["claim"]}}}},
    ]


class CoordinatorContracts(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.RolloutContracts()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.events = []
        self.proof = self.root / "proof.json"
        self.ledger = self.root / "lease-ledger.json"
        candidate.create(self.proof, candidate.encoded({"project": str(self.root), "owner": "test-owner",
                                                       "fence": 8, "token": "fixture-private-token"}))
        candidate.create(self.ledger, candidate.encoded({"version": 1}))
        self.args = argparse.Namespace(**vars(self.fixture.install_args),
            job_dir=self.root / "job", proof=self.proof, release_state=self.ledger,
            target=None, compat_pid=101, core_pid=102, deadline_seconds=1)
        owner = self

        class FakeGate:
            def __init__(self, proof_path, state_path=None, target=None):
                self.proof = candidate.read_json(proof_path)
                self.state_path = state_path
                self.target = target
                self.fd, self._bridge = None, None
            def __enter__(self):
                self.fd = 123
                owner.events.append("guard-enter")
                return self
            def check(self, cleanup=False):
                if self.fd is None:
                    raise RuntimeError("fixture guard is not held")
                owner.events.append("check")
            def __exit__(self, kind, value, traceback):
                owner.events.append("finished" if kind is None else "unknown")
                self.fd = None

        self.FakeGate = FakeGate
        self.addCleanup(patch.stopall)
        patch.object(rollout, "ReleaseGate", FakeGate).start()
        patch.object(rollout, "component_guard", return_value=[{"component": "core", "source": "fixture"}]).start()
        patch.object(rollout, "runtime_pair", side_effect=self.runtime_pair).start()
        self.real_identity_state = rollout.identity_state

        def live_state(expected):
            if expected["pid"] in (101, 102):
                return "dead"
            return self.real_identity_state(expected)
        patch.object(rollout, "identity_state", side_effect=live_state).start()

    def runtime_pair(self, selector, launcher, compat_pid, core_pid, expected_cwd=None):
        self.events.append("runtime-" + str(core_pid))
        return {key: {"pid": pid, "boot_id": "fixture-boot", "start_ticks": pid * 100,
                      "cwd": str(self.root), "exe": key, "exe_sha256": key + "-digest"}
                for key, pid in (("compat", compat_pid), ("core", core_pid))}

    def receipt(self, state, kind="consumer", process=True):
        base = {"schema": 1, "kind": kind, "job_id": state["job_id"], "challenge": state["challenge"],
                "observed_at_unix_ms": rollout.now_ms(), "provider_operation_id": "gptadmin-task-fixture-" + kind,
                "target": rollout.CONTROLLER, "ref": rollout.CHILD}
        if kind == "restart":
            return {**base, "method": "mcp_manage", "action": "restart", "compat_pid": 201, "core_pid": 202}
        tools = tools_schema(process)
        return {**base, "method": "mcp_tools", "tools": tools, "schema_sha256": rollout.json_hash(tools)}

    def publish_receipts(self, process=True, restart_update=None):
        state = rollout.read_state(self.args.job_dir)
        if state["phase"] != "awaiting_restart":
            return
        restart = self.receipt(state, "restart")
        if restart_update:
            restart.update(restart_update)
        consumer = self.receipt(state, process=process)
        candidate.create(self.args.job_dir / "restart-ack.json", candidate.encoded(restart))
        candidate.create(self.args.job_dir / "consumer-receipt.json", candidate.encoded(consumer))

    def test_guard_covers_install_restart_and_fresh_consumer(self):
        def operator(_):
            self.publish_receipts()
        with patch.object(rollout.time, "sleep", side_effect=operator):
            result = rollout.run(self.args)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["occupancy"], "resolved")
        self.assertLess(self.events.index("guard-enter"), self.events.index("runtime-202"))
        self.assertGreater(self.events.index("finished"), self.events.index("runtime-202"))
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["consumer_evidence"]["method"], "mcp_tools")
        self.assertTrue(state["consumer_evidence"]["schema_sha256"])
        self.assertNotIn("token", json.dumps(state))
        self.assertEqual(self.fixture.database.read_bytes(), self.fixture.before_db)
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.new_selector.read_bytes())

    def test_old_schema_names_do_not_prove_new_core_ready(self):
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts(process=False)):
            with self.assertRaisesRegex(ValueError, "lacks process_completion"):
                rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["phase"], "unknown")
        self.assertEqual(rollout.read_occupancy(self.fixture.selector)["phase"], "active")
        self.assertIn("unknown", self.events)
        self.assertNotIn("finished", self.events)

    def test_same_process_ack_is_not_restart_evidence(self):
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts(
                restart_update={"compat_pid": 101, "core_pid": 102})):
            with self.assertRaisesRegex(RuntimeError, "restart is unproved"):
                rollout.run(self.args)
        self.assertEqual(rollout.read_state(self.args.job_dir)["phase"], "unknown")

    def test_deadline_or_missing_ack_never_rolls_back_or_restarts(self):
        self.args.deadline_seconds = 0.01
        with self.assertRaises(TimeoutError):
            rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["phase"], "unknown")
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.new_selector.read_bytes())
        self.assertFalse((self.args.job_dir / "restart-ack.json").exists())
        # New proof ownership or a vanished OS lock cannot bypass active occupancy.
        self.args.job_dir = self.root / "new-job"
        before = list(self.events)
        with self.assertRaisesRegex(RuntimeError, "unresolved rollout"):
            rollout.run(self.args)
        self.assertEqual(self.events, before)

    def test_half_switch_preserves_checkpoint_and_exact_backup(self):
        original = candidate.replace

        def fail_selector(path, *args, **kwargs):
            if Path(path) == self.fixture.selector:
                raise OSError("fixture interruption before selector replacement")
            return original(path, *args, **kwargs)
        with patch.object(candidate, "replace", side_effect=fail_selector):
            with self.assertRaisesRegex(OSError, "fixture interruption"):
                rollout.run(self.args)
        self.assertEqual(rollout.read_state(self.args.job_dir)["phase"], "unknown")
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
        self.assertEqual(self.fixture.launcher.read_bytes(), self.fixture.new_launcher.read_bytes())
        self.assertEqual((self.root / "backup/selector.before.json").read_bytes(), self.fixture.before_selector)
        self.assertNotIn("finished", self.events)

    def test_sigkill_leaves_durable_occupancy_after_process_lock_dies(self):
        pid = os.fork()
        if pid == 0:
            try:
                self.args.deadline_seconds = 60
                rollout.run(self.args)
            finally:
                os._exit(77)
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                path = self.args.job_dir / "state.json"
                if path.exists() and rollout.read_state(self.args.job_dir)["phase"] == "awaiting_restart":
                    break
                time.sleep(0.02)
            else:
                self.fail("isolated coordinator did not reach admitted wait")
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            pid = None
            observed = rollout.status(self.args)
            self.assertEqual(observed["coordinator_state"], "dead")
            self.assertTrue(observed["requires_reconciliation"])
            self.args.job_dir = self.root / "another-job"
            with self.assertRaisesRegex(RuntimeError, "unresolved rollout"):
                rollout.run(self.args)
        finally:
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)

    def prepare_recovery(self, canonical=False):
        self.args.deadline_seconds = 0.01
        with self.assertRaises(TimeoutError):
            rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        # Reconciliation fixture represents a different, now absent boot.
        state["coordinator"]["boot_id"] = "old-coordinator-boot"
        path = self.args.job_dir / "state.json"
        candidate.replace(path, candidate.encoded(state), candidate.digest(path), 0o600)
        if canonical:
            candidate.replace(self.ledger, candidate.encoded({"version": 2, "canonical": {"version": 1}}),
                              candidate.digest(self.ledger), 0o600)
        receipt = self.receipt(state)
        path = self.root / "recovery-consumer.json"
        candidate.create(path, candidate.encoded(receipt))
        return argparse.Namespace(job_dir=self.args.job_dir, proof=self.proof, outcome="candidate",
                                  compat_pid=201, core_pid=202, consumer_receipt=path)

    def test_legacy_recovery_observes_settled_state_without_new_effect(self):
        args = self.prepare_recovery()
        original_selector = self.fixture.selector.read_bytes()
        result = rollout.recover(args)
        self.assertEqual(result["status"], "recovered_candidate")
        self.assertEqual(result["occupancy"], "resolved")
        self.assertEqual(self.fixture.selector.read_bytes(), original_selector)
        self.assertEqual(self.events.count("guard-enter"), 2)

    def test_finished_checkpoint_can_settle_pointer_after_a_final_write_crash(self):
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts()):
            with patch.object(rollout, "resolve_occupancy", side_effect=OSError("fixture final pointer write lost")):
                with self.assertRaisesRegex(OSError, "final pointer"):
                    rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["phase"], "completed")
        self.assertEqual(rollout.read_occupancy(self.fixture.selector)["phase"], "active")
        state["coordinator"]["boot_id"] = "previous-boot"
        path = self.args.job_dir / "state.json"
        candidate.replace(path, candidate.encoded(state), candidate.digest(path), 0o600)
        candidate.replace(self.ledger, candidate.encoded({"version": 2, "canonical": {"version": 1}}),
                          candidate.digest(self.ledger), 0o600)
        receipt = self.root / "fresh-final-consumer.json"
        candidate.create(receipt, candidate.encoded(self.receipt(state)))
        before = list(self.events)
        result = rollout.recover(argparse.Namespace(job_dir=self.args.job_dir, outcome="candidate",
            proof=self.proof, compat_pid=201, core_pid=202, consumer_receipt=receipt))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["occupancy"], "resolved")
        self.assertNotIn("guard-enter", self.events[len(before):])

    def test_canonical_unknown_never_fabricates_a_new_guard_or_finished(self):
        args = self.prepare_recovery(canonical=True)
        before = list(self.events)
        result = rollout.recover(args)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["occupancy"], "active")
        self.assertIn("canonical_guard_binding", result["recovery_blocked"])
        self.assertNotIn("guard-enter", self.events[len(before):])
        self.assertNotIn("finished", self.events)

    def test_consumer_receipt_is_exact_and_cannot_be_a_ready_boolean(self):
        args = self.prepare_recovery()
        state = rollout.read_state(self.args.job_dir)
        good = self.receipt(state)
        for change in ({"ref": "some-other-herder"}, {"target": "shell:other"},
                       {"provider_operation_id": ""}, {"schema_sha256": "bad"},
                       {"observed_at_unix_ms": 0}, {"tools": [], "ready": True}):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    rollout.validate_consumer(state, {**good, **change}, state["created_at_unix_ms"])
        args = argparse.Namespace(job_dir=self.args.job_dir, kind="consumer", receipt=args.consumer_receipt)
        result = rollout.record_receipt(args)
        self.assertEqual(result["status"], "receipt_recorded")
        self.assertEqual(rollout.record_receipt(args), result)

    def test_live_coordinator_cannot_be_recovered(self):
        self.args.deadline_seconds = 0.01
        with self.assertRaises(TimeoutError):
            rollout.run(self.args)
        args = argparse.Namespace(job_dir=self.args.job_dir, proof=self.proof, outcome="candidate",
                                  compat_pid=201, core_pid=202, consumer_receipt=self.root / "never-read.json")
        with self.assertRaisesRegex(RuntimeError, "no longer live"):
            rollout.recover(args)


class ComponentAncestry(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.RolloutContracts()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.repo = self.root / "source"
        self.origin = self.root / "origin.git"
        self.git(["init", "--bare", "-q", str(self.origin)], cwd=self.root)
        self.git(["init", "-q", str(self.repo)], cwd=self.root)
        self.git(["config", "user.email", "test@example.invalid"])
        self.git(["config", "user.name", "Rollout fixture"])
        self.git(["remote", "add", "origin", str(self.origin)])
        first = self.commit("first")
        self.core = self.commit("core")
        self.new = self.commit("candidate")
        self.git(["push", "-q", "origin", "HEAD:main"])
        self.git(["checkout", "-q", "-b", "adapter", first])
        self.adapter = self.commit("retained adapter")
        self.git(["checkout", "-q", "--detach", self.new])
        self.before, self.after = copy.deepcopy(self.fixture.base), copy.deepcopy(self.fixture.manifest)
        self.before.update(source_commit=self.adapter)
        self.before["component_provenance"].update(core_source_commit=self.core)
        self.after["process_leases_build"]["source_commit"] = self.new
        self.after["component_provenance"].update(core_source_commit=self.new,
            process_worker_source_commit=self.new, process_config_source_commit=self.new)
        # Preserve each prior component identity; top-level adapter commit need
        # not be the ancestor of a core replacement which retains that adapter.
        for key in ("browser_source_commit", "opencode_source_commit"):
            self.before["component_provenance"][key] = self.adapter
            self.after["component_provenance"][key] = self.adapter

    def git(self, argv, cwd=None):
        return subprocess.run(["git", *argv], cwd=cwd or self.repo, text=True, capture_output=True,
                              check=True, timeout=10).stdout.strip()

    def commit(self, content):
        (self.repo / "source.txt").write_text(content)
        self.git(["add", "source.txt"])
        self.git(["commit", "-q", "-m", content])
        return self.git(["rev-parse", "HEAD"])

    def test_composite_core_ancestry_preserves_unrelated_pinned_adapter(self):
        checked = rollout.component_guard(self.repo / ".git", self.before, self.after)
        self.assertEqual(checked[0]["previous_source"], self.core)
        self.assertNotEqual(self.adapter, self.core)

    def test_new_unmerged_core_is_refused(self):
        unmerged = self.commit("unmerged")
        self.after["process_leases_build"]["source_commit"] = unmerged
        for name in ("core_source_commit", "process_worker_source_commit"):
            self.after["component_provenance"][name] = unmerged
        with self.assertRaisesRegex(rollout.main_guard.MainGuardError, "candidate_not_in_main"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def test_installed_core_commit_cannot_be_discarded(self):
        self.before["component_provenance"]["core_source_commit"] = self.adapter
        with self.assertRaisesRegex(rollout.main_guard.MainGuardError, "discard_live_commits"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def test_retained_component_and_authority_changes_need_separate_review(self):
        self.after["adapters"]["codex"] += "-different"
        with self.assertRaisesRegex(ValueError, "unreviewed.*replacement"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def test_missing_composite_core_provenance_is_not_replaced_by_top_sha(self):
        del self.before["component_provenance"]["core_source_commit"]
        with self.assertRaisesRegex(ValueError, "provenance is unknown"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def adapter_transition(self, previous_zcode):
        module = load("migration_ancestry_fixtures", "process-leases-adapters-test.py")
        fixture = module.AdapterMigrationContracts()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.base["component_provenance"].update(core_source_commit=self.core,
            opencode_source_commit=self.core, zcode_source_commit=previous_zcode)
        fixture.base_manifest.write_bytes(candidate.encoded(fixture.base))
        fixture.selection["manifest_sha256"] = candidate.digest(fixture.base_manifest)
        fixture.selector.write_bytes(candidate.encoded(fixture.selection))
        fixture.manifest.update(source_commit=self.new, source_sha=self.new)
        fixture.manifest["process_leases_build"]["source_commit"] = self.new
        fixture.manifest["component_provenance"].update(core_source_commit=self.new,
            process_worker_source_commit=self.new, process_config_source_commit=self.new,
            opencode_source_commit=self.new, zcode_source_commit=self.new)
        fixture.migration.update(source_commit=self.new,
            base_manifest_sha256=candidate.digest(fixture.base_manifest),
            base_selector_sha256=candidate.digest(fixture.selector))
        fixture.migration["build"]["source_commit"] = self.new
        for kind, item in fixture.migration["adapters"].items():
            item["source_commit"] = self.new
            item["previous_source_commit"] = self.core if kind == "opencode" else previous_zcode
        fixture.reseal()
        fixture.check()
        return fixture.base, fixture.manifest

    def test_typed_adapter_migration_checks_each_replaced_component_ancestry(self):
        before, after = self.adapter_transition(self.core)
        checked = rollout.component_guard(self.repo / ".git", before, after)
        adapters = {item["component"]: item for item in checked if item["component"].startswith("adapter:")}
        self.assertEqual(set(adapters), {"adapter:opencode", "adapter:zcode"})
        self.assertEqual(adapters["adapter:zcode"]["previous_source"], self.core)

    def test_typed_migration_cannot_discard_newer_installed_adapter_commits(self):
        before, after = self.adapter_transition(self.adapter)
        with self.assertRaisesRegex(rollout.main_guard.MainGuardError, "discard_live_commits"):
            rollout.component_guard(self.repo / ".git", before, after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
