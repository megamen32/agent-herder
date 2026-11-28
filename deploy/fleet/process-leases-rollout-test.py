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
        values += ["process_completion", "reconcile_process", "cancel_execution", "timer", "session_completion", "wait_status"]
    return [
        {"name": "automation", "inputSchema": {"oneOf": [{"const": value} for value in values]}},
        {"name": "resource", "inputSchema": {"properties": {"action": {"enum": ["claim", "bind"] if process else ["claim"]}}}},
        {"name": "session", "inputSchema": {"properties": {"action": {"enum": ["resolve"] if process else ["list"]}}}},
        {"name": "deliver", "inputSchema": {"properties": {"action": {"enum": ["receipt"] if process else ["session"]}}}},
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
        self.scheduler_proof = self.root / "scheduler-preflight.json"
        candidate.create(self.scheduler_proof, candidate.encoded({"fixture": "scheduler-preflight"}), 0o400)
        candidate.create(self.proof, candidate.encoded({"project": str(self.root), "owner": "test-owner",
                                                       "fence": 8, "token": "fixture-private-token"}))
        candidate.create(self.ledger, candidate.encoded({"version": 1}))
        self.args = argparse.Namespace(**vars(self.fixture.install_args),
            job_dir=self.root / "job", proof=self.proof, release_state=self.ledger,
            target=None, compat_pid=101, core_pid=102, deadline_seconds=1, scheduler_proof=self.scheduler_proof)
        owner = self

        class FakeGate:
            _canonical_authority = staticmethod(rollout.ReleaseGate._canonical_authority)
            def __init__(self, proof_path, state_path=None, target=None, *, require_target_lease=False):
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
        self.scheduler_identity = {"process": {"pid": 301}, "canonical": {"epoch": "fixture-epoch"},
                                   "runtime": {"source_commit": self.fixture.manifest["process_leases_build"]["source_commit"]}}
        def scheduler_proof(receipt, source_commit, **kwargs):
            self.events.append("scheduler-" + kwargs["stage"])
            return {"identity": self.scheduler_identity, "response_sha256": "a" * 64,
                    "observed_at_unix_ms": rollout.now_ms(), "provider_operation_id": "fixture-scheduler-read"}
        self.scheduler_validator = patch.object(rollout.scheduler, "validate_receipt", side_effect=scheduler_proof).start()
        self.scheduler_observer = patch.object(rollout.scheduler, "observe", return_value=self.scheduler_identity).start()
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
        candidate.create(self.args.job_dir / "scheduler-consumer.json", candidate.encoded({"fixture": "scheduler-consumer"}))

    def prepare_native_drain(self):
        capture = self.root / "native-before.json"
        result = rollout.capture_drain(argparse.Namespace(selector=self.args.selector,
            launcher=self.args.launcher, compat_pid=self.args.compat_pid, core_pid=self.args.core_pid, output=capture))
        self.args.drained_baseline = capture
        self.args.drained_baseline_sha256 = result["sha256"]
        self.args.drain_receipt = self.root / "native-disable.json"
        receipt = {"schema":1, "kind":"native-drain", "baseline_sha256":result["sha256"],
                   "observed_at_unix_ms":rollout.now_ms(), "provider_operation_id":"gptadmin-native-disable-fixture",
                   "target":rollout.CONTROLLER, "ref":rollout.CHILD, "method":"mcp_manage", "action":"disable", "disabled":True}
        candidate.create(self.args.drain_receipt, candidate.encoded(receipt), 0o400)
        self.args.drain_receipt_sha256 = candidate.digest(self.args.drain_receipt)
        return receipt

    def test_typed_drained_baseline_enables_only_new_runtime_and_full_consumers(self):
        self.prepare_native_drain()
        def runtime(selector, launcher, compat_pid, core_pid, expected_cwd=None):
            if core_pid == 102:
                raise AssertionError("a drained core cannot be observed alive during candidate admission")
            return self.runtime_pair(selector, launcher, compat_pid, core_pid, expected_cwd)
        def operator(_):
            self.publish_receipts(restart_update={"action":"enable", "drain_receipt_sha256":self.args.drain_receipt_sha256})
        with patch.object(rollout, "runtime_pair", side_effect=runtime), patch.object(rollout.time, "sleep", side_effect=operator):
            result = rollout.run(self.args)
        self.assertEqual(result["status"], "completed")
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["native_drain"]["receipt"]["sha256"], self.args.drain_receipt_sha256)
        self.assertEqual(Path(state["native_drain"]["baseline"]["path"]).stat().st_mode & 0o777, 0o400)
        self.assertIn("scheduler-consumer", self.events)
        self.assertIn("runtime-202", self.events)

    def test_drained_baseline_refuses_live_or_unknown_old_identity(self):
        self.prepare_native_drain()
        for status in ("live", "unknown"):
            with self.subTest(status=status), patch.object(rollout, "identity_state", return_value=status):
                with self.assertRaisesRegex(ValueError, "drain is unproved"):
                    rollout.run(self.args)
            self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
            self.assertFalse(self.args.job_dir.exists())

    def test_drained_baseline_refuses_configuration_drift_and_untyped_receipt(self):
        receipt = self.prepare_native_drain()
        receipt["action"] = "restart"
        candidate.replace(self.args.drain_receipt, candidate.encoded(receipt), self.args.drain_receipt_sha256, 0o400)
        self.args.drain_receipt_sha256 = candidate.digest(self.args.drain_receipt)
        with self.assertRaisesRegex(ValueError, "exact typed disable"):
            rollout.run(self.args)
        receipt["action"] = "disable"
        candidate.replace(self.args.drain_receipt, candidate.encoded(receipt), self.args.drain_receipt_sha256, 0o400)
        self.args.drain_receipt_sha256 = candidate.digest(self.args.drain_receipt)
        data = self.fixture.launcher.read_bytes() + b"\n"
        candidate.replace(self.fixture.launcher, data, candidate.digest(self.fixture.launcher), 0o700)
        with self.assertRaises((ValueError, RuntimeError)):
            rollout.run(self.args)
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
        self.assertFalse(self.args.job_dir.exists())

    def test_enable_is_rejected_without_native_drain_and_drain_rejects_wrong_ack(self):
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts(restart_update={"action":"enable"})):
            with self.assertRaisesRegex(ValueError, "typed child restart"):
                rollout.run(self.args)
        self.assertEqual(rollout.read_state(self.args.job_dir)["phase"], "unknown")

    def test_drained_mode_requires_enable_binding_and_forbids_baseline_recovery(self):
        self.prepare_native_drain()
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts(restart_update={"action":"enable", "drain_receipt_sha256":"f" * 64})):
            with self.assertRaisesRegex(ValueError, "enable receipt does not bind"):
                rollout.run(self.args)
        recovery = argparse.Namespace(job_dir=self.args.job_dir, outcome="baseline")
        with self.assertRaisesRegex(ValueError, "cannot reactivate"):
            rollout.recover(recovery)

    def test_guard_covers_install_restart_and_fresh_consumer(self):
        def operator(_):
            self.publish_receipts()
        with patch.object(rollout.time, "sleep", side_effect=operator):
            result = rollout.run(self.args)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["occupancy"], "resolved")
        self.assertLess(self.events.index("guard-enter"), self.events.index("runtime-202"))
        self.assertGreater(self.events.index("finished"), self.events.index("runtime-202"))
        self.assertGreater(self.events.index("finished"), self.events.index("scheduler-consumer"))
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["consumer_evidence"]["method"], "mcp_tools")
        self.assertTrue(state["consumer_evidence"]["schema_sha256"])
        self.assertNotIn("token", json.dumps(state))
        self.assertEqual(self.fixture.database.read_bytes(), self.fixture.before_db)
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.new_selector.read_bytes())

    def test_existing_backup_refused_before_guard(self):
        Path(self.args.backup).mkdir()
        with self.assertRaises(FileExistsError):
            rollout.run(self.args)
        self.assertNotIn("guard-enter", self.events)
        self.assertFalse(self.args.job_dir.exists())
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
        self.assertEqual(self.fixture.launcher.read_bytes(), self.fixture.before_launcher)

    def test_missing_scheduler_proof_refuses_before_any_selector_mutation(self):
        self.args.scheduler_proof = self.root / "missing-scheduler.json"
        with self.assertRaises(FileNotFoundError):
            rollout.run(self.args)
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
        self.assertEqual(self.fixture.launcher.read_bytes(), self.fixture.before_launcher)
        self.assertFalse(self.args.job_dir.exists())

    def test_changed_scheduler_is_rechecked_before_selector_mutation(self):
        self.scheduler_observer.side_effect = ValueError("scheduler PID changed")
        with self.assertRaisesRegex(ValueError, "scheduler PID changed"):
            rollout.run(self.args)
        self.assertEqual(self.fixture.selector.read_bytes(), self.fixture.before_selector)
        self.assertEqual(self.fixture.launcher.read_bytes(), self.fixture.before_launcher)
        self.assertEqual(rollout.read_state(self.args.job_dir)["phase"], "unknown")
        self.assertNotIn("finished", self.events)

    def test_native_consumer_alone_cannot_finish_the_paired_rollout(self):
        self.args.deadline_seconds = 0.02
        def native_only(_):
            self.publish_receipts()
            (self.args.job_dir / "scheduler-consumer.json").unlink(missing_ok=True)
        with patch.object(rollout.time, "sleep", side_effect=native_only):
            with self.assertRaises(TimeoutError):
                rollout.run(self.args)
        self.assertNotIn("finished", self.events)
        self.assertEqual(rollout.read_state(self.args.job_dir)["phase"], "unknown")

    def test_first_verified_ack_pair_survives_scheduler_failure(self):
        original_pair = self.runtime_pair(self.args.selector, self.args.launcher, 201, 202)
        def reject_scheduler(state, receipt, minimum):
            saved = rollout.read_state(self.args.job_dir)
            self.assertEqual(saved["restart_runtime_capture"]["runtime_pair"], original_pair)
            raise ValueError("scheduler proof failed")
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts()), \
                patch.object(rollout, "validate_scheduler_consumer", side_effect=reject_scheduler):
            with self.assertRaisesRegex(ValueError, "scheduler proof failed"):
                rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["phase"], "unknown")
        self.assertEqual(state["restart_runtime_capture"]["runtime_pair"], original_pair)
        self.assertEqual(state["restart_runtime_capture"]["restart_receipt_sha256"],
                         candidate.digest(self.args.job_dir / "restart-ack.json"))
        self.assertEqual(rollout.read_occupancy(self.fixture.selector)["phase"], "active")

    def test_old_schema_names_do_not_prove_new_core_ready(self):
        with patch.object(rollout.time, "sleep", side_effect=lambda _: self.publish_receipts(process=False)):
            with self.assertRaisesRegex(ValueError, "lacks process_completion"):
                rollout.run(self.args)
        state = rollout.read_state(self.args.job_dir)
        self.assertEqual(state["phase"], "unknown")
        self.assertEqual(rollout.read_occupancy(self.fixture.selector)["phase"], "active")
        self.assertIn("unknown", self.events)
        self.assertNotIn("finished", self.events)

    def test_supersede_only_exact_active_job_reaches_new_guard(self):
        old = self.root / "old-job"
        other = self.root / "other-job"
        pointer = {"phase": "active", "job_dir": str(old)}
        self.args.supersede_restart_provider = self.root / "restart-provider.json"
        self.args.supersede_consumer_provider = self.root / "consumer-provider.json"
        self.args.target = self.root / "target.json"
        candidate.create(self.args.target, candidate.encoded({"unit": "fixture.service"}))
        candidate.replace(self.ledger, candidate.encoded({"version": 2, "projects": {},
            "canonical": {"version": 1, "config": str(self.root / "config.json"),
                          "bridge": str(self.root / "bridge"), "seal_id": "fixture"}}),
            candidate.digest(self.ledger), 0o600)
        for named, admitted in ((None, False), (other, False), (old, True)):
            with self.subTest(named=named), patch.object(rollout, "read_occupancy", return_value=pointer), \
                    patch.object(rollout, "admit", side_effect=ValueError("inside new guard")) as admit:
                self.args.supersede_job = named
                with self.assertRaisesRegex((ValueError, RuntimeError),
                                            "inside new guard" if admitted else "occupancy"):
                    rollout.run(self.args)
                self.assertEqual(admit.called, admitted)

    def test_supersede_requires_archived_claim_and_exact_typed_evidence(self):
        old_dir = self.root / "old-job"
        old_dir.mkdir(mode=0o700)
        target = {"unit": "fixture.service", "fleetDir": str(self.root)}
        selector, launcher = self.fixture.selector, self.fixture.launcher
        selection = candidate.read_json(selector)
        project = str(self.root)
        token = "ab" * 32
        claim_id = str(rollout.uuid.UUID(bytes=rollout.hashlib.sha256(token.encode()).digest()[:16], version=5))
        resource = "fixture-resource"
        guard_id = "guard-" + "1" * 32
        execution = "release-" + guard_id

        def write(path, value):
            path = Path(path)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if path.exists():
                candidate.replace(path, candidate.encoded(value), candidate.digest(path), 0o600)
            else:
                candidate.create(path, candidate.encoded(value))
            return path

        proof = write(old_dir / "proof.json", {"project": project, "owner": "old-owner", "fence": 7, "token": token})
        old = {"job_id": "rollout-" + "1" * 32, "job_dir": str(old_dir), "phase": "unknown",
               "challenge": "a" * 64, "coordinator": {"pid": 111}, "awaiting_restart_at_unix_ms": 1,
               "selector": str(selector), "launcher": str(launcher), "candidate": str(self.root / "prior.json"),
               "selector_after_sha256": candidate.digest(selector), "launcher_after_sha256": candidate.digest(launcher),
               "candidate_manifest": selection["manifest"], "candidate_manifest_sha256": selection["manifest_sha256"],
               "release_identity": {"project": project, "owner": "old-owner", "fence": 7},
               "release_state": str(self.ledger), "deployment_target": target, "proof_path": str(proof),
               "baseline_runtime": self.runtime_pair(selector, launcher, 101, 102)}
        old["install_receipt"] = str(write(old_dir / "install.json", {**old, "status": "configured_pending_restart"}))
        restart, consumer = self.receipt(old, "restart"), self.receipt(old)
        old["restart_operation_id"] = restart["provider_operation_id"]
        state_path = write(old_dir / "state.json", old)
        write(old_dir / "restart-ack.json", restart)
        write(old_dir / "consumer-receipt.json", consumer)
        context = {"claim_id": claim_id, "resource_ref": resource, "principal_ref": "fixture-principal"}
        archive = {"version": 1, "kind": "herder-unresolved-execution-quarantine-v1",
                   "claim_id": claim_id, "resource_ref": resource,
                   "reason": "expired-owner-generation-with-free-target-lock",
                   "binding": {**context, "execution_ref": execution, "resource_revision": 3, "resolved_receipt": None}}
        resource_dir = self.root / "resources" / resource
        archive_path = write(resource_dir / "unresolved-executions" / (claim_id + ".json"), archive)
        intent = {**context, "version": 1, "guard_id": guard_id, "execution_ref": execution,
                  "revision": 3, "fence": 7, "finished_at_seconds": None}
        intent_path = write(resource_dir / "compat-guards" / (guard_id + ".intent.json"), intent)
        config = write(self.root / "config.json", {"ledger": str(self.ledger), "seal_id": "fixture",
            "principal_ref": context["principal_ref"],
            "process_config": str(write(self.root / "process.json", {"resources": {"root": str(self.root)}})),
            "mappings": [{"project": project, "deployment_target": target, "resource_ref": resource, "revision": 3}]})
        lease = {"project": project, "owner": "new-owner", "fence": 8, "deploymentTarget": target}
        gate = argparse.Namespace(_bridge=object(), _canonical={"config": str(config), "seal_id": "fixture"},
                                  target=target, proof=lease, state_path=self.ledger, check=lambda: lease)

        def provider(receipt, payload):
            operation = receipt["provider_operation_id"]
            return {"status": "completed", "server_id": rollout.CONTROLLER, "job_id": operation,
                    "task_id": operation, "response": {"structuredContent": {
                        "server": rollout.CONTROLLER.removeprefix("shell:"),
                        "result": {"resultType": "complete", "structuredContent": payload}}}}

        before = {"process_leases_build": {"source_commit": "a" * 40}}
        after = {"process_leases_build": {"source_commit": "b" * 40}}
        current = self.runtime_pair(selector, launcher, 201, 202)
        self.args.supersede_job = old_dir
        self.args.expected_selector_sha256 = old["selector_after_sha256"]
        write(Path(self.args.candidate).parent / "process-leases-build.json", {
            "base_selector": str(selector), "base_selector_sha256": old["selector_after_sha256"],
            "base_manifest_sha256": old["candidate_manifest_sha256"]})
        self.args.supersede_restart_provider = write(old_dir / "restart-provider.json",
            provider(restart, {"ref": rollout.CHILD, "action": "restart"}))
        self.args.supersede_consumer_provider = write(old_dir / "consumer-provider.json",
            provider(consumer, {"tools": consumer["tools"]}))
        pointer = {"job_id": old["job_id"], "job_dir": str(old_dir), "phase": "active"}

        def verify():
            return rollout.supersede_evidence(self.args, gate, pointer, selector, launcher,
                                               selection, before, after, current)

        with patch.object(rollout, "identity_state", return_value="dead"):
            state_bytes = state_path.read_bytes()
            self.assertEqual(verify()[0]["archived_guard"]["claim_id"], claim_id)
            self.assertEqual(state_path.read_bytes(), state_bytes)
            lease["fence"] = 7
            with self.assertRaisesRegex(ValueError, "higher fence"):
                verify()
            lease["fence"] = 8
            gate._bridge = None
            with self.assertRaisesRegex(ValueError, "canonical target guard"):
                verify()
            gate._bridge = object()
            after["process_leases_build"]["source_commit"] = "a" * 40
            with self.assertRaisesRegex(ValueError, "distinct new release"):
                verify()
            after["process_leases_build"]["source_commit"] = "b" * 40
            with patch.object(rollout, "identity", return_value={"pid": 201}):
                current["compat"]["pid"] = 301
                with self.assertRaisesRegex(ValueError, "restart PID still exists"):
                    verify()
                current["compat"]["pid"] = 201
            write(intent_path, {**intent, "fence": 6})
            with self.assertRaisesRegex(ValueError, "original fence"):
                verify()
            write(intent_path, intent)
            archive_path.unlink()
            with self.assertRaises(FileNotFoundError):
                verify()
            write(archive_path, archive)
            write(self.args.supersede_consumer_provider, provider(consumer, {"tools": []}))
            with self.assertRaisesRegex(ValueError, "schemas differ"):
                verify()
        with patch.object(rollout, "identity_state", return_value="live"):
            with self.assertRaisesRegex(ValueError, "dead coordinator"):
                verify()

    def test_supersede_pointer_cas_keeps_old_job_and_rejects_pointer_drift(self):
        old_dir = self.root / "old-job"
        old_dir.mkdir(mode=0o700)
        old = {"schema": 1, "job_id": "rollout-" + "a" * 32, "job_dir": str(old_dir),
               "selector": str(self.fixture.selector), "phase": "unknown"}
        checkpoint = old_dir / "state.json"
        candidate.create(checkpoint, candidate.encoded(old))
        old_bytes = checkpoint.read_bytes()
        path = rollout.occupancy_path(self.fixture.selector)
        pointer = {"schema": 1, "job_id": old["job_id"], "job_dir": str(old_dir),
                   "selector": old["selector"], "phase": "active"}
        candidate.create(path, candidate.encoded(pointer))
        original_pointer = path.read_bytes()
        self.args.supersede_job = old_dir
        evidence = {"pointer": pointer, "evidence_sha256": {str(checkpoint): candidate.digest(checkpoint)}}
        proof_pin = (str(self.proof), candidate.digest(self.proof))
        replace = candidate.replace

        def conflict(file, data, expected, mode):
            if file == path:
                replace(file, original_pointer + b" ", expected, mode)
            return replace(file, data, expected, mode)

        with self.FakeGate(self.proof, self.ledger) as gate:
            with patch.object(rollout, "supersede_evidence", return_value=(evidence, proof_pin)):
                with patch.object(candidate, "replace", side_effect=conflict):
                    with self.assertRaisesRegex(ValueError, "concurrent change"):
                        rollout.admit(self.args, gate)
                self.assertEqual(path.read_bytes(), original_pointer + b" ")
                self.assertEqual(checkpoint.read_bytes(), old_bytes)
                self.args.job_dir = self.root / "second-job"
                admitted = rollout.admit(self.args, gate)
        self.assertEqual(rollout.read_occupancy(self.fixture.selector)["job_id"], admitted["job_id"])
        self.assertEqual((self.args.job_dir / "superseded-selector-pointer.json").read_bytes(),
                         original_pointer + b" ")
        self.assertEqual(checkpoint.read_bytes(), old_bytes)

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
                                  compat_pid=201, core_pid=202, consumer_receipt=path, scheduler_proof=self.scheduler_proof)

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
            proof=self.proof, compat_pid=201, core_pid=202, consumer_receipt=receipt,
            scheduler_proof=self.scheduler_proof))
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

    def test_native_recovery_with_existing_or_new_profiles_can_retain_the_unchanged_scheduler(self):
        receipt = {"response": {"runtime": {"source_commit": self.new}}}
        native = self.repo / "crates/herder"
        native.mkdir(parents=True)
        (native / "fix.rs").write_text("// Native-only change\n")
        self.git(["add", "crates"])
        self.git(["commit", "-q", "-m", "native fix"])
        native_source = self.git(["rev-parse", "HEAD"])
        tooling = self.repo / "deploy" / "fleet"
        tooling.mkdir(parents=True)
        (tooling / "rollout-recovery").write_text("operator command\n")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", "operator tooling"], cwd=self.repo, check=True)
        native_source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        self.after["process_leases_build"]["source_commit"] = native_source
        git_dir = self.repo / ".git"
        self.assertEqual(rollout.scheduler_source(git_dir, self.after, {"kind": "recovery"}, receipt), self.new)
        self.assertEqual(rollout.scheduler_source(git_dir, self.after, None, receipt), self.new)
        self.assertEqual(rollout.scheduler_source(git_dir, self.after, {"kind": "adapter"}, receipt), native_source)
        self.after["process_leases_build"]["source_commit"] = self.commit("changed scheduler input")
        for migration in (None, {"kind": "recovery"}):
            with self.subTest(migration=migration), self.assertRaisesRegex(ValueError, "changes installed scheduler inputs"):
                rollout.scheduler_source(git_dir, self.after, migration, receipt)

    def test_browser_only_profile_migration_can_keep_an_unchanged_scheduler(self):
        receipt = {"response": {"runtime": {"source_commit": self.new}}}
        browser = {"schema": 2, "type": "herder-native-profile-rebind", "kinds": ["chatgpt", "zai"]}
        for name in (".github/workflows/fleet-session.yml", "integrations/chrome/agent-herder/background.js",
                     "deploy/fleet/launch-v1-core.py", "deploy/fleet/process-leases-migration-launcher-test.py"):
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Browser owner transport change\n")
        self.git(["add", "."])
        self.git(["commit", "-qm", "browser transport and deployment"])
        native_source = self.git(["rev-parse", "HEAD"])
        self.after["process_leases_build"]["source_commit"] = native_source
        git_dir = self.repo / ".git"
        self.assertEqual(rollout.scheduler_source(git_dir, self.after, browser, receipt), self.new)
        mixed = {**browser, "kinds": ["chatgpt", "opencode"]}
        self.assertEqual(rollout.scheduler_source(git_dir, self.after, mixed, receipt), native_source)
        self.after["process_leases_build"]["source_commit"] = self.commit("changed scheduler input")
        with self.assertRaisesRegex(ValueError, "changes installed scheduler inputs"):
            rollout.scheduler_source(git_dir, self.after, browser, receipt)

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

    def test_remote_companion_replacement_checks_its_own_component_ancestry(self):
        self.before["process_remote_bridge"] = "/fixture/old-remote.mjs"
        self.before["sha256"]["process_remote_bridge"] = "1" * 64
        self.before["component_provenance"]["process_remote_bridge_source_commit"] = self.core
        self.after["process_remote_bridge"] = "/fixture/new-remote.mjs"
        self.after["sha256"]["process_remote_bridge"] = "2" * 64
        self.after["component_provenance"]["process_remote_bridge_source_commit"] = self.new
        checked = rollout.component_guard(self.repo / ".git", self.before, self.after)
        self.assertEqual(next(row for row in checked if row["component"] == "process_remote_bridge")["previous_source"], self.core)
        self.before["component_provenance"]["process_remote_bridge_source_commit"] = self.adapter
        with self.assertRaisesRegex(rollout.main_guard.MainGuardError, "discard_live_commits"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def test_retained_component_and_authority_changes_need_separate_review(self):
        self.after["adapters"]["codex"] += "-different"
        with self.assertRaisesRegex(ValueError, "unreviewed.*replacement"):
            rollout.component_guard(self.repo / ".git", self.before, self.after)

    def test_existing_migration_binding_cannot_be_silently_removed(self):
        self.before["canonical_migration"] = {"config": "/fixture/canonical.json", "sha256": "a" * 64}
        with self.assertRaisesRegex(ValueError, "canonical migration authority"):
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
            opencode_source_commit=self.core, zcode_source_commit=previous_zcode, codex_source_commit=self.core)
        fixture.base_manifest.write_bytes(candidate.encoded(fixture.base))
        fixture.selection["manifest_sha256"] = candidate.digest(fixture.base_manifest)
        fixture.selector.write_bytes(candidate.encoded(fixture.selection))
        fixture.manifest.update(source_commit=self.new, source_sha=self.new)
        fixture.manifest["process_leases_build"]["source_commit"] = self.new
        fixture.manifest["component_provenance"].update(core_source_commit=self.new,
            process_worker_source_commit=self.new, process_config_source_commit=self.new,
            opencode_source_commit=self.new, zcode_source_commit=self.new, codex_source_commit=self.new)
        fixture.migration.update(source_commit=self.new,
            base_manifest_sha256=candidate.digest(fixture.base_manifest),
            base_selector_sha256=candidate.digest(fixture.selector))
        fixture.migration["build"]["source_commit"] = self.new
        for kind, item in fixture.migration["adapters"].items():
            item["source_commit"] = self.new
            item["previous_source_commit"] = previous_zcode if kind == "zcode" else self.core
        fixture.reseal()
        fixture.check()
        return fixture.base, fixture.manifest

    def test_typed_adapter_migration_checks_each_replaced_component_ancestry(self):
        before, after = self.adapter_transition(self.core)
        checked = rollout.component_guard(self.repo / ".git", before, after)
        adapters = {item["component"]: item for item in checked if item["component"].startswith("adapter:")}
        self.assertEqual(set(adapters), {"adapter:opencode", "adapter:zcode", "adapter:codex"})
        self.assertEqual(adapters["adapter:zcode"]["previous_source"], self.core)

    def test_typed_migration_cannot_discard_newer_installed_adapter_commits(self):
        before, after = self.adapter_transition(self.adapter)
        with self.assertRaisesRegex(rollout.main_guard.MainGuardError, "discard_live_commits"):
            rollout.component_guard(self.repo / ".git", before, after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
