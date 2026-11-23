import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import recovery_owner_update as updater
from recovery_owner_update import candidate_env, transition


@unittest.skipUnless(sys.platform.startswith("linux"), "the local owner is observed through /proc")
class LocalOwnerReceipt(unittest.TestCase):
    def setUp(self):
        area = tempfile.TemporaryDirectory()
        self.addCleanup(area.cleanup)
        self.bundle = Path(area.name) / "bundle"
        fixture = self.bundle / "fixture"
        fixture.mkdir(parents=True)
        core = fixture / "herder_native_stdio"
        shutil.copy2(shutil.which("cat"), core)
        self.owner = subprocess.Popen([core], stdin=subprocess.PIPE)
        self.addCleanup(self.owner.wait, 5)
        self.addCleanup(self.owner.stdin.close)
        self.source = "a" * 40
        self.sha = updater.digest(core)
        self.selection = '{"profiles": []}'
        (self.bundle / "selector.json").write_text(self.selection)
        self.selector = Path(area.name) / "selector.json"
        self.selector.write_text(self.selection)
        self.receipt = Path(area.name) / "receipt.json"
        self.entry = {"selector": self.selector, "receipt": self.receipt, "command": "/fixture/cutover"}
        self.local_owner = runpy.run_path(str(Path(__file__).with_name("rollout-recovery")))["local_owner"]

    def verified(self):
        self.selector.write_text(self.selection)
        self.receipt.write_text(json.dumps({"source": self.source, "core_sha256": self.sha}))

    def test_reentry_reads_the_installed_owner_without_a_second_cutover(self):
        self.selector.write_text('{"profiles":["before"]}')
        with patch("subprocess.run", side_effect=lambda *a, **kw: self.verified()) as cutover:
            first = self.local_owner(self.entry, self.bundle, self.source, self.sha)
            second = self.local_owner(self.entry, self.bundle, self.source, self.sha)
        self.assertEqual(cutover.call_count, 1)
        self.assertEqual(first["core_pid"], self.owner.pid)
        self.assertEqual(second["core_pid"], self.owner.pid)

    def test_partial_switch_or_unrelated_receipt_never_restarts(self):
        with patch("subprocess.run") as cutover:
            with self.assertRaisesRegex(RuntimeError, "receipt"):
                self.local_owner(self.entry, self.bundle, self.source, self.sha)
            self.selector.write_text('{"profiles":["before"]}')
            self.receipt.write_text(json.dumps({"source": "b" * 40, "core_sha256": self.sha}))
            with self.assertRaisesRegex(RuntimeError, "receipt"):
                self.local_owner(self.entry, self.bundle, self.source, self.sha)
        cutover.assert_not_called()


class ExistingOwnerUpdate(unittest.TestCase):
    def test_upgrade_preserves_profile_and_unknown_settings(self):
        source = (
            'AGENT_HERDER_LOCAL_RECOVERY_CORE="/old"\n'
            'EXTRA="keep"\nAGENT_HERDER_LOCAL_RECOVERY_PROFILE="/original"\n'
            'AGENT_HERDER_LOCAL_RECOVERY_CORE_SHA256="old-digest"\n'
        )
        new = candidate_env(source, Path("/new"), "new-digest")
        self.assertEqual(new, source.replace('"/old"', '"/new"').replace('"old-digest"', '"new-digest"'))
        self.assertEqual(candidate_env(new, Path("/new"), "new-digest"), new)

    def test_already_running_and_selected_skips_restart(self):
        self.assertEqual(transition("new", "new", "new", None), "verified")

    def test_lost_ack_after_cutover_is_resolved_by_readback(self):
        self.assertEqual(transition("new", "new", "new", "old"), "verified")
        with self.assertRaises(RuntimeError):
            transition("new", "old", "new", "old")

    def test_reread_receipt_after_an_ordinary_scheduler_restart(self):
        from recovery_owner_update import verify_observation

        previous = {"sha256": "wanted", "profile_sha256": "same-profile", "core_pid": 40, "scheduler_pid": 30}
        latest = dict(
            previous, core_pid=42, scheduler_pid=32, scope="instance", reason="rust_recovery_handoff"
        )
        self.assertEqual(verify_observation(previous, latest), latest)
        with self.assertRaises(RuntimeError):
            verify_observation(previous, dict(latest, profile_sha256="different-profile"))

    def test_missing_controller_ack_accepts_only_the_original_profile_on_the_candidate(self):
        from recovery_owner_update import recovered_cutover

        before = {"core_pid": 11, "sha256": "old", "profile_sha256": "profile", "scope": "instance"}
        after = dict(before, core_pid=15, sha256="new")
        intent = {"baseline": before, "sha256": "new"}
        self.assertEqual(recovered_cutover(intent, after)["status"], "reconciled")
        with self.assertRaises(RuntimeError):
            recovered_cutover(intent, dict(after, profile_sha256="foreign"))
        with self.assertRaises(RuntimeError):
            recovered_cutover(intent, before)

    def test_first_install_requires_selected_running_pair(self):
        self.assertEqual(transition("old", "old", "new", None), "switch")
        with self.assertRaises(RuntimeError):
            transition("unrelated", "old", "new", None)


class Cutover(unittest.TestCase):
    def setUp(self):
        area = tempfile.TemporaryDirectory()
        self.addCleanup(area.cleanup)
        self.home = Path(area.name).resolve()
        self.unit = "owner.service"
        self.dropin = self.home / ".config/systemd/user/owner.service.d/80-host-local-recovery.conf"
        self.dropin.parent.mkdir(parents=True)
        env = self.home / ".config/agent-herder/local/versions" / ("1" * 40) / "owner.env"
        env.parent.mkdir(parents=True)
        env.write_text(
            'AGENT_HERDER_LOCAL_RECOVERY_CORE="/old"\n'
            'AGENT_HERDER_LOCAL_RECOVERY_CORE_SHA256="old"\n'
            'AGENT_HERDER_LOCAL_RECOVERY_PROFILE="/profile"\n'
        )
        self.original = "[Service]\nEnvironmentFile=" + str(env) + "\n"
        self.dropin.write_text(self.original)
        self.packet = self.home / "packet"
        self.packet.mkdir()
        binary = self.packet / "herder_native_stdio"
        binary.write_bytes(b"candidate")
        self.contract = {
            "descriptor": {"unit": self.unit},
            "native_source": "2" * 40,
            "native_sha256": updater.digest(binary),
        }
        for patcher in [
            patch.object(Path, "home", return_value=self.home),
            patch.object(
                updater.runpy, "run_path", return_value={"canonical_mcp_bearer": lambda unit: "fixture"}
            ),
            patch.object(
                updater,
                "prove",
                side_effect=lambda node, binding, bearer: {"core_pid": 13, "sha256": binding["CORE_SHA256"]},
            ),
            patch.object(
                updater,
                "live",
                side_effect=lambda unit: (10, 13, None, self.binding()["CORE_SHA256"], "/profile"),
            ),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.gate = Mock()

    def binding(self):
        return updater.env_values(updater.selected_env(self.dropin).read_text())

    def test_install_and_reenter_send_one_restart(self):
        with patch.object(updater.subprocess, "run") as systemctl:
            first = updater.apply(self.contract, self.gate, self.packet)
            second = updater.apply(self.contract, self.gate, self.packet)
        self.assertEqual([first["status"], second["status"]], ["installed", "already-installed"])
        self.assertEqual(self.binding()["PROFILE"], "/profile")
        self.assertEqual([call.args[0][2] for call in systemctl.call_args_list], ["daemon-reload", "restart"])

    def test_readiness_failure_rolls_back_to_the_same_binding(self):
        with (
            patch.object(updater, "await_owner", side_effect=[RuntimeError("unhealthy"), {}]),
            patch.object(updater.subprocess, "run"),
            self.assertRaises(updater.RolledBack),
        ):
            updater.apply(self.contract, self.gate, self.packet)
        self.assertEqual(self.dropin.read_text(), self.original)
        self.assertEqual(self.binding()["CORE_SHA256"], "old")


if __name__ == "__main__":
    unittest.main()
