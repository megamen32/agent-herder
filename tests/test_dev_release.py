import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dev_release", ROOT / "deploy/fleet/dev-release.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class DevReleaseTests(unittest.TestCase):
    def test_promote_uses_guarded_rollout(self):
        args = MODULE.parser().parse_args(["--catalog", "/tmp/herder-fleet", "--release-proof", "/tmp/proof.json", "promote", "--sha", "a" * 40])
        command = MODULE.promote_command(args, "a" * 40, "b" * 40)
        self.assertIn(str(MODULE.ROLLOUT), command)
        self.assertIn("--release-proof", command)
        self.assertIn("--previous-sha", command)
        self.assertNotIn("--current", command)

    def test_status_keeps_blue_and_staged_green_without_mutation(self):
        with tempfile.TemporaryDirectory() as raw:
            catalog = Path(raw); blue, green = "b" * 40, "a" * 40
            (catalog / "releases" / blue).mkdir(parents=True); (catalog / "releases" / green).mkdir()
            (catalog / "current").symlink_to(catalog / "releases" / blue)
            (catalog / "node-config.json").write_text(json.dumps({"sourceSha": blue}))
            args = MODULE.parser().parse_args(["--catalog", raw, "status"])
            self.assertEqual(MODULE.status(args), 0); self.assertEqual(MODULE.current_sha(catalog), blue)

    def test_rollback_plan_points_to_snapshot_release(self):
        with tempfile.TemporaryDirectory() as raw:
            catalog = Path(raw); blue, old = "b" * 40, "a" * 40
            (catalog / "releases" / blue).mkdir(parents=True); (catalog / "releases" / old).mkdir()
            (catalog / "current").symlink_to(catalog / "releases" / blue)
            (catalog / "node-config.json").write_text(json.dumps({"sourceSha": blue}))
            (catalog / f"node-config-before-{blue[:8]}.json").write_text(json.dumps({"sourceSha": old}))
            args = MODULE.parser().parse_args(["--catalog", raw, "rollback"])
            plan = MODULE.rollback_plan(args)
            self.assertEqual(plan["blue"], blue); self.assertEqual(plan["rollbackTo"], old)

    def test_status_does_not_call_rollback_release_green(self):
        with tempfile.TemporaryDirectory() as raw:
            catalog = Path(raw); blue, old = "b" * 40, "a" * 40
            (catalog / "releases" / blue).mkdir(parents=True); (catalog / "releases" / old).mkdir()
            (catalog / "current").symlink_to(catalog / "releases" / blue)
            (catalog / "node-config.json").write_text(json.dumps({"sourceSha": blue}))
            (catalog / f"node-config-before-{blue[:8]}.json").write_text(json.dumps({"sourceSha": old}))
            args = MODULE.parser().parse_args(["--catalog", raw, "status"])
            output = io.StringIO()
            with redirect_stdout(output): MODULE.status(args)
            value = json.loads(output.getvalue())
            self.assertIsNone(value["green"]["sha"])
            self.assertEqual(value["rollback"]["rollbackTo"], old)

    def test_stop_without_apply_is_plan_only(self):
        with tempfile.TemporaryDirectory() as raw:
            self.assertEqual(MODULE.main(["--state-dir", raw, "stop"]), 0)


if __name__ == "__main__": unittest.main()
