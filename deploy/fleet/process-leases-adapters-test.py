#!/usr/bin/env python3
"""Review adapter/profile migration in isolated authorities; no live runtime."""
import argparse
import copy
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


class AdapterMigrationContracts(unittest.TestCase):
    def setUp(self):
        fixtures.RolloutContracts.setUp(self)
        self.source = "d" * 40
        self.base["remote_ahap_wrappers"] = []
        self.base["component_provenance"].update(opencode_source_commit="b" * 40, zcode_source_commit="c" * 40)
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
        self.base["adapter"] = self.base["adapters"]["opencode"]
        self.base["sha256"]["adapter"] = self.base["sha256"]["adapters"]["opencode"]
        self.base_manifest.write_bytes(candidate.encoded(self.base))
        self.selection.update(manifest_sha256=candidate.digest(self.base_manifest), profiles=list(self.old_profiles))
        self.selector.write_bytes(candidate.encoded(self.selection))
        self.before_selector = self.selector.read_bytes()
        self.install_args.expected_selector_sha256 = candidate.digest(self.selector)
        hashes = {key: self.manifest["sha256"][key] for key in ("core", "process_worker", "process_config")}
        self.manifest = candidate.compose_manifest(self.base, self.new, self.source, self.base_manifest,
            candidate.digest(self.base_manifest), hashes, ["cargo", "build"])
        adapters = {}
        for kind in ("opencode", "zcode"):
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
        self.new_launcher.chmod(0o700)
        self.new_launcher.write_bytes(Path(__file__).with_name("launch-v1-core.py").read_bytes())
        self.new_launcher.chmod(0o500)
        candidate.create(self.new / "check-selector.json", b"{}")
        self.reseal()

    def reseal(self):
        migration_path = self.new / "adapter-migration.json"
        migration_path.chmod(0o600)
        migration_path.write_bytes(candidate.encoded(self.migration))
        self.manifest["sha256"]["adapter_migration"] = candidate.digest(migration_path)
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
            adapter_migration_sha256=candidate.digest(migration_path))
        (self.new / "process-leases-build.json").write_bytes(candidate.encoded(self.build_receipt))

    def check(self):
        return candidate.check_candidate(self.new_selector, self.new_launcher)

    def assert_unchanged(self):
        self.assertEqual(self.selector.read_bytes(), self.before_selector)
        self.assertEqual(self.database.read_bytes(), self.before_db)
        for path, raw in self.old_profiles.items():
            self.assertEqual(Path(path).read_bytes(), raw)

    def test_staging_checks_actual_payloads_without_creating_authority_files(self):
        self.assertEqual(self.check()["profile_validation"], "staged_payloads_not_installed")
        for item in self.migration["profiles"]:
            self.assertFalse(Path(item["path"]).exists())
            old = self.old_profiles[item["previous_path"]]
            expected = candidate.profile_payload(old, self.base["adapters"][item["kind"]], self.manifest["adapters"][item["kind"]])
            self.assertEqual(Path(item["payload"]).read_bytes(), expected)
        self.assertEqual(self.manifest["adapters"]["codex"], self.base["adapters"]["codex"])
        self.assert_unchanged()
        with self.assertRaises(FileNotFoundError):
            candidate.check_selector(self.new_selector, self.new_launcher)

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
        self.manifest["adapters"]["codex"] = self.manifest["adapters"]["opencode"]
        self.manifest["sha256"]["adapters"]["codex"] = self.manifest["sha256"]["adapters"]["opencode"]
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

    def test_later_core_only_release_does_not_reuse_old_profile_migration(self):
        hashes = {key: self.manifest["sha256"][key] for key in ("core", "process_worker", "process_config")}
        later = candidate.compose_manifest(self.manifest, self.new, "a" * 40, self.manifest_path,
            candidate.digest(self.manifest_path), hashes, ["cargo", "build"])
        self.assertNotIn("adapter_migration", later)
        self.assertNotIn("adapter_migration", later["sha256"])
        self.assertEqual(later["adapters"], self.manifest["adapters"])


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
                    "adapters": {kind: candidate.digest(old) for kind in ("opencode", "zcode")}},
                    "adapters": {kind: str(old) for kind in ("opencode", "zcode")}, "source_commit": sha}
            adapters, evidence = candidate.bundle_adapters(source, output, sha, base, ["opencode", "zcode"])
            self.assertEqual(set(adapters), {"opencode", "zcode"})
            self.assertEqual(evidence["source_commit"], sha)
            self.assertEqual(git("status", "--porcelain"), "")
            for item in adapters.values():
                self.assertIn("fresh-shared-package-evidence", Path(item["path"]).read_text())
            self.assertFalse((output / "fixture/ahap-codex-runner.mjs").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
