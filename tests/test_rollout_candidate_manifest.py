import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "rollout_candidate_manifest", ROOT / "deploy/fleet/rollout-candidate.py"
)
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)


class RolloutCandidateManifestTests(unittest.TestCase):
    def release(self, root: Path, *, node_marker: str) -> Path:
        release = root / "releases" / ("a" * 40)
        (release / "dist").mkdir(parents=True)
        (release / "dist" / "index.js").write_text("export {};\n")
        (release / "package.json").write_text("{}\n")
        (release / "package-lock.json").write_text("{}\n")
        (release / "node_modules").mkdir()
        (release / "node_modules" / "host-marker").write_text(node_marker)
        entries = rollout.release_rules.bundle_entries(release, exclude=("build-manifest.json",))
        payload = rollout.release_rules.payload_entries(release, exclude=("build-manifest.json",))
        (release / "build-manifest.json").write_text(json.dumps({
            "sourceSha": "a" * 40,
            "bundleFingerprint": rollout.release_rules.bundle_fingerprint(entries),
            "bundleFiles": len(entries),
            "payloadFingerprint": rollout.release_rules.payload_fingerprint(payload),
            "payloadFiles": len(payload),
        }))
        return release

    def test_fleet_uses_portable_payload_when_host_package_farm_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.release(root, node_marker="built-on-owner")
            manifest = json.loads((release / "build-manifest.json").read_text())
            (release / "node_modules" / "host-marker").write_text("prepared-on-target")
            result = rollout.validate_release_manifest(release, "a" * 40, "fleet")
            self.assertEqual(result["payload_fingerprint"], manifest["payloadFingerprint"])
            self.assertNotEqual(result["bundle_fingerprint"], manifest["bundleFingerprint"])

    def test_owner_still_requires_the_complete_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.release(root, node_marker="built-on-owner")
            (release / "node_modules" / "host-marker").write_text("changed")
            with self.assertRaisesRegex(RuntimeError, "owner release"):
                rollout.validate_release_manifest(release, "a" * 40, "owner")


if __name__ == "__main__":
    unittest.main()
