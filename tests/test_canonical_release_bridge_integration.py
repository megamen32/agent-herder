"""Explicit real-binary fixture test. Never reads the installed live authority."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("joint_release_gate", ROOT / "deploy/fleet/release_gate.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
import rotate_canonical_bridge as rotation
from apply_canonical_release_cutover import process_identity
BRIDGE = os.environ.get("HERDER_RESOURCE_BRIDGE_BIN")


@unittest.skipUnless(BRIDGE, "requires explicit fixture bridge binary")
class CanonicalBridgeIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-real-release-bridge-")
        self.root = Path(self.temp.name)
        # Installed companions are immutable executable payloads. The shared
        # Cargo cache may be group writable under the developer's umask.
        self.bridge = self.root / "herder_resource_bridge"
        shutil.copyfile(Path(BRIDGE).resolve(strict=True), self.bridge)
        self.bridge.chmod(0o700)
        self.authority = self.root / "resources"
        self.resource = self.authority / "resources" / "fixture-release"
        self.project = self.root / "repo" / ".git"
        self.fleet = self.root / "fleet"
        self.execution_root = self.root / "executions"
        for directory in (self.authority, self.authority / "resources", self.resource, self.project.parent, self.project, self.fleet, self.execution_root):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o700)
        self.write(self.authority / "storage.json", {"schema": "v1", "storage_id": "fixture-storage"})
        descriptor = {"resource_ref": "fixture-release", "scope": {"type": "global"}, "kind": {"type": "deployment"},
                      "external_ref": "fixture-only-deployment", "authority_ref": "fixture-storage", "attachment": None, "revision": 1}
        self.write(self.resource / "resource.json", {"schema": "v1", "storage_id": "fixture-storage", "resource_ref": "fixture-release",
                                                    "scope": {"type": "global"}, "descriptor": descriptor})
        self.process_config = self.root / "process.json"
        self.write(self.process_config, {"version": 1, "node_ref": socket.gethostname(), "worker": str(self.bridge),
             "execution_root": str(self.execution_root), "resources": {"storage_id": "fixture-storage", "authority_node": socket.gethostname(),
             "root": str(self.authority), "schema": "v1", "route": {"type": "local"}}, "administrators": ["alice"]})
        self.config = self.root / "compat.json"
        self.ledger = self.root / "ledger.json"
        settings = self.root / "settings.json"
        self.write(settings, {"version": 1, "releaseOccupancyEnabled": True})
        env = patch.dict(os.environ, {"AGENT_HERDER_RUNTIME_SETTINGS_PATH": str(settings)})
        env.start()
        self.addCleanup(env.stop)
        self.target = {"fleetDir": str(self.fleet), "unit": "fixture.service"}
        self.write(self.config, {"version": 1, "process_config": str(self.process_config), "ledger": str(self.ledger), "seal_id": "fixture-reviewed-seal",
             "principal_ref": "alice", "mappings": [{"project": str(self.project), "resource_ref": "fixture-release", "revision": 1,
             "previous_fence": 118, "deployment_target": self.target}]})
        self.write(self.ledger, {"version": 2, "canonical": {"version": 1, "config": str(self.config), "bridge": str(self.bridge), "seal_id": "fixture-reviewed-seal"},
                                 "projects": {str(self.project): {"fence": 118}}})
        identity = process_identity(Path("/proc"), os.getpid())
        if identity is None:
            self.skipTest("the Linux release authority fixture requires procfs")
        self.owner = {"hostId": socket.gethostname(), "harness": "fixture", "nativeSessionId": "fixture-session",
                      "process": {"pid": identity["pid"], "bootId": identity["boot_id"], "startTicks": identity["start_ticks"]}}
        acquired = self.call({"action": "acquire", "project": str(self.project), "owner": self.owner, "ttlSeconds": 30,
                              "token": "a" * 64, "deploymentTarget": self.target})
        self.assertTrue(acquired["acquired"])
        self.assertEqual(acquired["lease"]["fence"], 119)
        self.proof = {"project": str(self.project), "owner": self.owner, "token": acquired["token"], "fence": acquired["lease"]["fence"]}
        self.proof_path = self.root / "proof.json"
        self.write(self.proof_path, self.proof)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def call(self, request, error=None):
        result = subprocess.run([str(self.bridge), "--config", str(self.config)], input=json.dumps(request) + "\n",
                                text=True, capture_output=True, timeout=10)
        response = json.loads(result.stdout.splitlines()[0])
        if error:
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"], error)
            return response
        self.assertTrue(response["ok"], response)
        return response["result"]

    def expire(self):
        path = self.resource / "owner.json"
        record = json.loads(path.read_text())
        record["claim"]["expires_at"] = "unix-seconds:0"
        self.write(path, record)

    def successor(self):
        return self.call({"action": "acquire", "project": str(self.project), "owner": {**self.owner, "nativeSessionId": "next-session"},
                          "ttlSeconds": 30, "token": "b" * 64, "deploymentTarget": self.target})

    def test_real_guard_keeps_expired_cleanup_fenced_until_finished(self):
        before = self.ledger.read_bytes()
        with MODULE.ReleaseGate(self.proof_path, self.ledger, target=self.target) as gate:
            self.assertEqual(gate.check()["fence"], 119)
            self.expire()
            with self.assertRaisesRegex(RuntimeError, "lease_expired"):
                gate.check()
            self.assertEqual(gate.check(cleanup=True)["fence"], 119)
            self.assertFalse(self.successor()["acquired"])
        binding = json.loads((self.resource / "execution-binding.json").read_text())
        self.assertTrue(binding["resolved_receipt"])
        next_owner = self.successor()
        self.assertTrue(next_owner["acquired"])
        self.assertGreater(next_owner["lease"]["fence"], 119)
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_eof_blocks_live_takeover_and_quarantines_unknown_after_expiry(self):
        with self.assertRaisesRegex(RuntimeError, "simulated unknown effect"):
            with MODULE.ReleaseGate(self.proof_path, self.ledger, target=self.target):
                raise RuntimeError("simulated unknown effect")
        binding = json.loads((self.resource / "execution-binding.json").read_text())
        self.assertIsNone(binding["resolved_receipt"])
        self.assertFalse(self.successor()["acquired"])
        self.expire()
        self.assertEqual(self.call({"action": "status", "project": str(self.project)})["occupancyState"], "stale_unknown")
        self.assertGreater(self.successor()["lease"]["fence"], 119)
        archive = self.resource / "unresolved-executions" / (binding["claim_id"] + ".json")
        self.assertEqual(json.loads(archive.read_bytes())["claim_id"], binding["claim_id"])

    def test_rotating_the_seal_preserves_a_running_guard_and_concurrent_ledger_updates(self):
        original = self.ledger.read_bytes()
        expected = rotation.digest(self.ledger)
        proposed = self.root / "proposal.json"
        self.write(proposed, {**json.loads(self.config.read_bytes()), "version": 2})

        def rotate(name):
            return rotation.rotate(self.ledger, self.config, self.bridge, self.root/name,
                                   expected, str(self.project), proposed)

        with MODULE.ReleaseGate(self.proof_path, self.ledger, target=self.target) as gate:
            with self.assertRaisesRegex(RuntimeError, "active deployment"):
                rotate("during-guard")
            self.assertEqual(self.ledger.read_bytes(), original)
            self.assertEqual(gate.check()["fence"], 119)

        probe = rotation.bridge_status
        def record_concurrent_update(*args):
            result = probe(*args)
            state = json.loads(self.ledger.read_bytes())
            state["projects"][str(self.project)]["sessions"] = {}
            self.write(self.ledger, state)
            return result

        with patch.object(rotation, "bridge_status", side_effect=record_concurrent_update):
            with self.assertRaisesRegex(RuntimeError, "CAS failed"):
                rotate("during-update")
        updated = json.loads(self.ledger.read_bytes())
        self.assertIn("sessions", updated["projects"][str(self.project)])
        self.assertEqual(updated["canonical"], json.loads(original)["canonical"])
        expected = rotation.digest(self.ledger)
        self.assertTrue(rotate("idle")["rotated"])
        self.assertEqual(json.loads(self.ledger.read_bytes())["projects"], updated["projects"])
        with MODULE.ReleaseGate(self.proof_path, self.ledger, target=self.target) as gate:
            self.assertEqual(gate.check()["fence"], 119)

    def test_rotation_routes_default_and_two_independent_fleet_proofs(self):
        proposed = self.root / "three-targets.json"
        config = json.loads(self.config.read_bytes())
        config["version"] = 2
        config["mappings"][0]["default_for_project"] = True
        targets = []
        for node in ("server-44", "server-88"):
            fleet_dir = self.root / node
            fleet_dir.mkdir(mode=0o700)
            target = {"fleetDir": str(fleet_dir), "unit": f"fixture-{node}.service"}
            targets.append(target)
            resource_ref = f"fixture-release-{node}"
            directory = self.resource.parent / resource_ref
            directory.mkdir(mode=0o700)
            record = json.loads((self.resource / "resource.json").read_bytes())
            record["resource_ref"] = resource_ref
            record["descriptor"].update(resource_ref=resource_ref, external_ref=node)
            self.write(directory / "resource.json", record)
            config["mappings"].append({
                "project": str(self.project), "resource_ref": resource_ref,
                "revision": 1, "previous_fence": 118, "deployment_target": target,
            })
        self.write(proposed, config)

        rotated = rotation.rotate(self.ledger, self.config, self.bridge, self.root / "archive",
                                  rotation.digest(self.ledger), str(self.project), proposed)
        original_config = self.config
        self.config = Path(rotated["config"])
        status = {"action": "status", "project": str(self.project)}
        self.assertEqual(self.call(status)["resourceRef"], "fixture-release")
        self.assertEqual(self.call({**status, "deploymentTarget": self.target})["resourceRef"],
                         "fixture-release")
        with MODULE.ReleaseGate(self.proof_path, self.ledger) as gate:
            self.assertEqual(gate.check()["fence"], 119)

        proofs = []
        for target, node, token in zip(targets, ("server-44", "server-88"), ("b", "c")):
            request = {"project": str(self.project), "owner": self.owner, "deploymentTarget": target}
            self.assertEqual(self.call({**status, "deploymentTarget": target})["resourceRef"],
                             f"fixture-release-{node}")
            acquired = self.call({**request, "action": "acquire", "ttlSeconds": 30, "token": token * 64})
            self.assertTrue(acquired["acquired"])
            self.assertEqual(acquired["lease"]["fence"], 119)
            proof = {**request, "fence": 119, "token": acquired["token"]}
            path = self.root / f"{node}-proof.json"
            self.write(path, proof)
            proofs.append((target, path, proof))

        for target, path, proof in proofs:
            with MODULE.ReleaseGate(path, self.ledger, target=target, require_target_lease=True) as gate:
                self.assertEqual(gate.check()["fence"], 119)
            for wrong_target in [self.target, *(other for other in targets if other != target)]:
                with self.assertRaisesRegex(RuntimeError, "proof_mismatch"):
                    with MODULE.ReleaseGate(path, self.ledger, target=wrong_target, require_target_lease=True):
                        self.fail("cross-target proof opened a guard")
            with self.assertRaisesRegex(RuntimeError, "proof_mismatch"):
                with MODULE.ReleaseGate(self.proof_path, self.ledger, target=target, require_target_lease=True):
                    self.fail("default proof opened a fleet guard")
            self.call({**proof, "action": "release"})

        restored = rotation.rotate(self.ledger, self.config, self.bridge, self.root / "rollback",
                                   rotation.digest(self.ledger), str(self.project), original_config)
        self.config = Path(restored["config"])
        self.assertEqual(self.call(status)["resourceRef"], "fixture-release")
        for target in targets:
            self.call({**status, "deploymentTarget": target}, error="proof_mismatch")
        with MODULE.ReleaseGate(self.proof_path, self.ledger) as gate:
            self.assertEqual(gate.check()["fence"], 119)


if __name__ == "__main__":
    unittest.main()
