#!/usr/bin/env python3
"""Smoke the Rust browser AHAP binary and public owner MCP against disposable Chrome.

Build herder-browser, herder_native_stdio and ahap-owner-bootstrap into one Cargo
target directory. Run with --bin-dir TARGET/debug. Requires Node, OpenSSL, Google
Chrome and playwright-core (PLAYWRIGHT_MODULE can point to its absolute index.mjs).
"""
import argparse
import base64
from contextlib import ExitStack, closing
import hashlib
from itertools import product
import json
import math
import os
from pathlib import Path
import select
import shutil
import sqlite3
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
OTHER_PROMPT = "Other active fixture input"
FILE_CAPTIONS = {"chatgpt": "", "zai": "Verify the attached bytes."}
# ECMAScript trim also removes U+FEFF from a caption.
BLANK_CAPTIONS = (("empty", ""), ("whitespace", " \t\ufeff "))
# Valid 2x1 RGB PNGs. Both turns reuse the filenames and MIME types but have
# different originals. The raw document includes NUL and non-UTF-8 bytes.
PNG = [
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGN4rFIGRAALTAL7sy9ZawAAAABJRU5ErkJggg==",
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGNQmXgIiAAJDALvFenV6AAAAABJRU5ErkJggg==",
]


def input_files(turn):
    binary = bytes([0, turn, 0xff, 0x0d, 0x0a, 0x80, 0, 0x42])
    return [{"name": "inline.png", "mime_type": "image/png", "data_base64": PNG[turn]},
            {"name": "original.bin", "mime_type": "application/octet-stream",
             "data_base64": base64.b64encode(binary).decode("ascii")}]


def limit_file():
    size = 2 * 1024 * 1024
    raw = b"\x00" + hashlib.shake_256(b"herder-browser-fixture").digest(size - 2) + b"\xff"
    return {"name": "limit.bin", "mime_type": "application/octet-stream",
            "data_base64": base64.b64encode(raw).decode("ascii")}


def file_facts(file):
    raw = base64.b64decode(file["data_base64"], validate=True)
    return {"name": file["name"], "mime_type": file["mime_type"],
            "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def timed(record, label, call):
    start = time.perf_counter_ns()
    try:
        return call()
    finally:
        record.setdefault("operation_ns", {})[label] = time.perf_counter_ns() - start


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
    result = []
    for row in rows:
        text = row["text"]
        if any(p.get("type") == "image" for p in row.get("parts", [])):
            # ChatGPT can render an image pointer as a separate text line.
            text = "\n".join(line for line in text.split("\n") if line != "[Изображение]")
        result.append((row["id"], row["role"], text))
    return result


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


def check_sends(fixture, receipt_ids, seed_ids, media=False, followup_text=PROMPT):
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
        exact(user, (receipt_id, "user", followup_text if i == 1 else PROMPT),
              "provider submit versus native user receipt")
        if media:
            check_recorded_files(send["rows"][0]["files"], input_files(i), "submit originals")
        check(assistant[1] == "assistant" and assistant[0] != receipt_id, "missing separate assistant row")
        expected.extend([user, assistant])
    return expected


def check_recorded_files(observed, originals, label):
    expected = [file_facts(f) for f in originals]
    actual = [{k: f[k] for k in ("name", "mime_type", "size", "sha256")} for f in observed]
    exact(actual, expected, label)


def check_message_originals(session, message, originals, download, record, stage):
    mid = message["id"]
    parts = [p for p in message["parts"] if p["type"] in ("image", "file")]
    exact(len(parts), len(originals), f"file parts on {mid}")
    by_name = {p["name"]: p for p in parts}
    refs = {}
    reads = record.setdefault("attachment_reads", {}).setdefault(stage, [])
    for original in originals:
        facts = file_facts(original)
        name, mime = facts["name"], facts["mime_type"]
        part = by_name[name]
        aid = part["attachment_id"]
        check(isinstance(aid, str) and aid and "data_base64" not in part, "history needs a metadata reference")
        exact((part["type"], part["mime_type"]), ("image" if mime.startswith("image/") else "file", mime),
              "history file metadata")
        refs[name] = aid
        start = time.perf_counter_ns()
        body = download(session, mid, aid)
        duration = time.perf_counter_ns() - start
        fields = (("sessionId", "messageId", "attachmentId") if record["surface"] == "ahap"
                  else ("session_ref", "message_id", "attachment_id"))
        exact(tuple(body[k] for k in fields), (session, mid, aid), "download address")
        exact((body["name"], body["mime_type"]), (name, mime), "download metadata")
        raw = base64.b64decode(body["data_base64"], validate=True)
        check(raw == base64.b64decode(original["data_base64"], validate=True), f"wrong original bytes for {name}")
        reads.append({**facts, "message_id": mid, "attachment_id": aid,
                      "download_sha256": hashlib.sha256(raw).hexdigest(), "elapsed_ns": duration})
    exact(refs, record.setdefault("attachment_refs", {}).setdefault(mid, refs), "stable attachment references")
    return refs


def check_originals(fixture, setup, session, history, download, record, stage):
    snapshot = fixture.call("snapshot")
    sends = snapshot["sends"]
    check_recorded_files(snapshot["uploads"], input_files(0) + input_files(1), "browser File uploads")
    messages = {row["id"]: row for row in history}
    groups = [(sends[0]["rows"][0], input_files(0)), (sends[0]["rows"][1], setup["replyOriginals"]),
              (sends[1]["rows"][0], input_files(1))]
    refs = {row["id"]: check_message_originals(session, messages[row["id"]], originals, download, record, stage)
            for row, originals in groups}
    first, second = sends[0]["rows"][0]["id"], sends[1]["rows"][0]["id"]
    check(set(refs[first].values()).isdisjoint(refs[second].values()), "distinct originals share attachment IDs")
    return refs


def check_limit_original(fixture, session, mid, file, read, download, record, stage):
    snapshot = fixture.call("snapshot")
    submitted = next(s["rows"][0] for s in snapshot["sends"] if s["rows"][0]["id"] == mid)
    caption = FILE_CAPTIONS[record["harness"]]
    exact(submitted["text"], caption, "2 MiB native input caption")
    check_recorded_files(submitted["files"], [file], "2 MiB submit originals")
    check_recorded_files(snapshot["uploads"], input_files(0) + input_files(1) + [file], "all picker uploads")
    message = next(row for row in read(session) if row["id"] == mid)
    exact((message["role"], message["text"]), ("user", caption), "2 MiB input caption in history")
    record["limit_file"] = {"message_id": mid, "caption": message["text"], **submitted["files"][0]}
    check_message_originals(session, message, [file], download, record, "limit_file_" + stage)


def caption_effects(fixture, inventory):
    sessions = sorted(inventory())
    snap = fixture.call("snapshot")
    return {"sessions": sessions, "provider_chats": sorted(snap["chatIds"]), "documents": snap["documents"],
            "uploads": len(snap["uploads"]), "downloads": len(snap["downloads"]), "submit_clicks": snap["submitClicks"],
            "submit_requests": snap["requests"].get("submit", 0), "sends": len(snap["sends"]), "stops": len(snap["stops"])}


def check_denied_download(fixture, refuse, session, mid, aid, record, label):
    def effects():
        snapshot = fixture.call("snapshot")
        return (snapshot["downloads"], snapshot["requests"].get("downloadLink", 0))
    before = effects()
    error = refuse(session, mid, aid)
    check(error and "data_base64" not in json.dumps(error), f"{label} returned original bytes")
    exact(effects(), before, f"{label} accessed the original")
    record.setdefault("denied_attachments", {})[label] = error


def active_pair(fixture, seed, addressed, other, total=3, other_prompt=OTHER_PROMPT):
    snap = fixture.call("snapshot")
    exact(len(snap["sends"]), total, "submits across both chats")
    route = snap["sends"][0]["id"]
    foreign = snap["sends"][-1]
    exact((foreign["id"], foreign["addressed"]), (seed, seed), "other submit route")
    exact(projected(foreign["rows"])[0], (other, "user", other_prompt), "other active receipt")
    exact(snap["active"], {route: addressed, seed: other}, "two simultaneous native inputs")
    exact(snap["stops"], [], "stop controls before scoped stop")
    return route


def checked_stop(fixture, route, mid, other_route, other_mid, call, record):
    result = timed(record, "scoped_stop", call)
    deadline = time.monotonic() + 3
    while True:
        snap = fixture.call("snapshot")
        if snap["stops"] or time.monotonic() >= deadline:
            break
        time.sleep(.025)
    exact(snap["stops"], [{"id": route, "inputMessageId": mid, "accepted": True}], "native stop clicks")
    exact(snap["active"], {other_route: other_mid}, "independent chat still generating")
    record["stop"] = {"before": {route: mid, other_route: other_mid}, "result": result, "after": snap["active"],
                      "clicks": snap["stops"]}
    return result


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


def ahap_case(binary, home, fixture, setup, harness, n, record, stack, media):
    def start():
        rpc = JsonLines([binary, "--harness", harness, "--node", NODE, "--instance", INSTANCE],
                        {**private_env(home), **setup["env"]}, home)
        stack.callback(rpc.close)
        hello = rpc.call("initialize", {"harness": harness, "ahapVersion": "0.1"})
        exact(hello["harness"], harness, "initialize harness")
        check(METHODS <= set(hello["capabilities"]["methods"]), "missing AHAP operations")
        if media:
            check({"cancelTurn", "getMessageAttachment"} <= set(hello["capabilities"]["methods"])
                  and hello["capabilities"]["controlCapabilities"]["cancelTurn"] is True,
                  "missing scoped stop or attachment capability")
            exact(hello["capabilities"]["browserFeatures"]["attachmentCaptionRequired"], harness == "zai",
                  "provider caption capability")
        rpc.call("init")
        record.setdefault("pids", []).append(rpc.process.pid)
        return rpc

    def read(key):
        return rpc.call("getSessionMessages", {"id": key, "limit": 20})

    def inventory():
        return inventory_ids(rpc.call("listSessions", {"options": {"limit": 20}}))

    def send(session, key, text, files=None):
        options = {"queue": True, "activeTurnOnly": False, "message": text, "inputId": key}
        if files is not None:
            options["attachments"] = files
        return rpc.call("sendMessage", {"id": session, "options": options})

    def download(session, mid, aid):
        return rpc.call("getMessageAttachment", {"id": session, "messageId": mid, "attachmentId": aid})

    def refuse(session, mid, aid):
        return rpc.frame("getMessageAttachment", {"id": session, "messageId": mid, "attachmentId": aid}).get("error")

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
    if media and harness == "zai":
        record["phase"] = "AHAP blank-caption rejection"
        before = caption_effects(fixture, inventory)
        proof = record["blank_caption_rejections"] = {"before": before, "results": {}}
        # Exercise a first send to the local draft and a continuation on the pinned chat.
        for session, (label, blank) in zip((draft, seeds[1]), BLANK_CAPTIONS, strict=True):
            params = {"id": session, "options": {"inputId": "blank-" + label, "message": blank,
                      "queue": True, "attachments": [input_files(0)[1]]}}
            frame = rpc.frame("sendMessage", params)
            check("result" not in frame, "blank-caption AHAP send returned a result")
            exact(frame.get("error", {}).get("code"), -32602, "blank-caption AHAP error")
            proof["results"][label] = frame["error"]
            proof["after"] = caption_effects(fixture, inventory)
            exact(proof["after"], before, "blank-caption AHAP side effects")
    ids = record["receipt_ids"] = []
    caption = FILE_CAPTIONS[harness]
    followup_text = caption if media else PROMPT
    for i in range(2):
        record["phase"] = f"send {i + 1}"
        key = f"distinct-input-{i}"
        if media and i == 1:
            fixture.call("holdNext")
        text = followup_text if i == 1 else PROMPT
        receipt = timed(record, f"send_{i+1}", lambda: send(draft, key, text, input_files(i) if media else None))
        exact(receipt["inputId"], key, "AHAP input correlation")
        exact(receipt["sessionId"], draft, "AHAP session correlation")
        check(receipt.get("ok") is True and receipt.get("admission") == "accepted" and receipt.get("admitted") is True,
              f"unconfirmed send: {receipt}")
        ids.append(receipt["nativeInputMessageId"])
        expected = check_sends(fixture, ids, setup["seedIds"], media, followup_text)
        exact(projected(read(draft)), expected, "post-send history")
        exact_seeds(read, seeds)
    if media:
        check_originals(fixture, setup, draft, read(draft), download, record, "before_restart")
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
    check_sends(fixture, ids, setup["seedIds"], media, followup_text)
    if media:
        refs = check_originals(fixture, setup, draft, read(draft), download, record, "after_restart")
        aid = refs[ids[0]]["original.bin"]
        check_denied_download(fixture, refuse, draft, ids[1], aid, record, "cross_message")
        record["phase"] = "AHAP 2 MiB delivery and readback"
        fixture.call("holdNext")
        file = limit_file()
        receipt = timed(record, "limit_file_delivery", lambda: send(seeds[1], "other-input", caption, [file]))
        other = receipt["nativeInputMessageId"]
        check_limit_original(fixture, seeds[1], other, file, read, download, record, "before_restart")
        rpc.call("shutdown")
        rpc.close()
        rpc = start()
        check_limit_original(fixture, seeds[1], other, file, read, download, record, "after_restart")
        record["phase"] = "scoped AHAP cancel with two active chats"
        route = active_pair(fixture, setup["seedIds"][1], ids[1], other, other_prompt=caption)
        for mid in (ids[0], other):
            frame = rpc.frame("cancelTurn", {"id": draft, "inputMessageId": mid})
            check(frame.get("error") or frame["result"].get("cancelled") is False, "cancel accepted wrong input")
        active_pair(fixture, setup["seedIds"][1], ids[1], other, other_prompt=caption)
        ack = checked_stop(fixture, route, ids[1], setup["seedIds"][1], other,
                           lambda: rpc.call("cancelTurn", {"id": draft, "inputMessageId": ids[1]}), record)
        exact((ack["sessionId"], ack["inputMessageId"], ack["cancelled"]), (draft, ids[1], True), "AHAP cancel")
    record["phase"] = "wrong account"
    before = fixture.call("snapshot")
    fixture.call("switchAccount")
    refusals = {}
    for method, params in [("getSessionMessages", {"id": draft, "limit": 20}), ("listSessions", {})]:
        error = rpc.frame(method, params).get("error")
        check(error and error["code"] == -32000 and "identity" in error["message"],
              f"{method} did not reject the account mismatch: {error}")
        refusals[method] = error
    result = send(draft, "wrong-account", PROMPT, input_files(0) if media else None)
    exact(result.get("admission"), "not_submitted", "wrong-account send")
    if media:
        check_denied_download(fixture, refuse, draft, ids[0], aid, record, "account_switch")
        error = rpc.frame("cancelTurn", {"id": seeds[1], "inputMessageId": other}).get("error")
        check(error and "identity" in error["message"], "wrong-account cancel must reject the input")
        refusals["cancelTurn"] = error
    after = fixture.call("snapshot")
    for key in ("sends", "uploads", "active", "stops"):
        exact(after[key], before[key], "wrong-account " + key)
    record["wrong_scope"] = {**refusals, "sendMessage": result["admission"]}
    rpc.call("shutdown")


def mcp_content(reply):
    if reply.get("isError"):
        raise AssertionError(f"MCP tool error: {reply.get('structuredContent', {}).get('code')}")
    return reply["structuredContent"]


def owner_task(rpc, name, args):
    reply = rpc_tool(rpc, name, args)
    task_id = reply.get("taskId")
    check(task_id, f"{name} missing task: {reply}")
    task = wait_task(rpc, task_id)
    exact(task.get("taskId"), task_id, f"{name} task correlation")
    return task, task_id


def conflict(rpc, name, args):
    reply = rpc_tool(rpc, name, args)
    if reply.get("taskId"):
        reply = wait_task(rpc, reply["taskId"])["result"]
    check(reply.get("isError") and reply["structuredContent"].get("code") == "idempotency_conflict",
          f"missing changed-payload conflict on {name}: {reply}")


def changed_file(args):
    files = [dict(f) for f in args["attachments"]]
    raw = bytearray(base64.b64decode(files[-1]["data_base64"], validate=True))
    raw[-1] ^= 1  # Same length, filename, MIME, text, ordering and key.
    files[-1]["data_base64"] = base64.b64encode(raw).decode("ascii")
    return {**args, "attachments": files}


def check_zai_mcp_blank_captions(rpc, fixture, inventory, session, database, record):
    record["phase"] = "ordinary MCP blank-caption rejection"
    calls = (("create", "prompt", {"action": "create", "instance_ref": INSTANCE}),
             ("deliver", "message", {"action": "session", "session_ref": session, "mode": "queue"}))
    uri = Path(database).as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        def effects():
            return {**caption_effects(fixture, inventory),
                    "stored_tasks": db.execute("SELECT count(*) FROM tasks").fetchone()[0]}

        before = effects()
        proof = record["blank_caption_rejections"] = {"before": before, "results": {}}
        for name, field, base in calls:
            for label, blank in BLANK_CAPTIONS:
                key = f"blank-{name}-{label}"
                args = {**base, field: blank, "request_key": key, "attachments": [input_files(0)[1]]}
                reply = rpc_tool(rpc, name, args, tasks=False)
                check(reply.get("isError") is True and "taskId" not in reply,
                      f"{key} must return an ordinary error without a task")
                error = reply["structuredContent"]
                exact((error.get("code"), error.get("effect")), ("invalid_attachments", "none"), key)
                reason = error["received"].lower().replace("non-empty", "nonempty")
                check("nonempty" in reason and "text" in reason and "task_ref" not in error,
                      f"{key} missing the nonempty text diagnostic: {error}")
                proof["results"][key] = {"code": error["code"], "reason": error["received"]}
                proof["after"] = effects()
                exact(proof["after"], before, key + " side effects")


def lost_receipt_case(rpc, start, fixture, setup, name, args, record):
    record["phase"] = f"owner {name} with unreadable receipt"
    before = fixture.call("snapshot")
    fixture.call("withholdReceipt", {"enabled": True})
    task, task_id = timed(record, "unknown_" + name, lambda: owner_task(rpc, name, args))
    result = task["result"]
    payload = result["structuredContent"]
    exact((task["status"], result.get("isError")), ("completed", True), "unconfirmed owner task")
    if name == "create":
        exact(payload["create"]["effect"], "confirmed", "local draft creation")
        session = payload["create"]["session_ref"]
        prompt = payload["prompt"]
    else:
        session = args["session_ref"]
        prompt = payload
    check(session and not task_delivery_receipt(task), "unexpected confirmed delivery receipt")
    exact((prompt.get("code"), prompt.get("effect"), prompt.get("retry")),
          ("outcome_unknown", "unknown", "forbidden"), "owner submit outcome")

    snapshot = fixture.call("snapshot")
    accepted = snapshot["sends"]
    exact(accepted[:-1], before["sends"], "only one new submit before owner restart")
    send = accepted[-1]
    exact(send["addressed"], None if name == "create" else accepted[0]["id"], "unconfirmed submit route")
    check(send["id"] not in setup["seedIds"], "unconfirmed submit reached a seed")
    user, _ = projected(send["rows"])
    exact(user[1:], ("user", args.get("prompt", args.get("message"))), "fixture's accepted input")
    files = args.get("attachments", [])
    check_recorded_files(send["rows"][0]["files"], files, "originals on the unconfirmed submit")
    check_recorded_files(snapshot["uploads"][len(before["uploads"]):], files, "uploads before UNKNOWN")
    check(snapshot["requests"].get("withheldReceipt", 0) > 0, "adapter never read the withheld receipt")
    record.setdefault("task_ids", []).append(task_id)
    record.update(session=session, unknown=prompt, submit_counts={"before_restart": len(accepted)})

    record["phase"] = "owner restart and replay of unknown " + name
    rpc.close()
    fixture.call("withholdReceipt", {"enabled": False})
    rpc = start()
    restored = wait_task(rpc, task_id)
    if record["harness"] == "zai" and name == "create":
        recovered = task_delivery_receipt(restored)
        check(recovered and recovered.get("outcome") == "confirmed", "late first-send receipt")
        exact(receipt_reference(recovered["native_receipt_id"]), ("message", user[0]),
              "original task's exact native input")
        exact(wait_task(rpc, task_id)["result"], restored["result"], "stable terminal task read")
        record["receipt_ids"] = [user[0]]
    else:
        exact(restored["result"], result, "durable UNKNOWN result after restart")
    after_restart = fixture.call("snapshot")["sends"]
    exact(after_restart, accepted, "fixture ledger after restart")
    record["submit_counts"]["after_restart"] = len(after_restart)
    replay, replay_id = timed(record, "unknown_replay", lambda: owner_task(rpc, name, args))
    exact(replay_id, task_id, "same-key task after restart")
    exact(replay["result"], restored["result"], "durable result on same-key replay")
    if files:
        conflict(rpc, name, changed_file(args))
    final = fixture.call("snapshot")
    after_replay = final["sends"]
    exact(after_replay, accepted, "fixture ledger after same-key replay")
    exact(final["submitClicks"], snapshot["submitClicks"], "no second click")
    exact(final["uploads"], snapshot["uploads"], "no duplicate uploads after UNKNOWN or conflict")
    record["submit_counts"]["after_replay"] = len(after_replay)
    record["replay_task"] = replay_id


def mcp_case(bins, home, fixture, setup, harness, n, record, stack, lost_receipt, media):
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
        check({"session", "sessions", "create", "deliver", "stop"} <= set(rpc.preflight()), "owner tools missing")
        record.setdefault("pids", []).append(rpc.process.pid)
        return rpc

    def tool(name, **args):
        return mcp_content(rpc_tool(rpc, name, args, tasks=False))

    def read(key):
        return tool("session", action="messages", session_ref=key)["page"]["messages"]

    def download(session, mid, aid):
        return tool("session", action="attachment", session_ref=session, message_id=mid, attachment_id=aid)

    def refuse(session, mid, aid):
        reply = rpc_tool(rpc, "session", {"action": "attachment", "session_ref": session,
                                         "message_id": mid, "attachment_id": aid}, tasks=False)
        check(reply.get("isError"), "owner returned success for out-of-scope attachment")
        return reply["structuredContent"]

    def inventory():
        listing = tool("sessions", action="list", instance_ref=INSTANCE)
        check(listing["native_coverage_complete"], "owner list omitted native session metadata")
        rows = listing["sessions"]
        return [r["session_ref"] for r in rows]

    def receipt_message(name, result):
        receipt = task_delivery_receipt({"result": result})
        check(receipt, f"{name} lacks a confirmed delivery receipt")
        kind_and_id = receipt_reference(receipt["native_receipt_id"])
        check(kind_and_id and kind_and_id[0] == "message", f"{name} lacks native message receipt")
        return kind_and_id[1]

    def mutation(name, args):
        task, task_id = owner_task(rpc, name, args)
        exact(task["status"], "completed", name + " task status")
        mcp_content(task["result"])
        return task, task_id, receipt_message(name, task["result"])

    def ordinary(name, args):
        reply = rpc_tool(rpc, name, args, tasks=False)
        check("taskId" not in reply, f"ordinary {name} returned a task handle")
        return mcp_content(reply), receipt_message(name, reply)

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
    if media and harness == "zai" and not lost_receipt:
        check_zai_mcp_blank_captions(rpc, fixture, inventory, seeds[1], seed["database"], record)
    caption = FILE_CAPTIONS[harness]
    followup_text = caption if media else PROMPT
    if media:
        create_args["attachments"] = input_files(0)
    if lost_receipt == "create":
        return lost_receipt_case(rpc, start, fixture, setup, "create", create_args, record)
    record["phase"] = "owner create"
    if media and not lost_receipt:
        payload, first = timed(record, "create", lambda: ordinary("create", create_args))
        task, first_task, replay_id = mutation("create", create_args)
        exact((task["result"]["structuredContent"], replay_id), (payload, first),
              "task-capable replay of ordinary create")
        record["ordinary_mcp"] = {"create": {"session_ref": payload["create"]["session_ref"], "native_message": first}}
    else:
        task, first_task, first = timed(record, "create", lambda: mutation("create", create_args))
    session = task["result"]["structuredContent"]["create"]["session_ref"]
    record.update(session=session, receipt_ids=[first], task_ids=[first_task])
    expected = check_sends(fixture, [first], setup["seedIds"], media, followup_text)
    exact(projected(read(session)), expected, "owner create readback")
    record["phase"] = "owner deliver"
    delivery = {"action": "session", "session_ref": session, "mode": "queue",
                "message": followup_text, "request_key": "second-input"}
    if media:
        delivery["attachments"] = input_files(1)
    if lost_receipt == "deliver":
        return lost_receipt_case(rpc, start, fixture, setup, "deliver", delivery, record)
    _, second_task, second = timed(record, "deliver", lambda: mutation("deliver", delivery))
    ids = record["receipt_ids"]
    ids.append(second)
    record["task_ids"].append(second_task)
    expected = check_sends(fixture, ids, setup["seedIds"], media, followup_text)
    exact(projected(read(session)), expected, "owner continuation readback")
    exact_seeds(read, seeds)
    if media:
        check_originals(fixture, setup, session, read(session), download, record, "before_restart")
    rpc.close()
    record["phase"] = "owner restart and replay"
    rpc = start()
    exact(projected(read(session)), expected, "owner reopened history")
    exact_seeds(read, seeds)
    _, replay_task, replay_id = mutation("deliver", delivery)
    exact((replay_task, replay_id), (second_task, second), "same key replay after owner restart")
    conflict(rpc, "deliver", {**delivery, "message": "changed fixture payload"})
    if media:
        payload, create_message = ordinary("create", create_args)
        exact((payload["create"]["session_ref"], create_message), (session, first), "ordinary same-key create")
        exact(payload, task["result"]["structuredContent"], "ordinary create replay receipt after restart")
        record["ordinary_mcp"]["create_replay"] = {"session_ref": session, "native_message": create_message}
        for name, args in (("create", create_args), ("deliver", delivery)):
            conflict(rpc, name, changed_file(args))
        record["changed_bytes_conflicts"] = ["create", "deliver"]
    check_sends(fixture, ids, setup["seedIds"], media, followup_text)
    record["conflict"] = "idempotency_conflict"
    record["replay_task"] = replay_task
    record["timings"] = benchmark(lambda: read(session), inventory, expected, [*seeds, session], n)
    check_sends(fixture, ids, setup["seedIds"], media, followup_text)
    if media:
        refs = check_originals(fixture, setup, session, read(session), download, record, "after_restart")
        aid = refs[first]["original.bin"]
        check_denied_download(fixture, refuse, session, second, aid, record, "cross_message")
        check_denied_download(fixture, refuse, seeds[1], first, aid, record, "cross_session")
        record["phase"] = "ordinary MCP 2 MiB delivery and readback"
        # A third delivery gives us two real public delivery keys in the same
        # chat. A fourth starts a different chat on the pinned tab.
        fixture.call("holdNext")
        file = limit_file()
        current_key = "active-limit-file"
        limit_delivery = {**delivery, "request_key": current_key, "message": caption, "attachments": [file]}
        payload, current = timed(record, "limit_file_delivery", lambda: ordinary("deliver", limit_delivery))
        exact(payload["outcome"], "confirmed", "ordinary 2 MiB delivery outcome")
        record["ordinary_mcp"]["limit_file_delivery"] = {
            "outcome": payload["outcome"], "native_receipt_id": payload["native_receipt_id"]}
        check_limit_original(fixture, session, current, file, read, download, record, "before_restart")
        rpc.close()
        rpc = start()
        check_limit_original(fixture, session, current, file, read, download, record, "after_restart")
        replay, current_task, replay_mid = mutation("deliver", limit_delivery)
        exact((replay["result"]["structuredContent"], replay_mid), (payload, current),
              "task-capable replay of ordinary 2 MiB delivery")
        record["ordinary_mcp"]["limit_file_replay_task"] = current_task
        record["phase"] = "owner stop with stale and active delivery keys"
        fixture.call("holdNext")
        _, other_task, other = mutation("deliver", {"action": "session", "session_ref": seeds[1], "mode": "queue",
                                                    "message": OTHER_PROMPT, "request_key": "other-active"})
        record["task_ids"].extend([current_task, other_task])
        seed = setup["seedIds"][1]
        route = active_pair(fixture, seed, current, other, total=4)
        stale = tool("stop", action="stop", session_ref=session, request_key=delivery["request_key"])
        check(stale["hold"] == "active" and stale["native_interrupt"] in ("not_sent", "required_or_reconcile"),
              f"stale delivery stop was acknowledged: {stale}")
        record["stale_stop"] = stale
        active_pair(fixture, seed, current, other, total=4)
        def stop():
            return tool("stop", action="stop", session_ref=session, request_key=current_key)
        ack = checked_stop(fixture, route, current, seed, other, stop, record)
        exact((ack["session_ref"], ack["hold"], ack["native_interrupt"]),
              (session, "active", "acknowledged"), "owner interrupt acknowledgement")
        exact(stop(), ack, "same-key stop replay")
        exact(fixture.call("snapshot")["stops"], record["stop"]["clicks"], "one click after stop replay")
    record["phase"] = "owner wrong account"
    before = fixture.call("snapshot")
    fixture.call("switchAccount")
    denied = rpc_tool(rpc, "session", {"action": "messages", "session_ref": session})
    check(denied.get("isError") and denied["structuredContent"]["code"] == "source_unavailable",
          f"owner read did not fail closed: {denied}")
    record["wrong_scope"] = {"messages": denied["structuredContent"]["code"]}
    if media:
        check_denied_download(fixture, refuse, session, first, aid, record, "account_switch")
        failed = tool("stop", action="stop", session_ref=seeds[1], request_key="other-active")
        check(failed["native_interrupt"] in ("not_sent", "required_or_reconcile"), "wrong-account stop acknowledged")
        record["wrong_scope"]["stop"] = failed["native_interrupt"]
    after = fixture.call("snapshot")
    for key in ("sends", "uploads", "active", "stops"):
        exact(after[key], before[key], "wrong-account " + key)


def run_case(args, bins, harness, surface, content, case):
    media = content == "attachments"
    case.mkdir(mode=0o700)
    record = {"harness": harness, "surface": surface, "content": content, "phase": "fixture"}
    if args.lost_receipt:
        record["scenario"] = "lost-receipt" if args.lost_receipt == "create" else "lost-delivery-receipt"
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
                ahap_case(bins["herder-browser"], home, fixture, setup, harness, args.iterations, record, stack, media)
            else:
                mcp_case(bins, home, fixture, setup, harness, args.iterations, record, stack, args.lost_receipt, media)
            snapshot = fixture.call("snapshot")
            exact(snapshot["unexpected"], [], "unexpected browser requests")
            exact(snapshot["pinnedRoute"], "/c/" + setup["seedIds"][1], "pinned tab moved off seed B")
            expected_sends = {"create": 1, "deliver": 2}.get(args.lost_receipt, 2)
            if media and not args.lost_receipt:
                expected_sends = 4 if surface == "mcp" else 3
            exact(len(snapshot["sends"]), expected_sends, "total browser submits")
            exact(snapshot["submitClicks"], expected_sends, "total browser send-button clicks")
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
    parser.add_argument("--content", choices=["text", "attachments"], help="default: run both in separate fixtures")
    parser.add_argument("--lost-receipt", nargs="?", const="create", choices=["create", "deliver"],
                        help="withhold the accepted submit's native receipt (default: create), then replay through MCP")
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
    cases = product([args.harness] if args.harness else ["chatgpt", "zai"],
                    [args.surface] if args.surface else ["ahap", "mcp"],
                    [args.content] if args.content else ["text", "attachments"])
    for harness, surface, content in cases:
        case = output / (f"{harness}-{surface}" + ("-attachments" if content == "attachments" else ""))
        record = run_case(args, bins, harness, surface, content, case)
        result = {k: record[k] for k in ("harness", "surface", "content", "scenario", "status", "phase", "error")
                  if k in record}
        result["sends"] = len(record.get("fixture", {}).get("sends", []))
        result["receipt"] = str(case / "receipt.json")
        if "timings" in record:
            result["timings"] = {op: {k: v for k, v in t.items() if k != "samples_ns"}
                                 for op, t in record["timings"].items()}
        summary["cases"].append(result)
        persist_evidence(output / "summary.json", summary)
        print(json.dumps(result), flush=True)
    return 0 if all(r["status"] == "PASS" for r in summary["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
