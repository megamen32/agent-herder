"""Synthetic tests for guarded root MCP-child entrypoint switch; no live service touched."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/fleet/rollout-mcp-child.py"
spec = importlib.util.spec_from_file_location("guarded_root_mcp_rollout", SCRIPT)
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class Gate:
    def __init__(self, deny=False):
        self.deny = deny
        self.checks = 0

    def check(self, cleanup=False):
        self.checks += 1
        if self.deny:
            raise RuntimeError("release_lease_not_owned_or_expired")


class TestRootMcpChildSwitch(unittest.TestCase):
    def test_atomic_symlink_loads_complete_candidate_tree_and_preserves_old(self):
        with tempfile.TemporaryDirectory(prefix="mcp-child-switch-") as base:
            root = Path(base)
            old = root / "repo/dist"
            candidate = root / "candidate/dist"
            old.mkdir(parents=True)
            candidate.mkdir(parents=True)
            for directory, label in ((old, "OLD"), (candidate, "NEW")):
                (directory / "package.json").write_text('{"type":"module"}')
                (directory / "label.js").write_text(f'export const label = "{label}";')
                (directory / "index.js").write_text('import {label} from "./label.js"; console.log(label);')
            before = subprocess.check_output(["node", str(old / "index.js")], text=True).strip()
            self.assertEqual(before, "OLD")
            guard = Gate()
            backup = rollout.atomic_entrypoint_switch(
                old / "index.js", candidate / "index.js", root / "backup", guard)
            self.assertGreaterEqual(guard.checks, 1)
            self.assertTrue((old / "index.js").is_symlink())
            self.assertEqual(backup.read_text(), 'import {label} from "./label.js"; console.log(label);')
            self.assertEqual(subprocess.check_output(["node", str(old / "index.js")],
                                                     text=True).strip(), "NEW")
            self.assertEqual((old / "label.js").read_text(), 'export const label = "OLD";')

    def test_mixed_legacy_requires_known_reviewed_release_bytes(self):
        with tempfile.TemporaryDirectory(prefix="mcp-mixed-legacy-") as base:
            root = Path(base)
            repo = root / "repo"
            olddist = repo / "dist"
            review = root / ("b" * 40) / "dist"
            olddist.mkdir(parents=True)
            review.mkdir(parents=True)
            names = ("index.js", "mcp/project-release-tools.js", "project-release-lease.js")
            for name in names:
                (olddist / name).parent.mkdir(parents=True, exist_ok=True)
                (review / name).parent.mkdir(parents=True, exist_ok=True)
                (olddist / name).write_text(name + ":reviewed")
                (review / name).write_text(name + ":reviewed")
            (olddist / "fleet-deployment-manifest.json").write_text(json.dumps({
                "source_sha": "a" * 40, "payload": {"index.js": "0" * 64}}))
            (review / "fleet-deployment-manifest.json").write_text(json.dumps({
                "source_sha": "b" * 40, "payload": {}}))
            with ExitStack() as stack:
                stack.enter_context(patch.object(rollout, "REPO", repo))
                stack.enter_context(patch.object(rollout, "ENTRYPOINT", olddist / "index.js"))
                stack.enter_context(patch.object(rollout, "KNOWN_RECOVERY_RELEASE", review.parent))
                _, old_sha = rollout.existing_source()
                self.assertEqual(old_sha, "b" * 40)
                (olddist / "mcp/project-release-tools.js").write_text("unreviewed")
                with self.assertRaisesRegex(RuntimeError, "mixed_runtime_unverified"):
                    rollout.existing_source()

    def test_guard_refusal_preserves_entrypoint(self):
        with tempfile.TemporaryDirectory(prefix="mcp-child-refuse-") as base:
            root = Path(base)
            old, candidate = root / "index.js", root / "candidate.js"
            old.write_text("previous")
            candidate.write_text("candidate")
            guard = Gate(deny=True)
            with self.assertRaisesRegex(RuntimeError, "release_lease_not_owned_or_expired"):
                rollout.atomic_entrypoint_switch(old, candidate, root / "backup", guard)
            self.assertFalse(old.is_symlink())
            self.assertEqual(old.read_text(), "previous")
            self.assertEqual(list(root.glob(".mcp-entrypoint-*")), [])


if __name__ == "__main__":
    unittest.main()
