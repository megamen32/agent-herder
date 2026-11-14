#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ts_runtime", HERE / "process-leases-ts-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
SOURCE = "a" * 40

class RuntimePublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.release = self.root / "releases" / SOURCE
        self.dist = self.release / "dist"
        self.dist.mkdir(parents=True)
        for name in runtime.readiness.REQUIRED_FILES:
            (self.dist / name).write_text("export const ready = true;\n")
        (self.dist / "fleet-deployment-manifest.json").write_text(json.dumps({"source_sha": SOURCE}))
        self.node = self.root / "node"
        self.node.write_bytes(b"fixture-node-bytes")
        self.node.chmod(0o500)
        self.manifest = self.root / "runtime.json"

    def tearDown(self):
        for directory, children, names in os.walk(self.root):
            os.chmod(directory, 0o700)
            for name in names:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def test_published_runtime_passes_independent_reader_and_detects_tampering(self):
        identity = runtime.freeze(self.release, SOURCE, self.node, self.manifest)
        manifest, _, _ = runtime.readiness.runtime_tree(identity)
        self.assertEqual(manifest["files"]["index.js"], hashlib.sha256((self.dist / "index.js").read_bytes()).hexdigest())
        self.assertEqual(stat.S_IMODE(self.dist.stat().st_mode), 0o500)
        target = self.dist / "index.js"
        target.chmod(0o600)
        target.write_text("changed")
        target.chmod(0o400)
        with self.assertRaises(ValueError):
            runtime.readiness.runtime_tree(identity)

    def test_source_mismatch_refused_before_freeze(self):
        (self.dist / "fleet-deployment-manifest.json").write_text(json.dumps({"source_sha": "b" * 40}))
        before = (self.dist / "index.js").stat().st_mode
        with self.assertRaisesRegex(ValueError, "compiled_source"):
            runtime.freeze(self.release, SOURCE, self.node, self.manifest)
        self.assertEqual(before, (self.dist / "index.js").stat().st_mode)
        self.assertFalse(self.manifest.exists())

    def test_shared_node_is_refused_before_freeze(self):
        os.link(self.node, self.root / "node-alias")
        with self.assertRaises(ValueError):
            runtime.freeze(self.release, SOURCE, self.node, self.manifest)
        self.assertFalse(self.manifest.exists())
        self.assertNotEqual(stat.S_IMODE(self.dist.stat().st_mode), 0o500)

    def test_symlink_in_tree_refused_before_freeze(self):
        (self.dist / "unreviewed.js").symlink_to(self.node)
        with self.assertRaises(ValueError):
            runtime.freeze(self.release, SOURCE, self.node, self.manifest)
        self.assertFalse(self.manifest.exists())

    def test_owner_identity_uses_explicit_user_bus_when_inherited_environment_is_empty(self):
        called = {}
        def run(argv, **kwargs):
            called.update(argv=argv, environment=kwargs["env"])
            return subprocess.CompletedProcess(argv, 0, str(os.getpid()) + "\n", "")
        with patch.dict(os.environ, {}, clear=True), patch.object(runtime.subprocess, "run", side_effect=run):
            observed = runtime.owner_identity(runtime.readiness.UNIT)
        self.assertEqual(observed[0], os.getpid())
        self.assertEqual(called["environment"]["XDG_RUNTIME_DIR"], "/run/user/" + str(os.getuid()))
        self.assertEqual(called["environment"]["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/" + str(os.getuid()) + "/bus")
        self.assertEqual(called["argv"][:3], ["/usr/bin/systemctl", "--user", "show"])

    def test_unit_compare_and_swap_preserves_foreign_edit(self):
        dropin = self.root / "10-release.conf"
        dropin.write_bytes(b"old")
        dropin.chmod(0o600)
        expected = runtime.digest(b"old")
        dropin.write_bytes(b"other release")
        with self.assertRaisesRegex(ValueError, "install_file_changed"):
            runtime.replace(dropin, b"new", expected)
        self.assertEqual(dropin.read_bytes(), b"other release")

    def test_live_legacy_service_refuses_before_journal_or_unit_changes(self):
        identity = runtime.freeze(self.release, SOURCE, self.node, self.manifest)
        catalog = self.root
        (catalog / "current").symlink_to("releases/" + "b" * 40)
        cfg = catalog / "node-config.json"
        cfg.write_text(json.dumps({"sourceSha": "b" * 40}))
        cfg.chmod(0o600)
        old = self.root / "10-release.conf"
        old.write_bytes(b"old unit")
        old.chmod(0o600)
        canonical = self.root / "99-canonical.conf"
        plan = {"version": 1, "kind": "herder-canonical-ts-install",
                "source_commit": SOURCE, "runtime": identity, "canonical": {},
                "catalog": str(catalog), "current_target": "releases/" + "b" * 40,
                "previous_source": "b" * 40, "node_config_sha256": runtime.digest(cfg.read_bytes()),
                "drop_in": {"path": str(old), "sha256": runtime.digest(old.read_bytes())},
                "canonical_drop_in": {"path": str(canonical), "sha256": None}}
        plan_path = self.root / "install-plan.json"
        pin = runtime.publish(plan_path, runtime.encoded(plan))
        journal = self.root / "journal"
        with patch.object(runtime.readiness, "writer_drain"), patch.object(runtime, "stopped_service",
                side_effect=ValueError("legacy_service_not_stopped")), patch.object(runtime, "module") as modules:
            with self.assertRaisesRegex(ValueError, "legacy_service_not_stopped"):
                runtime.install(plan_path, pin["sha256"], self.root / "proof", journal)
            modules.assert_not_called()
        self.assertFalse(journal.exists())
        self.assertFalse(canonical.exists())
        self.assertEqual(old.read_bytes(), b"old unit")
        self.assertEqual(os.readlink(catalog / "current"), "releases/" + "b" * 40)

if __name__ == "__main__":
    unittest.main()
