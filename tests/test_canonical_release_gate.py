"""Inactive fixture coverage for sealed canonical rollout guards."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("canonical_release_gate", ROOT / "deploy/fleet/release_gate.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CanonicalReleaseGateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-canonical-gate-")
        self.root = Path(self.temp.name)
        self.calls = self.root / "calls.jsonl"
        self.calls.write_text("")
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"calls": str(self.calls)}))
        self.bridge = self.root / "bridge.py"
        self.bridge.write_text("""#!/usr/bin/env python3
import json,sys
config=json.load(open(sys.argv[2]))
guard=False
for line in sys.stdin:
 req=json.loads(line)
 with open(config['calls'],'a') as f:f.write(json.dumps({'request':req,'argv':sys.argv})+'\\n')
 if req['action']=='guard':guard=True;result={'guarded':True,'lease':{'fence':119}}
 elif req['action']=='finished':guard=False;result={'finished':True}
 else:result={'fence':119}
 print(json.dumps({'ok':True,'result':result}),flush=True)
if guard:
 with open(config['calls'],'a') as f:f.write(json.dumps({'unresolved':True})+'\\n')
""")
        self.bridge.chmod(0o700)
        self.marker = {"version": 1, "config": str(self.config), "bridge": str(self.bridge), "seal_id": "fixture-seal"}
        self.ledger = self.root / "ledger.json"
        self.state = {"version": 2, "canonical": self.marker, "projects": {"project": {"fence": 118}}}
        self.ledger.write_text(json.dumps(self.state))
        self.proof = self.root / "proof.json"
        self.token = "a" * 64
        self.proof.write_text(json.dumps({"project": "project", "owner": {"hostId": "fixture", "harness": "test", "nativeSessionId": "session"}, "token": self.token, "fence": 119}))
        self.target = {"fleetDir": "/fixture/fleet", "unit": "fixture.service"}

    def tearDown(self):
        self.temp.cleanup()

    def gate(self):
        return MODULE.ReleaseGate(self.proof, self.ledger, target=self.target)

    def history(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_guard_is_held_through_cleanup_and_finished_after_effect(self):
        before = self.ledger.read_bytes()
        with self.gate() as gate:
            self.assertEqual([v["request"]["action"] for v in self.history()], ["guard"])
            self.assertEqual(gate.check()["fence"], 119)
            self.assertEqual(gate.check(cleanup=True)["fence"], 119)
        history = self.history()
        self.assertEqual([v["request"]["action"] for v in history], ["guard", "check", "check", "finished"])
        self.assertEqual(history[0]["request"]["deploymentTarget"], self.target)
        self.assertTrue(history[2]["request"]["cleanup"])
        self.assertNotIn(self.token, json.dumps([v["argv"] for v in history]))
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(list(self.root.glob("deploy-*.lock")), [])

    def test_exception_leaves_unresolved_guard_and_never_declares_finished(self):
        with self.assertRaisesRegex(RuntimeError, "unknown effect"):
            with self.gate():
                raise RuntimeError("unknown effect")
        self.assertEqual([v.get("request", {}).get("action") for v in self.history()], ["guard", None])
        self.assertTrue(self.history()[-1]["unresolved"])

    def test_fresh_cleanup_requires_previously_admitted_guard(self):
        with self.assertRaisesRegex(RuntimeError, "release_canonical_cleanup_requires_guard"):
            self.gate().check(cleanup=True)
        self.assertEqual(self.history(), [])

    def test_mixed_seal_is_rejected_without_starting_any_bridge(self):
        self.state["projects"]["project"]["lease"] = None
        self.ledger.write_text(json.dumps(self.state))
        with self.assertRaisesRegex(RuntimeError, "release_canonical_seal_invalid"):
            with self.gate():
                self.fail("invalid seal admitted effect")
        self.assertEqual(self.history(), [])
        self.state["projects"]["project"] = {"inventory": [{"lease": None}]}
        self.ledger.write_text(json.dumps(self.state))
        with self.assertRaisesRegex(RuntimeError, "release_canonical_seal_invalid"):
            self.gate().check()
        self.assertEqual(self.history(), [])

    def test_authority_flip_during_legacy_admission_is_fail_closed(self):
        gate = self.gate()
        gate._legacy_admitted = True
        with self.assertRaisesRegex(RuntimeError, "release_authority_changed_retry"):
            gate.check()
        self.assertEqual(self.history(), [])


if __name__ == "__main__":
    unittest.main()
