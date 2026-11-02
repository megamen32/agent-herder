"""Synthetic tests for guarded root MCP-child entrypoint switch; no live service touched."""
import importlib.util
import hashlib
import os
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

    def test_valid_other_project_proof_with_same_target_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="mcp-proof-binding-") as base:
            root = Path(base)
            repo = root / "repo"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            project = str((repo / ".git").resolve())
            other_project = str(root / "other.git")
            owner = {"hostId": "fixture", "harness": "test", "nativeSessionId": "fixture"}
            token = "a" * 64
            proof = {"project": other_project, "owner": owner, "token": token, "fence": 1}
            proof_path, ledger = root / "proof.json", root / "ledger.json"
            proof_path.write_text(json.dumps(proof))
            ledger.write_text(json.dumps({"projects": {other_project: {"lease": {
                "owner": owner, "fence": 1, "expiresAt": 2000,
                "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
                "deploymentTarget": rollout.TARGET,
            }}}}))
            gate = rollout.ReleaseGate(proof_path, state_path=ledger,
                                       target=rollout.TARGET, now=lambda: 1000)
            gate.check()  # Regression: this valid but unrelated proof passed the old gate.
            with patch.object(rollout, "REPO", repo):
                with self.assertRaisesRegex(RuntimeError, "release_lease_project_mismatch"):
                    rollout.assert_project_binding(gate)
                gate.proof["project"] = project
                rollout.assert_project_binding(gate)

    def test_final_snapshot_rejects_intervening_foreign_write(self):
        with tempfile.TemporaryDirectory(prefix="mcp-cas-") as base:
            root = Path(base)
            old, candidate = root / "index.js", root / "candidate.js"
            old.write_text("previous")
            candidate.write_text("candidate")
            expected = rollout.entrypoint_snapshot(old)
            guard = Gate()
            def change_before_commit(cleanup=False):
                old.write_text("foreign-change")
            guard.check = change_before_commit
            with self.assertRaisesRegex(RuntimeError, "live_entrypoint_changed_before_commit"):
                rollout.atomic_entrypoint_switch(old, candidate, root / "backup", guard, expected)
            self.assertEqual(old.read_text(), "foreign-change")
            self.assertEqual((root / "backup/index.js").read_text(), "previous")
            self.assertEqual(list(root.glob(".mcp-entrypoint-*")), [])

    def test_foreign_symlink_to_same_candidate_is_not_rolled_back(self):
        with tempfile.TemporaryDirectory(prefix="mcp-foreign-link-") as base:
            root = Path(base)
            old, candidate = root / "index.js", root / "candidate.js"
            old.write_text("previous")
            candidate.write_text("candidate")
            guard = Gate()
            def change_before_commit(cleanup=False):
                old.unlink()
                old.symlink_to(candidate)
            guard.check = change_before_commit
            with self.assertRaisesRegex(RuntimeError, "live_entrypoint_changed_before_commit"):
                rollout.atomic_entrypoint_switch(old, candidate, root / "backup", guard)
            self.assertTrue(old.is_symlink())
            self.assertEqual(old.resolve(), candidate)

    def test_post_replace_failure_restores_regular_or_relative_symlink_entry(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory(prefix="mcp-rollback-") as base:
                root = Path(base)
                old, candidate = root / "index.js", root / "candidate.js"
                previous = root / "previous.js"
                previous.write_text("previous")
                if symlink:
                    old.symlink_to("previous.js")
                else:
                    old.write_text("previous")
                candidate.write_text("candidate")
                replace = os.replace
                calls = []
                def fail_after_replace(source, destination):
                    replace(source, destination)
                    calls.append((source, destination))
                    if len(calls) == 1:
                        raise RuntimeError("injected_after_replace")
                guard = Gate()
                with patch.object(rollout.os, "replace", side_effect=fail_after_replace):
                    with self.assertRaisesRegex(RuntimeError, "injected_after_replace"):
                        rollout.atomic_entrypoint_switch(old, candidate, root / "backup", guard)
                self.assertEqual(old.read_text(), "previous")
                self.assertEqual(old.is_symlink(), symlink)
                if symlink:
                    self.assertEqual(os.readlink(old), "previous.js")
                self.assertEqual(guard.checks, 2)
                self.assertEqual(list(root.glob(".mcp-entrypoint-*")), [])
                self.assertEqual(list(root.glob(".mcp-recover-*")), [])

    def test_rollback_preserves_foreign_change_during_cleanup_or_staging(self):
        for change_during in ("cleanup", "staging"):
            with self.subTest(change_during=change_during), tempfile.TemporaryDirectory(prefix="mcp-rollback-foreign-") as base:
                root = Path(base)
                old, candidate = root / "index.js", root / "candidate.js"
                old.write_text("previous")
                candidate.write_text("candidate")
                replace, copy2 = os.replace, rollout.shutil.copy2
                guard = Gate()
                def foreign_replace():
                    foreign = root / "foreign.js"
                    foreign.write_text("foreign-change")
                    replace(foreign, old)
                def fail_after_replace(source, destination):
                    replace(source, destination)
                    if Path(source).name.startswith(".mcp-entrypoint-"):
                        raise RuntimeError("injected_after_replace")
                def cleanup_check(cleanup=False):
                    if cleanup and change_during == "cleanup":
                        foreign_replace()
                def recovery_copy(source, destination):
                    result = copy2(source, destination)
                    if Path(destination).name.startswith(".mcp-recover-") and change_during == "staging":
                        foreign_replace()
                    return result
                guard.check = cleanup_check
                with patch.object(rollout.os, "replace", side_effect=fail_after_replace), \
                     patch.object(rollout.shutil, "copy2", side_effect=recovery_copy):
                    with self.assertRaisesRegex(RuntimeError, "injected_after_replace"):
                        rollout.atomic_entrypoint_switch(old, candidate, root / "backup", guard)
                self.assertFalse(old.is_symlink())
                self.assertEqual(old.read_text(), "foreign-change")
                self.assertEqual(list(root.glob(".mcp-entrypoint-*")), [])
                self.assertEqual(list(root.glob(".mcp-recover-*")), [])

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
