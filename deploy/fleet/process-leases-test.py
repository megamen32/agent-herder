#!/usr/bin/env python3
"""Isolated rollout contract checks. No running Herder or live selector is used."""
import argparse
import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader(
    "process_leases_candidate", str(Path(__file__).with_name("process-leases-candidate.py")))
spec = importlib.util.spec_from_loader(loader.name, loader)
candidate = importlib.util.module_from_spec(spec)
loader.exec_module(candidate)

OLD_LAUNCHER = """import json
from pathlib import Path
def prepare(selector):
    s = json.loads(Path(selector).read_text())
    m = json.loads(Path(s['manifest']).read_text())
    return [m['compat']], {'HERDER_NATIVE_COMMAND': m['core']}, {}
"""
NEW_LAUNCHER = """import json
from pathlib import Path
def prepare(selector):
    s = json.loads(Path(selector).read_text())
    m = json.loads(Path(s['manifest']).read_text())
    env = {'HERDER_NATIVE_COMMAND': m['core']}
    for key, name in [('process_worker', 'HERDER_PROCESS_WORKER'), ('process_config', 'HERDER_PROCESS_CONFIG')]:
        if key in m:
            env[name] = m[key]
    return [m['compat']], env, {}
"""


class RolloutContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="herder-process-leases-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.old = self.root / "old"
        self.new = self.root / "new"
        for path in (self.old, self.new, self.new / "fixture"):
            path.mkdir(mode=0o700)
        self.profile = self.root / "profile.json"
        candidate.create(self.profile, candidate.encoded({"owner": {"principal": "owner-a"}}))
        self.database = self.root / "state.db"
        candidate.create(self.database, b"untouched durable authority database")
        artifacts = {}
        for key in ("core", "compat", "node", "bootstrap", "adapter"):
            path = self.old / key
            candidate.create(path, ("pinned old " + key).encode(), 0o500)
            artifacts[key] = str(path)
        self.base = {
            **{key: artifacts[key] for key in ("core", "compat", "node", "bootstrap")},
            "adapters": {"codex": artifacts["adapter"]},
            "sha256": {**{key: candidate.digest(artifacts[key]) for key in ("core", "compat", "node", "bootstrap")},
                       "adapters": {"codex": candidate.digest(artifacts["adapter"])}},
            "source_commit": "older-source",
            "component_provenance": {"browser_source_commit": "preserve-browser",
                                     "opencode_source_commit": "preserve-opencode"},
            "remote_ahap_wrappers": [{"script": "pinned-wrapper", "node": "remote-node"}],
            "composition": {"existing": "preserve"},
            "launch": [artifacts["core"]],
            "launch_compat": {"env": {"HERDER_NATIVE_COMMAND": artifacts["core"], "existing": "preserve"}},
        }
        self.base_manifest = self.old / "manifest.json"
        candidate.create(self.base_manifest, candidate.encoded(self.base))
        self.selector = self.root / "installed-selector.json"
        self.selection = {"manifest": str(self.base_manifest),
                          "manifest_sha256": candidate.digest(self.base_manifest),
                          "profiles": [str(self.profile)]}
        candidate.create(self.selector, candidate.encoded(self.selection))
        self.launcher = self.root / "agent-herder-v1"
        candidate.create(self.launcher, OLD_LAUNCHER.encode(), 0o700)
        self.before_selector = self.selector.read_bytes()
        self.before_launcher = self.launcher.read_bytes()
        self.before_db = self.database.read_bytes()
        self.config = candidate.process_config(
            self.selection, self.new / "fixture/herder_process_worker", "node-a",
            self.root / "executions", self.root / "resources", "stable-storage-a")
        hashes = {}
        for key, name in (("core", "herder_native_stdio"), ("process_worker", "herder_process_worker")):
            path = self.new / "fixture" / name
            candidate.create(path, ("new " + key).encode(), 0o500)
            hashes[key] = candidate.digest(path)
        self.config_path = self.new / "fixture/process-runtime.json"
        candidate.create(self.config_path, candidate.encoded(self.config))
        hashes["process_config"] = candidate.digest(self.config_path)
        self.manifest = candidate.compose_manifest(
            self.base, self.new, "new-source", self.base_manifest,
            candidate.digest(self.base_manifest), hashes, ["cargo", "build"])
        self.manifest_path = self.new / "manifest.json"
        candidate.create(self.manifest_path, candidate.encoded(self.manifest))
        self.new_selection = {**self.selection, "manifest": str(self.manifest_path),
                              "manifest_sha256": candidate.digest(self.manifest_path)}
        self.new_selector = self.new / "selector.json"
        candidate.create(self.new_selector, candidate.encoded(self.new_selection))
        self.new_launcher = self.new / "fixture/launch-v1-core.py"
        candidate.create(self.new_launcher, NEW_LAUNCHER.encode(), 0o500)
        self.build_receipt = {
            "base_selector": str(self.selector),
            "base_selector_sha256": candidate.digest(self.selector),
            "base_manifest_sha256": candidate.digest(self.base_manifest),
            "launcher_sha256": candidate.digest(self.new_launcher),
            "process_config_sha256": hashes["process_config"],
            "profile_sha256": {str(self.profile): candidate.digest(self.profile)},
            "candidate_selector_sha256": candidate.digest(self.new_selector),
            "candidate_manifest_sha256": candidate.digest(self.manifest_path)}
        candidate.create(self.new / "process-leases-build.json", candidate.encoded(self.build_receipt))
        self.install_args = argparse.Namespace(candidate=self.new_selector, selector=self.selector,
            launcher=self.launcher, backup=self.root / "backup",
            expected_selector_sha256=candidate.digest(self.selector))

    def test_check_does_not_provision_or_execute(self):
        result = candidate.check_selector(self.new_selector, self.new_launcher)
        self.assertEqual(result["source_commit"], "new-source")
        self.assertFalse((self.root / "resources").exists())
        self.assertFalse((self.root / "executions").exists())
        self.assertEqual(self.database.read_bytes(), self.before_db)

    def test_extensionless_installed_launcher(self):
        result = candidate.check_selector(self.selector, self.launcher, require_worker=False)
        self.assertEqual(result["profiles_count"], 1)

    def test_composition_retains_components_and_provenance(self):
        for key in ("compat", "node", "bootstrap", "adapters", "remote_ahap_wrappers"):
            self.assertEqual(self.manifest[key], self.base[key])
        self.assertEqual(self.manifest["component_provenance"]["browser_source_commit"], "preserve-browser")
        self.assertEqual(self.manifest["component_provenance"]["opencode_source_commit"], "preserve-opencode")
        self.assertEqual(self.new_selection["profiles"], self.selection["profiles"])
        self.assertEqual(self.manifest["launch_compat"]["env"]["existing"], "preserve")

    def test_worker_corruption_is_rejected(self):
        Path(self.manifest["process_worker"]).chmod(0o700)
        Path(self.manifest["process_worker"]).write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "artifact mismatch"):
            candidate.check_selector(self.new_selector, self.new_launcher)

    def test_config_corruption_is_rejected(self):
        self.config_path.write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "configuration digest mismatch"):
            candidate.check_selector(self.new_selector, self.new_launcher)

    def test_untrusted_admin_and_wrong_authority_are_rejected(self):
        for mutate in (
            lambda c: c["administrators"].append("untrusted-principal"),
            lambda c: c["resources"].update(authority_node="other-node"),
            lambda c: c["resources"].update(route={"type": "remote"}),
        ):
            config = copy.deepcopy(self.config)
            mutate(config)
            with self.assertRaises(ValueError):
                candidate.validate_process_config(config, self.selection, self.config["worker"])

    def test_symlink_store_is_rejected(self):
        (self.root / "resources").symlink_to(self.old, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "canonical"):
            candidate.state_roots(self.config)

    def test_foreign_marker_is_not_rewritten(self):
        resource = self.root / "resources"
        resource.mkdir(mode=0o700)
        marker = resource / "storage.json"
        candidate.create(marker, candidate.encoded({"schema": "v1", "storage_id": "foreign-store"}))
        before = marker.read_bytes()
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            candidate.install(self.install_args)
        self.assertEqual(marker.read_bytes(), before)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertFalse((self.root / "backup").exists())

    def test_selector_cas_rejects_changed_selection(self):
        self.selector.write_bytes(self.selector.read_bytes() + b"\n")
        before = self.selector.read_bytes()
        with self.assertRaisesRegex(ValueError, "selector changed"):
            candidate.install(self.install_args)
        self.assertEqual(self.selector.read_bytes(), before)
        self.assertEqual(self.launcher.read_bytes(), self.before_launcher)

    def test_profile_changes_invalidate_candidate(self):
        self.profile.write_bytes(candidate.encoded({"owner": {"principal": "owner-b"}}))
        with self.assertRaises(ValueError):
            candidate.install(self.install_args)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertFalse((self.root / "resources").exists())

    def test_install_and_rollback_preserve_authority_db(self):
        result = candidate.install(self.install_args)
        self.assertEqual(result["status"], "configured_pending_restart")
        self.assertTrue(result["restart_required"])
        self.assertEqual(self.database.read_bytes(), self.before_db)
        resource = self.root / "resources"
        self.assertEqual(candidate.read_json(resource / "storage.json"),
                         {"schema": "v1", "storage_id": "stable-storage-a"})
        for path in (resource, resource / "resources", self.root / "executions"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((resource / "storage.json").stat().st_mode), 0o600)
        outcome = candidate.rollback(argparse.Namespace(receipt=Path(result["rollback_receipt"])))
        self.assertEqual(outcome["status"], "configuration_rolled_back_pending_restart")
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertEqual(self.launcher.read_bytes(), self.before_launcher)
        self.assertEqual(self.database.read_bytes(), self.before_db)
        self.assertTrue((resource / "storage.json").exists())

    def test_interrupted_switch_is_recoverable(self):
        original = candidate.replace
        def interrupted(path, *args, **kwargs):
            if Path(path) == self.selector:
                raise OSError("injected failure before selector replacement")
            return original(path, *args, **kwargs)
        candidate.replace = interrupted
        try:
            with self.assertRaises(OSError):
                candidate.install(self.install_args)
        finally:
            candidate.replace = original
        self.assertNotEqual(self.launcher.read_bytes(), self.before_launcher)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        candidate.rollback(argparse.Namespace(receipt=self.root / "backup/receipt.json"))
        self.assertEqual(self.launcher.read_bytes(), self.before_launcher)
        self.assertEqual(self.database.read_bytes(), self.before_db)

    def test_rollback_refuses_newer_release(self):
        result = candidate.install(self.install_args)
        self.selector.write_bytes(self.selector.read_bytes() + b"\n")
        changed = self.selector.read_bytes()
        with self.assertRaisesRegex(ValueError, "another release"):
            candidate.rollback(argparse.Namespace(receipt=Path(result["rollback_receipt"])))
        self.assertEqual(self.selector.read_bytes(), changed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
