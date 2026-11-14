import hashlib
import fcntl
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/fleet"))
SPEC = importlib.util.spec_from_file_location("apply_cutover", ROOT / "deploy/fleet/apply_canonical_release_cutover.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GuardedCutoverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-guarded-cutover-")
        self.root = Path(self.temp.name)
        self.authority = self.root / "authority"
        self.resource = self.authority / "resources/release"
        self.resource.mkdir(parents=True)
        for path in (self.authority, self.authority / "resources", self.resource):
            path.chmod(0o700)
        self.write(self.authority / "storage.json", {"schema": "v1", "storage_id": "fixture"})
        self.write(self.resource / "resource.json", {"schema": "v1", "storage_id": "fixture", "resource_ref": "release",
            "descriptor": {"resource_ref": "release", "revision": 1, "external_ref": "fixture-release"}})
        self.process = self.root / "process.json"
        self.write(self.process, {"administrators": ["alice"], "resources": {"root": str(self.authority), "schema": "v1", "storage_id": "fixture"}})
        self.project = str(self.root / "repo/.git")
        self.target = {"fleetDir": str(self.root / "fleet"), "unit": "fixture.service"}
        self.owner = {"hostId": socket.gethostname(), "harness": "test", "nativeSessionId": "migration"}
        self.token = "a" * 64
        self.ledger = self.root / "ledger.json"
        self.state = {"version": 1, "projects": {self.project: {"fence": 118, "sessions": {}, "lease": {
            "project": self.project, "owner": self.owner, "fence": 118, "acquiredAt": int(time.time()*1000),
            "expiresAt": int(time.time()*1000)+300000, "tokenHash": hashlib.sha256(self.token.encode()).hexdigest(), "deploymentTarget": self.target}}}}
        self.write(self.ledger, self.state)
        self.proof = self.root / "proof.json"
        self.write(self.proof, {"project": self.project, "owner": self.owner, "token": self.token, "fence": 118})
        self.bridge = self.root / "bridge"
        self.bridge.write_text("inactive fixture binary, never executed\n")
        self.bridge.chmod(0o700)
        self.config = self.root / "config.json"
        self.config_data = {"version": 1, "process_config": str(self.process), "ledger": str(self.ledger), "seal_id": "fixture-seal",
            "principal_ref": "alice", "mappings": [{"project": self.project, "resource_ref": "release", "revision": 1,
            "previous_fence": 118, "deployment_target": self.target}]}
        self.write(self.config, self.config_data)
        self.proc = self.root / "proc"
        (self.proc / "sys/kernel/random").mkdir(parents=True)
        (self.proc / "sys/kernel/random/boot_id").write_text("fixture-boot")
        self.writer = self.root / "old-writer.js"
        self.writer.write_text("old fixture writer, never executed\n")
        self.selector = self.root / "selector.json"
        self.write(self.selector, {"fixture": True})
        self.job = self.root / "job"
        self.job.mkdir()
        self.job.chmod(0o700)
        self.write(self.job / "state.json", {"schema": 1, "job_id": "fixture-job", "job_dir": str(self.job), "selector": str(self.selector), "phase": "completed"})
        self.pointer = self.root / ".selector.json.process-leases-rollout.json"
        self.write(self.pointer, {"schema": 1, "job_id": "fixture-job", "job_dir": str(self.job), "selector": str(self.selector), "phase": "resolved",
            "final_state_sha256": self.sha(self.job / "state.json")})
        evidence = []
        for index, kind in enumerate(("typescript_facade", "python_gate", "native_rollout")):
            artifact = self.root / (kind + ".fixture")
            artifact.write_text("verified inactive fixture " + kind)
            receipt = self.root / (kind + ".receipt.json")
            self.write(receipt, {"protocol": "canonical-release-v1", "kind": kind, "result": "passed", "artifact_sha256": self.sha(artifact),
                "observed_process": {"pid": 300+index, "start_ticks": 100, "boot_id": "fixture-boot"}, "checks": ["sealed-aware fixture"]})
            evidence.append({"kind": kind, "artifact": str(artifact), "artifact_sha256": self.sha(artifact), "receipt": str(receipt), "receipt_sha256": self.sha(receipt)})
        self.manifest = self.root / "manifest.json"
        self.policy = {"version": 1, "host": socket.gethostname(), "seal_id": "fixture-seal", "ledger_sha256": self.sha(self.ledger),
            "writer_entrypoints": [str(self.writer)], "drained_processes": [{"pid": 99, "start_ticks": 100, "boot_id": "fixture-boot", "entrypoint": str(self.writer)}],
            "consumer_verifications": evidence, "occupancy_selectors": [str(self.selector)]}
        self.write(self.manifest, self.policy)
        self.checkpoint = self.root / "cutover.json"

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def apply(self):
        return MODULE.apply(self.ledger, self.config, self.bridge, self.proof, self.manifest, self.checkpoint, proc_root=self.proc)

    def reviewed_foreign_hold(self):
        from release_quarantine import lease_digest
        project = str(self.root / "foreign/.git")
        resource = self.authority / "resources/foreign"
        resource.mkdir(mode=0o700)
        self.write(resource / "resource.json", {"schema":"v1", "storage_id":"fixture", "resource_ref":"foreign",
            "descriptor":{"resource_ref":"foreign", "revision":1, "external_ref":"foreign-release"}})
        target = {"fleetDir":str(self.root / "foreign-fleet"), "unit":"foreign.service"}
        lease = {"project":project, "owner":{"hostId":"old-node", "harness":"codex", "nativeSessionId":"legacy"},
            "fence":9, "acquiredAt":1, "expiresAt":2, "tokenHash":"b" * 64, "deploymentTarget":target}
        self.state["projects"][project] = {"fence":9, "sessions":{}, "lease":lease}
        self.config_data["mappings"].append({"project":project, "resource_ref":"foreign", "revision":1,
            "previous_fence":9, "deployment_target":target})
        self.write(self.ledger, self.state)
        self.write(self.config, self.config_data)
        self.policy["ledger_sha256"] = self.sha(self.ledger)
        self.policy["resource_quarantines"] = [{"project":project, "resource_ref":"foreign", "revision":1,
            "fence":9, "lease_sha256":lease_digest(lease), "outcome":"unknown"}]
        self.write(self.manifest, self.policy)
        return project, resource, lease

    def test_reviewed_unknown_transfers_to_exact_resource_hold_without_success(self):
        project, resource, lease = self.reviewed_foreign_hold()
        original = self.ledger.read_bytes()
        self.apply()
        hold_path = resource / "migration-hold.json"
        hold = json.loads(hold_path.read_bytes())
        self.assertEqual(hold["outcome"], "unknown")
        self.assertEqual(hold["source_owner"], lease["owner"])
        self.assertEqual(hold["source_fence"], 9)
        self.assertEqual(Path(hold["archive"]["path"]).read_bytes(), original)
        self.assertEqual(hold_path.stat().st_mode & 0o777, 0o400)
        self.assertEqual(hold_path.stat().st_nlink, 1)
        sealed = json.loads(self.ledger.read_bytes())
        self.assertEqual(sealed["projects"][project]["migrationQuarantine"]["outcome"], "unknown")
        self.assertNotIn("lease", sealed["projects"][project])
        self.assertFalse((resource / "owner.json").exists())

    def test_changed_foreign_owner_is_not_covered_by_reviewed_hold(self):
        project, resource, lease = self.reviewed_foreign_hold()
        self.state["projects"][project]["lease"]["owner"]["nativeSessionId"] = "different"
        self.write(self.ledger, self.state)
        self.policy["ledger_sha256"] = self.sha(self.ledger)
        self.write(self.manifest, self.policy)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "owner_binding_changed"):
            self.apply()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse((resource / "migration-hold.json").exists())

    def test_crash_after_resource_hold_preserves_unknown_and_fresh_proposal_adopts_it(self):
        project, resource, lease = self.reviewed_foreign_hold()
        original = self.ledger.read_bytes()
        write_checkpoint = MODULE.checkpoint_write
        def fail_after_hold(path, record, phase):
            write_checkpoint(path, record, phase)
            if phase == "quarantined":
                raise RuntimeError("fixture lost after quarantine")
        with mock.patch.object(MODULE, "checkpoint_write", side_effect=fail_after_hold):
            with self.assertRaisesRegex(RuntimeError, "lost after quarantine"):
                self.apply()
        self.assertEqual(self.ledger.read_bytes(), original)
        hold_path = resource / "migration-hold.json"
        held = hold_path.read_bytes()
        self.assertEqual(MODULE.reconcile(self.checkpoint)["outcome"], "source_unchanged_requires_fresh_guard_and_proposal")
        self.checkpoint = self.root / "fresh-cutover.json"
        self.apply()
        self.assertEqual(hold_path.read_bytes(), held)
        self.assertEqual(hold_path.stat().st_nlink, 1)
        self.assertEqual(json.loads(self.ledger.read_bytes())["projects"][project]["migrationQuarantine"]["outcome"], "unknown")

    def test_apply_archives_exact_source_and_retires_only_admitted_migration_lease(self):
        before = self.ledger.read_bytes()
        result = self.apply()
        self.assertTrue(result["sealed"])
        self.assertTrue(result["consumer_verification_required"])
        sealed = json.loads(self.ledger.read_bytes())
        self.assertEqual(sealed["version"], 2)
        self.assertNotIn("lease", sealed["projects"][self.project])
        self.assertEqual(sealed["projects"][self.project]["fence"], 118)
        checkpoint = json.loads(self.checkpoint.read_bytes())
        self.assertEqual(Path(checkpoint["archive"]).read_bytes(), before)
        self.assertEqual(checkpoint["archive_sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(checkpoint["inventory"][0]["mapping"], self.config_data["mappings"][0])
        self.assertFalse(Path(str(self.ledger)+".lock").exists())
        self.assertEqual(MODULE.reconcile(self.checkpoint)["outcome"], "sealed_requires_consumer_verification")

    def test_expired_foreign_owner_is_never_discarded(self):
        other = "/fixture/other/.git"
        self.state["projects"][other] = {"fence": 7, "lease": {"expiresAt": 0, "fence": 7, "tokenHash": "preserve-private-evidence"}}
        self.config_data["mappings"].append({**self.config_data["mappings"][0], "project": other, "previous_fence": 118})
        self.write(self.ledger, self.state)
        self.write(self.config, self.config_data)
        self.policy["ledger_sha256"] = self.sha(self.ledger)
        self.write(self.manifest, self.policy)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "other_ownership_requires_reconciliation"):
            self.apply()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.checkpoint.exists())

    def test_live_writer_identity_or_active_rollout_occupancy_blocks_apply(self):
        pid = self.proc / "99"
        pid.mkdir()
        fields = ["0"] * 20
        fields[0], fields[19] = "S", "100"
        (pid / "stat").write_text("99 (fixture process) " + " ".join(fields))
        (pid / "cmdline").write_bytes(str(self.writer).encode()+b"\0")
        with self.assertRaisesRegex(RuntimeError, "old_writer_still_alive"):
            self.apply()
        (pid / "stat").unlink()
        (pid / "cmdline").unlink()
        pid.rmdir()
        pointer = json.loads(self.pointer.read_bytes())
        pointer["phase"] = "active"
        self.write(self.pointer, pointer)
        with self.assertRaisesRegex(RuntimeError, "occupancy_unresolved"):
            self.apply()
        self.assertEqual(json.loads(self.ledger.read_bytes())["version"], 1)

    def test_crash_after_archive_preserves_source_and_reconcile_never_claims_success(self):
        before = self.ledger.read_bytes()
        original = MODULE.checkpoint_write
        def fail_after_archive(path, record, phase):
            original(path, record, phase)
            if phase == "archived":
                raise RuntimeError("injected interrupted cutover")
        with mock.patch.object(MODULE, "checkpoint_write", side_effect=fail_after_archive):
            with self.assertRaisesRegex(RuntimeError, "injected interrupted"):
                self.apply()
        self.assertEqual(self.ledger.read_bytes(), before)
        result = MODULE.reconcile(self.checkpoint)
        self.assertEqual(result["outcome"], "source_unchanged_requires_fresh_guard_and_proposal")
        self.assertFalse(result["automatic_resume"])
        self.assertFalse(result["automatic_rollback"])

    def test_crash_after_atomic_seal_is_reconciled_from_durable_evidence(self):
        original = MODULE.checkpoint_write
        def fail_final_checkpoint(path, record, phase):
            if phase == "sealed_requires_consumer_verification":
                raise RuntimeError("injected lost acknowledgement")
            original(path, record, phase)
        with mock.patch.object(MODULE, "checkpoint_write", side_effect=fail_final_checkpoint):
            with self.assertRaisesRegex(RuntimeError, "lost acknowledgement"):
                self.apply()
        self.assertEqual(json.loads(self.checkpoint.read_bytes())["phase"], "archived")
        result = MODULE.reconcile(self.checkpoint)
        self.assertEqual(result["outcome"], "sealed_requires_consumer_verification")
        self.assertFalse(result["automatic_resume"])
        self.assertEqual(json.loads(self.ledger.read_bytes())["version"], 2)

    def test_source_cas_and_consumer_receipt_hash_are_required(self):
        self.ledger.write_text(self.ledger.read_text()+"\n")
        with self.assertRaisesRegex(RuntimeError, "source_cas_failed"):
            self.apply()
        self.policy["ledger_sha256"] = self.sha(self.ledger)
        self.write(self.manifest, self.policy)
        Path(self.policy["consumer_verifications"][0]["receipt"]).write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "evidence_digest_changed"):
            self.apply()

    def test_canonical_effect_and_claim_locks_block_the_authority_switch(self):
        before = self.ledger.read_bytes()
        for name in ("execution.lock", "guard.lock"):
            with self.subTest(name=name):
                path = self.resource / name
                with path.open("a+") as lock:
                    path.chmod(0o600)
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaisesRegex(RuntimeError, "canonical_resource_busy"):
                        self.apply()
                self.assertEqual(self.ledger.read_bytes(), before)
                self.assertFalse(self.checkpoint.exists())

    def test_resolved_selector_requires_private_matching_checkpoint(self):
        state = json.loads((self.job / "state.json").read_bytes())
        state["job_dir"] = str(self.root / "different-job")
        self.write(self.job / "state.json", state)
        pointer = json.loads(self.pointer.read_bytes())
        pointer["final_state_sha256"] = self.sha(self.job / "state.json")
        self.write(self.pointer, pointer)
        with self.assertRaisesRegex(RuntimeError, "terminal_evidence_invalid"):
            self.apply()
        self.pointer.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "private_file_required"):
            self.apply()

    def test_nested_legacy_evidence_blocks_seal_without_erasing_metadata(self):
        self.state["projects"][self.project]["integration"] = {"inventory": [{"lease": None}]}
        self.write(self.ledger, self.state)
        self.policy["ledger_sha256"] = self.sha(self.ledger)
        self.write(self.manifest, self.policy)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "other_ownership_requires_reconciliation"):
            self.apply()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.checkpoint.exists())


if __name__ == "__main__":
    unittest.main()
