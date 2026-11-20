#!/usr/bin/env python3
"""Smoke the Rust browser AHAP binary and public owner MCP against disposable Chrome.

Build herder-browser, herder_native_stdio and ahap-owner-bootstrap into one Cargo
target directory. Run with --bin-dir TARGET/debug. Requires Node, OpenSSL, Google
Chrome and playwright-core (PLAYWRIGHT_MODULE can point to its absolute index.mjs).
"""
import argparse
from contextlib import ExitStack
import json
import math
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time

from ahap_opencode_stand import (
    RpcProcess, parse_fresh_seed, persist_evidence, rpc_tool, sha256_file,
    task_delivery_receipt, wait_task,
)
from v1_codex_stand import receipt_reference


HERE = Path(__file__).resolve().parent
PROMPT = "Local browser acceptance, identical input"
NODE = "browser-fixture-node"
INSTANCE = "browser-fixture-instance"
ORIGINS = {"chatgpt": "https://chatgpt.com", "zai": "https://chat.z.ai"}
METHODS = {"init", "listSessions", "getSession", "getSessionMessages", "createSession", "sendMessage"}
WARMUP = 3


def check(ok, detail):
    if not ok:
        raise AssertionError(detail)


def private_env(home):
    return {"HOME": str(home), "PATH": os.defpath, "LANG": "C.UTF-8",
            **{"XDG_" + name.upper() + "_HOME": str(home / name)
               for name in ("cache", "config", "data", "state")}}


class JsonLines(RpcProcess):
    """Browser fixture and AHAP each return one response per JSONL request."""

    def __init__(self, argv, env, cwd):
        self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.next_id = 0

    def frame(self, method, params=None):
        self.next_id += 1
        request = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 45)[0]:
            raise TimeoutError(f"{method} timed out")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"{method} closed stdout: {self.process.stderr.read(2048)}")
        frame = json.loads(line)
        check(frame.get("jsonrpc") == "2.0" and frame.get("id") == self.next_id,
              f"{method} returned the wrong response envelope")
        return frame

    def call(self, method, params=None):
        frame = self.frame(method, params)
        check("result" in frame and "error" not in frame, f"{method}: {frame.get('error')}")
        return frame["result"]


def seed_histories():
    data = json.loads((HERE.parents[1] / "acceptance/native/z-ai/recent-two-chats.json").read_text())
    return [[(r["id"], r["role"], r["content"]) for r in seed["data"].values()] for seed in data]


def projected(rows):
    return [(r["id"], r["role"], r["text"]) for r in rows]


def native_ids(harness, route_ids):
    prefix = "chatgpt::" if harness == "chatgpt" else "zai::route%3A"
    return [prefix + route for route in route_ids]


def exact(actual, expected, what):
    check(actual == expected, f"{what}: expected {expected!r}, observed {actual!r}")


def exact_seeds(read, sessions):
    for session, expected in zip(sessions, seed_histories(), strict=True):
        exact(projected(read(session)), expected, f"exact history for {session}")


def inventory_ids(rows):
    return [r["id"] for r in rows]


def check_sends(fixture, receipt_ids, seed_ids):
    snapshot = fixture.call("snapshot")
    pinned = "/c/" + seed_ids[1]
    exact(snapshot["pinnedRoute"], pinned, "pinned tab route")
    if receipt_ids:
        exact(snapshot["documents"][:2], [pinned, "/"], "pinned and fresh provider documents")
    else:
        exact(snapshot["documents"], [pinned], "documents before first submit")
    sends = snapshot["sends"]
    exact(len(sends), len(receipt_ids), "fixture submit count")
    check(len(set(receipt_ids)) == len(receipt_ids), "repeated prompt reused an earlier native user ID")
    expected = []
    for i, (send, receipt_id) in enumerate(zip(sends, receipt_ids)):
        exact(send["addressed"], None if i == 0 else sends[0]["id"], "addressed form submit")
        same_new_chat = send["id"] == sends[0]["id"] and send["id"] not in seed_ids
        check(same_new_chat, f"submit went to the wrong conversation: {send['id']}")
        user, assistant = projected(send["rows"])
        exact(user, (receipt_id, "user", PROMPT), "provider submit versus native user receipt")
        check(assistant[1] == "assistant" and assistant[0] != receipt_id, "missing separate assistant row")
        expected.extend([user, assistant])
    return expected


def measure(call, validate, iterations):
    for _ in range(WARMUP):
        validate(call())
    samples = []
    for _ in range(iterations):
        start = time.perf_counter_ns()
        value = call()
        samples.append(time.perf_counter_ns() - start)
        validate(value)
    ordered = sorted(samples)
    def percentile(q):
        return round(ordered[math.ceil(q * iterations) - 1] / 1e6, 3)
    return {"iterations": iterations, "warmup": WARMUP, "p50_ms": percentile(.50),
            "p95_ms": percentile(.95), "samples_ns": samples}


def benchmark(read, inventory, expected_rows, expected_ids, n):
    return {
        "read": measure(read, lambda rows: exact(projected(rows), expected_rows, "warm read"), n),
        "list": measure(inventory, lambda ids: exact(sorted(ids), sorted(expected_ids), "warm list"), n),
    }


def ahap_case(binary, home, fixture, setup, harness, n, record, stack):
    def start():
        rpc = JsonLines([binary, "--harness", harness, "--node", NODE, "--instance", INSTANCE],
                        {**private_env(home), **setup["env"]}, home)
        stack.callback(rpc.close)
        hello = rpc.call("initialize", {"harness": harness, "ahapVersion": "0.1"})
        exact(hello["harness"], harness, "initialize harness")
        check(METHODS <= set(hello["capabilities"]["methods"]), "missing AHAP operations")
        rpc.call("init")
        record.setdefault("pids", []).append(rpc.process.pid)
        return rpc

    def read(key):
        return rpc.call("getSessionMessages", {"id": key, "limit": 20})

    def inventory():
        return inventory_ids(rpc.call("listSessions", {"options": {"limit": 20}}))

    def send(key):
        return {"id": draft, "options": {"queue": True, "activeTurnOnly": False,
                                         "message": PROMPT, "inputId": key}}

    rpc = start()
    seeds = native_ids(harness, setup["seedIds"])
    exact(sorted(inventory()), sorted(seeds), "seed inventory")
    for key in seeds:
        session = rpc.call("getSession", {"id": key})
        exact((session["id"], session["harness"]), (key, harness), "exact session")
    exact_seeds(read, seeds)
    record["phase"] = "draft"
    draft = rpc.call("createSession", {"options": {"name": "Local fixture draft", "cwd": str(home)}})["id"]
    record["session"] = draft
    check(draft not in seeds and draft in inventory(), "draft identity missing from inventory")
    exact(read(draft), [], "fresh draft history")
    check_sends(fixture, [], setup["seedIds"])
    ids = record["receipt_ids"] = []
    for i in range(2):
        record["phase"] = f"send {i + 1}"
        key = f"distinct-input-{i}"
        receipt = rpc.call("sendMessage", send(key))
        exact(receipt["inputId"], key, "AHAP input correlation")
        exact(receipt["sessionId"], draft, "AHAP session correlation")
        check(receipt.get("ok") is True and receipt.get("admission") == "accepted" and receipt.get("admitted") is True,
              f"unconfirmed send: {receipt}")
        ids.append(receipt["nativeInputMessageId"])
        expected = check_sends(fixture, ids, setup["seedIds"])
        exact(projected(read(draft)), expected, "post-send history")
        exact_seeds(read, seeds)
    rpc.call("shutdown")
    rpc.close()
    record["phase"] = "restart"
    rpc = start()
    reopened = rpc.call("getSession", {"id": draft})
    exact(reopened["id"], draft, "reopened draft")
    remote = fixture.call("snapshot")["sends"][0]["id"]
    source_route = reopened["meta"].get("sourceRoute")
    exact(source_route, f"{ORIGINS[harness]}/c/{remote}", "sourceRoute of reopened bound draft")
    record["sourceRoute"] = source_route
    exact(projected(read(draft)), expected, "reopened history")
    exact_seeds(read, seeds)
    record["timings"] = benchmark(lambda: read(draft), inventory, expected, [*seeds, draft], n)
    check_sends(fixture, ids, setup["seedIds"])
    record["phase"] = "wrong account"
    fixture.call("switchAccount")
    refusals = {}
    for method, params in [("getSessionMessages", {"id": draft, "limit": 20}), ("listSessions", {})]:
        error = rpc.frame(method, params).get("error")
        check(error and error["code"] == -32000 and "identity" in error["message"],
              f"{method} did not reject the account mismatch: {error}")
        refusals[method] = error
    result = rpc.call("sendMessage", send("wrong-account"))
    exact(result.get("admission"), "not_submitted", "wrong-account send")
    check_sends(fixture, ids, setup["seedIds"])
    record["wrong_scope"] = {**refusals, "sendMessage": result["admission"]}
    rpc.call("shutdown")


def mcp_content(reply):
    check(not reply.get("isError"), f"MCP tool error: {reply.get('structuredContent')}")
    return reply["structuredContent"]


def owner_task(rpc, name, args):
    reply = rpc_tool(rpc, name, args)
    task_id = reply.get("taskId")
    check(task_id, f"{name} missing task: {reply}")
    task = wait_task(rpc, task_id)
    exact(task.get("taskId"), task_id, f"{name} task correlation")
    return task, task_id


def lost_receipt_case(rpc, start, fixture, setup, args, record):
    record["phase"] = "owner create with unreadable receipt"
    fixture.call("withholdReceipt", {"enabled": True})
    task, task_id = owner_task(rpc, "create", args)
    result = task["result"]
    payload = result["structuredContent"]
    prompt = payload["prompt"]
    exact((task["status"], result.get("isError")), ("completed", True), "unconfirmed create task")
    exact(payload["create"]["effect"], "confirmed", "local draft creation")
    session = payload["create"]["session_ref"]
    check(session and not task_delivery_receipt(task), "expected a draft without a delivery receipt")
    exact((prompt.get("code"), prompt.get("effect"), prompt.get("retry")),
          ("outcome_unknown", "unknown", "forbidden"), "owner first-submit outcome")

    snapshot = fixture.call("snapshot")
    accepted = snapshot["sends"]
    exact(len(accepted), 1, "submits before owner restart")
    send = accepted[0]
    exact(send["addressed"], None, "first submit on the blank page")
    check(send["id"] not in setup["seedIds"], "first submit reached a seed")
    user, _ = projected(send["rows"])
    exact(user[1:], ("user", PROMPT), "fixture's accepted input")
    check(snapshot["requests"].get("withheldReceipt", 0) > 0, "adapter never read the withheld receipt")
    record.update(session=session, task_ids=[task_id], unknown=prompt,
                  submit_counts={"before_restart": len(accepted)})

    record["phase"] = "owner restart and replay of unknown create"
    rpc.close()
    fixture.call("withholdReceipt", {"enabled": False})
    rpc = start()
    restored = wait_task(rpc, task_id)
    exact(restored["result"], result, "durable UNKNOWN result after restart")
    after_restart = fixture.call("snapshot")["sends"]
    exact(after_restart, accepted, "fixture ledger after restart")
    record["submit_counts"]["after_restart"] = len(after_restart)
    replay, replay_id = owner_task(rpc, "create", args)
    exact(replay_id, task_id, "same-key create task after restart")
    exact(replay["result"], result, "replayed UNKNOWN result")
    after_replay = fixture.call("snapshot")["sends"]
    exact(after_replay, accepted, "fixture ledger after same-key replay")
    record["submit_counts"]["after_replay"] = len(after_replay)
    record["replay_task"] = replay_id


def mcp_case(bins, home, fixture, setup, harness, n, record, stack, lost_receipt):
    protected = home / "herder-owner-home"
    protected.mkdir(mode=0o700)
    seed = parse_fresh_seed(subprocess.check_output([bins["ahap-owner-bootstrap"], protected],
                            env=private_env(home), text=True, timeout=20), protected)
    profile = {k: seed[k] for k in ("database", "gate", "generation")}
    profile["owner"] = {"kind": harness, "principal": "browser-fixture-owner", "node": NODE,
                        "instance": INSTANCE, "executable": str(bins["herder_native_stdio"]),
                        "cwd": str(home), "code_home": str(home), "ahap_env": setup["env"]}
    profile_path = Path(seed["profile_seed"]).with_name("profile.json")
    with os.fdopen(os.open(profile_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
        json.dump(profile, f)

    def start():
        rpc = RpcProcess(bins["herder_native_stdio"], profile_path, private_env(home))
        stack.callback(rpc.close)
        check({"session", "sessions", "create", "deliver"} <= set(rpc.preflight()), "owner tools missing")
        record.setdefault("pids", []).append(rpc.process.pid)
        return rpc

    def tool(name, **args):
        return mcp_content(rpc_tool(rpc, name, args))

    def read(key):
        return tool("session", action="messages", session_ref=key)["page"]["messages"]

    def inventory():
        listing = tool("sessions", action="list", instance_ref=INSTANCE)
        check(listing["native_coverage_complete"], "owner list omitted native session metadata")
        rows = listing["sessions"]
        return [r["session_ref"] for r in rows]

    def mutation(name, args):
        task, task_id = owner_task(rpc, name, args)
        receipt = task_delivery_receipt(task)
        check(task.get("status") == "completed" and receipt, f"{name} unconfirmed: {task}")
        kind_and_id = receipt_reference(receipt["native_receipt_id"])
        check(kind_and_id and kind_and_id[0] == "message", f"{name} lacks native message receipt")
        return task, task_id, kind_and_id[1]

    rpc = start()
    seeds = []
    for i, key in enumerate(native_ids(harness, setup["seedIds"])):
        binding = tool("session", action="register", instance_ref=INSTANCE, native_session_id=key,
                       request_key=f"register-seed-{i}")
        ref = binding["session_ref"]
        exact(tool("session", action="context", session_ref=ref)["address"]["native_session_id"],
              key, "owner exact binding")
        seeds.append(ref)
    exact(sorted(inventory()), sorted(seeds), "owner seed inventory")
    exact_seeds(read, seeds)
    check_sends(fixture, [], setup["seedIds"])
    create_args = {"action": "create", "instance_ref": INSTANCE,
                   "request_key": "first-input", "prompt": PROMPT}
    if lost_receipt:
        return lost_receipt_case(rpc, start, fixture, setup, create_args, record)
    record["phase"] = "owner create"
    task, first_task, first = mutation("create", create_args)
    session = task["result"]["structuredContent"]["create"]["session_ref"]
    record.update(session=session, receipt_ids=[first], task_ids=[first_task])
    expected = check_sends(fixture, [first], setup["seedIds"])
    exact(projected(read(session)), expected, "owner create readback")
    record["phase"] = "owner deliver"
    delivery = {"action": "session", "session_ref": session, "mode": "queue",
                "message": PROMPT, "request_key": "second-input"}
    _, second_task, second = mutation("deliver", delivery)
    ids = record["receipt_ids"]
    ids.append(second)
    record["task_ids"].append(second_task)
    expected = check_sends(fixture, ids, setup["seedIds"])
    exact(projected(read(session)), expected, "owner continuation readback")
    exact_seeds(read, seeds)
    rpc.close()
    record["phase"] = "owner restart and replay"
    rpc = start()
    exact(projected(read(session)), expected, "owner reopened history")
    exact_seeds(read, seeds)
    _, replay_task, replay_id = mutation("deliver", delivery)
    exact((replay_task, replay_id), (second_task, second), "same key replay after owner restart")
    conflict = rpc_tool(rpc, "deliver", {**delivery, "message": "changed fixture payload"})
    if conflict.get("taskId"):
        conflict = wait_task(rpc, conflict["taskId"])
    check("idempotency_conflict" in json.dumps(conflict), f"missing changed-payload conflict: {conflict}")
    check_sends(fixture, ids, setup["seedIds"])
    record["conflict"] = "idempotency_conflict"
    record["replay_task"] = replay_task
    record["timings"] = benchmark(lambda: read(session), inventory, expected, [*seeds, session], n)
    check_sends(fixture, ids, setup["seedIds"])
    record["phase"] = "owner wrong account"
    fixture.call("switchAccount")
    denied = rpc_tool(rpc, "session", {"action": "messages", "session_ref": session})
    check(denied.get("isError") and denied["structuredContent"]["code"] == "source_unavailable",
          f"owner read did not fail closed: {denied}")
    record["wrong_scope"] = {"messages": denied["structuredContent"]["code"]}
    check_sends(fixture, ids, setup["seedIds"])


def run_case(args, bins, harness, surface, output):
    case = output / f"{harness}-{surface}"
    case.mkdir(mode=0o700)
    record = {"harness": harness, "surface": surface, "phase": "fixture"}
    if args.lost_receipt:
        record["scenario"] = "lost-receipt"
    with tempfile.TemporaryDirectory(prefix="herder-browser-smoke-", dir=Path.home()) as temp, ExitStack() as stack:
        home = Path(temp)
        env = private_env(home)
        if "PLAYWRIGHT_MODULE" in os.environ:
            env["PLAYWRIGHT_MODULE"] = os.environ["PLAYWRIGHT_MODULE"]
        fixture = JsonLines([shutil.which("node"), HERE / "browser_adapter_fixture.mjs", harness,
                             "9222", case], env, home)
        stack.callback(fixture.close)
        try:
            setup = fixture.call("setup")
            record.update(chrome=setup["version"], phase="seed inventory and exact reads")
            if surface == "ahap":
                ahap_case(bins["herder-browser"], home, fixture, setup, harness, args.iterations, record, stack)
            else:
                mcp_case(bins, home, fixture, setup, harness, args.iterations, record, stack, args.lost_receipt)
            snapshot = fixture.call("snapshot")
            exact(snapshot["unexpected"], [], "unexpected browser requests")
            exact(snapshot["pinnedRoute"], "/c/" + setup["seedIds"][1], "pinned tab moved off seed B")
            exact(len(snapshot["sends"]), 1 if args.lost_receipt else 2, "total browser submits")
            record.update(status="PASS", phase="complete", fixture=snapshot)
        except Exception as error:
            record.update(status="FAIL", error=str(error))
            if fixture.process.poll() is None:
                try:
                    record["fixture"] = fixture.call("snapshot")
                    record["screenshots"] = fixture.call("screenshots")
                except Exception as diagnostic:
                    record["diagnostic_error"] = str(diagnostic)
        finally:
            persist_evidence(case / "receipt.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--harness", choices=["chatgpt", "zai"])
    parser.add_argument("--surface", choices=["ahap", "mcp"])
    parser.add_argument("--lost-receipt", action="store_true",
                        help="run the owner MCP accepted-submit/UNKNOWN replay case")
    parser.add_argument("--iterations", default=20, type=int)
    parser.add_argument("--output", type=Path, help="fresh receipt directory")
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("--iterations must be positive")
    if args.lost_receipt:
        if args.surface == "ahap":
            parser.error("--lost-receipt uses the owner MCP surface")
        args.surface = "mcp"
    names = ["herder-browser", "herder_native_stdio", "ahap-owner-bootstrap"]
    bins = {name: (args.bin_dir / name).resolve(strict=True) for name in names}
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="herder-browser-evidence-"))
    if args.output:
        output.mkdir(mode=0o700, parents=True)
    summary = {"clock": time.get_clock_info("perf_counter").implementation,
               "percentile": "nearest rank", "artifact_sha256": {k: sha256_file(v) for k, v in bins.items()},
               "cases": []}
    for harness in ([args.harness] if args.harness else ["chatgpt", "zai"]):
        for surface in ([args.surface] if args.surface else ["ahap", "mcp"]):
            record = run_case(args, bins, harness, surface, output)
            result = {k: record[k] for k in ("harness", "surface", "scenario", "status", "phase", "error") if k in record}
            result["sends"] = len(record.get("fixture", {}).get("sends", []))
            result["receipt"] = str(output / f"{harness}-{surface}" / "receipt.json")
            if "timings" in record:
                result["timings"] = {op: {k: v for k, v in t.items() if k != "samples_ns"}
                                     for op, t in record["timings"].items()}
            summary["cases"].append(result)
            persist_evidence(output / "summary.json", summary)
            print(json.dumps(result), flush=True)
    return 0 if all(r["status"] == "PASS" for r in summary["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
