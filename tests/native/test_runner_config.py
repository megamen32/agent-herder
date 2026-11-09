import hashlib
import json
import os
from pathlib import Path
import platform
import tempfile
import unittest
from unittest.mock import patch

import runner_config


class RunnerConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmp_root = Path(self.tmp.name).resolve()
        self.root = self.tmp_root / "artifact space"
        self.root.mkdir()
        self.manifest = {"source_commit": "a" * 40, "launch": ["python", "stand", "--core", "{core}"], "sha256": {}}
        for name in ("core", "adapter", "opencode"):
            path = self.root / name
            path.write_text(name)
            path.chmod(0o755)
            self.manifest[name] = str(path)
            self.manifest["sha256"][name] = hashlib.sha256(name.encode()).hexdigest()
        self.manifest_path = self.root / "manifest.json"
        self.save_manifest()
        self.config = {"artifact_root": str(self.root), "manifest": str(self.manifest_path),
                       "capabilities": {"os": "linux", "arch": "x86_64", "backend": "linux-netns-bwrap"}}
        for name in ("python", "node", "bootstrap", "stand", "launcher"):
            path = self.tmp_root / name
            path.write_text(name)
            path.chmod(0o755)
            self.config[name] = str(path)
        (self.tmp_root / "test-model-server.py").write_text("fixture")
        self.system = patch.object(platform, "system", return_value="Linux")
        self.machine = patch.object(platform, "machine", return_value="x86_64")
        self.which = patch.object(runner_config.shutil, "which", return_value="/bin/tool")
        for p in (self.system, self.machine, self.which):
            p.start()
            self.addCleanup(p.stop)

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def test_argv_uses_config_and_verified_manifest_without_shell(self):
        result = runner_config.build(self.config)
        argv = result["argv"]
        self.assertEqual(argv[:2], [self.config["python"], self.config["launcher"]])
        separator = argv.index("--")
        self.assertEqual(argv[separator + 1:separator + 3], [self.config["python"], self.config["stand"]])
        for path in (self.manifest["core"], self.manifest["adapter"], self.manifest["opencode"], self.config["node"], self.config["bootstrap"], str(Path(self.config["stand"]).parent)):
            self.assertIn(["--ro-bind", path], [argv[i:i+2] for i in range(separator)])
        self.assertEqual(argv[argv.index("--runner") + 1], self.manifest["adapter"])
        self.assertEqual(result["identities"]["sha256"], self.manifest["sha256"])
        self.assertNotIn("launch", result["identities"])

    def test_rejects_changed_artifact_before_argv(self):
        (self.root / "adapter").write_text("changed")
        with self.assertRaisesRegex(runner_config.ConfigError, "adapter: SHA-256 mismatch"):
            runner_config.build(self.config)

    def test_rejects_missing_prerequisite_and_wrong_arch(self):
        with patch.object(runner_config.shutil, "which", return_value=None):
            with self.assertRaisesRegex(runner_config.ConfigError, "unshare"):
                runner_config.build(self.config)
        self.config["capabilities"]["arch"] = "arm64"
        with self.assertRaisesRegex(runner_config.ConfigError, "does not match"):
            runner_config.build(self.config)

    def test_rejects_escape_and_non_executable(self):
        self.manifest["core"] = self.config["python"]
        self.save_manifest()
        with self.assertRaisesRegex(runner_config.ConfigError, "outside artifact_root"):
            runner_config.build(self.config)
        self.manifest["core"] = str(self.root / "core")
        self.save_manifest()
        os.chmod(self.config["bootstrap"], 0o600)
        with self.assertRaisesRegex(runner_config.ConfigError, "not executable"):
            runner_config.build(self.config)

    def test_consumer_can_read_the_exact_manifest_inside_sandbox(self):
        argv = runner_config.build(self.config)["argv"]
        mounts = [argv[i+1] for i, value in enumerate(argv[:-1]) if value == "--ro-bind"]
        self.assertIn(str(self.manifest_path), mounts)

    def test_v1_manifest_uses_explicit_hashed_external_opencode(self):
        binary = self.tmp_root / "official-opencode"
        binary.write_bytes(b"official-native")
        binary.chmod(0o755)
        self.manifest.pop("opencode")
        self.manifest["sha256"].pop("opencode")
        self.save_manifest()
        self.config.update(opencode=str(binary), opencode_sha256=hashlib.sha256(b"official-native").hexdigest())
        result = runner_config.build(self.config)
        self.assertEqual(result["argv"][result["argv"].index("--opencode")+1], str(binary))
        binary.write_bytes(b"changed-native")
        with self.assertRaisesRegex(runner_config.ConfigError, "SHA-256 mismatch"):
            runner_config.build(self.config)

    def test_v1_node_and_bootstrap_must_match_manifest_hashes(self):
        for name in ("node", "bootstrap"):
            self.manifest["sha256"][name] = "b" * 64
            self.save_manifest()
            with self.subTest(name=name), self.assertRaisesRegex(runner_config.ConfigError, "SHA-256 mismatch"):
                runner_config.build(self.config)
            self.manifest["sha256"].pop(name)

    def test_malformed_manifest_is_bounded_and_does_not_echo_secret(self):
        self.manifest["source_commit"] = "secret-value"
        self.save_manifest()
        with self.assertRaises(runner_config.ConfigError) as ctx:
            runner_config.build(self.config)
        self.assertNotIn("secret-value", str(ctx.exception))
        self.manifest["source_commit"] = "a" * 40
        self.manifest["launch"] = "shell command"
        self.save_manifest()
        with self.assertRaisesRegex(runner_config.ConfigError, "argv list"):
            runner_config.build(self.config)


if __name__ == "__main__":
    unittest.main()
