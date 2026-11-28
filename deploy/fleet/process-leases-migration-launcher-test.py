#!/usr/bin/env python3
"""Native migration epochs are selected by pinned private configuration."""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("migration_launcher", str(Path(__file__).with_name("launch-v1-core.py")))
spec = importlib.util.spec_from_loader(loader.name, loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)


class MigrationLauncherContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-migration-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        artifacts = {}
        for name in ("core", "compat", "node", "bootstrap", "adapter"):
            artifacts[name] = self.root / name
            self.save(artifacts[name], b"isolated artifact " + name.encode())
        self.manifest = {name: str(artifacts[name]) for name in ("core", "compat", "node", "bootstrap")}
        self.manifest.update(source_commit="a" * 40, adapters={"codex": str(artifacts["adapter"])},
                             sha256={name: launcher.digest(artifacts[name]) for name in ("core", "compat", "node", "bootstrap")})
        self.manifest["sha256"]["adapters"] = {"codex": launcher.digest(artifacts["adapter"])}
        self.profile = self.root / "profile.json"
        self.save(self.profile, {"owner": {"kind": "codex", "node": "local", "instance": "one",
            "executable": str(artifacts["node"]), "ahap_script": str(artifacts["adapter"])}})
        self.config = self.root / "canonical.json"
        self.save(self.config, {"version": 1, "mode": "canonical", "epoch": "reviewed-epoch"})
        self.selector = self.root / "selector.json"
        self.seal()

    def save(self, path, value):
        raw = value if isinstance(value, bytes) else (json.dumps(value) + "\n").encode()
        path.write_bytes(raw)
        path.chmod(0o600)

    def seal(self):
        path = self.root / "manifest.json"
        self.save(path, self.manifest)
        self.save(self.selector, {"manifest": str(path), "manifest_sha256": launcher.digest(path),
                                 "profiles": [str(self.profile)]})

    def bind(self):
        self.manifest["canonical_migration"] = {"config": str(self.config), "sha256": launcher.digest(self.config)}
        self.seal()

    def test_inherited_epoch_is_removed_without_a_manifest_binding(self):
        with patch.dict(os.environ, {"AGENT_HERDER_MIGRATION_EPOCH": "untrusted-inherited-epoch"}):
            _, env, receipt = launcher.prepare(self.selector)
        self.assertNotIn("AGENT_HERDER_MIGRATION_EPOCH", env)
        self.assertIsNone(receipt["canonical_migration"])

    def test_pinned_epoch_overrides_inheritance_and_is_reported(self):
        self.bind()
        with patch.dict(os.environ, {"AGENT_HERDER_MIGRATION_EPOCH": "wrong-epoch"}):
            _, env, receipt = launcher.prepare(self.selector)
        self.assertEqual(env["AGENT_HERDER_MIGRATION_EPOCH"], "reviewed-epoch")
        self.assertEqual(receipt["canonical_migration"], {
            "config": str(self.config), "config_sha256": launcher.digest(self.config), "epoch": "reviewed-epoch"})

    def test_private_profile_parent_alias_is_readable(self):
        alias = self.root / "profile-artifact-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.selector.write_text(json.dumps({
            "manifest": str(self.root / "manifest.json"),
            "manifest_sha256": launcher.digest(self.root / "manifest.json"),
            "profiles": [str(alias / self.profile.name)],
        }) + "\n")
        self.selector.chmod(0o600)

        argv, _, _ = launcher.prepare(self.selector)
        self.assertEqual(argv[1:], ["--trusted-owner-profile", str(alias / self.profile.name)])

    def test_config_mutation_after_manifest_seal_blocks_launch(self):
        self.bind()
        self.save(self.config, {"version": 1, "mode": "canonical", "epoch": "replaced-epoch"})
        with self.assertRaisesRegex(ValueError, "digest mismatched"):
            launcher.prepare(self.selector)

    def test_browser_account_added_after_migration_uses_its_own_authority(self):
        self.manifest["adapters"]["zai"] = self.manifest["adapters"]["codex"]
        self.manifest["sha256"]["adapters"]["zai"] = self.manifest["sha256"]["adapters"]["codex"]
        config = json.loads(self.config.read_bytes())
        config["quarantine"] = {"snapshots": [
            {"node_ref": "local", "instance_ref": "existing", "authority_generation": "original"},
        ]}
        self.save(self.config, config)
        self.bind()
        selector = json.loads(self.selector.read_bytes())
        for instance, generation in [("existing", "changed"), ("relocated", "original"), ("new", "fresh")]:
            profile = self.root / (instance + ".json")
            self.save(profile, {"generation": generation, "owner": {
                "kind": "zai", "node": "local", "instance": instance, "executable": self.manifest["core"],
                "ahap_env": {"AHAP_BROWSER_TRANSPORT": "herder-extension"},
            }})
            selector["profiles"].append(str(profile))
        self.save(self.selector, selector)
        with patch.dict(os.environ, {"AGENT_HERDER_MIGRATION_NEW_AUTHORITIES": '[["local","existing","changed"]]'}):
            _, env, _ = launcher.prepare(self.selector)
        self.assertEqual(json.loads(env["AGENT_HERDER_MIGRATION_NEW_AUTHORITIES"]), [["local", "new", "fresh"]])
        self.assertEqual(env["AGENT_HERDER_MIGRATION_EPOCH"], "reviewed-epoch")

    def test_only_fresh_pinned_remote_codex_gets_a_new_authority_scope(self):
        script = self.root / "remote-runner.js"
        companion = Path(str(script) + ".json")
        self.save(script, b"isolated wrapper")
        self.save(companion, {"nodeRef": "remote", "kind": "codex"})
        self.manifest["remote_ahap_wrappers"] = [{
            "node": "remote", "instance": "new", "kind": "codex", "script": str(script),
            "script_sha256": launcher.digest(script), "config_sha256": launcher.digest(companion),
        }]
        config = json.loads(self.config.read_bytes())
        config["quarantine"] = {"snapshots": [
            {"node_ref": "local", "instance_ref": "one", "authority_generation": "original"},
        ]}
        self.save(self.config, config)
        self.bind()
        owner = {"kind": "codex", "node": "remote", "instance": "new",
                 "executable": self.manifest["node"], "ahap_script": str(script),
                 "fresh_remote_codex_authority": True}
        self.save(self.profile, {"generation": "fresh", "owner": owner})
        _, env, _ = launcher.prepare(self.selector)
        self.assertEqual(json.loads(env["AGENT_HERDER_MIGRATION_NEW_AUTHORITIES"]), [["remote", "new", "fresh"]])
        self.assertEqual(env["AGENT_HERDER_MIGRATION_EPOCH"], "reviewed-epoch")
        self.save(self.profile, {"generation": "original", "owner": owner})
        _, env, _ = launcher.prepare(self.selector)
        self.assertNotIn("AGENT_HERDER_MIGRATION_NEW_AUTHORITIES", env)
        self.save(self.profile, {"generation": "fresh", "owner": {
            **owner, "ahap_script": self.manifest["adapters"]["codex"],
        }})
        with self.assertRaisesRegex(ValueError, "requires a pinned wrapper"):
            launcher.prepare(self.selector)

    def test_old_launcher_cannot_pass_candidate_preflight_with_new_migration(self):
        candidate_loader = importlib.machinery.SourceFileLoader(
            "migration_candidate", str(Path(__file__).with_name("process-leases-candidate.py")))
        candidate_spec = importlib.util.spec_from_loader(candidate_loader.name, candidate_loader)
        candidate = importlib.util.module_from_spec(candidate_spec)
        candidate_loader.exec_module(candidate)
        for name in ("core", "compat", "node", "bootstrap"):
            Path(self.manifest[name]).chmod(0o700)
        self.bind()
        old = self.root / "old-launcher.py"
        self.save(old, b"import json\nfrom pathlib import Path\ndef prepare(selector):\n s=json.loads(Path(selector).read_text());m=json.loads(Path(s['manifest']).read_text())\n return [m['compat']],{'HERDER_NATIVE_COMMAND':m['core']},{}\n")
        with self.assertRaisesRegex(ValueError, "pinned canonical migration epoch"):
            candidate.check_selector(self.selector, old, require_worker=False)
        reviewed = self.root / "reviewed-launcher.py"
        self.save(reviewed, Path(__file__).with_name("launch-v1-core.py").read_bytes())
        checked = candidate.check_selector(self.selector, reviewed, require_worker=False)
        self.assertEqual(checked["canonical_migration"]["epoch"], "reviewed-epoch")

    def test_symlink_or_shared_config_cannot_select_epoch(self):
        self.bind()
        self.config.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "not private"):
            launcher.prepare(self.selector)
        self.config.chmod(0o600)
        link = self.root / "linked.json"
        link.symlink_to(self.config)
        self.manifest["canonical_migration"]["config"] = str(link)
        self.seal()
        with self.assertRaisesRegex(ValueError, "not canonical"):
            launcher.prepare(self.selector)

    def test_invalid_or_ambiguous_epoch_blocks_launch(self):
        values = [
            {"version": True, "mode": "canonical", "epoch": "one"},
            {"version": 1, "mode": "legacy", "epoch": "one"},
            {"version": 1, "mode": "canonical", "epoch": " one"},
            {"version": 1, "mode": "canonical", "epoch": "one\ntwo"},
            {"version": 1, "mode": "canonical", "epoch": "я" * 65},
            {"version": 1, "mode": "canonical", "epoch": "x\u0085y"},
            b'{"version":1,"mode":"canonical","epoch":"one","epoch":"two"}',
        ]
        for value in values:
            with self.subTest(value=value):
                self.save(self.config, value)
                self.bind()
                with self.assertRaises(ValueError):
                    launcher.prepare(self.selector)


if __name__ == "__main__":
    unittest.main(verbosity=2)
