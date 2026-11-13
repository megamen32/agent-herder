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

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("joint_release_gate", ROOT / "deploy/fleet/release_gate.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
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
        self.bridge.chmod(0o755)
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
        self.target = {"fleetDir": str(self.fleet), "unit": "fixture.service"}
        self.write(self.config, {"version": 1, "process_config": str(self.process_config), "ledger": str(self.ledger), "seal_id": "fixture-reviewed-seal",
             "principal_ref": "alice", "mappings": [{"project": str(self.project), "resource_ref": "fixture-release", "revision": 1,
             "previous_fence": 118, "deployment_target": self.target}]})
        self.write(self.ledger, {"version": 2, "canonical": {"version": 1, "config": str(self.config), "bridge": str(self.bridge), "seal_id": "fixture-reviewed-seal"},
                                 "projects": {str(self.project): {"fence": 118}}})
        self.owner = {"hostId": socket.gethostname(), "harness": "fixture", "nativeSessionId": "fixture-session"}
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

    def test_eof_leaves_durable_unknown_and_blocks_takeover_after_expiry(self):
        with self.assertRaisesRegex(RuntimeError, "simulated unknown effect"):
            with MODULE.ReleaseGate(self.proof_path, self.ledger, target=self.target):
                raise RuntimeError("simulated unknown effect")
        self.expire()
        binding = json.loads((self.resource / "execution-binding.json").read_text())
        self.assertIsNone(binding["resolved_receipt"])
        self.assertFalse(self.successor()["acquired"])


if __name__ == "__main__":
    unittest.main()
