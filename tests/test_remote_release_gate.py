import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

FLEET = Path(__file__).resolve().parents[1] / "deploy/fleet"
sys.path.insert(0, str(FLEET))
from remote_release_gate import Authority, Frames, ProtocolError, RemoteReleaseGate, run_authorized_ssh
from deployment_config import validate_node, descriptor_digest
from deployment_fixture import LINUX_NODE

spec = importlib.util.spec_from_file_location("rollout_candidate", FLEET / "rollout-candidate.py")
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class FakeGate:
    def __init__(self):
        self.expired = False
        self.foreign = False
        self.calls = []
    def check(self, cleanup=False):
        self.calls.append(("check", cleanup))
        if self.foreign or self.expired and not cleanup:
            raise RuntimeError("release_lease_not_owned_or_expired")
        return {"tokenHash": "never-transmit", "owner": "private"}
    def candidate_descends_from(self, previous, candidate):
        self.check()
        self.calls.append(("ancestry", previous, candidate))


def contract(root):
    descriptor = validate_node({**LINUX_NODE,"hostId":socket.gethostname(),
        "fleetDir":str(root),"home":str(root.parent),"uid":os.getuid(),
        "unit":"test-herder.service",
        "restartCmd":"systemctl --user restart test-herder.service",
        "authorityTarget":{"fleetDir":str(root),"unit":"test-herder.service"}})
    return {"run":"a"*32,"hostId":descriptor["hostId"],"fleetDir":str(root),
        "unit":descriptor["unit"],"previousSha":"1"*40,"candidateSha":"2"*40,
        "descriptor":descriptor,"descriptorDigest":descriptor_digest(descriptor)}


def request(c, sequence, method, arguments=None):
    return {"run": c["run"], "sequence": sequence,
            "method": method, "arguments": arguments or {}}


def hello(c):
    return {k: c[k] for k in ("hostId", "fleetDir", "unit", "previousSha", "candidateSha", "descriptorDigest")}


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.c = contract(Path("/tmp/test-fleet"))
        self.g = FakeGate()
        self.a = Authority(self.g, self.c)
    def start(self):
        return self.a.handle(request(self.c, 1, "hello", hello(self.c)))
    def test_no_lease_data_crosses_channel(self):
        answer = self.start()
        self.assertEqual(answer, {"run": self.c["run"], "sequence": 1, "ok": True})
        self.assertNotIn("never-transmit", json.dumps(answer))
    def test_target_mismatch_before_any_gate_or_mutation(self):
        args = hello(self.c)
        args["hostId"] = "another-host"
        with self.assertRaises(ProtocolError):
            self.a.handle(request(self.c, 1, "hello", args))
        self.assertEqual(self.g.calls, [])
    def test_sequence_replay_and_run_substitution_are_fatal(self):
        self.start()
        for r in (request(self.c, 1, "check"), request(self.c, 3, "check"), request(self.c, True, "check"), request({**self.c, "run": "b"*32}, 2, "check")):
            with self.assertRaises(ProtocolError):
                self.a.handle(r)
    def test_no_generic_execution_or_extra_arguments(self):
        self.start()
        for method, args in (("exec", {"cmd": "true"}), ("check", {"cleanup": True}),
                             ("ancestry", {"previousSha": "3"*40, "candidateSha": "2"*40})):
            with self.assertRaises(ProtocolError):
                self.a.handle(request(self.c, 2, method, args))
    def test_expiry_allows_only_owned_cleanup(self):
        self.start()
        self.g.expired = True
        with self.assertRaises(RuntimeError):
            self.a.handle(request(self.c, 2, "check"))
        self.a.handle(request(self.c, 3, "cleanup"))
        self.g.foreign = True
        with self.assertRaises(RuntimeError):
            self.a.handle(request(self.c, 4, "cleanup"))
    def test_finish_closes_protocol(self):
        self.start()
        self.a.handle(request(self.c, 2, "finish", {"returncode": 0}))
        with self.assertRaises(ProtocolError):
            self.a.handle(request(self.c, 3, "check"))


class LoopFrames:
    def __init__(self, authority):
        self.authority = authority
        self.answer = None
    def write(self, request):
        self.answer = self.authority.handle(request)
    def read(self):
        return self.answer


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "fleet"
        self.root.mkdir()
        self.c = contract(self.root)
        self.config = self.root / "node-config.json"
        self.config.write_text(json.dumps({"hostId": self.c["hostId"], "sourceSha": self.c["previousSha"]}))
        self.g = FakeGate()
        self.a = Authority(self.g, self.c)
        self.remote = RemoteReleaseGate(self.c, LoopFrames(self.a))
        self.home = patch.dict(os.environ, {"HOME": self.tmp.name})
        self.home.start()
        self.addCleanup(self.home.stop)
    def test_without_target_ledger_or_git(self):
        with self.remote as r:
            r.compare_revision(self.config, self.c["previousSha"])
            r.candidate_descends_from(self.c["previousSha"], self.c["candidateSha"])
        self.assertFalse((Path(self.tmp.name)/".local/state/agent-herder/project-release-leases.json").exists())
        self.assertFalse((self.root/".git").exists())
    def test_local_identity_mismatch_never_contacts_authority(self):
        self.config.write_text(json.dumps({"hostId": "wrong", "sourceSha": "1"*40}))
        with self.assertRaisesRegex(RuntimeError, "identity_mismatch"):
            with self.remote: pass
        self.assertEqual(self.g.calls, [])
    def test_target_unit_lock_excludes_second_controller(self):
        with self.remote:
            other = RemoteReleaseGate(self.c, LoopFrames(Authority(FakeGate(), self.c)))
            with self.assertRaises(BlockingIOError):
                with other: pass
    def test_revision_and_cleanup_drift_refuse(self):
        with self.remote as r:
            self.config.write_text(json.dumps({"hostId": self.c["hostId"], "sourceSha": "3"*40}))
            with self.assertRaisesRegex(RuntimeError, "revision_changed"):
                r.compare_revision(self.config, "1"*40)
            with self.assertRaisesRegex(RuntimeError, "cleanup_revision_changed"):
                r.compare_cleanup_revision(self.config, ("1"*40, "2"*40))
    def test_wrong_config_and_candidate_refuse(self):
        with self.remote as r:
            with self.assertRaisesRegex(RuntimeError, "config_mismatch"):
                r.compare_revision(self.root/"other.json", "1"*40)
            with self.assertRaisesRegex(RuntimeError, "ancestry_refused"):
                r.candidate_descends_from("1"*40, "4"*40)
    def test_same_sha_preparation_is_noop(self):
        from types import SimpleNamespace
        args = SimpleNamespace(fleet_dir=str(self.root), sha="1"*40, previous_sha="1"*40)
        with self.remote as r, patch.object(rollout, "trim_releases") as trim, patch.object(rollout, "unpack_release") as unpack:
            self.assertEqual(rollout._node_side_fleet(args, release_gate=r), 0)
            trim.assert_not_called()
            unpack.assert_not_called()
    def test_revision_check_precedes_trim_and_unpack(self):
        from types import SimpleNamespace
        args = SimpleNamespace(fleet_dir=str(self.root), sha="2"*40, previous_sha="1"*40)
        self.config.write_text(json.dumps({"hostId": self.c["hostId"], "sourceSha": "3"*40}))
        # Direct test of ordering, with an admitted-shaped proxy, no real commands.
        with patch.object(rollout, "trim_releases") as trim, patch.object(rollout, "unpack_release") as unpack:
            class RefusingGate:
                def compare_revision(self, *args):
                    raise RuntimeError("revision_changed")
            with self.assertRaises(RuntimeError):
                rollout._node_side_fleet(args, release_gate=RefusingGate())
            trim.assert_not_called()
            unpack.assert_not_called()


class FrameTests(unittest.TestCase):
    def pipes(self, timeout=.05):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        return Frames(r, w, timeout), r, w
    def test_roundtrip_and_bound(self):
        f, r, w = self.pipes()
        f.write({"hello": "world"})
        self.assertEqual(f.read(), {"hello": "world"})
        with self.assertRaisesRegex(RuntimeError, "too_large"):
            f.write({"large": "x"*9000})
    def test_read_timeout(self):
        f, _, _ = self.pipes()
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            f.read()
    def test_eof(self):
        r, w = os.pipe()
        os.close(w)
        # unused write descriptor remains open independently
        r2, w2 = os.pipe()
        try:
            f = Frames(r, w2, .05)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                f.read()
        finally:
            os.close(r)
            os.close(w2)
            os.close(r2)
    def test_write_timeout_on_unread_pipe(self):
        f, r, w = self.pipes()
        try:
            while True: os.write(w, b"x"*4096)
        except BlockingIOError:
            pass
        before = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            f.write({"check": True})
        self.assertLess(time.monotonic()-before, .5)
    def test_malformed_frame(self):
        f, r, w = self.pipes()
        os.write(w, b"not-json\n")
        with self.assertRaisesRegex(RuntimeError, "invalid_frame"):
            f.read()


class ProcessTests(unittest.TestCase):
    def test_real_duplex_process_without_remote_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/"fleet"; root.mkdir()
            c = contract(root)
            (root/"node-config.json").write_text(json.dumps({"hostId": c["hostId"], "sourceSha": c["previousSha"]}))
            source = """import json,sys,os
sys.path.insert(0,sys.argv[1])
from remote_release_gate import *
c=json.loads(sys.argv[2])
with RemoteReleaseGate(c,remote_frames()) as g:
    assert os.read(0,1)==b''
    print('ordinary log')
    subprocess.run([sys.executable,'-c',"print('child log')"],check=True)
    g.compare_revision(Path(c['fleetDir'])/'node-config.json',c['previousSha'])
    g.finish(0)
"""
            with patch.dict(os.environ, {"HOME": tmp}):
                self.assertEqual(run_authorized_ssh([sys.executable,"-c",source,str(FLEET),json.dumps(c)],FakeGate(),c),0)
    def test_lost_child_is_unknown_no_retry(self):
        c=contract(Path("/tmp/unused"))
        with self.assertRaisesRegex(RuntimeError,"outcome_unconfirmed"):
            run_authorized_ssh([sys.executable,"-c","pass"],FakeGate(),c)
    def test_remote_entry_rejects_other_command_before_gate(self):
        from types import SimpleNamespace
        args=SimpleNamespace(authority_stdio=True,kind="fleet",release_proof="",
            unit="agent-herder-fleet.service",restart_cmd="systemctl stop unrelated",
            expected_host="linux-a.example.invalid",authority_run="a"*32)
        with patch.object(rollout,"RemoteReleaseGate") as gate:
            with self.assertRaisesRegex(RuntimeError,"command_refused"):
                rollout.node_side(args)
            gate.assert_not_called()
    def test_lost_channel_after_fixture_switch_is_unknown_without_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"fleet"; root.mkdir(); c=contract(root)
            config=root/"node-config.json"
            config.write_text(json.dumps({"hostId":c["hostId"],"sourceSha":c["previousSha"]}))
            source="""import sys,json,os
sys.path.insert(0,sys.argv[1])
from remote_release_gate import *
c=json.loads(sys.argv[2])
with RemoteReleaseGate(c,remote_frames()) as g:
    p=Path(c['fleetDir'])/'node-config.json'
    g.compare_revision(p,c['previousSha'])
    p.write_text(json.dumps({'hostId':c['hostId'],'sourceSha':c['candidateSha']}))
    os._exit(7)
"""
            with patch.dict(os.environ,{"HOME":tmp}):
                with self.assertRaisesRegex(RuntimeError,"outcome_unconfirmed"):
                    run_authorized_ssh([sys.executable,"-c",source,str(FLEET),json.dumps(c)],FakeGate(),c)
            self.assertEqual(json.loads(config.read_text())["sourceSha"],c["candidateSha"])

    def test_local_owner_path_still_requires_proof(self):
        import subprocess
        run=subprocess.run([sys.executable,str(FLEET/"rollout-candidate.py"),"--sha","2"*40,"--node","100"],
                           capture_output=True,text=True)
        self.assertNotEqual(run.returncode,0)
        self.assertIn("--release-proof is required",run.stderr)
    def test_authority_flag_cannot_be_top_level_bypass(self):
        import subprocess
        run=subprocess.run([sys.executable,str(FLEET/"rollout-candidate.py"),"--sha","2"*40,"--node","44","--authority-stdio"],
                           capture_output=True,text=True)
        self.assertNotEqual(run.returncode,0)
        self.assertIn("requires --node-side",run.stderr)


class StagingTests(unittest.TestCase):
    def test_confirmed_success_and_rollback_cleanup_only_private_stage(self):
        from unittest.mock import Mock
        for result in (0, 1):
            with patch.object(rollout,"run_authorized_ssh",return_value=result), patch.object(rollout.subprocess,"run",return_value=Mock(returncode=0)) as run:
                self.assertEqual(rollout.finish_staged_rollout([],None,{},["ssh","host"],"/tmp/herder-release.ABC12345"),result)
                self.assertEqual(run.call_count,1)
                self.assertIn("/tmp/herder-release.ABC12345",run.call_args.args[0][-1])
                self.assertNotIn("rm -rf",run.call_args.args[0][-1])
    def test_unknown_retains_staging_and_sends_no_cleanup(self):
        with patch.object(rollout,"run_authorized_ssh",side_effect=RuntimeError("unknown")), patch.object(rollout.subprocess,"run") as run:
            with self.assertRaises(RuntimeError):
                rollout.finish_staged_rollout([],None,{},["ssh","host"],"/tmp/herder-release.ABC12345")
            run.assert_not_called()


class MutationBoundaryTests(unittest.TestCase):
    def setUp(self):
        from contextlib import ExitStack
        self.stack=ExitStack(); self.addCleanup(self.stack.close)
        self.tmp=self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root=Path(self.tmp)/"fleet"; self.root.mkdir()
        self.old="1"*40; self.new="2"*40
        (self.root/"node-config.json").write_text(json.dumps({"hostId":socket.gethostname(),"sourceSha":self.old,"nodeBin":sys.executable}))
        spec=importlib.util.spec_from_file_location("remote_boundary_rollout_node",FLEET/"rollout-node.py")
        self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.args=["--fleet-dir",str(self.root),"--sha",self.new,"--previous-sha",self.old,
                   "--port","18791","--restart-cmd","false","--kind","fleet","--state-dir",self.tmp]
        from unittest.mock import Mock
        self.gate=Mock()
        values={"system_pause_state":"unchanged","disarm_state":{},
                "prepare_packages":"prepared","verify_payload":{"missing":[],"extra":[],"mismatched":[],"source_sha_ok":True},
                "release_budget":(2,100),"package_resolution":"fixture","wait_codex_socket":True,
                "unit_entrypoint":"python3 bootstrap.py","restore_install":None,
                "switch_current":None,"restart":Mock(returncode=0)}
        self.mocks={}
        for name,value in values.items():
            self.mocks[name]=self.stack.enter_context(patch.object(self.node,name,return_value=value))
    def test_expiry_or_eof_before_packages_never_prepares(self):
        for error in ("release_lease_not_owned_or_expired","release_authority_channel_closed"):
            self.gate.compare_revision.side_effect=RuntimeError(error)
            self.assertEqual(self.node._main(self.args,release_gate=self.gate),1)
        self.mocks["prepare_packages"].assert_not_called()
        self.mocks["restart"].assert_not_called()
    def test_expiry_before_restart_enters_fenced_rollback(self):
        def compare(path,expected):
            if expected==self.new: raise RuntimeError("release_lease_not_owned_or_expired")
        self.gate.compare_revision.side_effect=compare
        self.assertEqual(self.node._main(self.args,release_gate=self.gate),1)
        self.mocks["restart"].assert_not_called()
        self.gate.compare_cleanup_revision.assert_called_once()
        self.mocks["restore_install"].assert_called_once()
    def test_lost_channel_or_successor_fence_never_speculates_rollback(self):
        def compare(path,expected):
            if expected==self.new: raise RuntimeError("release_authority_channel_closed")
        self.gate.compare_revision.side_effect=compare
        self.gate.compare_cleanup_revision.side_effect=RuntimeError("release_lease_not_owned_or_expired")
        self.assertEqual(self.node._main(self.args,release_gate=self.gate),1)
        self.mocks["restart"].assert_not_called()
        self.mocks["restore_install"].assert_not_called()

if __name__ == "__main__":
    unittest.main()
