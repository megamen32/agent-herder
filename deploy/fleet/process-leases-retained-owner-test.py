#!/usr/bin/env python3
"""Restore one pinned retained authority through the guarded candidate path."""
import argparse
import copy
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import unittest


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(Path(__file__).with_name(filename)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


fixtures = load("retained_owner_fixtures", "process-leases-test.py")
candidate = fixtures.candidate


class RetainedOwnerContracts(unittest.TestCase):
    def setUp(self):
        fixtures.RolloutContracts.setUp(self)
        self.manifest.update(source_commit="a" * 40, source_sha="a" * 40)
        self.manifest["process_leases_build"]["source_commit"] = "a" * 40
        self.manifest["remote_ahap_wrappers"] = []
        browser = self.old / "ahap-browser.mjs"
        candidate.create(browser, b"retained reviewed browser adapter", 0o400)
        self.manifest["adapters"]["chatgpt"] = str(browser)
        self.manifest["sha256"]["adapters"]["chatgpt"] = candidate.digest(browser)
        self.current_profiles = []
        for index in range(7):
            directory = self.root / ("current-authority-" + str(index))
            directory.mkdir(mode=0o700)
            for name in ("state.db", "gate"):
                candidate.create(directory / name, ("existing-" + name).encode())
            profile = directory / "profile.json"
            candidate.create(profile, candidate.encoded({
                "database": str(directory / "state.db"), "gate": str(directory / "gate"),
                "generation": "current-generation-" + str(index),
                "owner": {"principal": "owner-a", "node": "node-a", "instance": "codex-" + str(index),
                          "kind": "codex", "executable": self.manifest["node"],
                          "ahap_script": self.manifest["adapters"]["codex"],
                          "code_home": str(directory), "cwd": str(directory),
                          "existing_sessions": ["preserve-session-" + str(index)]}}))
            self.current_profiles.append(str(profile))
        self.authority = self.root / "retained-authority"
        self.authority.mkdir(mode=0o700)
        self.retained_db, self.retained_gate = self.authority / "state.db", self.authority / "gate"
        candidate.create(self.retained_db, b"")
        candidate.create(self.retained_gate, b"")
        self.retained = self.authority / "profile-chatgpt.json"
        self.generation = "ahap-owner-123456789"
        self.profile_value = {
            "database": str(self.retained_db), "gate": str(self.retained_gate), "generation": self.generation,
            "owner": {"principal": "owner-a", "node": "node-a", "instance": "chatgpt-retained",
                      "kind": "chatgpt", "executable": self.manifest["node"], "ahap_script": str(browser),
                      "code_home": str(self.authority), "cwd": str(self.authority),
                      "existing_sessions": ["retained-session"], "policy": {"unchanged": True},
                      "ahap_env": {"AHAP_USERIO_ACCOUNT_SCOPE": "retained-account"}}}
        candidate.create(self.retained, candidate.encoded(self.profile_value))
        self.snapshot_value = {
            "version": 1, "kind": "herder-legacy-quarantine", "epoch": "retained-epoch",
            "node_ref": "node-a", "instance_ref": "chatgpt-retained", "authority_generation": self.generation,
            "writer_drain_sha256": "c" * 64, "inventory_sha256": "d" * 64,
            "records": [{"request_keys": ["unknown-retained-request"], "outcome": "unknown"}]}
        self.snapshot = self.root / "quarantine.json"
        candidate.create(self.snapshot, candidate.encoded(self.snapshot_value), 0o400)
        self.canonical_config = self.root / "canonical.json"
        self.config_value = {
            "version": 1, "mode": "canonical", "epoch": "retained-epoch",
            "authority": "mcp:shell:node-a:AgentHerder",
            "writer_drain": {"path": str(self.root / "drain.json"), "sha256": "c" * 64},
            "quarantine": {"inventory_sha256": "d" * 64, "snapshots": [{
                "harness": "chatgpt", "node_ref": "node-a", "instance_ref": "chatgpt-retained",
                "authority_generation": self.generation, "path": str(self.snapshot),
                "sha256": candidate.digest(self.snapshot)}]}}
        candidate.create(self.canonical_config, candidate.encoded(self.config_value), 0o400)
        self.manifest["canonical_migration"] = {
            "config": str(self.canonical_config), "sha256": candidate.digest(self.canonical_config)}
        dm, gm = self.retained_db.stat(), self.retained_gate.stat()
        with sqlite3.connect(self.retained_db) as db:
            db.executescript("""
                PRAGMA user_version=4;
                CREATE TABLE humanstop_authority
                  (singleton, generation, gate_device, gate_inode, database_device, database_inode);
                CREATE TABLE settings (scope, setting_key, value_json);
                CREATE TABLE intents (request_key, outcome);
                CREATE TABLE session_bindings (session_ref);
                CREATE TABLE humanstop_sessions (session_ref);
            """)
            db.execute("INSERT INTO humanstop_authority VALUES (1,?,?,?,?,?)",
                       (self.generation, gm.st_dev, gm.st_ino, dm.st_dev, dm.st_ino))
            db.execute("INSERT INTO settings VALUES ('migration:legacy','quarantine:v1',?)",
                       (self.snapshot.read_text(),))
            db.execute("INSERT INTO intents VALUES ('unknown-retained-request','unknown')")
            db.execute("INSERT INTO session_bindings VALUES ('retained-session')")
            db.execute("INSERT INTO humanstop_sessions VALUES ('retained-session')")
        db.close()
        self.manifest_path.write_bytes(candidate.encoded(self.manifest))
        self.selection = {"manifest": str(self.manifest_path), "manifest_sha256": candidate.digest(self.manifest_path),
                          "profiles": self.current_profiles}
        self.selector.write_bytes(candidate.encoded(self.selection))
        self.launcher.write_bytes(Path(__file__).with_name("launch-v1-core.py").read_bytes())
        self.donor_manifest = self.root / "historical-manifest.json"
        candidate.create(self.donor_manifest, candidate.encoded(self.manifest), 0o400)
        self.donor = self.root / "historical-selector.json"
        candidate.create(self.donor, candidate.encoded({
            "manifest": str(self.donor_manifest), "manifest_sha256": candidate.digest(self.donor_manifest),
            "profiles": [str(self.retained)]}), 0o400)
        self.output = self.root / "restored-candidate"
        self.before_selector = self.selector.read_bytes()
        self.before_launcher = self.launcher.read_bytes()
        self.before_retained = self.retained.read_bytes()
        self.before_db = self.retained_db.read_bytes()
        self.before_profiles = {p: Path(p).read_bytes() for p in self.current_profiles}
        self.args = argparse.Namespace(
            selector=self.selector, launcher=self.launcher, output=self.output,
            expected_selector_sha256=candidate.digest(self.selector),
            retained_selector=(str(self.donor), candidate.digest(self.donor)),
            profile=(str(self.retained), candidate.digest(self.retained)))

    def stage(self):
        result = subprocess.run([
            "python3", str(Path(candidate.__file__).resolve()), "restore-retained-owner",
            "--selector", str(self.args.selector), "--launcher", str(self.args.launcher),
            "--output", str(self.args.output), "--expected-selector-sha256", self.args.expected_selector_sha256,
            "--retained-selector", *self.args.retained_selector, "--profile", *self.args.profile,
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def assert_authority_unchanged(self):
        self.assertEqual(self.retained.read_bytes(), self.before_retained)
        self.assertEqual(self.retained_db.read_bytes(), self.before_db)
        self.assertEqual(self.launcher.read_bytes(), self.before_launcher)
        for path, raw in self.before_profiles.items():
            self.assertEqual(Path(path).read_bytes(), raw)
        self.assertFalse(any(Path(str(self.retained_db) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")))

    def install(self, result):
        return candidate.install(argparse.Namespace(
            candidate=Path(result["selector"]), selector=self.selector, launcher=self.launcher,
            backup=self.root / "restore-backup", expected_selector_sha256=self.args.expected_selector_sha256),
            guard=self.guard)

    def test_restoration_cli_preserves_seven_owners_and_existing_authority(self):
        result = self.stage()
        selected = candidate.read_json(result["selector"])
        self.assertEqual(selected["profiles"], [*self.current_profiles, str(self.retained)])
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assert_authority_unchanged()
        installed = self.install(result)
        self.assertEqual(candidate.read_json(self.selector)["profiles"], selected["profiles"])
        self.assert_authority_unchanged()
        receipt = candidate.read_json(installed["rollback_receipt"])
        self.assertTrue(receipt["profiles_preserved"])
        self.assertFalse(receipt.get("profile_creation_intent"))
        self.assertFalse(Path(self.config["resources"]["root"]).exists())
        candidate.rollback(argparse.Namespace(receipt=Path(installed["rollback_receipt"])), guard=self.guard)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assert_authority_unchanged()

    def assert_rejected_without_switch(self, operation, pattern):
        with self.assertRaisesRegex((ValueError, OSError), pattern):
            operation()
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertFalse((self.root / "restore-backup").exists())

    def stage_direct(self):
        return candidate.stage_retained_owner_restore(self.args)

    def reseal(self, result, *, migration_change=None, selector_change=None, manifest_change=None):
        bundle = Path(result["selector"]).parent
        def write(path, value):
            path.chmod(0o600)
            path.write_bytes(candidate.encoded(value))
            path.chmod(0o400)
        migration_path = bundle / "native-profile-migration.json"
        migration = candidate.read_json(migration_path)
        if migration_change:
            migration_change(migration)
            write(migration_path, migration)
        manifest_path = bundle / "manifest.json"
        manifest = candidate.read_json(manifest_path)
        manifest["sha256"]["native_profile_migration"] = candidate.digest(migration_path)
        if manifest_change:
            manifest_change(manifest)
        write(manifest_path, manifest)
        selector_path = Path(result["selector"])
        selection = candidate.read_json(selector_path)
        selection["manifest_sha256"] = candidate.digest(manifest_path)
        if selector_change:
            selector_change(selection)
        write(selector_path, selection)
        write(bundle / "check-selector.json", selection)
        receipt_path = bundle / "process-leases-build.json"
        receipt = candidate.read_json(receipt_path)
        receipt.update(candidate_selector_sha256=candidate.digest(selector_path),
                       candidate_manifest_sha256=candidate.digest(manifest_path),
                       staged_selector_sha256=candidate.digest(bundle / "check-selector.json"),
                       profile_migration_sha256=candidate.digest(migration_path))
        write(receipt_path, receipt)

    def test_stale_stage_cas_is_rejected(self):
        self.args.expected_selector_sha256 = "0" * 64
        self.assert_rejected_without_switch(self.stage_direct, "installed selector changed")
        self.assertFalse(self.output.exists())
        self.assert_authority_unchanged()

    def test_install_still_requires_release_guard(self):
        result = self.stage()
        args = argparse.Namespace(candidate=Path(result["selector"]), selector=self.selector,
                                  launcher=self.launcher, backup=self.root / "restore-backup",
                                  expected_selector_sha256=self.args.expected_selector_sha256)
        with self.assertRaisesRegex(RuntimeError, "held release guard"):
            candidate.install(args)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assert_authority_unchanged()

    def test_unpinned_or_unselected_profile_is_rejected(self):
        self.args.profile = (str(self.retained), "0" * 64)
        self.assert_rejected_without_switch(self.stage_direct, "pin mismatch")
        self.args.profile = (str(self.retained), candidate.digest(self.retained))
        donor = candidate.read_json(self.donor)
        donor["profiles"] = []
        self.donor.chmod(0o600)
        self.donor.write_bytes(candidate.encoded(donor))
        self.args.retained_selector = (str(self.donor), candidate.digest(self.donor))
        self.assert_rejected_without_switch(self.stage_direct, "not selected")
        self.assertFalse(self.output.exists())

    def test_donor_selector_pin_is_rechecked_at_install(self):
        result = self.stage()
        self.donor.chmod(0o600)
        self.donor.write_bytes(self.donor.read_bytes() + b" ")
        self.assert_rejected_without_switch(lambda: self.install(result), "pin mismatch")
        self.assert_authority_unchanged()

    def test_donor_manifest_pin_is_rechecked_at_install(self):
        result = self.stage()
        self.donor_manifest.chmod(0o600)
        self.donor_manifest.write_bytes(self.donor_manifest.read_bytes() + b" ")
        self.assert_rejected_without_switch(lambda: self.install(result), "pin mismatch")
        self.assert_authority_unchanged()

    def test_retained_profile_pin_is_rechecked_at_install(self):
        result = self.stage()
        self.retained.write_bytes(self.retained.read_bytes() + b" ")
        self.assert_rejected_without_switch(lambda: self.install(result), "pin mismatch")

    def test_canonical_config_and_snapshot_pins_are_rechecked_at_install(self):
        result = self.stage()
        for path in (self.canonical_config, self.snapshot):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.chmod(0o600)
                path.write_bytes(original + b" ")
                self.assert_rejected_without_switch(lambda: self.install(result), "pin mismatch|digest mismatch")
                path.write_bytes(original)
                path.chmod(0o400)
        self.assert_authority_unchanged()

    def test_sidecars_and_held_gate_fail_without_opening_authority(self):
        for suffix in ("-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                sidecar = Path(str(self.retained_db) + suffix)
                candidate.create(sidecar, b"owned pending journal")
                self.assert_rejected_without_switch(self.stage_direct, "sidecars")
                sidecar.unlink()
        with self.retained_gate.open("rb") as held:
            candidate.fcntl.flock(held, candidate.fcntl.LOCK_EX | candidate.fcntl.LOCK_NB)
            self.assert_rejected_without_switch(self.stage_direct, "temporarily unavailable")
        self.assertFalse(self.output.exists())
        self.assert_authority_unchanged()

    def test_sidecar_created_after_stage_blocks_install(self):
        result = self.stage()
        sidecar = Path(str(self.retained_db) + "-wal")
        candidate.create(sidecar, b"pending journal")
        self.assert_rejected_without_switch(lambda: self.install(result), "sidecars")

    def test_foreign_generation_is_not_restorable(self):
        profile = copy.deepcopy(self.profile_value)
        profile["generation"] = "foreign-generation"
        self.retained.write_bytes(candidate.encoded(profile))
        self.args.profile = (str(self.retained), candidate.digest(self.retained))
        self.assert_rejected_without_switch(self.stage_direct, "exact canonical quarantine authority")
        self.assertFalse(self.output.exists())

    def test_existing_authority_identity_must_match_database(self):
        with sqlite3.connect(self.retained_db) as db:
            db.execute("UPDATE humanstop_authority SET gate_inode=gate_inode+1")
        db.close()
        self.assert_rejected_without_switch(self.stage_direct, "authority identity")
        self.assertFalse(self.output.exists())

    def test_existing_quarantine_state_is_required(self):
        with sqlite3.connect(self.retained_db) as db:
            db.execute("UPDATE settings SET value_json='{}'")
        db.close()
        self.assert_rejected_without_switch(self.stage_direct, "database quarantine")
        self.assertFalse(self.output.exists())

    def test_database_mutation_after_stage_is_rejected(self):
        result = self.stage()
        with sqlite3.connect(self.retained_db) as db:
            db.execute("UPDATE intents SET outcome='confirmed'")
        db.close()
        self.assert_rejected_without_switch(lambda: self.install(result), "exact retained owner restoration")

    def test_gate_replacement_after_stage_is_rejected(self):
        result = self.stage()
        self.retained_gate.rename(self.authority / "gate.original")
        candidate.create(self.retained_gate, b"")
        self.assert_rejected_without_switch(lambda: self.install(result), "authority identity")

    def test_selected_scope_generation_and_database_collisions_are_rejected(self):
        selected = Path(self.current_profiles[0])
        original = selected.read_bytes()
        for change in ("scope", "generation", "database"):
            with self.subTest(change=change):
                profile = candidate.strict_json(original)
                if change == "scope":
                    profile["owner"]["instance"] = self.profile_value["owner"]["instance"]
                elif change == "generation":
                    profile["generation"] = self.generation
                else:
                    # Exact authority directory reuse is a collision even if the
                    # selected owner has a different instance and generation.
                    self.args.profile = (str(self.retained), candidate.digest(self.retained))
                    profile["database"] = str(self.retained_db)
                    profile["gate"] = str(self.retained_gate)
                selected.write_bytes(candidate.encoded(profile))
                self.assert_rejected_without_switch(self.stage_direct, "collides|sibling")
                selected.write_bytes(original)
        self.assertFalse(self.output.exists())
        self.assert_authority_unchanged()

    def test_new_executable_cannot_be_introduced_by_retained_profile(self):
        replacement = self.old / "unselected-node"
        candidate.create(replacement, b"unselected runtime", 0o500)
        profile = copy.deepcopy(self.profile_value)
        profile["owner"]["executable"] = str(replacement)
        self.retained.write_bytes(candidate.encoded(profile))
        self.args.profile = (str(self.retained), candidate.digest(self.retained))
        self.assert_rejected_without_switch(self.stage_direct, "unchanged trusted component")
        self.assertFalse(self.output.exists())

    def test_resealed_candidate_cannot_drop_current_owner_or_change_resources(self):
        result = self.stage()
        self.reseal(result, selector_change=lambda s: s["profiles"].pop(0))
        self.assert_rejected_without_switch(lambda: self.install(result), "exact retained owner restoration")
        self.assert_authority_unchanged()

    def test_resealed_candidate_cannot_change_authority_intent(self):
        result = self.stage()
        self.reseal(result, migration_change=lambda m: m["restoration"]["authority"]["database"].update(sha256="0" * 64))
        self.assert_rejected_without_switch(lambda: self.install(result), "exact retained owner restoration")
        self.assert_authority_unchanged()

    def test_resealed_manifest_cannot_change_runtime_pins(self):
        result = self.stage()
        self.reseal(result, manifest_change=lambda m: m.update(core=m["node"]))
        self.assert_rejected_without_switch(lambda: self.install(result), "exact retained owner restoration")
        self.assert_authority_unchanged()


    def native_build(self, *, restore=True):
        # A real clean Git worktree and the official CLI exercise candidate
        # composition; the isolated cargo stub only emits inert fixture files.
        repo = self.root / "build-repo"
        repo.mkdir(mode=0o700)
        deploy = repo / "deploy/fleet"
        deploy.mkdir(parents=True)
        for name in ("process-leases-candidate.py", "launch-v1-core.py"):
            (deploy / name).write_bytes(Path(__file__).with_name(name).read_bytes())
        (repo / "crates/herder").mkdir(parents=True)
        (repo / "crates/herder/Cargo.toml").write_text("# isolated build contract fixture\n")
        cargo = self.root / "cargo-fixture"
        candidate.create(cargo, b"""#!/usr/bin/env python3
from pathlib import Path
import sys
out=Path(sys.argv[sys.argv.index('--target-dir')+1])/'release'
out.mkdir(parents=True)
for name in ('herder_native_stdio','herder_process_worker'):
    path=out/name
    path.write_bytes(('inert rebuilt '+name).encode())
    path.chmod(0o500)
""", 0o500)
        for argv in (["git", "init", "-b", "main"], ["git", "add", "."],
                     ["git", "-c", "user.name=contract-fixture", "-c", "user.email=fixture@example.invalid",
                      "commit", "-m", "isolated native build fixture"]):
            subprocess.run(argv, cwd=repo, capture_output=True, check=True)
        source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        self.args.output = self.root / "native-restored-candidate"
        result = subprocess.run([
            "python3", str(deploy / "process-leases-candidate.py"), "build",
            "--repo", str(repo), "--selector", str(self.selector), "--output", str(self.args.output),
            "--build-dir", str(self.root / "cargo-target"), "--cargo", str(cargo),
            "--execution-root", self.config["execution_root"], "--resource-root", self.config["resources"]["root"],
            "--node-ref", self.config["node_ref"], "--storage-id", self.config["resources"]["storage_id"],
            *(["--restore-retained-owner", *self.args.retained_selector, *self.args.profile] if restore else []),
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), source

    def test_native_build_restores_owner_and_rebinds_existing_native_browser(self):
        selected = Path(self.current_profiles[-1])
        value = candidate.read_json(selected)
        value["owner"].update(kind="zai", executable=self.manifest["core"], existing_sessions=[],
            ahap_env={"AHAP_BROWSER_TRANSPORT": "direct-cdp",
                      "AHAP_BROWSER_ACCOUNT_SCOPE": "e" * 64,
                      "AHAP_BROWSER_CDP_WS_URL": "ws://127.0.0.1:9222/devtools/browser/fixture",
                      "AHAP_BROWSER_CDP_CONTEXT_ID": "existing-context",
                      "AHAP_BROWSER_CDP_TARGET_ID": "existing-target"})
        value["owner"].pop("ahap_script")
        selected.write_bytes(candidate.encoded(value))
        self.before_profiles[str(selected)] = selected.read_bytes()
        self.manifest["adapters"]["zai"] = self.manifest["adapters"]["chatgpt"]
        self.manifest["sha256"]["adapters"]["zai"] = self.manifest["sha256"]["adapters"]["chatgpt"]
        self.manifest_path.write_bytes(candidate.encoded(self.manifest))
        self.selection["manifest_sha256"] = candidate.digest(self.manifest_path)
        self.selector.write_bytes(candidate.encoded(self.selection))
        self.before_selector = self.selector.read_bytes()
        self.args.expected_selector_sha256 = candidate.digest(self.selector)
        result, source = self.native_build()
        self.assertNotEqual(source, self.manifest["process_leases_build"]["source_commit"])
        proposed = candidate.read_json(result["selector"])
        manifest = candidate.read_json(proposed["manifest"])
        self.assertEqual(manifest["process_leases_build"]["source_commit"], source)
        self.assertEqual(proposed["profiles"][:6], self.current_profiles[:6])
        self.assertNotEqual(proposed["profiles"][6], self.current_profiles[6])
        self.assertEqual(proposed["profiles"][7], str(self.retained))
        receipt = candidate.read_json(Path(result["selector"]).parent / "process-leases-build.json")
        self.assertEqual(receipt["base_selector"], str(self.selector))
        self.assertEqual(receipt["base_selector_sha256"], self.args.expected_selector_sha256)
        self.assert_authority_unchanged()
        installed = self.install(result)
        rebound = candidate.read_json(proposed["profiles"][6])
        expected = copy.deepcopy(value)
        expected["owner"]["executable"] = manifest["core"]
        self.assertEqual(rebound, expected)
        self.assert_authority_unchanged()
        self.assertEqual(candidate.read_json(self.selector)["profiles"], proposed["profiles"])
        candidate.rollback(argparse.Namespace(receipt=Path(installed["rollback_receipt"])), guard=self.guard)
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assert_authority_unchanged()


    def test_native_restore_revalidates_profile_at_install(self):
        result, _ = self.native_build()
        self.retained.write_bytes(self.retained.read_bytes() + b" ")
        self.assert_rejected_without_switch(lambda: self.install(result), "pin mismatch")

    def test_native_restore_rejects_changed_resource_binding(self):
        result, _ = self.native_build()
        proposed = candidate.read_json(result["selector"])
        manifest = candidate.read_json(proposed["manifest"])
        config_path = Path(manifest["process_config"])
        config = candidate.read_json(config_path)
        config["resources"]["storage_id"] = "foreign-storage"
        config_path.chmod(0o600)
        config_path.write_bytes(candidate.encoded(config))
        config_path.chmod(0o400)
        self.reseal(result, manifest_change=lambda m: m["sha256"].update(process_config=candidate.digest(config_path)))
        self.assert_rejected_without_switch(lambda: self.install(result), "resource bindings")
        self.assert_authority_unchanged()

    def test_native_restore_rejects_replacement_of_current_owner(self):
        result, _ = self.native_build()
        self.reseal(result, selector_change=lambda s: s["profiles"].pop(0))
        self.assert_rejected_without_switch(lambda: self.install(result), "exact retained owner restoration")
        self.assert_authority_unchanged()

    def test_native_restore_stale_baseline_is_rejected(self):
        result, _ = self.native_build()
        self.selector.write_bytes(self.selector.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "baseline changed"):
            self.install(result)
        self.assertFalse((self.root / "restore-backup").exists())
        self.assert_authority_unchanged()


    def test_existing_browser_account_collision_is_rejected(self):
        selected = Path(self.current_profiles[0])
        value = candidate.read_json(selected)
        value["owner"].update(kind="chatgpt", ahap_script=self.manifest["adapters"]["chatgpt"],
                              ahap_env={"AHAP_BROWSER_ACCOUNT_SCOPE": "retained-account"})
        selected.write_bytes(candidate.encoded(value))
        self.assert_rejected_without_switch(self.stage_direct, "selected browser account")
        self.assertFalse(self.output.exists())


    def test_installed_restore_allows_database_evolution_and_next_native_build(self):
        restored = self.stage()
        self.install(restored)
        installed_profiles = candidate.read_json(self.selector)["profiles"]
        db = sqlite3.connect(self.retained_db)
        try:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            db.execute("INSERT INTO intents VALUES ('later-normal-request','confirmed')")
            db.commit()
            self.assertTrue(Path(str(self.retained_db) + "-wal").exists())
            self.assertTrue(Path(str(self.retained_db) + "-shm").exists())
            evolved_database = self.retained_db.read_bytes()
            self.assertNotEqual(evolved_database, self.before_db)
            self.assertEqual(candidate.check_selector(self.selector, self.launcher)["profiles_count"], 8)
            result, _ = self.native_build(restore=False)
            proposed = candidate.read_json(result["selector"])
            manifest = candidate.read_json(proposed["manifest"])
            self.assertNotIn("native_profile_migration", manifest)
            self.assertEqual(proposed["profiles"], installed_profiles)
            candidate.install(argparse.Namespace(
                candidate=Path(result["selector"]), selector=self.selector, launcher=self.launcher,
                backup=self.root / "next-native-backup", expected_selector_sha256=candidate.digest(self.selector)),
                guard=self.guard)
            self.assertEqual(candidate.read_json(self.selector)["profiles"], installed_profiles)
            self.assertEqual(self.retained.read_bytes(), self.before_retained)
            self.assertEqual(self.retained_db.read_bytes(), evolved_database)
            self.assertEqual(db.execute("SELECT count(*) FROM intents WHERE request_key='later-normal-request'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT value_json FROM settings").fetchone()[0], self.snapshot.read_text())
            self.assertTrue(Path(str(self.retained_db) + "-wal").exists())
        finally:
            db.close()



if __name__ == "__main__":
    unittest.main()
