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
        self.root = Path(self.tmp.name) / "artifact space"
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
            path = Path(self.tmp.name) / name
            path.write_text(name)
            path.chmod(0o755)
            self.config[name] = str(path)
        (Path(self.tmp.name) / "test-model-server.py").write_text("fixture")
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
