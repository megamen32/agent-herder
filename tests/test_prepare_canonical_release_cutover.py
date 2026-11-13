import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_cutover", ROOT / "deploy/fleet/prepare_canonical_release_cutover.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CutoverProposalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-cutover-proposal-")
        self.root = Path(self.temp.name)
        self.ledger = self.root / "ledger.json"
        self.config = self.root / "compat.json"
        self.process = self.root / "process.json"
        self.bridge = self.root / "bridge"
        self.bridge.write_text("inactive fixture, never executed\n")
        self.authority = self.root / "authority"
        self.resource = self.authority / "resources" / "release"
        self.resource.mkdir(parents=True)
        (self.authority / "storage.json").write_text(json.dumps({"schema": "v1", "storage_id": "storage"}))
        (self.resource / "resource.json").write_text(json.dumps({"schema": "v1", "storage_id": "storage", "resource_ref": "release",
            "descriptor": {"resource_ref": "release", "revision": 1, "external_ref": "fixture-target"}}))
        self.process.write_text(json.dumps({"administrators": ["alice"], "resources": {"root": str(self.authority), "schema": "v1", "storage_id": "storage"}}))
        self.state = {"version": 1, "projects": {"/fixture/.git": {"fence": 118, "sessions": {}}}}
        self.mapping = {"version": 1, "process_config": str(self.process), "ledger": str(self.ledger), "seal_id": "reviewed-fixture",
                        "principal_ref": "alice", "mappings": [{"project": "/fixture/.git", "resource_ref": "release", "revision": 1,
                        "previous_fence": 118, "deployment_target": {"fleetDir": "/fixture/fleet", "unit": "fixture.service"}}]}
        self.persist()

    def tearDown(self):
        self.temp.cleanup()

    def persist(self):
        self.ledger.write_text(json.dumps(self.state))
        self.config.write_text(json.dumps(self.mapping))

    def prepare(self):
        return MODULE.prepare(self.ledger, self.config, self.bridge, now_ms=10000)

    def test_proposal_is_read_only_and_preserves_the_fence(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        result = self.prepare()
        self.assertTrue(result["data_ready"])
        self.assertFalse(result["live_cutover_authorized"])
        self.assertEqual(result["expected_ledger_sha256"], hashlib.sha256(before[self.ledger]).hexdigest())
        self.assertEqual(result["resource_fence_seeds"], {"release": 118})
        self.assertEqual(result["proposed_sealed_ledger"]["projects"], self.state["projects"])
        self.assertEqual(result["proposed_sealed_ledger"]["version"], 2)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_expired_legacy_owner_is_a_blocker_and_its_hash_is_not_printed(self):
        self.state["projects"]["/fixture/.git"]["lease"] = {"fence": 118, "expiresAt": 9999, "tokenHash": "private-proof-hash"}
        self.persist()
        before = self.ledger.read_bytes()
        result = self.prepare()
        self.assertFalse(result["data_ready"])
        self.assertTrue(result["blockers"][0]["expired"])
        self.assertIsNone(result["proposed_sealed_ledger"])
        self.assertNotIn("private-proof-hash", json.dumps(result))
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_counter_regression_or_resource_revision_drift_is_rejected(self):
        self.mapping["mappings"][0]["previous_fence"] = 117
        self.persist()
        with self.assertRaisesRegex(ValueError, "cannot_decrease"):
            self.prepare()
        self.mapping["mappings"][0]["previous_fence"] = 118
        self.mapping["mappings"][0]["revision"] = 2
        self.persist()
        with self.assertRaisesRegex(ValueError, "revision_mismatch"):
            self.prepare()

    def test_aliases_share_the_maximum_prior_fence_and_exact_target(self):
        alias = {**self.mapping["mappings"][0], "project": "/fixture-alias/.git", "previous_fence": 200}
        self.mapping["mappings"].append(alias)
        self.persist()
        self.assertEqual(self.prepare()["resource_fence_seeds"], {"release": 200})
        alias["deployment_target"] = {"fleetDir": "/different", "unit": "other.service"}
        self.persist()
        with self.assertRaisesRegex(ValueError, "aliases_disagree"):
            self.prepare()

    def test_existing_canonical_owner_and_unknown_occupancy_block_cutover(self):
        (self.resource / "owner.json").write_text("{}")
        (self.resource / "execution-binding.json").write_text(json.dumps({"resolved_receipt": None}))
        result = self.prepare()
        self.assertFalse(result["data_ready"])
        self.assertEqual({b["reason"] for b in result["blockers"]}, {"canonical_owner_requires_reconciliation", "canonical_occupancy_unresolved"})

    def test_one_local_unit_cannot_be_remapped_to_a_different_resource_or_fleet(self):
        alias = {**self.mapping["mappings"][0], "project": "/fixture-other/.git", "resource_ref": "other-resource",
                 "deployment_target": {"fleetDir": "/other-fleet", "unit": "fixture.service"}}
        self.mapping["mappings"].append(alias)
        self.persist()
        with self.assertRaisesRegex(ValueError, "unit_has_multiple"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
