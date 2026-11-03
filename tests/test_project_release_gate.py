import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release_gate", Path(__file__).resolve().parents[1] / "deploy/fleet/release_gate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ReleaseGate = module.ReleaseGate

class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.proof = dict(project="repo", fence=1, owner=dict(hostId="h", harness="test", nativeSessionId="a"), token="secret")
        self.proof_path = self.root / "proof.json"
        self.state = self.root / "state.json"
        self.proof_path.write_text(json.dumps(self.proof))
        self.lease = dict(self.proof, expiresAt=10000, tokenHash=hashlib.sha256(b"secret").hexdigest())
        self.lease.pop("token")
        self.write()
    def write(self):
        self.state.write_text(json.dumps(dict(version=1, projects={"repo":dict(fence=self.lease["fence"], lease=self.lease)})))
    def gate(self):
        return ReleaseGate(self.proof_path, self.state, now=lambda:1000)
    def test_parallel_rollout_excluded_and_status_readable(self):
        with self.gate():
            with self.assertRaises(BlockingIOError):
                with self.gate(): pass
            self.assertEqual(self.gate().check()["fence"], 1)
        with self.gate(): pass
    def test_successor_fence_refuses_stale_deploy_and_rollback(self):
        self.lease["fence"] = 2
        self.write()
        with self.assertRaises(RuntimeError): self.gate().check()
    def test_expired_or_foreign_proof_refused(self):
        self.lease["expiresAt"] = 999
        self.write()
        with self.assertRaises(RuntimeError): self.gate().check()
        self.lease["expiresAt"] = 10000
        self.lease["owner"] = {"hostId":"h","harness":"test","nativeSessionId":"other"}
        self.write()
        with self.assertRaises(RuntimeError): self.gate().check()
    def test_revision_compare_and_swap_before_mutation(self):
        config=self.root/"node.json"
        config.write_text(json.dumps({"sourceSha":"new"}))
        with self.assertRaisesRegex(RuntimeError,"revision_changed"):
            self.gate().compare_revision(config,"old")
        self.gate().compare_revision(config,"new")
    def test_missing_proof_or_ledger_fails_closed(self):
        self.state.unlink()
        with self.assertRaises(FileNotFoundError): self.gate().check()
    def test_no_capability_in_refusal(self):
        self.lease["tokenHash"]="wrong"
        self.write()
        with self.assertRaises(RuntimeError) as error: self.gate().check()
        self.assertNotIn("secret",str(error.exception))
    def test_git_ancestry_blocks_stale_candidate(self):
        import subprocess
        repo=self.root/"repo"
        subprocess.run(["git","init","-q",str(repo)],check=True)
        def git(*args):
            return subprocess.check_output(["git","-C",str(repo),*args],text=True).strip()
        git("config","user.name","Test");git("config","user.email","test@example.invalid")
        git("commit","--allow-empty","-qm","one");old=git("rev-parse","HEAD")
        git("commit","--allow-empty","-qm","two");new=git("rev-parse","HEAD")
        key=str(repo/".git")
        self.proof["project"]=key;self.proof_path.write_text(json.dumps(self.proof))
        self.state.write_text(json.dumps(dict(version=1,projects={key:dict(fence=1,lease=self.lease)})))
        self.gate().candidate_descends_from(old,new)
        with self.assertRaisesRegex(RuntimeError,"discard_live"):
            self.gate().candidate_descends_from(new,old)


    def test_cleanup_allows_expiry_but_not_replacement(self):
        self.lease["expiresAt"] = 999
        self.write()
        config = self.root / "config.json"
        config.write_text(json.dumps({"sourceSha":"old"}))
        self.gate().compare_cleanup_revision(config,("old","candidate"))
        self.lease["fence"] = 2
        self.write()
        with self.assertRaises(RuntimeError):
            self.gate().compare_cleanup_revision(config,("old","candidate"))

    def test_wrong_target_rejected(self):
        self.lease["deploymentTarget"] = dict(fleetDir="/one", unit="one.service")
        self.write()
        with self.assertRaisesRegex(RuntimeError,"target_mismatch"):
            with ReleaseGate(self.proof_path,self.state,now=lambda:1000,target=dict(fleetDir="/other",unit="one.service")):
                pass

    def test_different_project_cannot_rollout_same_unit_in_parallel(self):
        target=dict(fleetDir="/one",unit="one.service")
        self.lease["deploymentTarget"]=target
        self.write()
        other=dict(self.proof,project="other")
        other_path=self.root/"other-proof.json"
        other_path.write_text(json.dumps(other))
        state=json.loads(self.state.read_text())
        state["projects"]["other"]=dict(fence=1,lease=dict(self.lease))
        self.state.write_text(json.dumps(state))
        with ReleaseGate(self.proof_path,self.state,now=lambda:1000,target=target):
            with self.assertRaises(BlockingIOError):
                with ReleaseGate(other_path,self.state,now=lambda:1000,target=target):
                    pass

    def test_rollout_candidate_forwards_proof_and_packages_gate(self):
        source=(Path(__file__).resolve().parents[1]/"deploy/fleet/rollout-candidate.py").read_text()
        self.assertIn('"--release-proof", arguments.release_proof',source)
        self.assertIn('"release_rules.py", "release_gate.py", "remote_release_gate.py"',source)
        self.assertIn('with ReleaseGate(arguments.release_proof, target=target) as gate:',source)
        self.assertIn('return finish_staged_rollout(command, gate, contract, ssh, stage)',source)
        remote=source[source.index('side = remote_python_command(node)'):source.index('command = ssh +')]
        self.assertNotIn('--release-proof',remote)
        self.assertIn('--authority-stdio',remote)
        self.assertNotIn('"/tmp/release_gate.py"',source)
        self.assertIn('rollout._main(command[2:], stopped_generation=handoff, release_gate=release_gate)',source)

if __name__ == "__main__": unittest.main()
