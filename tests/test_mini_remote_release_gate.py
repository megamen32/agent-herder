"""Fixed Mini dispatch and Darwin mutation-boundary regressions."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

FLEET = Path(__file__).resolve().parents[1] / "deploy/fleet"
sys.path.insert(0, str(FLEET))
import remote_release_gate as remote
from deployment_config import descriptor_digest, verify_descriptor
from deployment_fixture import DARWIN_NODE, DARWIN_HOME, DARWIN_UNIT, DARWIN_AUTHORITY, LINUX_NODE, TOPOLOGY

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, FLEET / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
candidate = load("mini_candidate", "rollout-candidate.py")
node = load("mini_node", "rollout-node.py")

class MiniMappingTests(unittest.TestCase):
    def test_mini_uses_existing_watchdog_python_not_xcode_default(self):
        command = candidate.remote_python_command(dict(DARWIN_NODE))
        self.assertEqual(command, [DARWIN_NODE["pythonBin"], "-I", "-B"])
        self.assertEqual(command[0], DARWIN_NODE["pythonBin"])
        self.assertEqual(candidate.remote_python_command(LINUX_NODE), [LINUX_NODE["pythonBin"], "-I", "-B"])
        for output, accepted in ((json.dumps({"version":"3.12.8","executable":DARWIN_NODE["pythonExecutable"]}), True), (json.dumps({"version":"3.9.6","executable":DARWIN_NODE["pythonExecutable"]}), False), ("unverified", False)):
            with patch.object(candidate.subprocess, "run", return_value=SimpleNamespace(stdout=output)) as run:
                if accepted:
                    candidate.verify_remote_python(["ssh","fixed"], dict(DARWIN_NODE))
                else:
                    with self.assertRaises(RuntimeError):
                        candidate.verify_remote_python(["ssh","fixed"], dict(DARWIN_NODE))
                self.assertIn(DARWIN_NODE["pythonBin"], run.call_args.args[0][-1])

    def test_owner_entry_still_reaches_existing_gate(self):
        gate = Mock()
        gate.compare_revision.side_effect = RuntimeError("owner-gate-reached")
        args = SimpleNamespace(catalog="/owner", sha="2"*40, previous_sha="1"*40, drop_in="/dropin")
        with self.assertRaisesRegex(RuntimeError, "owner-gate-reached"):
            candidate._leased_node_side_owner(args, gate)
        gate.compare_revision.assert_called_once_with(Path("/owner/node-config.json"), "1"*40)

    def test_exact_descriptor_and_literal_authority(self):
        descriptor = candidate.node_spec(TOPOLOGY, "darwin-a")
        self.assertEqual(remote.deployment_target(descriptor), DARWIN_AUTHORITY)
        descriptor = dict(descriptor)
        descriptor["catalog"] = "/caller-controlled"
        with self.assertRaises(RuntimeError):
            remote.deployment_target(descriptor)

    def test_every_descriptor_field_is_pinned(self):
        for key in DARWIN_NODE:
            with self.subTest(key=key):
                changed = dict(DARWIN_NODE)
                changed[key] = "another-host-or-value"
                with self.assertRaises(RuntimeError):
                    verify_descriptor(changed, descriptor_digest(DARWIN_NODE))

    def test_m1_or_second_host_with_same_label_is_not_mini(self):
        for host in ("different.example.invalid", "second.example.invalid"):
            changed = {**DARWIN_NODE, "hostId": host}
            with self.assertRaises(RuntimeError):
                verify_descriptor(changed, descriptor_digest(DARWIN_NODE))

    def test_identity_uid_home_platform_path_host_unit(self):
        contract = {key: DARWIN_NODE[key] for key in ("hostId", "fleetDir", "unit")}
        contract.update(descriptor=DARWIN_NODE, descriptorDigest=descriptor_digest(DARWIN_NODE))
        with (patch.object(remote.sys, "platform", "darwin"),
              patch.object(remote.os, "getuid", return_value=501),
              patch.object(remote.Path, "home", return_value=Path(DARWIN_HOME)),
              patch.dict(os.environ, {"HOME": DARWIN_HOME})):
            remote.verify_target_identity(contract)
            for key in contract:
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    remote.verify_target_identity({**contract, key: "/wrong"})
            with patch.object(remote.os, "getuid", return_value=502), self.assertRaises(RuntimeError):
                remote.verify_target_identity(contract)
            with patch.dict(os.environ, {"HOME": "/wrong"}), self.assertRaises(RuntimeError):
                remote.verify_target_identity(contract)
            with patch.object(remote.Path, "home", return_value=Path("/wrong")), self.assertRaises(RuntimeError):
                remote.verify_target_identity(contract)
            with patch.object(remote.sys, "platform", "linux"), self.assertRaises(RuntimeError):
                remote.verify_target_identity(contract)

    def test_node_side_rejects_each_mini_argument_before_channel(self):
        args = SimpleNamespace(authority_stdio=True, kind="fleet", release_proof="",
            expected_host=DARWIN_NODE["hostId"], unit=DARWIN_UNIT,
            fleet_dir=DARWIN_NODE["fleetDir"], state_dir=DARWIN_NODE["stateDir"],
            web_port=DARWIN_NODE["webPort"], restart_cmd=DARWIN_NODE["restartCmd"], authority_run="a"*32,
            deployment_descriptor="/tmp/herder-release.abcdefgh/descriptor.json",descriptor_sha=descriptor_digest(DARWIN_NODE))
        for key in ("expected_host", "unit", "fleet_dir", "state_dir", "web_port", "restart_cmd", "authority_run"):
            changed = SimpleNamespace(**vars(args))
            setattr(changed, key, "wrong")
            with self.subTest(key=key), patch.object(candidate, "remote_frames") as frames, patch.object(candidate, "load_remote_descriptor",return_value=DARWIN_NODE):
                with self.assertRaisesRegex(RuntimeError, "command_refused"):
                    candidate.node_side(changed)
                frames.assert_not_called()

class DarwinBoundaryTests(unittest.TestCase):
    def handoff(self, gate):
        handoff = node.DarwinStoppedGeneration.__new__(node.DarwinStoppedGeneration)
        handoff.fleet = Path("/fixture")
        handoff.label = DARWIN_UNIT
        handoff.previous_sha, handoff.candidate_sha = "1"*40, "2"*40
        handoff.release_gate = gate
        handoff.proof = {"domain": "user/501"}
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        handoff.owned_pids = ["1", "2"]
        handoff.generation = "exact-generation"
        handoff.port = 18789
        handoff.restart_command = ["launchctl", "kickstart", "-k", "user/501/"+DARWIN_UNIT]
        handoff.check_configuration = Mock()
        handoff.check_stopped = Mock()
        return handoff

    def test_same_sha_cas_before_handoff_and_no_stop(self):
        args = SimpleNamespace(fleet_dir="/fixture", sha="1"*40, previous_sha="1"*40)
        gate = Mock()
        with patch.object(candidate.sys, "platform", "darwin"), patch.object(candidate.importlib.util, "module_from_spec") as loader:
            self.assertEqual(candidate._leased_node_side_fleet(args, gate), 0)
            gate.compare_revision.assert_called_once_with(Path("/fixture/node-config.json"), "1"*40)
            loader.assert_not_called()
            gate.compare_revision.side_effect = RuntimeError("CAS")
            with self.assertRaisesRegex(RuntimeError, "CAS"):
                candidate._leased_node_side_fleet(args, gate)
            loader.assert_not_called()

    def test_stop_checks_authority_after_generation_read_before_signal(self):
        for reason in ("expired", "EOF", "successor-fence"):
            gate = Mock()
            gate.compare_revision.side_effect = RuntimeError(reason)
            handoff = self.handoff(gate)
            with (patch.object(node, "darwin_fleet_launchd_proof", return_value=handoff.proof),
                  patch.object(node.subprocess, "run", return_value=SimpleNamespace(stdout="exact-generation")) as run):
                with self.assertRaisesRegex(RuntimeError, reason):
                    handoff.stop()
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][0], "ps")
                gate.compare_revision.assert_called_once()

    def test_stop_refuses_replacement_during_successful_authority_rpc(self):
        gate = Mock()
        handoff = self.handoff(gate)
        changed = False
        def authority(*args):
            nonlocal changed
            changed = True
        gate.compare_revision.side_effect = authority
        with (patch.object(node, "darwin_fleet_launchd_proof", side_effect=lambda *a: {"domain":"replacement"} if changed else handoff.proof),
              patch.object(node.subprocess, "run", return_value=SimpleNamespace(stdout="exact-generation")) as run):
            with self.assertRaisesRegex(ValueError, "generation_changed_during"):
                handoff.stop()
            self.assertEqual(run.call_count, 1)

    def test_restore_does_not_restart_replacement_during_successful_cleanup_rpc(self):
        gate = Mock()
        handoff = self.handoff(gate)
        with (patch.object(node, "running_release", side_effect=["", "replacement"]),
              patch.object(node, "restart") as restart):
            handoff.restore_if_still_owned()
            restart.assert_not_called()

    def test_receipt_io_replacement_is_rechecked_before_signal(self):
        handoff = self.handoff(Mock())
        changed = False
        def receipt(event, **kwargs):
            nonlocal changed
            if event == "before_sigterm": changed = True
        handoff.receipt = Mock(side_effect=receipt)
        with (patch.object(node, "darwin_fleet_launchd_proof",
                           side_effect=lambda *a: {"domain":"replacement"} if changed else handoff.proof),
              patch.object(node.subprocess, "run", return_value=SimpleNamespace(stdout="exact-generation")) as run):
            with self.assertRaisesRegex(ValueError, "generation_changed_during"):
                handoff.stop()
            self.assertEqual(run.call_count, 1)

    def test_receipt_io_replacement_is_rechecked_before_restore(self):
        handoff = self.handoff(Mock())
        def receipt(event, **kwargs):
            if event == "restore_start":
                handoff.check_stopped.side_effect = ValueError("replacement-owner")
        handoff.receipt = Mock(side_effect=receipt)
        with patch.object(node, "running_release", return_value=""), patch.object(node, "restart") as restart:
            with self.assertRaisesRegex(ValueError, "replacement-owner"):
                handoff.restore_if_still_owned()
            restart.assert_not_called()

    def test_restore_refuses_eof_successor_or_changed_revision_before_restart(self):
        for reason in ("EOF", "successor-fence", "changed-revision"):
            gate = Mock()
            gate.compare_cleanup_revision.side_effect = RuntimeError(reason)
            handoff = self.handoff(gate)
            with patch.object(node, "running_release", return_value=""), patch.object(node, "restart") as restart:
                with self.assertRaisesRegex(RuntimeError, reason):
                    handoff.restore_if_still_owned()
                restart.assert_not_called()
                handoff.check_stopped.assert_called_once()

    def test_expired_same_fence_cleanup_can_restore_only_previous(self):
        gate = Mock()
        gate.compare_revision.side_effect = RuntimeError("expired")
        handoff = self.handoff(gate)
        with (patch.object(node, "running_release", return_value=""),
              patch.object(node, "restart", return_value=SimpleNamespace(returncode=0)) as restart,
              patch.object(node, "canonical_mcp_bearer", return_value=None),
              patch.object(node, "wait_release_ready", return_value={"reason":"ready"}) as ready):
            handoff.restore_if_still_owned()
            gate.compare_cleanup_revision.assert_called_once_with(
                Path("/fixture/node-config.json"), ["1"*40, "2"*40])
            restart.assert_called_once_with(handoff.restart_command)
            self.assertEqual(ready.call_args.args[1], "1"*40)

    def test_replacement_runtime_never_restarted(self):
        handoff = self.handoff(Mock())
        with patch.object(node, "running_release", return_value="replacement"), patch.object(node, "restart") as restart:
            handoff.restore_if_still_owned()
            restart.assert_not_called()
            handoff.release_gate.compare_cleanup_revision.assert_not_called()


class PreviousReceiptTests(unittest.TestCase):
    def test_old_receipt_is_timestamped_and_excludes_config_argv_and_capability(self):
        handoff = node.DarwinStoppedGeneration.__new__(node.DarwinStoppedGeneration)
        handoff.fleet, handoff.label, handoff.previous_sha = Path("/fixture"), DARWIN_UNIT, "1"*40
        handoff.proof = {"pid":"11","plist":"/fixture.plist","domain":"user/501"}
        handoff.owned_pids = ["11","12"]
        handoff.generation = "11 501 Tue Nov 3 05:00:00 2026 /node --secret=never-log"
        handoff.config_bytes = b"secret-config-never-log"
        handoff.plist_sha = "fixed-plist-digest"
        handoff.release_gate = Mock(contract={"run":"a"*32,"token":"capability-never-log"})
        with patch.object(node, "sha256", return_value="observed-digest"), patch("builtins.print") as emit:
            handoff.receipt("captured")
        value=json.loads(emit.call_args.args[0])
        self.assertEqual(value["run"], "a"*32)
        self.assertEqual(value["expectedWrapperPid"], "11")
        self.assertEqual(value["capturedPids"], ["11","12"])
        self.assertIsInstance(value["timeNs"], int)
        self.assertTrue(value["utc"].endswith("Z"))
        self.assertNotIn("never-log", emit.call_args.args[0])

    def test_restore_receipt_reads_pid_without_affecting_restart_result(self):
        handoff = node.DarwinStoppedGeneration.__new__(node.DarwinStoppedGeneration)
        handoff.proof={"domain":"user/501"}
        handoff.label=DARWIN_UNIT
        handoff.receipt=Mock()
        with patch.object(node.subprocess, "run", return_value=SimpleNamespace(
                returncode=0,stdout="state = running\npid = 4242\n")) as read:
            handoff.restore_receipt(SimpleNamespace(returncode=0))
        self.assertEqual(read.call_args.args[0][:2], ["launchctl","print"])
        self.assertEqual(handoff.receipt.call_args.kwargs["observedWrapperPid"], "4242")

class CandidateRollbackTests(unittest.TestCase):
    def setUp(self):
        self.census = patch.object(node, "candidate_entry_absent")
        self.mock_census = self.census.start()
        self.addCleanup(self.census.stop)

    def previous(self):
        previous = Mock()
        previous.fleet = Path("/fixture")
        previous.label = DARWIN_UNIT
        previous.previous_sha = "1"*40
        previous.release_gate.contract = {"run":"a"*32}
        previous.proof = {"pid": 11, "domain": "user/501", "plist": "/fixture.plist",
                          "program": "/python", "entrypoint": "/watchdog"}
        return previous

    def test_real_switch_current_allows_exact_candidate_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            fleet = Path(tmp)
            old, new = "1"*40, "2"*40
            (fleet / "releases" / new).mkdir(parents=True)
            plist = fleet / "fixture.plist"
            plist.write_bytes(b"owned-plist")
            previous = node.DarwinStoppedGeneration.__new__(node.DarwinStoppedGeneration)
            previous.fleet = fleet
            previous.config_bytes = json.dumps({"sourceSha":old, "hostId":"mini"}).encode()
            previous.proof = {"plist":str(plist)}
            previous.plist_sha = node.sha256(plist)
            (fleet / "node-config.json").write_text(json.dumps({"sourceSha":new, "hostId":"mini"}))
            node.switch_current(fleet, new)
            previous.check_configuration_after_candidate(new)
            (fleet / "node-config.json").write_text(json.dumps({"sourceSha":new, "hostId":"other"}))
            with self.assertRaisesRegex(ValueError, "configuration_changed"):
                previous.check_configuration_after_candidate(new)

    def test_generation_accepts_only_exact_candidate_child(self):
        for command, accepted in (("", True),
                ("/node /fixture/releases/"+"2"*40+"/dist/index.js", True),
                ("/node /fixture/releases/"+"2"*40+"/dist/index.js-foreign", False),
                ("/node /other/index.js", False)):
            owned = node.DarwinCandidateGeneration.__new__(node.DarwinCandidateGeneration)
            owned.previous = self.previous()
            owned.sha, owned.pid, owned.snapshot = "2"*40, "55", "wrapper"
            owned.proof = {**owned.previous.proof, "pid":55}
            owned._wrapper = Mock(return_value="wrapper")
            processes = "56 55 "+command if command else ""
            generation = "55 501 Mon Jan 1 12:00:00 2024 /python"
            if command: generation += "\n56 501 Mon Jan 1 12:00:00 2024 "+command
            with (patch.object(node, "darwin_fleet_launchd_proof", return_value=owned.proof),
                  patch.object(node.os, "getuid", return_value=501),
                  patch.object(node.subprocess, "run", side_effect=[
                      SimpleNamespace(stdout=processes), SimpleNamespace(stdout=generation)])):
                if accepted:
                    pids, _ = owned._generation()
                    self.assertEqual(pids, ["55", "56"] if command else ["55"])
                else:
                    with self.assertRaisesRegex(ValueError, "children_unverified"):
                        owned._generation()

    def test_receipt_mismatch_is_not_adopted(self):
        previous = self.previous()
        owned = node.DarwinCandidateGeneration(previous, "2"*40, "55")
        with patch.object(node.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stderr="", stdout="path = /fixture.plist\nprogram = /python\npid = 99\nstate = running")):
            with self.assertRaisesRegex(ValueError, "receipt_owner_mismatch"):
                owned._startup_state()

    def test_invalid_receipt_is_refused_before_process_read(self):
        for receipt in ("", "55 extra", "0", "-1", "55\n66"):
            with patch.object(node, "darwin_fleet_launchd_proof") as proof:
                with self.assertRaisesRegex(ValueError, "pid_receipt_invalid"):
                    node.DarwinCandidateGeneration(self.previous(), "2"*40, receipt)
                proof.assert_not_called()

    def test_wrapper_already_ended_restores_without_signal(self):
        previous = self.previous()
        with (patch.object(node, "darwin_fleet_launchd_proof", side_effect=ValueError("not running")),
              patch.object(node, "recorded_processes_absent", return_value=True)):
            owned = node.DarwinCandidateGeneration(previous, "2"*40, "55")
            with self.assertRaisesRegex(ValueError, "exited_before_capture"):
                owned.capture()
            with patch.object(node.subprocess, "run") as run:
                owned.stop_for_rollback()
                run.assert_not_called()
            previous.release_gate.compare_cleanup_revision.assert_called_once()
            self.assertEqual(previous.check_stopped_owner.call_count, 2)

    def owned(self):
        owned = node.DarwinCandidateGeneration.__new__(node.DarwinCandidateGeneration)
        owned.previous = self.previous()
        owned.sha, owned.pid, owned.snapshot = "2"*40, "55", "exact-wrapper"
        owned.proof = {**owned.previous.proof, "pid": 55}
        owned._generation = Mock(return_value=(["55", "56"], "exact-generations"))
        return owned

    def test_expired_same_fence_can_stop_exact_wrapper_and_child(self):
        owned = self.owned()
        # Cleanup is allowed by the existing same-fence gate, unlike forward check.
        owned.previous.release_gate.compare_revision.side_effect = RuntimeError("expired")
        responses = [SimpleNamespace(returncode=0, stdout="55"),
                     SimpleNamespace(returncode=0, stdout=""),
                     SimpleNamespace(returncode=1, stdout="", stderr="")]
        with patch.object(node.subprocess, "run", side_effect=responses) as run, patch.object(node.os, "kill", side_effect=ProcessLookupError):
            owned.stop_for_rollback()
            self.assertEqual(run.call_args_list[1].args[0],
                ["launchctl", "kill", "SIGTERM", "user/501/"+DARWIN_UNIT])
            self.assertEqual(owned._generation.call_count, 2)

    def test_asynchronous_owned_candidate_exit_waits_without_resignaling(self):
        owned = self.owned()
        responses = [SimpleNamespace(returncode=0, stdout="55"),
                     SimpleNamespace(returncode=0, stdout=""),
                     SimpleNamespace(returncode=0, stdout="55\n56"),
                     SimpleNamespace(returncode=1, stdout="", stderr="")]
        with (patch.object(node.subprocess, "run", side_effect=responses) as run,
              patch.object(node.os, "kill", side_effect=ProcessLookupError),
              patch.object(node.time, "sleep") as sleep):
            owned.stop_for_rollback()
            self.assertEqual(sum(c.args[0][0] == "launchctl" for c in run.call_args_list), 1)
            sleep.assert_called_once()
            owned.previous.check_stopped_owner.assert_called_once()

    def test_cleanup_eof_or_successor_fence_never_signals(self):
        for reason in ("EOF", "successor-fence"):
            owned = self.owned()
            owned.previous.release_gate.compare_cleanup_revision.side_effect = RuntimeError(reason)
            with patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="55")) as run:
                with self.assertRaisesRegex(RuntimeError, reason):
                    owned.stop_for_rollback()
                self.assertEqual(run.call_count, 1)

    def test_replacement_during_successful_cleanup_rpc_never_signals(self):
        owned = self.owned()
        owned._generation.side_effect = [(["55", "56"], "before"), (["55", "56"], "replacement")]
        with patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="55")) as run:
            with self.assertRaisesRegex(ValueError, "changed_during_cleanup"):
                owned.stop_for_rollback()
            self.assertEqual(run.call_count, 1)

    def test_natural_exit_during_cleanup_restores_without_signaling(self):
        owned = self.owned()
        owned._generation.side_effect = [(["55", "56"], "55 501 Mon Jan 1 12:00:00 2024 /python"),
                                        ValueError("wrapper exited")]
        with (patch.object(node.subprocess, "run", side_effect=[
                  SimpleNamespace(returncode=0, stdout="55"),
                  SimpleNamespace(returncode=1, stdout="", stderr="")]) as run,
              patch.object(node.os, "kill", side_effect=ProcessLookupError)):
            owned.stop_for_rollback()
            self.assertEqual(run.call_count, 2)
            owned.previous.check_stopped_owner.assert_called_once()
            self.assertEqual(owned.previous.release_gate.compare_cleanup_revision.call_count, 2)

    def test_receipt_logs_identity_digest_without_raw_command(self):
        owned = self.owned()
        with patch("builtins.print") as emit:
            owned.receipt("test", "55 501 Mon Jan 1 12:00:00 2024 /python --secret=not-loggable")
        value = json.loads(emit.call_args.args[0])
        self.assertEqual(value["pid"], "55")
        self.assertEqual(value["run"], "a"*32)
        self.assertEqual(len(value["generationSha256"]), 64)
        self.assertNotIn("not-loggable", emit.call_args.args[0])

    def test_owned_wrapper_with_no_native_child_can_be_stopped(self):
        owned = self.owned()
        owned._generation.return_value = (["55"], "exact-wrapper")
        responses = [SimpleNamespace(returncode=0, stdout="55"),
                     SimpleNamespace(returncode=0, stdout=""),
                     SimpleNamespace(returncode=1, stdout="", stderr="")]
        with patch.object(node.subprocess, "run", side_effect=responses) as run, patch.object(node.os, "kill", side_effect=ProcessLookupError):
            owned.stop_for_rollback()
            self.assertEqual(run.call_args_list[2].args[0], ["ps", "-p", "55", "-o", "pid="])

    def test_exited_wrapper_with_foreign_listener_refuses_without_signal(self):
        owned = self.owned()
        owned.previous.check_stopped_owner.side_effect = ValueError("foreign-listener")
        with patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="")) as run, patch.object(node.os, "kill", side_effect=ProcessLookupError):
            with self.assertRaisesRegex(ValueError, "foreign-listener"):
                owned.stop_for_rollback()
            self.assertEqual(run.call_count, 1)

    def test_absence_rejects_ps_errors_and_reused_or_inaccessible_pid(self):
        for result in (SimpleNamespace(returncode=2, stdout="", stderr="error"),
                       SimpleNamespace(returncode=1, stdout="", stderr="error")):
            with patch.object(node.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, "absence_unverifiable"):
                    node.recorded_processes_absent(["55"])
        with patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="")):
            with patch.object(node.os, "kill", return_value=None):
                self.assertFalse(node.recorded_processes_absent(["55"]))
            with patch.object(node.os, "kill", side_effect=PermissionError):
                with self.assertRaisesRegex(ValueError, "absence_unverifiable"):
                    node.recorded_processes_absent(["55"])

    def test_failed_absence_observation_after_stop_refuses_restore(self):
        owned = self.owned()
        responses = [SimpleNamespace(returncode=0, stdout="55"),
                     SimpleNamespace(returncode=0, stdout=""),
                     SimpleNamespace(returncode=2, stdout="", stderr="failed observation")]
        with patch.object(node.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "absence_unverifiable"):
                owned.stop_for_rollback()

    def test_non_listening_orphan_prevents_no_signal_recovery(self):
        owned = self.owned()
        self.mock_census.side_effect = ValueError("candidate_survivor_unowned")
        with (patch.object(node, "recorded_processes_absent", return_value=True),
              patch.object(node.subprocess, "run") as run):
            with self.assertRaisesRegex(ValueError, "survivor_unowned"):
                owned.stop_for_rollback()
            run.assert_not_called()

    def test_real_census_rejects_candidate_orphan_and_observation_error(self):
        self.census.stop()
        entry = "/fixture/releases/"+"2"*40+"/dist/index.js"
        for result, reason in (
                (SimpleNamespace(returncode=0, stdout="56 1 /node "+entry, stderr=""), "survivor_unowned"),
                (SimpleNamespace(returncode=1, stdout="", stderr="failed"), "census_unverifiable")):
            with patch.object(node.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, reason):
                    node.candidate_entry_absent(Path("/fixture"), "2"*40)

    def test_restore_install_checks_after_config_restore_before_restart(self):
        guard = Mock(side_effect=RuntimeError("successor-fence"))
        with (patch.object(node, "atomic_copy"), patch.object(node, "switch_current"),
              patch.object(node, "restart") as restart):
            with self.assertRaisesRegex(RuntimeError, "successor-fence"):
                node.restore_install(Path("/fleet"), Path("/config"), Path("/backup"),
                    "2"*40, "1"*40, None, None, ["launchctl"], before_restart=guard)
            restart.assert_not_called()

class CandidateRestartBoundaryTests(unittest.TestCase):
    def test_exited_receipt_never_accepts_later_same_sha_readiness(self):
        spec = importlib.util.spec_from_file_location("exited_receipt_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume, handoff.check_stopped, handoff.check_stopped_owner = Mock(), Mock(), Mock()
        handoff.proof = {"domain":"user/501"}
        handoff.fleet = Path(fixture.args[fixture.args.index("--fleet-dir")+1])
        handoff.label = DARWIN_UNIT
        fixture.gate.contract = {"run":"a"*32}
        handoff.previous_sha = fixture.old
        handoff.release_gate = fixture.gate
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        fixture.mocks["restart"].return_value = SimpleNamespace(returncode=0, stdout="55")
        with (patch.object(fixture.node.sys,"platform","darwin"),
              patch.object(fixture.node,"canonical_mcp_bearer",return_value=None),
              patch.object(fixture.node,"recorded_processes_absent",return_value=True),
              patch.object(fixture.node,"candidate_entry_absent"),
              patch.object(fixture.node,"wait_release_ready",return_value={"reason":"ready"}) as ready):
            self.assertEqual(fixture.node._main(args,stopped_generation=handoff,release_gate=fixture.gate),1)
            ready.assert_not_called()
            fixture.mocks["restore_install"].assert_called_once()
            self.assertGreaterEqual(fixture.gate.compare_cleanup_revision.call_count,2)

    def test_same_sha_replacement_after_readiness_is_not_accepted(self):
        spec = importlib.util.spec_from_file_location("replacement_readiness_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume, handoff.check_stopped, handoff.check_stopped_owner = Mock(), Mock(), Mock()
        handoff.proof = {"domain":"user/501"}
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        fixture.mocks["restart"].return_value = SimpleNamespace(returncode=0,stdout="55")
        owned = Mock()
        owned.check_accepted_generation.side_effect = ValueError("replacement")
        owned.stop_for_rollback.side_effect = ValueError("replacement")
        with (patch.object(fixture.node.sys,"platform","darwin"),
              patch.object(fixture.node,"canonical_mcp_bearer",return_value=None),
              patch.object(fixture.node,"DarwinCandidateGeneration",return_value=owned),
              patch.object(fixture.node,"wait_release_ready",return_value={
                  "reason":"ready","live_sha":fixture.new,"sessions":200,"policy":200,"mcp":200})):
            self.assertEqual(fixture.node._main(args,stopped_generation=handoff,release_gate=fixture.gate),1)
            owned.check_accepted_generation.assert_called_once()
            fixture.mocks["restore_install"].assert_not_called()

    def test_capture_exception_retains_object_and_transfers_before_own_config(self):
        spec = importlib.util.spec_from_file_location("capture_failure_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume, handoff.check_stopped, handoff.check_stopped_owner = Mock(), Mock(), Mock()
        handoff.proof = {"domain":"user/501"}
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        fixture.mocks["restart"].return_value = SimpleNamespace(returncode=0, stdout="55")
        owned = Mock()
        owned.capture.side_effect = ValueError("primary-startup-timeout")
        owned.stop_for_rollback.side_effect = ValueError("not-owned-yet")
        with (patch.object(fixture.node.sys,"platform","darwin"),
              patch.object(fixture.node,"canonical_mcp_bearer",return_value=None),
              patch.object(fixture.node,"DarwinCandidateGeneration",return_value=owned),
              patch.object(fixture.node,"running_release",return_value=""),
              patch("builtins.print") as output):
            self.assertEqual(fixture.node._main(args,stopped_generation=handoff,release_gate=fixture.gate),1)
            self.assertTrue(handoff.transaction_owned)
            owned.capture.assert_called_once()
            owned.stop_for_rollback.assert_called_once()
            fixture.mocks["restore_install"].assert_not_called()
            handoff.restore_if_still_owned()
            output.assert_any_call("release configuration switch failed:", owned.capture.side_effect)

    def test_failed_readiness_rolls_back_receipt_owned_candidate(self):
        spec = importlib.util.spec_from_file_location("base_rollback_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume, handoff.check_stopped, handoff.check_stopped_owner = Mock(), Mock(), Mock()
        handoff.proof = {"domain": "user/501"}
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        fixture.mocks["restart"].return_value = SimpleNamespace(returncode=0, stdout="55")
        owned = Mock()
        with (patch.object(fixture.node.sys, "platform", "darwin"),
              patch.object(fixture.node, "canonical_mcp_bearer", return_value=None),
              patch.object(fixture.node, "DarwinCandidateGeneration", return_value=owned) as capture,
              patch.object(fixture.node, "wait_release_ready", return_value={
                  "reason":"mcp-failed", "live_sha":fixture.new, "sessions":200, "policy":200, "mcp":500}),
              patch.object(fixture.node, "wait_port"),
              patch.object(fixture.node, "running_release", return_value=fixture.old),
              patch.object(fixture.node, "http_status", return_value=200),
              patch.object(fixture.node, "mcp_status", return_value=200)):
            self.assertEqual(fixture.node._main(args, stopped_generation=handoff, release_gate=fixture.gate), 1)
            capture.assert_called_once_with(handoff, fixture.new, "55")
            owned.capture.assert_called_once()
            self.assertEqual(fixture.mocks["restart"].call_args.args[0],
                ["launchctl", "kickstart", "-p", "-k", "user/501/"+DARWIN_UNIT])
            owned.stop_for_rollback.assert_called_once()
            fixture.mocks["restore_install"].assert_called_once()
            guard = fixture.mocks["restore_install"].call_args.kwargs["before_restart"]
            guard()
            self.assertGreaterEqual(fixture.gate.compare_cleanup_revision.call_count, 3)


    def test_same_sha_config_drift_after_rpc_prevents_candidate_restart(self):
        spec = importlib.util.spec_from_file_location("drift_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume, handoff.check_stopped, handoff.check_stopped_owner = Mock(), Mock(), Mock()
        handoff.proof = {"domain": "user/501"}
        handoff.check_configuration_after_candidate = Mock(side_effect=ValueError("same-SHA-drift"))
        handoff.check_rollback_configuration = Mock(side_effect=ValueError("same-SHA-drift"))
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        with (patch.object(fixture.node.sys, "platform", "darwin"),
              patch.object(fixture.node, "canonical_mcp_bearer", return_value=None)):
            self.assertEqual(fixture.node._main(args, stopped_generation=handoff, release_gate=fixture.gate), 1)
        fixture.mocks["restart"].assert_not_called()
        fixture.mocks["restore_install"].assert_not_called()

    def test_replacement_after_candidate_rpc_prevents_restart_and_rollback(self):
        spec = importlib.util.spec_from_file_location("base_boundary",
            FLEET.parent.parent / "tests/test_remote_release_gate.py")
        base = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(base)
        fixture = base.MutationBoundaryTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        handoff = fixture.node.DarwinStoppedGeneration.__new__(fixture.node.DarwinStoppedGeneration)
        handoff.consume = Mock()
        handoff.check_stopped = Mock()
        handoff.proof = {"domain": "user/501"}
        handoff.check_configuration_after_candidate = Mock()
        handoff.check_rollback_configuration = Mock()
        handoff.check_stopped_owner = Mock()
        def compare(path, expected):
            if expected == fixture.new:
                handoff.check_stopped_owner.side_effect = ValueError("replacement-owner")
        fixture.gate.compare_revision.side_effect = compare
        args = list(fixture.args) + ["--launchd-label", DARWIN_UNIT]
        args[args.index("--restart-cmd")+1] = "launchctl kickstart -k user/501/" + DARWIN_UNIT
        with (patch.object(fixture.node.sys, "platform", "darwin"),
              patch.object(fixture.node, "canonical_mcp_bearer", return_value=None)):
            self.assertEqual(fixture.node._main(args, stopped_generation=handoff, release_gate=fixture.gate), 1)
        fixture.mocks["restart"].assert_not_called()
        fixture.mocks["restore_install"].assert_not_called()
        self.assertEqual(handoff.check_stopped_owner.call_count, 2)



class CandidateStartupTests(unittest.TestCase):
    def setup_owned(self):
        previous = CandidateRollbackTests().previous()
        owned = node.DarwinCandidateGeneration(previous, "2"*40, "55")
        wrapper = "55 501 Mon Jan 1 12:00:01 2024 /python -I -S -B /watchdog"
        owned._wrapper = Mock(return_value=wrapper)
        owned._generation = Mock(return_value=(["55"], wrapper))
        owned._check_listeners = Mock()
        return previous, owned

    def test_alive_nonrunning_then_same_generation_running_is_read_only(self):
        previous, owned = self.setup_owned()
        with (patch.object(node, "recorded_processes_absent", return_value=False),
              patch.object(owned, "_startup_state", side_effect=["starting", "running"]),
              patch.object(node, "darwin_fleet_launchd_proof", return_value={**previous.proof,"pid":"55"}),
              patch.object(node.time, "sleep"), patch.object(node, "restart") as restart,
              patch.object(owned, "stop_for_rollback") as stop):
            owned.capture()
            self.assertEqual(previous.release_gate.compare_revision.call_count, 2)
            owned._generation.assert_called_once()
            stop.assert_not_called()
            restart.assert_not_called()

    def test_foreign_listener_or_failed_observation_is_refused(self):
        previous, owned = self.setup_owned()
        for result in (SimpleNamespace(returncode=0, stdout="99", stderr=""),
                       SimpleNamespace(returncode=1, stdout="", stderr="probe failed")):
            with patch.object(node.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, "listener_unowned"):
                    node.DarwinCandidateGeneration._check_listeners(owned, ["55","56"])

    def test_startup_timeout_and_eof_keep_receipt_and_never_signal(self):
        for failure in ("timeout", "EOF"):
            previous, owned = self.setup_owned()
            if failure == "EOF":
                previous.release_gate.compare_revision.side_effect = RuntimeError("EOF")
            with (patch.object(node, "recorded_processes_absent", return_value=False),
                  patch.object(owned, "_startup_state", return_value="starting"),
                  patch.object(node.subprocess, "run") as run):
                with self.assertRaisesRegex((ValueError, RuntimeError),
                        "startup_timeout" if failure == "timeout" else "EOF"):
                    owned.capture(timeout=0)
                self.assertEqual(owned.pid, "55")
                run.assert_not_called()

    def test_generation_change_during_startup_is_not_adopted(self):
        for change in ("uid", "start", "argv"):
            previous, owned = self.setup_owned()
            original = owned._wrapper.return_value
            changed = original.replace("501", "502") if change == "uid" else (
                original.replace("12:00:01", "12:00:02") if change == "start" else original+" --foreign")
            owned._wrapper.side_effect = [original, changed]
            with (patch.object(node, "recorded_processes_absent", return_value=False),
                  patch.object(owned, "_startup_state", return_value="starting"),
                  patch.object(node.time, "sleep"), patch.object(node.subprocess, "run") as run):
                with self.assertRaisesRegex(ValueError, "generation_changed|command_mismatch"):
                    owned.capture()
                run.assert_not_called()

    def test_loaded_identity_or_config_drift_refuses_without_signal(self):
        for field in ("pid", "path", "program", "state", "config"):
            previous, owned = self.setup_owned()
            fields = {"pid":"55", "path":"/fixture.plist", "program":"/python", "state":"starting"}
            if field == "config":
                previous.check_configuration_after_candidate.side_effect = ValueError("configuration_changed")
            else:
                fields[field] = "" if field == "state" else "foreign"
            output = "\n".join(k+" = "+v for k,v in fields.items())
            with (patch.object(node, "recorded_processes_absent", return_value=False),
                  patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=0,stdout=output,stderr="")) as run):
                with self.assertRaisesRegex(ValueError, "mismatch|unverifiable|configuration_changed"):
                    owned.capture()
                self.assertTrue(all(call.args[0][:2] == ["launchctl","print"] for call in run.call_args_list))

    def test_probe_error_is_not_treated_as_exit(self):
        previous, owned = self.setup_owned()
        with (patch.object(node, "recorded_processes_absent", return_value=False),
              patch.object(node.subprocess, "run", return_value=SimpleNamespace(returncode=1,stdout="",stderr="probe failed")),
              patch.object(previous, "check_stopped_owner") as stopped):
            with self.assertRaisesRegex(ValueError, "startup_unverifiable"):
                owned.capture()
            stopped.assert_not_called()

    def test_verified_exit_requires_no_native_survivor(self):
        previous, owned = self.setup_owned()
        with (patch.object(node, "recorded_processes_absent", return_value=True),
              patch.object(node, "candidate_entry_absent", side_effect=ValueError("survivor"))):
            with self.assertRaisesRegex(ValueError, "survivor"):
                owned.capture()
        previous.check_stopped_owner.assert_not_called()

    def test_transaction_transfer_skips_old_finally_even_without_child_sha(self):
        handoff = DarwinBoundaryTests().handoff(Mock())
        handoff.transfer_to_transaction()
        with patch.object(node, "running_release") as live, patch.object(node, "restart") as restart:
            handoff.restore_if_still_owned()
            live.assert_not_called()
            restart.assert_not_called()
            handoff.check_stopped.assert_not_called()

    def test_outer_preparation_failure_restores_old_once_and_preserves_error(self):
        for transferred in (False, True):
            handoff = DarwinBoundaryTests().handoff(Mock())
            handoff.stop = Mock()
            handoff.restore_if_still_owned = Mock(wraps=handoff.restore_if_still_owned)
            args = SimpleNamespace(fleet_dir="/fixture", sha="2"*40, previous_sha="1"*40,
                web_port=18789, unit=DARWIN_UNIT, restart_cmd="launchctl kickstart -k user/501/"+DARWIN_UNIT)
            rollout = Mock()
            rollout.DarwinStoppedGeneration.return_value = handoff
            def failure(*args):
                if transferred: handoff.transfer_to_transaction()
                raise ValueError("primary-capture-error" if transferred else "preparation-error")
            with (patch.object(candidate.sys,"platform","darwin"),
                  patch.object(candidate.importlib.util,"module_from_spec",return_value=rollout),
                  patch.object(candidate.importlib.util,"spec_from_file_location"),
                  patch.object(candidate,"_node_side_fleet",side_effect=failure),
                  patch.object(node,"running_release",return_value=""),
                  patch.object(node,"restart",return_value=SimpleNamespace(returncode=0)) as restart,
                  patch.object(handoff,"restore_receipt"),
                  patch.object(node,"canonical_mcp_bearer",return_value=None),
                  patch.object(node,"wait_release_ready",return_value={"reason":"ready"})):
                with self.assertRaisesRegex(ValueError,"primary-capture-error" if transferred else "preparation-error"):
                    candidate._leased_node_side_fleet(args, Mock())
                self.assertEqual(restart.call_count, 0 if transferred else 1)
                handoff.restore_if_still_owned.assert_called_once()

if __name__ == "__main__":
    unittest.main()
