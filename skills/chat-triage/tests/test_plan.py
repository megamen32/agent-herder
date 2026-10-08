#!/usr/bin/env python3
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
planner, installer = module("plan"), module("install")
NOW = 2000000000

def r(sid, harness="codex", host="station"):
    return {"harness": harness, "host": host, "id": sid}
def session(sid, pinned=True, **changes):
    return {**r(sid), "pinned": pinned, "access": "available",
            "nativeStatus": "idle", "activeTurnId": None,
            "queued": False, "observedAt": NOW, **changes}
def contract(sid="parent", **changes):
    return {"id": sid, "scopeVerified": True, "owner": r(sid),
            "outcome": "pending", "aliases": [], "children": [], **changes}
def snapshot(sessions, contracts, **changes):
    return {"schemaVersion": 1, "inventoryComplete": True,
            "contractsComplete": True, "sessions": sessions,
            "contracts": contracts, **changes}
def done(sid="parent", **changes):
    return contract(sid, outcome="complete", completionEvidence={
        "verified": True, "kind": "consumer", "receipt": "user-result"}, **changes)
def handoff():
    return {"verified": True, "receipt": "owning-checkpoint"}
def actions(s):
    return [(a["id"], a["pinned"]) for a in planner.plan(s, NOW)["actions"]]

class PlannerTests(unittest.TestCase):
    def test_idle_and_failed_owners_remain_current(self):
        s=snapshot([session("p", False, nativeStatus="failed")],[contract("p")])
        self.assertEqual(actions(s), [("p", True)])
    def test_completed_child_does_not_complete_parent(self):
        s=snapshot([session("parent"),session("child",nativeStatus="completed")],
                   [contract(children=[r("child")])])
        self.assertEqual(actions(s), [])
    def test_titles_and_cwd_do_not_merge_sessions(self):
        s=snapshot([session("a",title="Same",cwd="/project"),
                    session("b",title="Same",cwd="/project")],
                   [contract("a"),contract("b")])
        self.assertEqual(actions(s),[])
        self.assertNotIn("Same", str(planner.plan(s,NOW)))
    def test_zcode_consumer_complete_unpins_only_known_id(self):
        s=snapshot([session("z",harness="zcode"),session("untracked",harness="zcode")],
                   [done("logical",owner=r("z","zcode"))])
        self.assertEqual(actions(s),[("z",False)])
    def test_source_pass_and_turn_finish_are_not_completion(self):
        c=done()
        c["completionEvidence"]["kind"]="source"
        self.assertEqual(actions(snapshot([session("parent")],[c])),[])
    def test_no_unpin_when_active_queued_or_unknown(self):
        for changes in [{"nativeStatus":"inProgress","activeTurnId":"turn"},
                        {"queued":True},{"queued":None},{"access":"unknown"},
                        {"observedAt":NOW-301},{"observedAt":NOW+1}]:
            with self.subTest(changes=changes):
                self.assertEqual(actions(snapshot([session("parent",**changes)],[done()])),[])
    def test_missing_active_turn_field_blocks_unpin(self):
        x=session("parent"); del x["activeTurnId"]
        self.assertEqual(actions(snapshot([x],[done()])),[])
    def test_partial_registry_retains_absent_original(self):
        s=snapshot([session("new")],[contract("new",aliases=[r("missing-original")])],
                   inventoryComplete=False)
        p=planner.plan(s,NOW)
        self.assertEqual(p["actions"],[])
        self.assertEqual(p["scope"]["contracts"][0]["aliases"],[r("missing-original")])
    def test_missing_replacement_does_not_hide_original(self):
        s=snapshot([session("old")],[contract("new",aliases=[r("old")],
                    handoffEvidence=handoff())])
        self.assertEqual(actions(s),[])
    def test_unverified_handoff_preserves_old_pin(self):
        s=snapshot([session("new"),session("old")],
                   [contract("new",aliases=[r("old")])])
        self.assertEqual(actions(s),[])
    def test_replacement_pin_requires_readback(self):
        s=snapshot([session("new",False),session("old")],
                   [contract("new",aliases=[r("old")],handoffEvidence=handoff())])
        p=planner.plan(s,NOW)
        self.assertEqual(actions(s),[("new",True),("old",False)])
        self.assertEqual([(a["id"],a["pinned"]) for a in planner.verify(p,s,NOW)["actions"]],
                         [("new",True)])
        s["sessions"][0]["pinned"]=True
        verified=planner.verify(p,s,NOW)
        self.assertEqual([(a["id"],a["pinned"]) for a in verified["actions"]],[("old",False)])
        self.assertEqual(verified["alreadySatisfied"],1)
    def test_alias_still_owns_other_pending_contract(self):
        s=snapshot([session("new"),session("old")],
                   [contract("new",aliases=[r("old")],handoffEvidence=handoff()),
                    contract("old")])
        self.assertEqual(actions(s),[])
    def test_alias_is_child_of_another_pending_parent(self):
        s=snapshot([session("new"),session("old"),session("other")],
                   [contract("new",aliases=[r("old")],handoffEvidence=handoff()),
                    contract("other",children=[r("old")])])
        self.assertEqual(actions(s),[])
    def test_same_id_different_host_and_harness_remain_distinct(self):
        s=snapshot([session("x",host="one"),session("x",host="two"),
                    session("x",host="one",harness="zcode")],
                   [done("logical",owner=r("x",host="one"))])
        p=planner.plan(s,NOW)
        self.assertEqual(len(p["actions"]),1)
        self.assertEqual(p["actions"][0]["host"],"one")
        self.assertEqual(p["actions"][0]["harness"],"codex")
    def test_scope_change_after_plan_is_rejected(self):
        s=snapshot([session("parent")],[done()])
        p=planner.plan(s,NOW)
        s["contracts"][0]["outcome"]="pending"
        with self.assertRaisesRegex(ValueError,"scope changed"):
            planner.verify(p,s,NOW)
    def test_activity_change_after_plan_blocks_unpin(self):
        s=snapshot([session("parent")],[done()])
        p=planner.plan(s,NOW)
        s["sessions"][0].update(nativeStatus="inProgress",activeTurnId="new")
        self.assertEqual(planner.verify(p,s,NOW)["actions"],[])
    def test_empty_or_duplicate_session_reference_rejected(self):
        with self.assertRaises(ValueError):
            planner.plan(snapshot([session("parent"),session("parent")],[done()]),NOW)
        with self.assertRaises(ValueError):
            planner.plan(snapshot([session("")],[done()]),NOW)

class InstallerTests(unittest.TestCase):
    def test_install_is_discoverable_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            first=installer.install(ROOT,home)
            second=installer.install(ROOT,home)
            self.assertEqual(first,second)
            self.assertTrue((home/".codex/skills/chat-triage/SKILL.md").is_file())
            text=(home/".zcode/commands/chat-triage.md").read_text()
            self.assertIn(str(ROOT/"SKILL.md"),text)
            self.assertFalse((home/".zcode/cli/config.json").exists())
    def test_install_from_existing_codex_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            source=home/".codex/skills/chat-triage"
            source.mkdir(parents=True)
            (source/"SKILL.md").write_text("Existing reviewed skill")
            installer.install(source,home)
            self.assertEqual((source/"SKILL.md").read_text(),"Existing reviewed skill")
            self.assertTrue((home/".zcode/commands/chat-triage.md").is_file())
    def test_foreign_command_is_preserved_before_any_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            command=home/".zcode/commands/chat-triage.md"
            command.parent.mkdir(parents=True)
            command.write_text("User's command")
            with self.assertRaises(ValueError):
                installer.install(ROOT,home)
            self.assertEqual(command.read_text(),"User's command")
            self.assertFalse((home/".codex/skills/chat-triage").exists())

if __name__=="__main__":
    unittest.main()
