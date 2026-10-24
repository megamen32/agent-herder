"""Focused release-installer invariants; no service or configuration mutations."""
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rollout_node", ROOT / "deploy/fleet/rollout-node.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)


class RolloutNodeInstallTests(unittest.TestCase):
    def test_linux_release_identity_comes_from_absolute_entrypoint_argument(self):
        with tempfile.TemporaryDirectory() as temporary:
            fleet = pathlib.Path(temporary) / "fleet"
            sha = "6549b34255adb669782f8f07f5b7b852045fd708"
            entrypoint = fleet / "releases" / sha / "dist" / "index.js"
            cmdline = b"/usr/local/bin/node\0" + os.fsencode(entrypoint) + b"\0"
            self.assertEqual(rollout.release_from_cmdline(cmdline, fleet), sha)
            self.assertEqual(rollout.release_from_cmdline(b"node\0dist/index.js\0", fleet), "")
            self.assertEqual(rollout.release_from_cmdline(
                b"node\0" + os.fsencode(pathlib.Path(temporary) / "releases" / sha / "dist/index.js"), fleet), "")

    def test_linux_release_budget_counts_physical_blocks_once_per_hardlinked_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            fleet = pathlib.Path(temporary)
            releases = fleet / "releases"
            first = releases / "first" / "node_modules" / "shared-package"
            second = releases / "second" / "node_modules" / "shared-package"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_bytes(b"x" * 65536)
            second.hardlink_to(first)
            paths = [path for release in (releases / "first", releases / "second")
                     for path in (release, *release.rglob("*"))]
            seen = set()
            expected = 0
            for path in paths:
                info = path.lstat()
                identity = (info.st_dev, info.st_ino)
                if identity not in seen:
                    expected += info.st_blocks * 512
                    seen.add(identity)
            with patch.object(rollout.sys, "platform", "linux"):
                self.assertEqual(rollout.release_budget(fleet), (2, expected))
                self.assertTrue(rollout.release_budget_admitted(*rollout.release_budget(fleet)))

    def test_systemd_exec_dropin_update_preserves_exact_rollback_and_restores_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            unit = "agent-herder.service"
            dropin = rollout.systemd_release_dropin_path(unit, home)
            dropin.parent.mkdir(parents=True)
            original = b"[Service]\nEnvironment=KEEP=1\nExecStart=/old/node /old/index.js\n"
            dropin.write_bytes(original)
            dropin.chmod(0o640)
            sha = "6549b34255adb669782f8f07f5b7b852045fd708"
            release = home / "agents-projects" / ".fleet" / "releases" / sha
            snapshot = rollout.preserve_systemd_release_dropin(dropin, sha)
            rollout.write_systemd_release_dropin(dropin, "/usr/local/bin/node", release, sha)
            installed = dropin.read_text()
            self.assertIn("ExecStart=\n", installed)
            self.assertIn(f"ExecStart=/usr/local/bin/node {release}/dist/index.js\n", installed)
            self.assertEqual(snapshot.exists(), True)
            self.assertEqual(dropin.stat().st_mode & 0o777, 0o640)
            rollout.restore_systemd_release_dropin(dropin, snapshot, sha)
            self.assertEqual(dropin.read_bytes(), original)
            self.assertEqual(dropin.stat().st_mode & 0o777, 0o640)

    def test_systemd_exec_dropin_rollback_removes_new_file_when_original_was_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            dropin = rollout.systemd_release_dropin_path("agent-herder.service", home)
            sha = "6549b34255adb669782f8f07f5b7b852045fd708"
            snapshot = rollout.preserve_systemd_release_dropin(dropin, sha)
            rollout.write_systemd_release_dropin(
                dropin, "/usr/local/bin/node", home / "releases" / sha, sha)
            self.assertTrue(dropin.exists())
            rollout.restore_systemd_release_dropin(dropin, snapshot, sha)
            self.assertFalse(dropin.exists())

    def test_linux_install_wires_dropin_reload_before_restart_and_accepts_entrypoint_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            fleet = root / "fleet"
            previous = "af06240abbe0a9567289b40e0e44328ee49e1942"
            target = "6549b34255adb669782f8f07f5b7b852045fd708"
            (fleet / "releases" / previous / "dist").mkdir(parents=True)
            (fleet / "releases" / target / "dist").mkdir(parents=True)
            (fleet / "current").symlink_to(fleet / "releases" / previous)
            config = fleet / "node-config.json"
            config.write_text(__import__("json").dumps({"sourceSha": previous, "nodeBin": "/usr/bin/node"}))
            argv = ["rollout-node.py", "--fleet-dir", str(fleet), "--sha", target,
                    "--port", "19091", "--restart-cmd", "systemctl --user restart agent-herder.service",
                    "--previous-sha", previous, "--unit", "agent-herder.service"]
            order = []

            def daemon_reload():
                order.append("reload")
                return True

            def restart(command):
                order.append("restart")
                return subprocess.CompletedProcess(command, 0, "", "")

            with (patch.object(sys, "argv", argv),
                  patch.object(rollout.Path, "home", return_value=root),
                  patch.object(rollout, "disarm_state", return_value="armed"),
                  patch.object(rollout, "system_pause_state", return_value="inactive"),
                  patch.object(rollout, "process_environment_value", return_value="/state"),
                  patch.object(rollout, "prepare_packages", return_value="unchanged"),
                  patch.object(rollout, "verify_payload", return_value={
                      "source_sha_ok": True, "missing": [], "extra": [], "mismatched": []}),
                  patch.object(rollout, "release_budget", return_value=(2, 0)),
                  patch.object(rollout, "package_resolution", return_value="resolved"),
                  patch.object(rollout, "wait_codex_socket", return_value=True),
                  patch.object(rollout, "systemd_daemon_reload", side_effect=daemon_reload),
                  patch.object(rollout, "restart", side_effect=restart),
                  patch.object(rollout, "wait_port", return_value=True),
                  patch.object(rollout, "running_release", return_value=target),
                  patch.object(rollout, "http_status", return_value=200),
                  patch.object(rollout, "mcp_status", return_value=200),
                  patch.object(rollout.time, "sleep")):
                self.assertEqual(rollout.main(), 0)

            dropin = rollout.systemd_release_dropin_path("agent-herder.service", root)
            self.assertIn(f"{fleet}/releases/{target}/dist/index.js", dropin.read_text())
            self.assertEqual(order[:2], ["reload", "restart"])
            self.assertEqual(__import__("json").loads(config.read_text())["sourceSha"], target)
            self.assertEqual((fleet / "current").resolve(), fleet / "releases" / target)


if __name__ == "__main__":
    unittest.main()
