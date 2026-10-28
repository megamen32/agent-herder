"""Focused release-installer invariants; no service or configuration mutations."""
import importlib.util
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rollout_node", ROOT / "deploy/fleet/rollout-node.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)
SPEC_CANDIDATE = importlib.util.spec_from_file_location(
    "rollout_candidate", ROOT / "deploy/fleet/rollout-candidate.py")
candidate = importlib.util.module_from_spec(SPEC_CANDIDATE)
SPEC_CANDIDATE.loader.exec_module(candidate)


class RolloutNodeInstallTests(unittest.TestCase):
    def test_node_side_reuses_its_python_interpreter_for_rollout_node(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            fleet = root / "fleet"
            previous = "af06240abbe0a9567289b40e0e44328ee49e1942"
            target = "6549b34255adb669782f8f07f5b7b852045fd708"
            (fleet / "releases" / previous).mkdir(parents=True)
            source = root / "candidate"
            (source / "dist").mkdir(parents=True)
            (source / "dist" / "index.js").write_text("candidate\n")
            archive = root / "candidate.tar"
            candidate.pack_release(source, archive)
            arguments = type("Args", (), {
                "fleet_dir": str(fleet), "sha": target, "previous_sha": previous,
                "archive": str(archive), "restart_cmd": "launchctl kickstart -k user/501/example",
                "web_port": 18789, "unit": "com.bezrabotnyi.agent-herder-fleet-node",
                "state_dir": "/state",
            })()
            calls = []
            with (patch.object(candidate, "HERE", root / "tools"),
                  patch.object(candidate.subprocess, "run", side_effect=lambda command, **kwargs: (
                      calls.append(command) or subprocess.CompletedProcess(command, 0, "", "")))):
                self.assertEqual(candidate.node_side_fleet(arguments), 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], sys.executable)
            self.assertEqual(calls[0][1], str(root / "tools" / "rollout-node.py"))

    def test_darwin_fleet_launcher_resolves_exact_active_user_domain_agent(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            fleet = home / ".local/share/agent-herder/fleet"
            fleet.mkdir(parents=True)
            watchdog = fleet / "mac-node-watchdog.py"
            watchdog.write_text("# installed watchdog\n")
            python = home / "Python"
            python.write_text("")
            python.chmod(0o700)
            plist_path = home / "Library/LaunchAgents/com.bezrabotnyi.agent-herder-fleet-node.plist"
            plist_path.parent.mkdir(parents=True)
            plist_path.write_bytes(plistlib.dumps({
                "Label": "com.bezrabotnyi.agent-herder-fleet-node",
                "ProgramArguments": [str(python), "-I", "-S", "-B", str(watchdog)],
                "RunAtLoad": True,
                "KeepAlive": False,
            }))
            def launchctl(args, **kwargs):
                if args[-1].startswith("gui/"):
                    return subprocess.CompletedProcess(args, 113, "", "Could not find service")
                return subprocess.CompletedProcess(args, 0,
                    f"\tpath = {plist_path}\n\tstate = running\n\tprogram = {python}\n\tpid = 456\n", "")
            with (patch.object(rollout.Path, "home", return_value=home),
                  patch.object(rollout.os, "getuid", return_value=os.getuid()),
                  patch.object(rollout.subprocess, "run", side_effect=launchctl)):
                proof = rollout.darwin_fleet_launchd_proof(fleet, "com.bezrabotnyi.agent-herder-fleet-node")
            self.assertEqual(proof["domain"], f"user/{os.getuid()}")
            self.assertEqual(proof["pid"], "456")

    def test_darwin_fleet_launcher_refuses_unrelated_program_arguments(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            fleet = home / ".local/share/agent-herder/fleet"
            fleet.mkdir(parents=True)
            (fleet / "mac-node-watchdog.py").write_text("# installed watchdog\n")
            plist_path = home / "Library/LaunchAgents/com.bezrabotnyi.agent-herder-fleet-node.plist"
            plist_path.parent.mkdir(parents=True)
            plist_path.write_bytes(plistlib.dumps({
                "Label": "com.bezrabotnyi.agent-herder-fleet-node",
                "ProgramArguments": ["/usr/bin/python3", "-I", "-S", "-B", "/tmp/other.py"],
                "RunAtLoad": True,
                "KeepAlive": False,
            }))
            with (patch.object(rollout.Path, "home", return_value=home),
                  patch.object(rollout.os, "getuid", return_value=os.getuid())):
                with self.assertRaisesRegex(ValueError, "launchagent_program_mismatch"):
                    rollout.darwin_fleet_launchd_proof(fleet, "com.bezrabotnyi.agent-herder-fleet-node")

    def test_darwin_fleet_install_uses_verified_launchd_domain_and_never_systemd(self):
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
            label = "com.bezrabotnyi.agent-herder-fleet-node"
            restart_cmd = f"launchctl kickstart -k user/{os.getuid()}/{label}"
            argv = ["rollout-node.py", "--fleet-dir", str(fleet), "--sha", target,
                    "--port", "19091", "--restart-cmd", restart_cmd,
                    "--previous-sha", previous, "--unit", label, "--kind", "fleet"]
            order = []
            with (patch.object(sys, "argv", argv),
                  patch.object(sys, "platform", "darwin"),
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
                  patch.object(rollout, "darwin_fleet_launchd_proof", return_value={
                      "domain": f"user/{os.getuid()}", "pid": "456"}),
                  patch.object(rollout, "unit_entrypoint", side_effect=AssertionError("systemd must not be used")),
                  patch.object(rollout, "restart", side_effect=lambda command: (
                      order.append(command) or subprocess.CompletedProcess(command, 0, "", ""))),
                  patch.object(rollout, "wait_port", return_value=True),
                  patch.object(rollout, "running_release", return_value=target),
                  patch.object(rollout, "http_status", return_value=200),
                  patch.object(rollout, "mcp_status", return_value=200),
                  patch.object(rollout.time, "sleep")):
                self.assertEqual(rollout.main(), 0)
            self.assertEqual(order, [["launchctl", "kickstart", "-k", f"user/{os.getuid()}/{label}"]])
            self.assertEqual(__import__("json").loads(config.read_text())["sourceSha"], target)
            self.assertEqual((fleet / "current").resolve(), fleet / "releases" / target)

    def test_readiness_authenticates_after_401_and_revokes_ephemeral_owner_token(self):
        calls = []
        class Reply:
            status = 200
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return self.body
        def respond(request, **kwargs):
            import json
            calls.append(request)
            if request.full_url.endswith('/mcp'):
                if request.get_header('Authorization') != 'Bearer isolated-fixture-token':
                    raise urllib.error.HTTPError(request.full_url, 401, 'unauthorized', {}, None)
                return Reply(b'{}')
            payload = json.loads(request.data)
            if payload['action'] == 'issue': return Reply(b'{"token":"isolated-fixture-token","record":{"id":"fixture-token-id"}}')
            self.assertEqual(payload, {'action':'revoke','id':'fixture-token-id'})
            return Reply(b'{"record":{"id":"fixture-token-id","revokedAt":"now"}}')
        with patch.object(rollout, 'process_environment_value', return_value=''), patch.object(rollout.urllib.request, 'urlopen', side_effect=respond):
            self.assertEqual(rollout.mcp_status(18791), 200)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[1].get_header('Origin'), 'http://127.0.0.1:18791')

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

    def test_linux_release_budget_excludes_rollback_hardlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            fleet = pathlib.Path(temporary)
            releases = fleet / "releases"
            first = releases / "first" / "node_modules" / "shared-package"
            second = releases / "second" / "node_modules" / "shared-package"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_bytes(b"x" * 65536)
            second.hardlink_to(first)
            candidate = releases / "second"
            entrypoint = candidate / "dist" / "index.js"
            entrypoint.parent.mkdir(parents=True)
            entrypoint.write_bytes(b"candidate-owned bytes")
            paths = [candidate, *candidate.rglob("*")]
            expected = sum(path.lstat().st_blocks * 512 for path in paths if path != second)
            with patch.object(rollout.sys, "platform", "linux"):
                self.assertEqual(rollout.release_budget(fleet, "second"), (2, expected))
                self.assertTrue(rollout.release_budget_admitted(*rollout.release_budget(fleet, "second")))

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
                    "--previous-sha", previous, "--unit", "agent-herder.service",
                    "--kind", "owner"]
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

    def test_fleet_node_install_writes_no_release_dropin_and_keeps_the_bootstrap(self):
        """A fleet node runs through bootstrap.py: the release is the current symlink.

        A release drop-in would replace the bootstrap with the release itself,
        and the node would take the port of the unit instead of the port of its
        own config. The drop-in must not be written for a fleet node.
        """
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
                    "--port", "19091", "--restart-cmd", "systemctl --user restart agent-herder-fleet.service",
                    "--previous-sha", previous, "--unit", "agent-herder-fleet.service",
                    "--kind", "fleet"]
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
                  patch.object(rollout, "unit_entrypoint", return_value=(
                      "/usr/bin/python3 -I -S -B "
                      "/home/roomhacker/.local/share/agent-herder/fleet/bootstrap.py")),
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

            # The node was switched: the current symlink and the sourceSha.
            self.assertEqual(__import__("json").loads(config.read_text())["sourceSha"], target)
            self.assertEqual((fleet / "current").resolve(), fleet / "releases" / target)
            # The bootstrap of the node was not touched: no release drop-in exists.
            dropin = rollout.systemd_release_dropin_path("agent-herder-fleet.service", root)
            self.assertFalse(dropin.exists())
            unit_dir = root / ".config" / "systemd" / "user" / "agent-herder-fleet.service.d"
            self.assertEqual(sorted(item.name for item in unit_dir.iterdir()), []) if unit_dir.is_dir() else None
            # No daemon-reload: nothing of the unit changed.
            self.assertEqual(order, ["restart"])

    def test_fleet_node_install_refuses_a_unit_that_does_not_use_the_bootstrap(self):
        """A fleet unit that does not run the bootstrap is refused, nothing is switched."""
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
                    "--port", "19091", "--restart-cmd", "systemctl --user restart agent-herder-fleet.service",
                    "--previous-sha", previous, "--unit", "agent-herder-fleet.service",
                    "--kind", "fleet"]
            switched = []

            with (patch.object(sys, "argv", argv),
                  patch.object(rollout.Path, "home", return_value=root),
                  patch.object(rollout, "disarm_state", return_value="armed"),
                  patch.object(rollout, "system_pause_state", return_value="inactive"),
                  patch.object(rollout, "process_environment_value", return_value="/state"),
                  patch.object(rollout, "unit_entrypoint", return_value=(
                      "/usr/local/bin/node /home/roomhacker/releases/x/dist/index.js")),
                  patch.object(rollout, "prepare_packages", return_value="unchanged"),
                  patch.object(rollout, "verify_payload", return_value={
                      "source_sha_ok": True, "missing": [], "extra": [], "mismatched": []}),
                  patch.object(rollout, "release_budget", return_value=(2, 0)),
                  patch.object(rollout, "package_resolution", return_value="resolved"),
                  patch.object(rollout, "wait_codex_socket", return_value=True),
                  patch.object(rollout, "switch_current", side_effect=lambda *a: switched.append(a)),
                  patch.object(rollout, "restart", side_effect=lambda *a: switched.append(a))):
                self.assertEqual(rollout.main(), 1)
            self.assertEqual(switched, [])
            self.assertEqual(__import__("json").loads(config.read_text())["sourceSha"], previous)
            self.assertEqual((fleet / "current").resolve(), fleet / "releases" / previous)


if __name__ == "__main__":
    unittest.main()
