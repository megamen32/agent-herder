"""Rollouts accept only origin/main descendants of the live revision."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("main_guard", ROOT / "deploy/fleet/main_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class MainGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.origin = root / "origin.git"
        self.work = root / "work"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.work)], check=True, capture_output=True)
        self.git("config", "user.name", "T")
        self.git("config", "user.email", "t@example.invalid")
        self.git("checkout", "-q", "-b", "main")
        self.a = self.commit("a")
        self.b = self.commit("b")
        self.git("push", "-q", "origin", "main")
        self.base = ["git", "-C", str(self.work)]
        self.env = {k: os.environ.get(k) for k in (guard.EMERGENCY_ENV, "AGENT_HERDER_ROLLOUT_JOURNAL")}
        os.environ.pop(guard.EMERGENCY_ENV, None)
        os.environ["AGENT_HERDER_ROLLOUT_JOURNAL"] = str(root / "journal.jsonl")
        self.addCleanup(self.restore)

    def restore(self):
        for key, value in self.env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.work), *args], text=True).strip()

    def commit(self, message):
        self.git("commit", "--allow-empty", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def side_branch(self, name, parent, message):
        self.git("checkout", "-q", "-b", name, parent)
        sha = self.commit(message)
        self.git("push", "-q", "origin", name)
        self.git("checkout", "-q", "main")
        return sha

    def test_unmerged_branch_refused_with_commit_list(self):
        feature = self.side_branch("feat/x", self.b, "unmerged work")
        with self.assertRaises(guard.MainGuardError) as caught:
            guard.check_deployable(self.base, self.b, feature)
        text = str(caught.exception)
        self.assertIn("release_candidate_not_in_main", text)
        self.assertIn("сделай PR", text)
        self.assertIn("open a PR", text)
        self.assertIn("unmerged work", text)

    def test_live_not_ancestor_refused_with_commit_list(self):
        live = self.side_branch("hotfix", self.a, "live only fix")
        with self.assertRaises(guard.MainGuardError) as caught:
            guard.check_deployable(self.base, live, self.b)
        text = str(caught.exception)
        self.assertIn("release_candidate_would_discard_live_commits", text)
        self.assertIn("в live есть коммиты", text)
        self.assertIn("live only fix", text)

    def test_main_descendant_of_live_passes(self):
        guard.check_deployable(self.base, self.a, self.b)
        guard.check_deployable(self.base, "", self.b)

    def test_stale_local_main_is_refreshed_by_fetch(self):
        other = Path(self.tmp.name) / "other"
        subprocess.run(["git", "clone", "-q", str(self.origin), str(other)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(other), "-c", "user.name=T", "-c", "user.email=t@example.invalid",
                        "commit", "--allow-empty", "-qm", "c"], check=True)
        new = subprocess.check_output(["git", "-C", str(other), "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(["git", "-C", str(other), "push", "-q", "origin", "main"], check=True, capture_output=True)
        guard.check_deployable(self.base, self.b, new)

    def test_fetch_failure_refuses(self):
        bad = ["git", "-C", str(self.work)]
        self.git("remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        with self.assertRaises(guard.MainGuardError):
            guard.check_deployable(bad, self.a, self.b)

    def test_emergency_override_is_journaled_not_a_flag(self):
        feature = self.side_branch("feat/y", self.b, "emergency work")
        os.environ[guard.EMERGENCY_ENV] = "prod down, hotfix"
        guard.check_deployable(self.base, self.b, feature)
        line = json.loads(Path(os.environ["AGENT_HERDER_ROLLOUT_JOURNAL"]).read_text().splitlines()[-1])
        self.assertEqual(line["candidate"], feature)
        self.assertEqual(line["reason"], "prod down, hotfix")
        os.environ[guard.EMERGENCY_ENV] = "  "
        with self.assertRaises(guard.MainGuardError):
            guard.check_deployable(self.base, self.b, feature)

    def test_config_symlink_process_mismatch_is_an_error_with_hint(self):
        guard.reconcile_live("a" * 40, "a" * 40, "a" * 40)
        with self.assertRaises(guard.MainGuardError) as caught:
            guard.reconcile_live("a" * 40, "b" * 40, None)
        self.assertIn("node-config.json", str(caught.exception))
        self.assertIn("restart the unit", str(caught.exception))
        with self.assertRaises(guard.MainGuardError):
            guard.reconcile_live("a" * 40, "a" * 40, "c" * 40)
        self.assertEqual(guard.sha_of_release_path("node /x/releases/" + "d" * 40 + "/dist/index.js"), "d" * 40)

    def test_release_gate_enforces_the_same_rules(self):
        gate_spec = importlib.util.spec_from_file_location("release_gate", ROOT / "deploy/fleet/release_gate.py")
        gate_mod = importlib.util.module_from_spec(gate_spec)
        gate_spec.loader.exec_module(gate_mod)
        import hashlib
        key = str(self.work / ".git")
        proof = dict(project=key, fence=1, owner=dict(hostId="h"), token="secret")
        state = Path(self.tmp.name) / "state.json"
        lease = dict(fence=1, owner=proof["owner"], expiresAt=10**15, tokenHash=hashlib.sha256(b"secret").hexdigest())
        state.write_text(json.dumps(dict(version=1, projects={key: dict(fence=1, lease=lease)})))
        (Path(self.tmp.name) / "proof.json").write_text(json.dumps(proof))
        gate = gate_mod.ReleaseGate(Path(self.tmp.name) / "proof.json", state, now=lambda: 1000)
        gate.candidate_descends_from(self.a, self.b)
        feature = self.side_branch("feat/z", self.b, "gate unmerged")
        with self.assertRaisesRegex(RuntimeError, "not_in_main"):
            gate.candidate_descends_from(self.b, feature)
        with self.assertRaisesRegex(RuntimeError, "discard_live"):
            gate.candidate_descends_from(self.b, self.a)


if __name__ == "__main__":
    unittest.main()
