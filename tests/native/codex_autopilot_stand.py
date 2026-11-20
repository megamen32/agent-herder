#!/usr/bin/env python3
"""Exercise semantic automation on an isolated official Codex and loopback chat-completions judge."""
from contextlib import ExitStack, closing, contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time

import codex_recovery_stand as stand
from codex_autopilot_probe import automation, create
from ahap_opencode_stand import task_get, task_delivery_receipt

INSTRUCTIONS = "Compare the requested colours with the final answer."
REQUEST = "Give the first colour, red."
CLARIFICATION = "Also include the second colour, blue."
NEXT = "Include both requested colours in your answer."

@contextmanager
def drop_first_ack(endpoint, proxy):
    """Relay real native RPCs. Withhold only the first semantic turn/start response."""
    from websockets.sync.server import unix_serve
    from websockets.sync.client import unix_connect
    from websockets.exceptions import ConnectionClosed
    dropped, release, visible = threading.Event(), threading.Event(), threading.Event()
    def relay(client):
        try:
            with unix_connect(str(endpoint), uri="ws://localhost/rpc", proxy=None) as upstream:
                pending = set()
                def forward_requests():
                    try:
                        for raw in client:
                            packet = json.loads(raw)
                            if packet.get("method") == "thread/items/list" and dropped.is_set() and not visible.is_set():
                                client.send(json.dumps({"id":packet["id"],"result":{"data":[],"nextCursor":None}}))
                                continue
                            if packet.get("method") == "turn/start" and packet["params"].get("clientUserMessageId", "").startswith("codex-autopilot:"):
                                pending.add(packet["id"])
                            upstream.send(raw)
                    except ConnectionClosed:
                        pass
                    finally:
                        upstream.close()
                worker = threading.Thread(target=forward_requests, daemon=True)
                worker.start()
                for raw in upstream:
                    packet = json.loads(raw)
                    if packet.get("id") in pending and not dropped.is_set():
                        assert packet["result"]["turn"]["id"]
                        dropped.set()
                        release.wait(18)
                        return
                    client.send(raw)
        except ConnectionClosed:
            pass
    with unix_serve(relay, str(proxy)) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield dropped, release, visible
        finally:
            release.set()
            server.shutdown()
            worker.join()


def dump(path, value):
    stand.private_write(path, json.dumps(value))


class Judge(BaseHTTPRequestHandler):
    calls = []
    entered = threading.Event()
    release = threading.Event()

    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.path == "/v1/chat/completions"
        assert self.headers.get("Authorization") == "Bearer isolated-judge-fixture"
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert request["model"] == "fixture-judge"
        case = json.loads(request["messages"][-1]["content"])
        assert case["instructions"] == INSTRUCTIONS
        assert not any("neighbour" in text for text in case["human_messages"])
        answer = case["assistant_answer"]
        Judge.calls.append(case)
        if answer == "judge connection lost":
            self.close_connection = True
            return
        if answer.startswith("red only"):
            if answer == "red only":
                assert REQUEST in case["human_messages"] and CLARIFICATION in case["human_messages"]
            if answer.endswith("delayed"):
                Judge.entered.set()
                assert Judge.release.wait(14)
            decision = {"kind": "continue", "nextGoal": NEXT}
        elif answer == "red and blue":
            assert NEXT not in case["human_messages"]
            decision = {"kind": "done", "summary": "Both colours supplied"}
        else:
            assert answer in ("Which colour?", "Pick a colour.")
            decision = {"kind": "human" if answer.startswith("Which") else "choice"}
        result = json.dumps({"choices": [{"message": {"content": json.dumps(decision)}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result)))
        self.end_headers()
        self.wfile.write(result)


def exercise(root, owner, native, home, cwd, endpoint, env, read, wait, module, judge, ack):
    def thread():
        return read("thread/start", {"cwd": str(cwd)})["thread"]["id"]

    def prompt(target, message, answer):
        module.ANSWER = answer
        turn = read("turn/start", {"threadId": target, "input": [{"type": "text", "text": message}]})["turn"]["id"]
        assert wait(target, turn)["status"] == "completed"
        return turn

    session, neighbour = thread(), thread()
    prompt(session, REQUEST, "red")
    baseline = prompt(session, "Use lowercase names.", "red")
    prompt(neighbour, "neighbour private task", "red only")
    gate, db = stand.make_authority(root, Path("/fixture/store"))
    tripwire = root / "legacy-runner"
    stand.private_write(tripwire, "#!/bin/sh\nexit 99\n")
    tripwire.chmod(0o700)
    binding = {"kind": "codex", "principal": "fixture-owner", "node": "fixture-node",
               "instance": stand.INSTANCE, "code_home": str(home), "cwd": str(cwd),
               "executable": str(tripwire), "ahap_script": str(tripwire),
               "ahap_env": {"AHAP_CODEX_BIN": str(native), "CODEX_HOME": str(home),
                            "AHAP_CODEX_CWD": str(cwd), "AHAP_CODEX_SOCKET": str(endpoint)}}
    profile = root / "owner.json"
    config = {"database": str(db), "gate": str(gate), "generation": "fixture", "owner": binding}
    dump(profile, config)
    with stand.owner_client(owner, profile, env) as client:
        def register(native_id):
            return stand.session_tool(client, action="register", instance_ref=stand.INSTANCE,
                                      native_session_id=native_id, request_key="register-" + native_id)["session_ref"]
        ref, other = register(session), register(neighbour)
        unconfigured = create(client, ref, INSTRUCTIONS, "arm")
        print(json.dumps({"phase": "default_owner", "result": unconfigured}), flush=True)
        assert unconfigured == {"code": "autopilot_not_configured", "effect": "none"}, unconfigured

    holds = {}
    for name, field in (("human_stops", "sessions"), ("human_requests", "requests"),
                        ("choices", "requests"), ("unfinished_sessions", "sessions")):
        path = root / (name + ".json")
        dump(path, {"version": 1, field: []})
        holds[name] = str(path)
    token_file = root / "judge.token"
    stand.private_write(token_file, "isolated-judge-fixture")
    binding["codex_autopilot"] = {"state_dir": str(root), "holds": holds,
                                  "judge": {"base_url": judge, "model": "fixture-judge",
                                            "token_file": str(token_file)}}
    dump(profile, config)

    def personal(enabled=True, executor="rust", target=session, directory=cwd):
        path = root / "sessions.json"
        rows = json.loads(path.read_bytes())["sessions"] if path.exists() else []
        rows = [r for r in rows if r["sessionId"] != target]
        rows.append({"harness":"codex", "sessionId":target, "cwd":str(directory), "enabled":enabled,
                     "executor":executor, "updatedAt":datetime.now(timezone.utc).isoformat()})
        dump(path, {"version":1, "sessions":rows})

    personal(executor="typescript")
    with stand.owner_client(owner, profile, env) as client:
        assert create(client, ref, INSTRUCTIONS, "arm")["code"] == "personal_policy_required"
        personal()
        assert create(client, other, INSTRUCTIONS, "arm-other")["code"] == "personal_policy_required"
        rule = create(client, ref, INSTRUCTIONS, "arm")
        assert rule["phase"] == "armed" and rule["turn_id"] == baseline, rule
        assert create(client, ref, INSTRUCTIONS, "arm") == rule
        rule_ref = rule["rule_ref"]
        assert automation(client, action="list", session_ref=ref)["rules"] == [rule]
        assert automation(client, action="list", session_ref=other)["rules"] == []
        probe = [sys.executable, "-B", "/fixture/native/codex_autopilot_probe.py",
                 "--owner", str(owner), "--profile", str(profile)]
        assert json.loads(subprocess.check_output([*probe, "list", ref], env=env))["rules"] == [rule]
        assert create(client, ref, INSTRUCTIONS + "changed", "arm")["code"] == "idempotency_conflict"
        prompt(neighbour, "neighbour after arming", "red only")
        time.sleep(2.3)
        assert Judge.calls == []

        source_turn = prompt(session, CLARIFICATION, "red only")
        module.ANSWER = "red and blue"
        def answered():
            packet = stand.turns(read, session)
            return len(packet) == 4 and packet[-1]["status"] == "completed" and packet[-1]["id"]
        try:
            answer_turn = stand.wait_for("one semantic continuation did not complete", answered, 18)
        except TimeoutError:
            print({"rule": automation(client, action="get", rule_ref=rule_ref), "judge": Judge.calls,
                   "intents": ledger(db), "items": stand.turns(read, session)[-1]["items"]}, flush=True)
            raise
        assert ack[0].is_set()
        ack[1].set()
        stand.wait_for("lost ACK did not produce UNKNOWN",lambda:any(row[1]=="unknown" for row in ledger(db)),12)
        time.sleep(2.3)
        rows = ledger(db)
        assert len(rows) == 1 and rows[0][1:4] == ("unknown", "finished", None), rows
        task_id = rows[0][0]
        assert len(Judge.calls) == 1
    ack[2].set()
    with stand.owner_client(owner, profile, env) as client:
        def status():
            return automation(client, action="get", rule_ref=rule_ref)

        def phase(name):
            try:
                return stand.wait_for("expected phase " + name, lambda: status().get("phase") == name, 12)
            except TimeoutError:
                print({"expected":name,"status":status(),"judged_answers":[c["assistant_answer"] for c in Judge.calls],
                       "intents":ledger(db)},flush=True)
                raise

        receipt = stand.wait_for("lost native ACK did not reconcile", lambda:
                                 task_delivery_receipt(task_get(client, task_id)), 16)
        assert receipt["native_receipt_id"] == answer_turn and receipt["reconciliation"]["ack_recovered"], receipt
        assert receipt["reconciliation"]["original_intent_state"] == "unknown", receipt
        phase("done")
        assert [c["assistant_answer"] for c in Judge.calls] == ["red only", "red and blue"]
        messages = stand.session_tool(client, action="messages", session_ref=ref)
        assert "red and blue" in json.dumps(messages) and status()["delivery_task_id"] == task_id
        assert len(stand.turns(read, session)) == 4 and len(ledger(db)) == 1
        # A second owner tick and duplicate create must reuse both verdict and receipt.
        assert create(client, ref, INSTRUCTIONS, "arm") == status()
        for answer, decision in [("Which colour?", "human"), ("Pick a colour.", "choice")]:
            prompt(session, "I have another question.", answer)
            phase(decision)
            assert len(ledger(db)) == 1

        before_loss = len(Judge.calls)
        prompt(session, "Check this once.", "judge connection lost")
        phase("judge_unavailable")
        assert json.loads(subprocess.check_output([*probe, "get", rule_ref], env=env)) == status()
        time.sleep(2.3)
        assert len(Judge.calls) == before_loss + 1 and len(ledger(db)) == 1

        def delayed():
            Judge.release.clear()
            Judge.entered.clear()
            prompt(session, "Check the outstanding requirement.", "red only delayed")
            assert Judge.entered.wait(7), status()

        delayed()
        pending_calls = len(Judge.calls)
        with stand.owner_client(owner, profile, env) as concurrent:
            assert automation(concurrent, action="get", rule_ref=rule_ref)["phase"] == "evaluating"
            time.sleep(2.2)
            assert len(Judge.calls) == pending_calls
        personal(False)
        Judge.release.set()
        phase("held")
        assert len(ledger(db)) == 1
        personal()
        # Explicit update captures a fresh baseline and keeps the control revision independent of ticks.
        def rearm():
            return automation(client, action="update", revision=status()["revision"], rule_ref=rule_ref,
                              rule={"kind":"autopilot", "instructions":INSTRUCTIONS})
        assert rearm()["phase"] == "armed"
        delayed()
        paused = automation(client, action="pause", rule_ref=rule_ref, revision=status()["revision"])
        assert paused["phase"] == "paused"
        Judge.release.set()
        time.sleep(2.3)
        assert status() == paused and len(ledger(db)) == 1
        assert automation(client, action="pause", rule_ref=rule_ref, revision=1)["code"] == "revision_conflict"
        assert rearm()["phase"] == "armed"
        for filename, field, row in [
            ("human_requests", "requests", {"target":{"agent":"codex","sessionId":session},"status":"pending"}),
            ("choices", "requests", {"harness":"codex","sessionId":session,"status":"pending"}),
            ("unfinished_sessions", "sessions", {"harness":"codex","sessionId":session,"quotaRecovery":{"state":"waiting"}}),
        ]:
            delayed()
            dump(root / (filename + ".json"), {"version":1, field:[row]})
            Judge.release.set()
            phase("held")
            assert len(ledger(db)) == 1
            dump(root / (filename + ".json"), {"version":1, field:[]})
        delayed()
        goal = read("thread/goal/set", {"threadId":session, "objective":"Wait for a human decision.",
                    "status":"paused", "origin":"user"})["goal"]
        assert goal["threadId"] == session and goal["status"] == "paused"
        Judge.release.set()
        phase("held")
        assert len(ledger(db)) == 1
        read("thread/goal/clear", {"threadId":session, "origin":"user"})

        delayed()
        prompt(session, "I want to choose a different colour.", "Which colour?")
        Judge.release.set()
        phase("human")
        assert len(ledger(db)) == 1

        delayed()
        stopped = client.request("tools/call", {"_meta":stand.MCP_META, "name":"stop",
                                 "arguments":{"action":"stop","session_ref":ref,"request_key":"manual-stop"}})
        assert not stopped.get("isError"), stopped
        Judge.release.set()
        phase("held")
        final = status()
        calls = len(Judge.calls)
        native_count = len(read("thread/turns/list", {"threadId":session, "limit":32})["data"])
        # Any explicitly selected session in the same profile can own an independent
        # rule. The second session gets no new turn or judge request during this check.
        personal(target=neighbour, directory=cwd.parent)
        assert create(client, other, INSTRUCTIONS, "second-rule")["code"] == "personal_policy_required"
        personal(target=neighbour)
        settings = {"schemaVersion":1, "revision":"fixture-self", "updatedAt":datetime.now(timezone.utc).isoformat(),
                    "policy":{"schemaVersion":1,"enabled":False,"harnesses":["codex"],"scope":{"mode":"all_ingress"},
                              "timeout":{"mode":"hold","delayMs":1000},"card":{"includeUserMessage":True,
                              "includeAssistantMessage":True,"includeReason":True},"maxContinuationsPerSession":3,
                              "judgeMode":"self"}}
        dump(root / "autopilot-policy.json", settings)
        assert create(client, other, INSTRUCTIONS, "second-rule")["code"] == "personal_policy_required"
        settings["policy"]["judgeMode"] = "llm"
        settings["revision"] = "fixture-llm"
        dump(root / "autopilot-policy.json", settings)
        second = create(client, other, INSTRUCTIONS, "second-rule")
        assert second["rule_ref"] != rule_ref and second["phase"] == "armed" and second["revision"] == 1, second
        assert automation(client, action="list", session_ref=other)["rules"] == [second]
        assert automation(client, action="pause", rule_ref=second["rule_ref"], revision=1)["phase"] == "paused"
        assert status() == final
    with stand.owner_client(owner, profile, env) as restarted:
        time.sleep(2.3)
        assert automation(restarted, action="get", rule_ref=rule_ref) == final
        assert task_delivery_receipt(task_get(restarted, task_id)) == receipt
        assert len(Judge.calls) == calls and len(ledger(db)) == 1
        assert len(read("thread/turns/list", {"threadId":session, "limit":32})["data"]) == native_count
        assert len(stand.turns(read, neighbour)) == 2
    return {"session":session, "source_turn":source_turn, "answered_turn":answer_turn,
            "receipt":receipt["native_receipt_id"], "judge_requests":calls, "native_deliveries":1,
            "ack_recovered":True,"restart_replays":0,"neighbour_judgments":0,
            "independent_rules":2, "native_goal_hold":True, "judge_loss_replays":0,
            "pending_recovery_hold":True, "concurrent_owners":2}


def ledger(db):
    with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)) as conn:
        return conn.execute("""SELECT i.task_id,i.state,d.phase,i.native_receipt,t.result_json
            FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
            JOIN tasks t ON t.task_id=i.task_id WHERE i.request_key LIKE 'codex-autopilot:%'""").fetchall()


def inside(parent):
    assert stand.namespace() != parent and {name for _, name in socket.if_nameindex()} == {"lo"}
    root = Path("/stand")
    assert root.is_mount()
    root.chmod(0o700)
    os.umask(0o077)
    native, owner = root / "codex", Path("/fixture/owner")
    shutil.copyfile("/fixture/codex", native)
    native.chmod(0o500)
    home, cwd, endpoint = root / "codex-home", root / "project", root / "codex.sock"
    home.mkdir()
    cwd.mkdir()
    env = {"HOME": str(home), "CODEX_HOME": str(home), "PATH": "/usr/bin:/bin"}
    module = stand.model_fixture()
    with ExitStack() as stack:
        model = stack.enter_context(stand.http_fixture(module.Handler))
        judge = stack.enter_context(stand.http_fixture(Judge))
        stand.private_write(home / "config.toml", f'''model = "fixture-model"
model_provider = "opencodex"
sandbox_mode = "read-only"
approval_policy = "never"
[features]
goals = true
[model_providers.opencodex]
name = "Isolated semantic autopilot"
base_url = "{model}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
experimental_bearer_token = "fixture-only"
''')
        stack.enter_context(stand.codex_server(native, endpoint, env, cwd))
        read, wait = stack.enter_context(stand.native_client(endpoint, home))
        proxy = root / "owner.sock"
        ack = stack.enter_context(drop_first_ack(endpoint, proxy))
        proof = exercise(root, owner, native, home, cwd, proxy, env, read, wait, module, judge, ack)
        print(json.dumps({"result": "PASS", "network": "loopback-only", "owner_sha256": stand.digest(owner),
                          "codex_sha256": stand.digest(native), **proof}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        stand.main(__file__, __doc__)
