#!/usr/bin/env python3
"""Review adapter/profile migration in isolated authorities; no live runtime."""
import argparse
import copy
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(Path(__file__).with_name(filename)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


fixtures = load("migration_fixtures", "process-leases-test.py")
candidate = fixtures.candidate


class MigrationFixture(unittest.TestCase):
    def setUp(self):
        fixtures.RolloutContracts.setUp(self)
        self.source = "d" * 40
        self.base["remote_ahap_wrappers"] = []
        self.base["component_provenance"].update(opencode_source_commit="b" * 40, zcode_source_commit="c" * 40, codex_source_commit="a" * 40)
        gate = self.root / "gate"
        candidate.create(gate, b"existing gate")
        self.old_profiles = {}
        for kind in ("opencode", "zcode", "codex"):
            if kind != "codex":
                artifact = self.old / ("ahap-" + kind + ".mjs")
                candidate.create(artifact, ("old adapter " + kind).encode(), 0o400)
                self.base["adapters"][kind] = str(artifact)
                self.base["sha256"]["adapters"][kind] = candidate.digest(artifact)
            path = self.root / ("profile-" + kind + ".json")
            profile = {"database": str(self.database), "gate": str(gate), "generation": "same-generation",
                       "owner": {"principal": "owner-a", "node": "node-a", "instance": kind,
                                 "executable": self.base["node"], "code_home": str(self.root),
                                 "cwd": str(self.root), "kind": kind,
                                 "ahap_script": self.base["adapters"][kind],
                                 "ahap_env": {"AHAP_OPENCODE_MODEL": "unchanged model ☃"}}}
            # Escapes, indentation and CRLF outside the one string token are
            # part of the preserved protected profile bytes.
            raw = json.dumps(profile, ensure_ascii=True, indent=3).replace("\n", "\r\n").encode() + b"\r\n"
            candidate.create(path, raw)
            self.old_profiles[str(path)] = raw
        self.base["adapters"]["browser"] = self.base["adapters"]["codex"]
        self.base["sha256"]["adapters"]["browser"] = self.base["sha256"]["adapters"]["codex"]
        self.wrapper = self.old / "remote-codex.mjs"
        candidate.create(self.wrapper, b"pinned remote transport", 0o400)
        companion = Path(str(self.wrapper) + ".json")
        candidate.create(companion, candidate.encoded({"nodeRef": "remote-node", "kind": "codex"}), 0o400)
        self.base["remote_ahap_wrappers"] = [{
            "node": "remote-node", "instance": "codex-remote", "kind": "codex",
            "script": str(self.wrapper), "script_sha256": candidate.digest(self.wrapper),
            "config_sha256": candidate.digest(companion)}]
        self.remote_profile = self.root / "profile-codex-remote.json"
        remote = json.loads(self.old_profiles[str(self.root / "profile-codex.json")])
        remote["owner"].update(node="remote-node", instance="codex-remote", ahap_script=str(self.wrapper))
        remote_raw = candidate.encoded(remote)
        candidate.create(self.remote_profile, remote_raw)
        self.old_profiles[str(self.remote_profile)] = remote_raw
        self.base["adapter"] = self.base["adapters"]["opencode"]
        self.base["sha256"]["adapter"] = self.base["sha256"]["adapters"]["opencode"]
        self.new_launcher.chmod(0o700)
        self.new_launcher.write_bytes(Path(__file__).with_name("launch-v1-core.py").read_bytes())
        self.new_launcher.chmod(0o500)
        candidate.create(self.new / "check-selector.json", b"{}")

    def seal_baseline(self):
        self.base_manifest.write_bytes(candidate.encoded(self.base))
        self.selection.update(manifest_sha256=candidate.digest(self.base_manifest), profiles=list(self.old_profiles))
        self.selector.write_bytes(candidate.encoded(self.selection))
        self.before_selector = self.selector.read_bytes()
        self.install_args.expected_selector_sha256 = candidate.digest(self.selector)
        hashes = {key: self.manifest["sha256"][key] for key in ("core", "process_worker", "process_config")}
        self.manifest = candidate.compose_manifest(self.base, self.new, self.source, self.base_manifest,
            candidate.digest(self.base_manifest), hashes, ["cargo", "build"])

    def reseal(self):
        migration_path = Path(self.manifest[self.migration_key])
        migration_path.chmod(0o600)
        migration_path.write_bytes(candidate.encoded(self.migration))
        self.manifest["sha256"][self.migration_key] = candidate.digest(migration_path)
        self.manifest_path.write_bytes(candidate.encoded(self.manifest))
        rebound = {item["previous_path"]: item["path"] for item in self.migration["profiles"]}
        self.new_selection = {**self.selection, "manifest": str(self.manifest_path),
                              "manifest_sha256": candidate.digest(self.manifest_path),
                              "profiles": [rebound.get(path, path) for path in self.selection["profiles"]]}
        self.new_selector.write_bytes(candidate.encoded(self.new_selection))
        staged = copy.deepcopy(self.new_selection)
        payloads = {item["path"]: item["payload"] for item in self.migration["profiles"]}
        staged["profiles"] = [payloads.get(path, path) for path in staged["profiles"]]
        staged_path = self.new / "check-selector.json"
        staged_path.write_bytes(candidate.encoded(staged))
        self.build_receipt.update(source_commit=self.source,
            base_selector_sha256=candidate.digest(self.selector),
            base_manifest_sha256=candidate.digest(self.base_manifest),
            launcher_sha256=candidate.digest(self.new_launcher),
            candidate_selector_sha256=candidate.digest(self.new_selector),
            candidate_manifest_sha256=candidate.digest(self.manifest_path),
            profile_sha256=self.migration["profile_sha256"],
            staged_selector_sha256=candidate.digest(staged_path),
            profile_migration_sha256=candidate.digest(migration_path))
        (self.new / "process-leases-build.json").write_bytes(candidate.encoded(self.build_receipt))

    def check(self):
        return candidate.check_candidate(self.new_selector, self.new_launcher)

    def assert_unchanged(self):
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertEqual(self.database.read_bytes(), self.before_db)
        for path, raw in self.old_profiles.items():
            self.assertEqual(Path(path).read_bytes(), raw)


class AdapterMigrationContracts(MigrationFixture):
    migration_key = "adapter_migration"

    def setUp(self):
        super().setUp()
        self.seal_baseline()
        adapters = {}
        for kind in ("opencode", "zcode", "codex"):
            path = self.new / "fixture" / ("ahap-" + kind + "-runner.mjs")
            candidate.create(path, ("new reviewed " + kind).encode(), 0o400)
            adapters[kind] = {"previous_path": self.base["adapters"][kind],
                              "previous_sha256": self.base["sha256"]["adapters"][kind],
                              "previous_source_commit": candidate.adapter_source(self.base, kind),
                              "path": str(path), "sha256": candidate.digest(path), "source_commit": self.source,
                              "compiled_entrypoint_sha256": "e" * 64}
        self.migration = candidate.stage_adapter_migration(self.base, self.manifest, self.selection,
            self.selector, self.new, self.source, adapters,
            {"source_commit": self.source, "bundler_sha256": "f" * 64, "compile_argv": [["tsc", "package"], ["tsc", "app"]]})
        self.reseal()

    def test_staging_checks_actual_payloads_without_creating_authority_files(self):
        self.assertEqual(self.check()["profile_validation"], "staged_payloads_not_installed")
        for item in self.migration["profiles"]:
            self.assertFalse(Path(item["path"]).exists())
            old = self.old_profiles[item["previous_path"]]
            expected = candidate.profile_payload(old, self.base["adapters"][item["kind"]], self.manifest["adapters"][item["kind"]])
            self.assertEqual(Path(item["payload"]).read_bytes(), expected)
        self.assertNotEqual(self.manifest["adapters"]["codex"], self.base["adapters"]["codex"])
        self.assertIn(str(self.remote_profile), self.new_selection["profiles"])
        self.assertFalse(any(item["previous_path"] == str(self.remote_profile) for item in self.migration["profiles"]))
        self.assertEqual(self.manifest["remote_ahap_wrappers"], self.base["remote_ahap_wrappers"])
        self.assert_unchanged()
        with self.assertRaises(FileNotFoundError):
            candidate.check_selector(self.new_selector, self.new_launcher)

    def test_native_opencode_profile_payload_removes_only_legacy_runner(self):
        path = self.root / "profile-opencode.json"
        profile = copy.deepcopy(candidate.strict_json(self.old_profiles[str(path)]))
        profile["owner"]["ahap_base_url"] = "http://127.0.0.1:4095"
        raw = json.dumps(profile, ensure_ascii=True, indent=3).replace("\n", "\r\n").encode() + b"\r\n"
        payload = candidate.native_profile_payload(raw)
        before = candidate.strict_json(raw)
        after = candidate.strict_json(payload)
        expected = copy.deepcopy(before)
        del expected["owner"]["ahap_script"]
        self.assertEqual(after, expected)
        self.assertIn(b"ahap_base_url", payload)
        self.assertNotIn(b"ahap_script", payload)
        self.assertTrue(payload.endswith(b"\r\n"))

    def stage_recovery(self, selection, selector, output, reviewed):
        output.mkdir(mode=0o700)
        manifest = candidate.compose_manifest(self.base, output, self.source, self.base_manifest,
            selection["manifest_sha256"], self.manifest["sha256"], ["cargo", "build"])
        staged = candidate.stage_native_profile_migration(
            self.base, manifest, selection, selector, output, self.source, [], [reviewed])
        path = output / "manifest.json"
        candidate.create(path, candidate.encoded(manifest), 0o400)
        return staged, manifest, {**selection, "manifest": str(path), "manifest_sha256": candidate.digest(path)}

    def test_codex_socket_can_be_staged_before_a_recovery_cohort_is_registered(self):
        old_path = self.root / "native-codex-profile.json"
        old = candidate.strict_json(self.old_profiles[str(self.root / "profile-codex.json")])
        old["owner"]["ahap_env"] = {"AHAP_CODEX_BIN": self.base["node"],
                                     "AHAP_CODEX_CWD": str(self.root), "CODEX_HOME": str(self.root)}
        before = candidate.encoded(old)
        candidate.create(old_path, before)
        selection = {**self.selection, "profiles": [str(old_path), str(self.remote_profile)]}
        selector = self.root / "socket-base.json"
        candidate.create(selector, candidate.encoded(selection))
        successor = copy.deepcopy(old)
        successor["owner"]["ahap_env"]["AHAP_CODEX_SOCKET"] = str(self.root / "shared.sock")
        reviewed = self.root / "reviewed-shared-socket.json"
        candidate.create(reviewed, candidate.encoded(successor))

        output = self.root / "socket-candidate"
        staged, manifest, new = self.stage_recovery(selection, selector, output, reviewed)
        [binding] = staged["profiles"]
        new["profiles"] = [binding["path"], str(self.remote_profile)]
        self.assertEqual(candidate.native_profile_transition(selection, new, self.base, manifest), staged)
        self.assertEqual(candidate.read_json(binding["payload"]), successor)
        self.assertEqual(old_path.read_bytes(), before)
        self.assertFalse(Path(binding["path"]).exists())

        changed = copy.deepcopy(successor)
        changed["database"] = str(self.root / "different.db")
        with self.assertRaisesRegex(ValueError, "changes protected profile"):
            candidate.recovery_profile_payload(before, candidate.encoded(changed))

        changed = copy.deepcopy(successor)
        changed["owner"]["ahap_env"]["AHAP_CODEX_SOCKET"] = str(self.root / "different.sock")
        with self.assertRaisesRegex(ValueError, "cannot change the existing Codex socket"):
            candidate.recovery_profile_payload(candidate.encoded(successor), candidate.encoded(changed))

    def test_semantic_autopilot_stages_on_the_active_codex_profile(self):
        old = json.loads(self.old_profiles[str(self.root / "profile-codex.json")])
        old["owner"]["ahap_env"] = {
            "AHAP_CODEX_BIN": self.base["node"], "CODEX_HOME": str(self.root),
            "AHAP_CODEX_CWD": str(self.root), "AHAP_CODEX_SOCKET": str(self.root / "codex.sock"),
        }
        marker = self.root / "active.json"
        candidate.create(marker, b"true\n")
        holds = {}
        for name in ("human_stops", "human_requests", "choices", "unfinished_sessions"):
            path = self.root / (name + ".json")
            candidate.create(path, b"{}\n")
            holds[name] = str(path)
        old["owner"]["codex_recovery"] = {"autopilot_state_dir": str(self.root), "legacy_handoff": {
            **holds, "native_sessions": ["existing-session"], "activation_file": str(marker)}}
        old_path = self.root / "active-profile.json"
        before = candidate.encoded(old)
        candidate.create(old_path, before)
        selection = {**self.selection, "profiles": [str(old_path), str(self.remote_profile)]}
        selector = self.root / "autopilot-base.json"
        candidate.create(selector, candidate.encoded(selection))
        successor = copy.deepcopy(old)
        config = {"state_dir": str(self.root), "holds": holds,
                  "judge": {"base_url": "http://127.0.0.1:20128/v1", "model": "fixture-judge"}}
        successor["owner"]["codex_autopilot"] = config
        after = candidate.encoded(successor)
        reviewed = self.root / "reviewed-autopilot.json"
        candidate.create(reviewed, after)

        migration, manifest, new = self.stage_recovery(selection, selector, self.root / "autopilot-candidate", reviewed)
        [row] = migration["profiles"]
        new["profiles"] = [row["path"], str(self.remote_profile)]
        self.assertEqual(candidate.native_profile_transition(selection, new, self.base, manifest), migration)
        self.assertEqual(Path(row["payload"]).read_bytes(), after)
        self.assertEqual(old_path.read_bytes(), before)
        self.assertEqual(marker.read_bytes(), b"true\n")
        self.assertEqual(candidate.recovery_profile_payload(after, before), before)

        combined = copy.deepcopy(successor)
        new_handoff = combined["owner"]["codex_recovery"]["legacy_handoff"]
        new_handoff.update(native_sessions=["existing-session", "handed-over-session"],
                           activation_file=str(self.root / "next-activation.json"))
        combined_bytes = candidate.encoded(combined)
        self.assertEqual(candidate.recovery_profile_payload(before, combined_bytes), combined_bytes)

        for name, edit in (
                ("foreign provider", lambda p: p["owner"].update(principal="another-owner")),
                ("different holds", lambda p: p["owner"]["codex_autopilot"]["holds"].update(human_stops=holds["choices"])),
                ("expanded cohort", lambda p: p["owner"]["codex_recovery"]["legacy_handoff"].update(instance_wide=True)),
                ("inline secret", lambda p: p["owner"]["codex_autopilot"]["judge"].update(token="fixture")),
                ("unencrypted judge", lambda p: p["owner"]["codex_autopilot"]["judge"].update(base_url="http://example.test/v1")),
                ("invalid judge port", lambda p: p["owner"]["codex_autopilot"]["judge"].update(base_url="https://example.test:invalid/v1"))):
            with self.subTest(change=name):
                invalid = copy.deepcopy(successor)
                edit(invalid)
                with self.assertRaises(ValueError):
                    candidate.recovery_profile_payload(before, candidate.encoded(invalid))

    def test_native_recovery_stages_only_the_explicit_existing_profile(self):
        old_path = self.root / "native-codex-profile.json"
        old = json.loads(self.old_profiles[str(self.root / "profile-codex.json")])
        old["owner"]["ahap_env"] = {
            "AHAP_CODEX_BIN": self.base["node"],
            "CODEX_HOME": str(self.root),
            "AHAP_CODEX_CWD": str(self.root),
        }
        raw = candidate.encoded(old)
        candidate.create(old_path, raw)
        selection = {**self.selection, "profiles": [str(old_path), str(self.remote_profile)]}
        selector = self.root / "recovery-base.json"
        candidate.create(selector, candidate.encoded(selection))
        recovery = copy.deepcopy(old)
        handoff = {"native_sessions": ["known-session"], "activation_file": str(self.root / "active.json")}
        for key in ("human_stops", "human_requests", "choices", "unfinished_sessions"):
            path = self.root / (key + ".json")
            candidate.create(path, b"{}")
            handoff[key] = str(path)
        recovery["owner"]["codex_recovery"] = {"autopilot_state_dir": str(self.root), "legacy_handoff": handoff}
        recovery["owner"]["ahap_env"]["AHAP_CODEX_SOCKET"] = str(self.root / "codex.sock")
        reviewed = self.root / "reviewed-codex.json"
        candidate.create(reviewed, candidate.encoded(recovery))
        out = self.root / "recovery-candidate"
        staged, manifest, new = self.stage_recovery(selection, selector, out, reviewed)
        [row] = staged["profiles"]
        new["profiles"] = [row["path"], str(self.remote_profile)]
        self.assertEqual(candidate.native_profile_transition(selection, new, self.base, manifest), staged)
        self.assertEqual(row["previous_path"], str(old_path))
        self.assertEqual(old_path.read_bytes(), raw)
        self.assertFalse(Path(row["path"]).exists())

        wide = copy.deepcopy(recovery)
        scope = wide["owner"]["codex_recovery"]["legacy_handoff"]
        del scope["native_sessions"]
        scope["instance_wide"] = True
        wide_raw = candidate.encoded(wide)
        self.assertEqual(candidate.recovery_profile_payload(raw, wide_raw), wide_raw)
        workspace = {"cwd": "/work/handed-over", "provider": "opencodex"}
        for selected in ({"workspaces": [workspace]}, {"workspaces": [workspace], "native_sessions": ["known-session"]}):
            with self.subTest(selected=selected):
                handed_over = copy.deepcopy(wide)
                scope = handed_over["owner"]["codex_recovery"]["legacy_handoff"]
                del scope["instance_wide"]
                scope.update(selected)
                payload = candidate.encoded(handed_over)
                self.assertEqual(candidate.recovery_profile_payload(raw, payload), payload)
        for invalid in ({}, {"instance_wide": False}, {"instance_wide": 1}, {"instance_wide": "true"},
                        {"instance_wide": True, "native_sessions": []},
                        {"instance_wide": True, "workspaces": [workspace]}, {"workspaces": []},
                        {"workspaces": [workspace, workspace]}, {"workspaces": [dict(workspace, cwd="../other")]},
                        {"workspaces": [dict(workspace, cwd="/work/./project")]},
                        {"workspaces": [dict(workspace, provider="")]}, {"workspaces": [dict(workspace, extra=True)]},
                        {"instance_wide": True, "native_sessions": ["known-session"]}):
            with self.subTest(scope=invalid):
                bad = copy.deepcopy(wide)
                bad_scope = bad["owner"]["codex_recovery"]["legacy_handoff"]
                del bad_scope["instance_wide"]
                bad_scope.update(invalid)
                with self.assertRaises(ValueError):
                    candidate.recovery_profile_payload(raw, candidate.encoded(bad))

        changed = copy.deepcopy(recovery)
        changed["owner"]["ahap_env"]["CODEX_HOME"] = "/foreign-home"
        with self.assertRaisesRegex(ValueError, "changes protected profile"):
            candidate.recovery_profile_payload(raw, candidate.encoded(changed))
        candidate.create(Path(handoff["activation_file"]), b"true")
        with self.assertRaisesRegex(ValueError, "fresh private activation"):
            candidate.recovery_profile_payload(raw, wide_raw)
        with self.assertRaisesRegex(ValueError, "fresh private activation"):
            candidate.native_profile_transition(selection, new, self.base, manifest)

    def test_guarded_install_creates_private_siblings_and_rollback_keeps_old_profiles(self):
        result = candidate.install(self.install_args, guard=self.guard)
        self.assertEqual(candidate.read_json(self.selector)["profiles"], self.new_selection["profiles"])
        candidate.check_selector(self.selector, self.launcher)
        for item in self.migration["profiles"]:
            path = Path(item["path"])
            self.assertEqual(path.parent, Path(item["previous_path"]).parent)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
            self.assertEqual(path.read_bytes(), Path(item["payload"]).read_bytes())
        self.assertGreaterEqual(self.guard.assert_mutation_allowed.call_count, 6)
        candidate.rollback(argparse.Namespace(receipt=Path(result["rollback_receipt"])), guard=self.guard)
        self.assert_unchanged()
        self.assertTrue(all(Path(item["path"]).exists() for item in self.migration["profiles"]))

    def test_resealed_protected_field_changes_are_still_rejected(self):
        item = self.migration["profiles"][0]
        payload = Path(item["payload"])
        original = payload.read_bytes()
        mutations = [lambda p: p.update(database="/different.db"), lambda p: p.update(gate="/different.gate"),
                     lambda p: p.update(generation="different"), lambda p: p["owner"].update(principal="different"),
                     lambda p: p["owner"].update(node="different"), lambda p: p["owner"].update(instance="different"),
                     lambda p: p["owner"]["ahap_env"].update(AHAP_OPENCODE_MODEL="different model")]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value = json.loads(original)
                mutate(value)
                payload.chmod(0o600)
                payload.write_bytes(candidate.encoded(value))
                item["sha256"] = item["payload_sha256"] = candidate.digest(payload)
                self.reseal()
                with self.assertRaisesRegex(ValueError, "outside owner.ahap_script"):
                    self.check()
                self.assert_unchanged()

    def test_target_outside_existing_authority_is_rejected(self):
        item = self.migration["profiles"][0]
        item["path"] = str(self.new / "misplaced-protected-profile.json")
        self.reseal()
        with self.assertRaisesRegex(ValueError, "existing authority"):
            self.check()
        self.assert_unchanged()

    def test_existing_destination_is_never_adopted_or_overwritten(self):
        path = Path(self.migration["profiles"][0]["path"])
        candidate.create(path, b"foreign existing file")
        with self.assertRaises(FileExistsError):
            candidate.install(self.install_args, guard=self.guard)
        self.assertEqual(path.read_bytes(), b"foreign existing file")
        self.assertFalse((self.root / "backup").exists())
        self.assert_unchanged()

    def test_duplicate_json_keys_are_not_silently_normalized(self):
        raw = b'{"owner":{"ahap_script":"old","principal":"a","principal":"b"}}'
        with self.assertRaisesRegex(ValueError, "duplicate"):
            candidate.profile_payload(raw, "old", "new")

    def test_missing_profile_binding_and_unreviewed_adapter_are_rejected(self):
        original = copy.deepcopy(self.migration)
        self.migration["profiles"].pop()
        self.reseal()
        with self.assertRaisesRegex(ValueError, "omits or adds"):
            self.check()
        self.migration = original
        self.manifest["adapters"]["browser"] = self.manifest["adapters"]["opencode"]
        self.manifest["sha256"]["adapters"]["browser"] = self.manifest["sha256"]["adapters"]["opencode"]
        self.reseal()
        with self.assertRaisesRegex(ValueError, "unreviewed adapter"):
            self.check()

    def test_forged_previous_adapter_provenance_is_rejected(self):
        self.migration["adapters"]["zcode"]["previous_source_commit"] = self.source
        self.reseal()
        with self.assertRaisesRegex(ValueError, "exact component pins"):
            self.check()

    def test_race_at_exclusive_creation_leaves_intent_and_never_switches(self):
        target = Path(self.migration["profiles"][0]["path"])
        real_create = candidate.create
        def racing_create(path, data, mode=0o600):
            if Path(path) == target:
                real_create(path, b"concurrent writer", mode)
            return real_create(path, data, mode)
        with patch.object(candidate, "create", side_effect=racing_create):
            with self.assertRaises(FileExistsError):
                candidate.install(self.install_args, guard=self.guard)
        receipt = candidate.read_json(self.root / "backup/receipt.json")
        self.assertEqual(receipt["profile_creation_intent"], self.migration["profiles"])
        self.assertEqual(target.read_bytes(), b"concurrent writer")
        self.assert_unchanged()

    def test_guard_loss_after_sibling_creation_keeps_selector_unchanged(self):
        targets = [Path(item["path"]) for item in self.migration["profiles"]]
        def guard(*_):
            if all(path.exists() for path in targets):
                raise RuntimeError("release proof expired")
        self.guard.assert_mutation_allowed.side_effect = guard
        with self.assertRaisesRegex(RuntimeError, "proof expired"):
            candidate.install(self.install_args, guard=self.guard)
        self.assertTrue(all(path.exists() for path in targets))
        self.assert_unchanged()

    def test_retained_remote_wrapper_requires_exact_identity_and_bytes(self):
        profile = json.loads(self.old_profiles[str(self.remote_profile)])
        self.assertFalse(candidate.uses_reviewed_local_adapter(profile, self.base, {"codex"}))
        for key, value in (("node", "other-node"), ("instance", "other-instance"),
                           ("ahap_script", self.base["adapters"]["opencode"])):
            changed = copy.deepcopy(profile)
            changed["owner"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "exact retained remote wrapper"):
                candidate.uses_reviewed_local_adapter(changed, self.base, {"codex"})
        self.wrapper.chmod(0o600)
        self.wrapper.write_bytes(b"changed transport")
        with self.assertRaisesRegex(ValueError, "identity or digest changed"):
            candidate.uses_reviewed_local_adapter(profile, self.base, {"codex"})

    def test_remote_wrapper_migration_cannot_be_resealed_as_local_update(self):
        self.manifest["remote_ahap_wrappers"][0]["instance"] = "other-instance"
        self.reseal()
        with self.assertRaisesRegex(ValueError, "unreviewed remote wrapper replacement"):
            self.check()
        self.assert_unchanged()

    def test_codex_retained_source_provenance_uses_exact_composite_baseline(self):
        manifest = copy.deepcopy(self.base)
        del manifest["component_provenance"]["codex_source_commit"]
        manifest["component_provenance"]["unchanged_source_commit"] = "f" * 40
        self.assertEqual(candidate.adapter_source(manifest, "codex"), "f" * 40)
        del manifest["component_provenance"]["unchanged_source_commit"]
        with self.assertRaisesRegex(ValueError, "exact component provenance"):
            candidate.adapter_source(manifest, "codex")

    def test_later_core_only_release_does_not_reuse_old_profile_migration(self):
        hashes = {key: self.manifest["sha256"][key] for key in ("core", "process_worker", "process_config")}
        later = candidate.compose_manifest(self.manifest, self.new, "a" * 40, self.manifest_path,
            candidate.digest(self.manifest_path), hashes, ["cargo", "build"])
        self.assertNotIn("adapter_migration", later)
        self.assertNotIn("adapter_migration", later["sha256"])
        self.assertEqual(later["adapters"], self.manifest["adapters"])


class NativeProfileMigrationContracts(MigrationFixture):
    migration_key = "native_profile_migration"

    def setUp(self):
        super().setUp()
        self.authority = self.root / "browser-authority"
        self.authority.mkdir(mode=0o700)
        self.alias = self.root / "authority-alias"
        self.alias.symlink_to(self.authority, target_is_directory=True)
        for name in ("gate", "database"):
            candidate.create(self.authority / name, b"existing browser authority")
        self.env = {}
        self.paths = {}
        self.pins = {}
        self.reviewed = self.root / "reviewed"
        self.reviewed.mkdir(mode=0o700)
        for kind, scope in (("chatgpt", "b" * 64), ("zai", "c" * 64)):
            self.base["adapters"][kind] = self.base["adapters"]["browser"]
            self.base["sha256"]["adapters"][kind] = self.base["sha256"]["adapters"]["browser"]
            self.env[kind] = {
                "AHAP_BROWSER_TRANSPORT": "direct-cdp", "AHAP_BROWSER_ACCOUNT_SCOPE": scope,
                "AHAP_BROWSER_CDP_WS_URL": "ws://127.0.0.1:9222/devtools/browser/private-fixture",
                "AHAP_BROWSER_CDP_CONTEXT_ID": "context-" + kind, "AHAP_BROWSER_CDP_TARGET_ID": "target-" + kind,
                "AHAP_BROWSER_CDP_ORIGIN_PORT": "9223"}
            self.paths[kind] = self.alias / (kind + ".json")
            owner = {"principal": "owner-a", "node": "node-a", "kind": kind, "instance": kind + "-local",
                     "code_home": str(self.root), "cwd": str(self.root), "executable": self.base["node"],
                     "ahap_script": self.base["adapters"][kind],
                     "ahap_env": {**self.env[kind], "AHAP_BROWSER_PAGE_ID": "7"}}
            if kind == "chatgpt":
                owner["ahap_env"] = self.userio(scope)
                owner["existing_sessions"] = [{"request_key": "granted", "native_session_id": "old-session",
                                               "account_scope": scope}]
            profile = {"database": str(self.alias / "database"), "gate": str(self.alias / "gate"),
                       "generation": "unchanged", "owner": owner}
            candidate.create(self.paths[kind], b"")
            self.save_profile(self.paths[kind], profile)

        # The local Codex session already uses the native triple. OpenCode already owns its endpoint.
        for kind in ("codex", "opencode"):
            path = self.root / ("profile-" + kind + ".json")
            profile = candidate.read_json(path)
            if kind == "codex":
                profile["owner"]["ahap_env"] = {"AHAP_CODEX_BIN": self.base["node"], "AHAP_CODEX_CWD": str(self.root),
                                                "CODEX_HOME": str(self.root)}
            else:
                del profile["owner"]["ahap_script"]
                profile["owner"]["ahap_base_url"] = "http://127.0.0.1:4095"
            self.save_profile(path, profile)
        self.pin("chatgpt")
        self.seal_baseline()

    @staticmethod
    def userio(scope):
        return {"AHAP_BROWSER_TRANSPORT": "userio", "AHAP_BROWSER_ACCOUNT_SCOPE": scope,
                "AHAP_USERIO_ACCOUNT_SCOPE": scope, "AHAP_USERIO_AGENT_ID": "agent", "AHAP_USERIO_ENDPOINT": "fixture",
                "AHAP_USERIO_CONNECTION_ID": "connection", "AHAP_USERIO_INSTANCE_ID": "legacy-instance",
                "AHAP_USERIO_PRINCIPAL_ID": "principal", "AHAP_USERIO_ACCESS_TOKEN_FILE": "/never-open-private-ref"}

    def save_profile(self, path, profile):
        raw = (json.dumps(profile, indent=3, ensure_ascii=True).replace("\n", "\r\n") + "\r\n").encode()
        path.write_bytes(raw)
        self.old_profiles[str(path)] = raw

    def pin(self, provider, **changes):
        path = self.reviewed / (provider + ".json")
        binding = {"kind": provider, "profile_sha256": candidate.digest(self.paths[provider]), "ahap_env": self.env[provider]}
        path.write_bytes(candidate.encoded({**binding, **changes}))
        path.chmod(0o600)
        self.pins[provider] = {"path": str(path), "sha256": candidate.digest(path)}

    def stage(self, kinds, pins):
        self.migration = candidate.stage_native_profile_migration(
            self.base, self.manifest, self.selection, self.selector, self.new, self.source, kinds, pins)
        self.reseal()

    def plan(self, kinds, pins):
        return candidate.native_profile_plan(self.base, self.manifest, self.selection, self.new, self.source, kinds, pins)

    def test_both_browsers_staged_checked_and_installed_as_exact_private_siblings(self):
        self.stage(["chatgpt", "zai"], self.pins)
        result = self.check()
        self.assertEqual(result["profile_validation"], "staged_payloads_not_installed")
        self.assertEqual(self.migration["bindings"], self.pins)
        self.assertEqual(len(self.migration["profiles"]), 2)
        evidence = json.dumps([result, self.migration, self.manifest, self.build_receipt])
        for private in ("private-fixture", "context-chatgpt", "target-chatgpt", "b" * 64, "/never-open-private-ref"):
            self.assertNotIn(private, evidence)
        for row in self.migration["profiles"]:
            kind = row["kind"]
            previous = candidate.read_json(self.paths[kind])
            expected = copy.deepcopy(previous)
            del expected["owner"]["ahap_script"]
            expected["owner"].update(executable=self.manifest["core"], ahap_env=self.env[kind])
            self.assertEqual(candidate.read_json(row["payload"]), expected)
            self.assertEqual(Path(row["payload"]).stat().st_mode & 0o777, 0o400)
            self.assertEqual(Path(row["path"]).parent, Path(expected["database"]).parent)
            self.assertFalse(os.path.lexists(row["path"]))
        self.assert_unchanged()
        installed = candidate.install(self.install_args, guard=self.guard)
        for row in self.migration["profiles"]:
            self.assertEqual(candidate.private_file(row["path"]).parent, self.authority)
            self.assertEqual(Path(row["path"]).stat().st_mode & 0o777, 0o400)
        for path in self.selection["profiles"]:
            if path not in {str(p) for p in self.paths.values()}:
                self.assertIn(path, self.new_selection["profiles"])
        candidate.rollback(argparse.Namespace(receipt=Path(installed["rollback_receipt"])), guard=self.guard)
        self.assert_unchanged()
        self.assertEqual((self.alias / "database").read_bytes(), b"existing browser authority")

    def test_explicit_zai_pin_and_userio_only_scope_leave_unselected_chatgpt(self):
        profile = candidate.read_json(self.paths["zai"])
        env = self.userio(self.env["zai"][candidate.BROWSER_SCOPE])
        del env[candidate.BROWSER_SCOPE]
        profile["owner"]["ahap_env"] = env
        self.save_profile(self.paths["zai"], profile)
        self.pin("zai")
        with self.assertRaisesRegex(ValueError, "provider and protected profile"):
            self.plan(["zai"], {"zai": self.pins["chatgpt"]})
        self.stage(["zai"], {"zai": self.pins["zai"]})
        self.check()
        self.assertEqual([row["kind"] for row in self.migration["profiles"]], ["zai"])
        self.assertIn(str(self.paths["chatgpt"]), self.new_selection["profiles"])

    def herder_extension(self, scope):
        token = self.reviewed / "token"
        if not token.exists():
            candidate.create(token, b"private-token-sentinel-32-byte-fixture")
        return {"AHAP_BROWSER_TRANSPORT": "herder-extension", candidate.BROWSER_SCOPE: scope,
                "AHAP_BROWSER_EXTENSION_LISTEN": "127.0.0.1:1234",
                "AHAP_BROWSER_EXTENSION_TOKEN_FILE": str(token)}

    def test_herder_extension_userio_and_explicit_direct_cdp_cutover(self):
        for kind in ("chatgpt", "zai"):
            self.pin(kind, ahap_env=self.herder_extension(self.env[kind][candidate.BROWSER_SCOPE]))
        self.stage(["chatgpt", "zai"], self.pins)
        self.assertNotIn("private-token-sentinel", json.dumps(self.migration))
        self.plan(["chatgpt", "zai"], self.pins)
        for row in self.migration["profiles"]:
            old = candidate.read_json(self.paths[row["kind"]])
            new = candidate.read_json(row["payload"])
            for field in ("database", "gate", "generation"):
                self.assertEqual(new[field], old[field])
            self.assertEqual(new["owner"].get("existing_sessions"), old["owner"].get("existing_sessions"))
            self.assertEqual(new["owner"]["ahap_env"], self.herder_extension(self.env[row["kind"]][candidate.BROWSER_SCOPE]))

    def test_herder_extension_invalid_bindings_fail_closed(self):
        good = self.herder_extension(self.env["chatgpt"][candidate.BROWSER_SCOPE])
        invalid = [{k: v for k, v in good.items() if k != key} for key in good]
        for key, value in (("AHAP_BROWSER_EXTENSION_LISTEN", "0.0.0.0:1234"),
                           ("AHAP_BROWSER_EXTENSION_LISTEN", "127.0.0.1:0"),
                           ("AHAP_BROWSER_EXTENSION_LISTEN", "127.0.0.1:65536"),
                           ("AHAP_BROWSER_EXTENSION_LISTEN", "[::]:1234"),
                           ("AHAP_BROWSER_EXTENSION_LISTEN", "localhost:1234"),
                           ("AHAP_BROWSER_EXTENSION_LISTEN", "private-sentinel"),
                           ("AHAP_BROWSER_EXTENSION_TOKEN_FILE", "/missing/private-sentinel"),
                           ("AHAP_BROWSER_CDP_TARGET_ID", "private-sentinel"),
                           (candidate.BROWSER_SCOPE, "d" * 64)):
            invalid.append({**good, key: value})
        for env in invalid:
            self.pin("chatgpt", ahap_env=env)
            with self.assertRaises((ValueError, OSError)) as refused:
                self.plan(["chatgpt"], self.pins)
            self.assertNotIn("private-sentinel", str(refused.exception))
        Path(good["AHAP_BROWSER_EXTENSION_TOKEN_FILE"]).chmod(0o644)
        self.pin("chatgpt", ahap_env=good)
        with self.assertRaises((ValueError, OSError)):
            self.plan(["chatgpt"], self.pins)

    def test_herder_extension_native_direct_cdp_and_loopback_listeners(self):
        path = self.paths["zai"]
        profile = candidate.read_json(path)
        del profile["owner"]["ahap_script"]
        profile["owner"].update(executable=self.base["core"], ahap_env=self.env["zai"])
        self.save_profile(path, profile)
        env = self.herder_extension(self.env["zai"][candidate.BROWSER_SCOPE])
        for address in ("127.0.0.1:1234", "127.1.2.3:1234", "[::1]:1234"):
            self.pin("zai", ahap_env={**env, "AHAP_BROWSER_EXTENSION_LISTEN": address})
            _, rows = self.plan(["zai"], {"zai": self.pins["zai"]})
            self.assertEqual(json.loads(rows[0][1])["owner"]["ahap_env"]["AHAP_BROWSER_EXTENSION_LISTEN"], address)

    def test_chatgpt_cutover_installs_only_exact_pinned_recovery(self):
        activation = self.root / "browser-recovery-active.json"
        handoff = {"native_sessions": ["chatgpt::existing"], "activation_file": str(activation)}
        for field in ("human_stops", "human_requests", "choices", "unfinished_sessions"):
            path = self.root / (field + ".json")
            candidate.create(path, b"{}")
            handoff[field] = str(path)
        recovery = {"autopilot_state_dir": str(self.root), "legacy_handoff": handoff}
        for invalid in ({**recovery, "fallback_routes": [{"provider": "elsewhere"}]},
                        {**recovery, "legacy_handoff": {**handoff, "instance_wide": True}}):
            self.pin("chatgpt", browser_recovery=invalid)
            with self.assertRaises(ValueError):
                self.plan(["chatgpt"], {"chatgpt": self.pins["chatgpt"]})
        self.pin("chatgpt", browser_recovery=recovery,
                 ahap_env=self.herder_extension(self.env["chatgpt"][candidate.BROWSER_SCOPE]))
        _, extension_rows = self.plan(["chatgpt"], {"chatgpt": self.pins["chatgpt"]})
        self.assertEqual(json.loads(extension_rows[0][1])["owner"]["browser_recovery"], recovery)
        self.pin("chatgpt", browser_recovery=recovery)
        self.stage(["chatgpt"], {"chatgpt": self.pins["chatgpt"]})
        self.check()
        [row] = self.migration["profiles"]
        previous = candidate.read_json(self.paths["chatgpt"])
        successor = candidate.read_json(Path(row["payload"]))
        self.assertEqual(successor["owner"]["browser_recovery"], recovery)
        for field in ("database", "gate", "generation"):
            self.assertEqual(successor[field], previous[field])
        self.assertEqual(successor["owner"]["existing_sessions"], previous["owner"]["existing_sessions"])
        self.assertFalse(activation.exists())
        self.assertIn(str(self.paths["zai"]), self.new_selection["profiles"])

    def test_core_only_rebind_changes_only_exact_old_executable(self):
        path = self.paths["zai"]
        profile = candidate.read_json(path)
        del profile["owner"]["ahap_script"]
        profile["owner"].update(executable=self.base["core"], ahap_env=self.env["zai"])
        self.save_profile(path, profile)
        self.stage([], {})
        self.check()
        row, = self.migration["profiles"]
        self.assertEqual(Path(row["payload"]).read_bytes(), path.read_bytes().replace(
            json.dumps(self.base["core"]).encode(), json.dumps(self.manifest["core"]).encode()))
        self.assertIn(str(self.paths["chatgpt"]), self.new_selection["profiles"])
        profile["owner"]["executable"] = self.manifest["core"]
        self.save_profile(path, profile)
        with self.assertRaisesRegex(ValueError, "exact installed executable"):
            self.check()

    def test_recovery_rebinds_native_browser_and_preserves_legacy_browser(self):
        path = self.paths["zai"]
        profile = candidate.read_json(path)
        del profile["owner"]["ahap_script"]
        profile["owner"].update(executable=self.base["core"], ahap_env=self.env["zai"])
        self.save_profile(path, profile)
        self.seal_baseline()

        successor = candidate.read_json(self.root / "profile-codex.json")
        successor["owner"]["ahap_env"]["AHAP_CODEX_SOCKET"] = str(self.root / "shared.sock")
        reviewed = self.reviewed / "codex.json"
        candidate.create(reviewed, candidate.encoded(successor))
        args = (self.base, self.manifest, self.selection, self.selector, self.new, self.source)
        with self.assertRaisesRegex(ValueError, "only one profile migration type"):
            candidate.stage_native_profile_migration(*args, ["chatgpt"], self.pins, recovery_profiles=[reviewed])
        self.migration = candidate.stage_native_profile_migration(*args, [], {}, recovery_profiles=[reviewed])
        self.reseal()
        self.assertEqual(self.check()["profile_validation"], "staged_payloads_not_installed")
        rows = {row["kind"]: row for row in self.migration["profiles"]}
        self.assertEqual(set(rows), {"codex", "zai"})
        self.assertEqual(Path(rows["codex"]["payload"]).read_bytes(), reviewed.read_bytes())
        self.assertEqual(Path(rows["zai"]["payload"]).read_bytes(), path.read_bytes().replace(
            json.dumps(self.base["core"]).encode(), json.dumps(self.manifest["core"]).encode()))
        self.assertIn(str(self.paths["chatgpt"]), self.new_selection["profiles"])
        self.assert_unchanged()

        self.migration["profiles"].remove(rows["zai"])
        self.reseal()
        with self.assertRaisesRegex(ValueError, "exact reviewed profile bindings"):
            self.check()

    def test_schema_one_opencode_transition_keeps_original_payload_and_selector(self):
        path = self.root / "profile-opencode.json"
        previous = self.old_profiles[str(path)]
        # A first member (including its trailing comma) must be removed exactly as by the v1 builder.
        raw = previous.replace(b'"owner": {', b'"owner": {"ahap_script":'
                               + json.dumps(self.base["adapters"]["opencode"]).encode() + b',', 1)
        path.write_bytes(raw)
        self.stage(["opencode"], {})
        self.check()
        self.assertEqual((self.migration["schema"], self.migration["kind"]), (1, "opencode"))
        self.assertNotIn("bindings", self.migration)
        self.assertEqual(Path(self.migration["profiles"][0]["payload"]).read_bytes(), previous)

    def test_binding_file_privacy_independence_digest_and_schema(self):
        path = Path(self.pins["chatgpt"]["path"])
        def check(pin):
            with self.assertRaises((ValueError, OSError)):
                self.plan(["chatgpt"], {"chatgpt": pin})
        pin = self.pins["chatgpt"].copy()
        path.chmod(0o644)
        check(pin)
        path.chmod(0o600)
        link = self.reviewed / "link"
        link.symlink_to(path)
        check({**pin, "path": str(link)})
        hard = self.reviewed / "hard"
        os.link(path, hard)
        check(pin)
        hard.unlink()
        inside = self.new / "self-attestation.json"
        candidate.create(inside, path.read_bytes())
        check({**pin, "path": str(inside)})
        check({**pin, "sha256": "0" * 64})
        for changes in ({"kind": "zai"}, {"profile_sha256": "0" * 64}, {"instance": "override"}):
            self.pin("chatgpt", **changes)
            check(self.pins["chatgpt"])
        path.write_bytes(b'{"kind":"chatgpt","kind":"chatgpt"}')
        check({"path": str(path), "sha256": candidate.digest(path)})
        with self.assertRaisesRegex(ValueError, "requires a reviewed private"):
            self.plan(["chatgpt"], {})
        self.pin("zai")
        self.plan(["zai"], {"zai": self.pins["zai"]})

    def test_incomplete_mixed_or_unsafe_cdp_is_rejected_without_disclosing_values(self):
        good = self.env["chatgpt"]
        invalid = [dict((k, v) for k, v in good.items() if k != missing) for missing in candidate.CDP_FIELDS]
        for key, value in (("AHAP_BROWSER_TRANSPORT", "userio"), ("AHAP_BROWSER_CDP_CONTEXT_ID", " "),
                           ("AHAP_BROWSER_CDP_TARGET_ID", "not\nexact"), ("AHAP_BROWSER_CDP_TARGET_ID", "x" * 257),
                           (candidate.ORIGIN_PORT, "0"), (candidate.ORIGIN_PORT, 9223),
                           (candidate.BROWSER_SCOPE, "A" * 64), (candidate.BROWSER_SCOPE, "d" * 64),
                           ("AHAP_USERIO_ACCESS_TOKEN_FILE", "private-sentinel"), ("LD_PRELOAD", "private-sentinel")):
            invalid.append({**good, key: value})
        for url in ("wss://localhost/devtools/browser/one", "ws://other-host/devtools/browser/one",
                    "ws://private-sentinel@localhost/devtools/browser/one", "ws://localhost/devtools/page/one",
                    good["AHAP_BROWSER_CDP_WS_URL"] + "?query=private-sentinel",
                    good["AHAP_BROWSER_CDP_WS_URL"] + "#private-sentinel", "ws://localhost:65536/devtools/browser/one"):
            invalid.append({**good, "AHAP_BROWSER_CDP_WS_URL": url})
        for i, env in enumerate(invalid):
            with self.subTest(case=i):
                self.pin("chatgpt", ahap_env=env)
                with self.assertRaises(ValueError) as refused:
                    self.plan(["chatgpt"], self.pins)
                self.assertNotIn("private-sentinel", str(refused.exception))

    def test_old_scope_alias_grants_and_unreviewed_runner_fail_closed(self):
        original = candidate.read_json(self.paths["chatgpt"])
        for mutate in (lambda o: o["ahap_env"].update(AHAP_USERIO_ACCOUNT_SCOPE="f" * 64),
                       lambda o: o["existing_sessions"][0].update(account_scope="f" * 64),
                       lambda o: o["ahap_env"].update(AHAP_BROWSER_CDP_TARGET_ID="partial"),
                       lambda o: o.update(executable=self.base["core"]), lambda o: o.update(ahap_script=str(self.wrapper))):
            profile = copy.deepcopy(original)
            mutate(profile["owner"])
            self.save_profile(self.paths["chatgpt"], profile)
            self.pin("chatgpt")
            with self.assertRaises(ValueError):
                self.plan(["chatgpt"], self.pins)

    def test_resealed_browser_payload_cannot_select_its_own_authority_or_binding(self):
        self.stage(["chatgpt"], self.pins)
        row = self.migration["profiles"][0]
        payload_dir = Path(row["payload"]).parent
        payload_dir.chmod(0o700)
        original = candidate.read_json(row["payload"])
        for mutate in (lambda p: p.update(database="other"), lambda p: p.update(gate="other"),
                       lambda p: p.update(generation="other"), lambda p: p["owner"].update(principal="other"),
                       lambda p: p["owner"].update(instance="other"), lambda p: p["owner"].update(node="other"),
                       lambda p: p["owner"].update(existing_sessions=[]),
                       lambda p: p["owner"].update(executable=self.base["core"]),
                       lambda p: p["owner"]["ahap_env"].update(AHAP_BROWSER_CDP_TARGET_ID="other")):
            value = copy.deepcopy(original)
            mutate(value)
            raw = candidate.encoded(value)
            sha = hashlib.sha256(raw).hexdigest()
            payload = payload_dir / (sha + ".json")
            candidate.create(payload, raw, 0o400)
            target = self.alias / ("profile-process-leases-native-" + self.source[:12] + "-" + sha[:20] + ".json")
            row.update(path=str(target), payload=str(payload), sha256=sha, payload_sha256=sha)
            self.reseal()
            with self.assertRaisesRegex(ValueError, "exact reviewed profile bindings"):
                self.check()
        self.assert_unchanged()

    def test_same_profile_bytes_under_retargeted_authority_alias_are_rejected(self):
        self.stage(["chatgpt"], self.pins)
        replacement = self.root / "other-authority"
        shutil.copytree(self.authority, replacement)
        self.alias.unlink()
        self.alias.symlink_to(replacement, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "exact reviewed profile bindings"):
            self.check()

    def test_binding_is_checked_again_and_an_old_launcher_cannot_skip_profiles(self):
        self.stage(["chatgpt"], self.pins)
        self.new_launcher.chmod(0o700)
        self.new_launcher.write_text(fixtures.NEW_LAUNCHER)
        with self.assertRaisesRegex(ValueError, "launcher differs"):
            self.check()
        self.reseal()
        with self.assertRaisesRegex(ValueError, "exact reviewed owner profiles"):
            self.check()
        path = Path(self.pins["chatgpt"]["path"])
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "binding digest mismatch"):
            self.check()

    def test_remote_browser_wrapper_must_keep_its_exact_identity_even_on_selected_kind(self):
        wrapper = self.old / "remote-zai.mjs"
        candidate.create(wrapper, b"remote browser transport")
        config = Path(str(wrapper) + ".json")
        candidate.create(config, candidate.encoded({"nodeRef": "remote-node", "kind": "zai"}))
        self.base["remote_ahap_wrappers"].append({"kind": "zai", "node": "remote-node", "instance": "remote-zai",
            "script": str(wrapper), "script_sha256": candidate.digest(wrapper), "config_sha256": candidate.digest(config)})
        path = self.alias / "remote-zai.json"
        profile = candidate.read_json(self.paths["zai"])
        profile["owner"].update(node="remote-node", instance="remote-zai", ahap_script=str(wrapper))
        candidate.create(path, b"")
        self.save_profile(path, profile)
        self.seal_baseline()
        self.stage(["zai"], {})
        self.check()
        self.assertIn(str(path), self.new_selection["profiles"])
        profile["owner"]["ahap_script"] = self.base["adapters"]["zai"]
        self.save_profile(path, profile)
        with self.assertRaisesRegex(ValueError, "exact retained remote wrapper"):
            self.check()

    def test_later_ahap_build_can_only_rebind_an_already_native_browser(self):
        profile = candidate.read_json(self.paths["zai"])
        del profile["owner"]["ahap_script"]
        profile["owner"].update(executable=self.base["core"], ahap_env=self.env["zai"])
        self.save_profile(self.paths["zai"], profile)
        previous = self.root / "profile-zcode.json"
        zcode = candidate.read_json(previous)
        zcode.update(database=str(self.alias / "database"), gate=str(self.alias / "gate"))
        zcode["owner"]["ahap_env"] = {}
        del self.old_profiles[str(previous)]
        path = self.alias / "zcode.json"
        candidate.create(path, b"")
        self.save_profile(path, zcode)
        self.seal_baseline()
        path = self.new / "fixture/ahap-zcode-runner.mjs"
        candidate.create(path, b"new ZCode runner", 0o400)
        old = self.base["adapters"]["zcode"]
        self.migration_key = "adapter_migration"
        self.migration = candidate.stage_adapter_migration(self.base, self.manifest, self.selection,
            self.selector, self.new, self.source, {"zcode": {
                "previous_path": old, "previous_sha256": candidate.digest(old),
                "previous_source_commit": candidate.adapter_source(self.base, "zcode"), "path": str(path),
                "sha256": candidate.digest(path), "source_commit": self.source, "compiled_entrypoint_sha256": "e" * 64}},
            {"source_commit": self.source, "bundler_sha256": "f" * 64, "compile_argv": [["tsc"], ["tsc"]]})
        self.reseal()
        self.check()
        self.assertEqual([row["kind"] for row in self.migration["profiles"]], ["zcode", "zai"])
        self.assertTrue(all(Path(row["path"]).parent == self.alias for row in self.migration["profiles"]))
        self.assertIn(str(self.paths["chatgpt"]), self.new_selection["profiles"])
        self.migration["profiles"].pop()
        self.migration["schema"] = 1
        self.reseal()
        with self.assertRaisesRegex(ValueError, "required native browser core rebinds"):
            self.check()


class FreshBundlerContract(unittest.TestCase):
    def test_real_compiler_and_existing_bundler_use_fresh_workspace_package(self):
        repo = Path(__file__).resolve().parents[2]
        if not (repo / "node_modules/typescript/bin/tsc").exists():
            self.skipTest("repository Node dependencies are unavailable on this test host")
        node = Path(shutil.which("node")).resolve()
        with tempfile.TemporaryDirectory(prefix="herder-adapter-bundle-test-") as temp:
            root = Path(temp)
            source, output = root / "source", root / "candidate"
            source.mkdir(mode=0o700)
            output.mkdir(mode=0o700)
            (output / "fixture").mkdir(mode=0o700)
            (source / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
            files = {
                ".gitignore": ".tmp/\nnode_modules\n",
                "package.json": json.dumps({"type": "module"}),
                "tsconfig.json": json.dumps({"compilerOptions": {"target": "ES2022", "module": "NodeNext",
                    "moduleResolution": "NodeNext", "rootDir": "src", "types": [], "skipLibCheck": True}, "include": ["src/**/*"]}),
                "packages/agent-resume/package.json": json.dumps({"name": "agent-resume-mcp", "type": "module",
                    "exports": {".": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}}}),
                "packages/agent-resume/tsconfig.json": json.dumps({"compilerOptions": {"target": "ES2022", "module": "NodeNext",
                    "moduleResolution": "NodeNext", "rootDir": "src", "outDir": "dist", "declaration": True,
                    "types": [], "skipLibCheck": True}, "include": ["src/**/*"]}),
                "packages/agent-resume/src/index.ts": 'export const evidence = "fresh-shared-package-evidence";\n',
                "src/herder-process-remote-bridge.ts": 'import { evidence } from "agent-resume-mcp"; export const result = evidence + "-remote";\n',
                "deploy/fleet/build-v1-core.py": Path(__file__).with_name("build-v1-core.py").read_text(),
            }
            for kind in ("opencode", "zcode", "browser", "codex"):
                files["src/ahap-" + kind + "-runner.ts"] = 'import { evidence } from "agent-resume-mcp"; export const receipt = evidence;\n'
            for name, data in files.items():
                path = source / name
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                path.write_text(data)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=source, stderr=subprocess.DEVNULL, text=True).strip()
            git("init", "-q")
            git("add", ".")
            git("-c", "user.name=Migration Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "isolated source")
            sha = git("rev-parse", "HEAD")
            old = root / "old.mjs"
            candidate.create(old, b"previous adapter")
            base = {"node": str(node), "sha256": {"node": candidate.digest(node),
                    "adapters": {kind: candidate.digest(old) for kind in ("opencode", "zcode", "codex")}},
                    "adapters": {kind: str(old) for kind in ("opencode", "zcode", "codex")}, "source_commit": sha}
            compilation = candidate.compile_typescript(source, output, sha, base)
            adapters, evidence = candidate.bundle_adapters(source, output, sha, base, ["opencode", "zcode", "codex"], compilation)
            remote = candidate.bundle_process_remote_bridge(source, output, sha, base, compilation)
            self.assertEqual(set(adapters), {"opencode", "zcode", "codex"})
            self.assertEqual(evidence["source_commit"], sha)
            self.assertEqual(git("status", "--porcelain"), "")
            for item in adapters.values():
                self.assertIn("fresh-shared-package-evidence", Path(item["path"]).read_text())
            self.assertFalse((output / "fixture/ahap-browser-runner.mjs").exists())
            self.assertEqual(remote["build"]["source_commit"], sha)
            self.assertEqual(remote["build"]["source_sha256"], candidate.digest(source / "src/herder-process-remote-bridge.ts"))
            self.assertEqual(remote["sha256"], candidate.digest(remote["path"]))
            self.assertEqual(Path(remote["path"]).stat().st_mode & 0o777, 0o400)
            self.assertEqual(remote["build"]["compile_argv"], evidence["compile_argv"])
            subprocess.run([str(node), "--input-type=module", "--eval",
                'const m=await import(process.argv[1]);if(m.result!=="fresh-shared-package-evidence-remote")throw new Error("dependency closure mismatch");',
                remote["path"]], check=True, capture_output=True, text=True, timeout=10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
