"""The candidate builder must preserve the exact live node config snapshot."""
import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_release_candidate", ROOT / "deploy/fleet/build-release-candidate.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class BuildNodeConfigSnapshotTests(unittest.TestCase):
    def test_existing_live_config_with_previous_source_sha_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "node-config.json"
            config.write_text('{"sourceSha":"af06240abbe0a9567289b40e0e44328ee49e1942"}\n')
            before = builder.snapshot_node_config(config)

            ok, detail = builder.node_config_matches_snapshot(config, before)

            self.assertTrue(ok, detail)
            self.assertNotEqual(builder.json.loads(before)["sourceSha"], "b" * 40)

    def test_config_change_during_build_fails_exact_snapshot_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "node-config.json"
            config.write_text('{"sourceSha":"af06240abbe0a9567289b40e0e44328ee49e1942"}\n')
            before = builder.snapshot_node_config(config)
            config.write_text('{"sourceSha":"b"}\n')

            ok, detail = builder.node_config_matches_snapshot(config, before)

            self.assertFalse(ok)
            self.assertIn("changed", detail)


if __name__ == "__main__":
    unittest.main()
