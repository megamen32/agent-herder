#!/usr/bin/env python3
"""Bidirectional ordinary MCP delivery between two isolated Linux UTS nodes.

Run inside a disposable filesystem and network namespace, with the built Herder
JS tree and a fresh output directory. The only simulated services are the Fleet
relay, the browser website and the model. The relay forwards real MCP calls.
"""
import argparse
from contextlib import ExitStack
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import uuid

import browser_adapter_smoke as browser
from ahap_opencode_stand import (
    RpcProcess, parse_fresh_seed, persist_evidence, rpc_tool, sha256_file,
    wait_opencode, write_opencode_fixture,
)
from codex_recovery_stand import http_fixture, model_fixture, wait_for
from opencode_mcp_create_stand import stop
from opencode_recovery_stand import call, messages
from v1_codex_stand import receipt_reference


HERE = Path(__file__).resolve().parent
CHAT = "pair-chatgpt"
OPEN = "pair-opencode"
FLEET = {f"mcp:shell:{host}:HerderFleet": host for host in (CHAT, OPEN)}
NATIVE = f"mcp:shell:{CHAT}:AgentHerder"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class Peer(RpcProcess):
    def __init__(self, argv, env, cwd):
        self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.next_id, self.buffer = 0, ""

    def tool(self, name, **args):
        return self.request("tools/call", {"name": name, "arguments": args}, timeout=45)


def node_namespace(stack, host):
    keeper = subprocess.Popen([
        "unshare", "--uts", sys.executable, "-c",
        "import signal,socket,sys; socket.sethostname(sys.argv[1]); "
        "print(socket.gethostname(),flush=True); signal.pause()", host,
    ], stdout=subprocess.PIPE, text=True)
    stack.callback(stop, keeper)
    check(keeper.stdout.readline().strip() == host, "could not isolate node hostname")
    return ["nsenter", "--target", str(keeper.pid), "--uts", "--"]


def stdio_node(stack, argv, env, home):
    peer = Peer(argv, env, home)
    stack.callback(peer.close)
    opened = peer.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                          "clientInfo": {"name": "isolated-pair", "version": "1"}})
    check(opened["protocolVersion"] == "2025-11-25", "public MCP handshake failed")
    peer.process.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    peer.process.stdin.flush()
    return peer


def relay(stack, nodes, rust, trace):
    """Only discover/schema and exact mcp.call DTOs, never evaluate submitted JS."""
    def dispatch(operation, args):
        if operation == "discover":
            return {"servers": [{"server_id": target, "kind": "child_mcp", "status": "online"}
                                for target, host in FLEET.items() if nodes[host].process.poll() is None]}
        if operation == "schema":
            page = nodes[FLEET[args["target"]]].request("tools/list", {})
            return {"tools": [{"name": row["name"]} for row in page["tools"]]}
        check(operation == "exec", "unexpected relay tool")
        match = re.fullmatch(r"return await mcp\.call\((.*)\);", args["code"], re.S)
        check(match, "unexpected relay expression")
        target, name, arguments = json.loads("[" + match[1] + "]")
        trace.append({"target": target, "tool": name, "action": arguments.get("action"),
                      "input_id": arguments.get("inputId", arguments.get("request_key"))})
        if target == NATIVE:
            check(name in ("session", "deliver"), "unexpected Rust owner tool")
            return rpc_tool(rust, name, arguments, tasks=False)
        check(name in ("fleet_node_info", "agent_info", "deliver"), "unexpected fleet tool")
        return nodes[FLEET[target]].tool(name, **arguments)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            frame = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if frame["method"] == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            reply = {"jsonrpc": "2.0", "id": frame["id"]}
            try:
                if frame["method"] == "initialize":
                    reply["result"] = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                                       "serverInfo": {"name": "pair-fixture-hub", "version": "1"}}
                else:
                    check(frame["method"] == "tools/call", "unexpected relay method")
                    params = frame["params"]
                    reply["result"] = dispatch(params["name"], params["arguments"])
            except Exception as error:
                trace.append({"relay_error": str(error)[:300]})
                reply["error"] = {"code": -32603, "message": "fixture relay refused call"}
            body = json.dumps(reply).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), Handler))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    stack.callback(thread.join)
    stack.callback(server.shutdown)
    return f"http://127.0.0.1:{server.server_port}/mcp"


def fake_model(stack, opening, closing_text, seen):
    module = model_fixture()
    lock = threading.Lock()

    class Handler(module.Handler):
        def chat(self, request, sequence):
            text = json.dumps(request.get("messages", []), ensure_ascii=False)
            returned = closing_text if "Fixture received " + opening in text else opening
            with lock:
                module.ANSWER = returned
                seen.append({"sequence": sequence, "model": request.get("model"),
                             "request_sha256": hashlib.sha256(text.encode()).hexdigest(),
                             "contains_browser_reply": "Fixture received " + opening in text,
                             "reply": returned})
                return super().chat(request, sequence)

    return stack.enter_context(http_fixture(Handler))


def assistant_text(row):
    return "".join(part.get("text", "") for part in row.get("content", []) if part.get("type") == "text")


def answer_rows(rows, expected):
    return [row for row in rows if row.get("type") == "assistant"
            and row.get("finish") == "stop" and not row.get("error")
            and assistant_text(row) == expected]


class Pair:
    def __init__(self, args, stack):
        self.args, self.stack = args, stack
        self.root = args.output
        self.root.mkdir(mode=0o700)
        self.nodes, self.model_requests, self.trace = {}, [], []
        self.run_id = uuid.uuid4().hex
        self.opening = "OpenCode opening " + self.run_id
        self.closing = "OpenCode received the browser reply " + self.run_id
        self.record = {"status": "IN_PROGRESS", "run_id": self.run_id, "directions": {},
                       "model_requests": self.model_requests, "relay_calls": self.trace}
        self.chrome = None

    def save(self):
        pending = self.root / "receipt.pending"
        persist_evidence(pending, self.record)
        pending.replace(self.root / "receipt.json")

    def rust_client(self):
        client = Peer(self.ns[CHAT] + [self.args.core, "--trusted-owner-profile", self.profile],
                      self.env[CHAT], self.homes[CHAT])
        self.stack.callback(client.close)
        client.preflight()
        return client

    def prepare(self):
        args, stack = self.args, self.stack
        check({name for _, name in socket.if_nameindex()} == {"lo"}, "private loopback required")
        self.ns = {host: node_namespace(stack, host) for host in (CHAT, OPEN)}
        self.homes = {host: args.scratch / host for host in self.ns}
        self.env = {}
        for host, home in self.homes.items():
            home.mkdir(mode=0o700)
            (home / "tmp").mkdir(mode=0o700)
            self.env[host] = dict(browser.private_env(home), TMPDIR=str(home / "tmp"),
                                  AGENT_HERDER_FLEET_PEERS="[]")
        self.env[CHAT]["PLAYWRIGHT_MODULE"] = str(args.playwright)
        self.env[OPEN].update(OPENCODE_SERVER_PASSWORD="fixture-only", OPENCODE_DISABLE_AUTOUPDATE="1",
                              OPENCODE_DISABLE_MODELS_FETCH="1")
        self.chrome = browser.JsonLines(self.ns[CHAT] + [args.node, HERE / "browser_adapter_fixture.mjs",
                                         "chatgpt", "9222", self.root, "--echo"],
                                        self.env[CHAT], self.homes[CHAT])
        stack.callback(self.chrome.close)
        setup = self.chrome.call("setup")
        protected = self.homes[CHAT] / "herder-owner-home"
        protected.mkdir(mode=0o700)
        seed = parse_fresh_seed(subprocess.check_output([args.bootstrap, protected],
                                env=self.env[CHAT], text=True, timeout=20), protected)
        profile = {k: seed[k] for k in ("database", "gate", "generation")}
        profile["owner"] = {"kind": "chatgpt", "node": CHAT, "instance": "fixture-chrome",
                            "principal": "chatgpt-pair-owner", "executable": str(args.core),
                            "cwd": str(protected), "code_home": str(protected), "ahap_env": setup["env"]}
        self.profile = Path(seed["profile_seed"]).with_name("profile.json")
        persist_evidence(self.profile, profile)
        self.rust = self.rust_client()
        chat_id = browser.native_ids("chatgpt", setup["seedIds"])[0]
        binding = browser.mcp_content(rpc_tool(self.rust, "session", {"action": "register",
                  "instance_ref": "fixture-chrome", "native_session_id": chat_id,
                  "request_key": "register-" + self.run_id}, tasks=False))
        self.ref = binding["session_ref"]
        self.baseline_chat = self.chat_history(self.rust)
        check(not self.chrome.call("snapshot")["sends"], "browser fixture has previous submissions")

        model_url = fake_model(stack, self.opening, self.closing, self.model_requests)
        project = self.homes[OPEN] / "project"
        project.mkdir(mode=0o700)
        write_opencode_fixture(project, model_url)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.endpoint = f"http://127.0.0.1:{port}"
        log = stack.enter_context((self.root / "opencode.log").open("ab"))
        server = subprocess.Popen(self.ns[OPEN] + [args.opencode, "serve", "--hostname", "127.0.0.1",
                                  "--port", str(port)], cwd=project, env=self.env[OPEN], stdout=log, stderr=log)
        stack.callback(stop, server)
        wait_opencode(self.endpoint, server)
        check("herder-test" in json.dumps(call(self.endpoint, "/api/model")), "missing fixture model")
        session = call(self.endpoint, "/api/session", {"title": "Mesh pair " + self.run_id,
                       "location": {"directory": str(project)}, "model": {"providerID": "fixture", "id": "herder-test"}})
        self.open_id = session["id"]
        self.address = {CHAT: {"hostId": CHAT, "harness": "chatgpt", "nativeSessionId": chat_id},
                        OPEN: {"hostId": OPEN, "harness": "opencode", "nativeSessionId": self.open_id}}
        relay_url = relay(stack, self.nodes, self.rust, self.trace)
        for host in self.ns:
            self.nodes[host] = stdio_node(stack, self.ns[host] + [args.node, "--experimental-transform-types",
                                          HERE / "chatgpt_opencode_mesh_node.mjs", CHAT, OPEN, relay_url, self.endpoint],
                                          self.env[host], self.homes[host])
        owners = {}
        for host, node in self.nodes.items():
            info = browser.mcp_content(node.tool("fleet_node_info"))
            check(info["hostId"] == host, "wrong UTS owner")
            owners[host] = {"reported_host": info["hostId"], "public_mcp_pid": node.process.pid,
                            "uts_namespace": os.readlink(f"/proc/{node.process.pid}/ns/uts"),
                            "home": str(self.homes[host])}
        check(owners[CHAT]["uts_namespace"] != owners[OPEN]["uts_namespace"], "shared owner UTS namespace")
        self.record.update(owners=owners, addresses=self.address, network=os.readlink("/proc/self/ns/net"),
                           network_interfaces=[name for _, name in socket.if_nameindex()],
                           chrome=setup["version"], rust_pid=self.rust.process.pid, opencode_pid=server.pid,
                           opencode_version=subprocess.check_output([args.opencode, "--version"], env=self.env[OPEN],
                                                                    cwd=project, text=True).strip(),
                           model_endpoint=model_url, native_opencode_endpoint=self.endpoint, relay=relay_url,
                           rust_sha256=sha256_file(args.core), opencode_sha256=sha256_file(args.opencode),
                           scope="two local UTS nodes; loopback fixture Fleet relay, HTTPS site and model",
                           route="source public deliver -> FleetDirectTransport -> FleetGptAdminTransport -> "
                                 "recipient public deliver -> registered local owner")
        self.save()

    def chat_history(self, reader):
        return browser.mcp_content(rpc_tool(reader, "session", {"action": "messages",
                                   "session_ref": self.ref}, tasks=False))["page"]["messages"]

    def deliver(self, source, target, message, source_message_id, attachments=None):
        packet = {"sender": self.address[source], "target": self.address[target],
                  "inputId": uuid.uuid4().hex, "message": message}
        if attachments:
            packet["attachments"] = attachments
        directions = self.record["directions"]
        check(target not in directions, "attempt already recorded for this direction")
        row = {"envelope": packet, "source_assistant_message_id": source_message_id}
        directions[target] = row
        self.save()
        response = self.nodes[source].tool("deliver", **packet)
        row["receipt"] = response.get("structuredContent", response)
        self.save()
        receipt = browser.mcp_content(response)
        check(receipt["inputId"] == packet["inputId"] and receipt["state"] in ("queued", "admitted"),
              f"ordinary delivery returned {receipt}")
        return row

    def seed(self):
        check("opening_turn" not in self.record, "opening turn already attempted")
        prompt = "Start pair " + self.run_id
        self.record["opening_turn"] = {"prompt": prompt}
        self.save()
        raw = call(self.endpoint, f"/api/session/{self.open_id}/prompt", {"text": prompt, "delivery": "queue"})
        check(raw["sessionID"] == self.open_id, "opening prompt received by wrong session")
        rows = wait_for("opening model reply", lambda: answer_rows(messages(self.endpoint, self.open_id), self.opening))
        answer, = rows
        self.record["opening_turn"].update(input_id=raw["id"], assistant_id=answer["id"],
                                           assistant_text=self.opening)
        self.save()
        return answer

    def verify_chat(self, row):
        packet = row["envelope"]
        snapshot = self.chrome.call("snapshot")
        self.record["browser_observation"] = {k: snapshot[k] for k in ("sends", "submitClicks", "unexpected", "pinnedRoute")}
        self.save()
        send, = snapshot["sends"]
        check(snapshot["submitClicks"] == 1 and not snapshot["unexpected"], "browser submit/origin count")
        check(send["addressed"] == send["id"] == packet["target"]["nativeSessionId"].removeprefix("chatgpt::"),
              "wrong browser conversation")
        native_input, native_reply = send["rows"]
        check(native_input["text"] == packet["message"] and native_reply["text"] == "Fixture received " + packet["message"],
              "wrong browser input or reply")
        fresh = self.rust_client()
        proof = browser.mcp_content(rpc_tool(fresh, "deliver", {"action": "receipt",
                  "session_ref": self.ref, "request_key": packet["inputId"]}, tasks=False))
        history = self.chat_history(fresh)
        check(proof["state"] == "confirmed" and proof["native_receipt"]["sender"] == packet["sender"]
              and proof["target"]["native_session_id"] == packet["target"]["nativeSessionId"]
              and proof["native_receipt"]["native_id"] == row["receipt"]["nativeReceiptId"]
              and receipt_reference(row["receipt"]["nativeReceiptId"]) == ("message", native_input["id"]),
              "browser owner receipt mismatch")
        check(browser.projected(history) == browser.projected(self.baseline_chat) +
              [(r["id"], r["role"], r["text"]) for r in send["rows"]], "independent Rust reader mismatch")
        browser.check_recorded_files(native_input["files"], packet["attachments"], "mesh upload")

        def download(session, mid, aid):
            return browser.mcp_content(rpc_tool(fresh, "session", {
                "action": "attachment", "session_ref": session, "message_id": mid, "attachment_id": aid,
            }, tasks=False))

        user, assistant = history[-2:]
        row["surface"] = "owner_mcp"
        browser.check_message_originals(self.ref, user, packet["attachments"], download, row, "mesh_readback")
        row.update(independent_reader_pid=fresh.process.pid, owner_receipt=proof,
                   native_input_id=native_input["id"], assistant={"id": assistant["id"], "text": assistant["text"]},
                   matching_inputs=1, matching_replies=1)
        self.save()
        return assistant

    def verify_open(self, row):
        packet, receipt = row["envelope"], row["receipt"]
        rows = wait_for("native OpenCode model reply", lambda: self.completed_open_rows(), seconds=45)
        persist_evidence(self.root / "opencode-native-messages.json", rows)
        native_input, = [m for m in rows if m["type"] == "synthetic"]
        assistant, = answer_rows(rows, self.closing)
        opening = self.record["opening_turn"]
        check([m["id"] for m in rows if m["type"] == "user"] == [opening["input_id"]] and
              [m["id"] for m in rows if m["type"] == "assistant"] == [opening["assistant_id"], assistant["id"]],
              "extra or missing OpenCode turn")
        sender = packet["sender"]
        expected = f"🤖 {sender['harness']}@{sender['hostId']} {sender['nativeSessionId']}\n\n{packet['message']}"
        check(native_input["metadata"]["agentHerderInputId"] == packet["inputId"]
              and native_input["text"] == expected and rows.index(assistant) > rows.index(native_input),
              "OpenCode native source, key, content or ordering mismatch")
        model = assistant["model"]
        check((model.get("providerID"), model.get("id")) == ("fixture", "herder-test")
              and any(r["contains_browser_reply"] and r["reply"] == self.closing for r in self.model_requests),
              "fake provider/model observation missing")
        if receipt["state"] == "queued":
            def terminal_job():
                job = browser.mcp_content(self.nodes[OPEN].tool("job", action="get", jobId=receipt["jobId"]))["job"]
                return job if job and job["state"] == "completed" else None
            job = wait_for("durable queue completion", terminal_job)
            result = job["result"]
            check(result["ok"] and result["inputId"] == packet["inputId"] and
                  result["nativeInputMessageId"] == native_input["id"], "OpenCode job/native ID mismatch")
            row["completed_job"] = {"id": job["id"], "state": job["state"], "result": result}
        row.update(native_input_id=native_input["id"], assistant={"id": assistant["id"], "text": self.closing},
                   matching_inputs=1, matching_replies=1, independent_read="OpenCode native GET /api/session/{id}/message")
        self.save()

    def completed_open_rows(self):
        rows = messages(self.endpoint, self.open_id)
        if rows and rows[-1]["type"] == "idle" and rows[-1].get("outcome") == "succeeded":
            return rows if answer_rows(rows, self.closing) else None
        return None

    def exchange(self):
        seed = self.seed()
        chat = self.deliver(OPEN, CHAT, assistant_text(seed), seed["id"], attachments=browser.input_files(0))
        answer = self.verify_chat(chat)
        opencode = self.deliver(CHAT, OPEN, answer["text"], answer["id"])
        self.verify_open(opencode)
        chat_input = chat["envelope"]["inputId"]
        writes = [(call["target"], call["input_id"]) for call in self.trace
                  if call.get("tool") == "deliver" and call.get("action") is None]
        check(writes == [(f"mcp:shell:{CHAT}:HerderFleet", chat_input), (NATIVE, chat_input),
                         (f"mcp:shell:{OPEN}:HerderFleet", opencode["envelope"]["inputId"])],
              "unexpected relay writes or delivery keys")

    def failed(self, error):
        self.record.update(status="FAIL", error=f"{type(error).__name__}: {error}")
        self.save()
        if self.chrome and self.chrome.process.poll() is None:
            self.record["screenshots"] = self.chrome.call("screenshots")
            self.save()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("output", "scratch", "node", "opencode", "core", "bootstrap", "playwright"):
        parser.add_argument("--" + name, type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    os.umask(0o077)
    with ExitStack() as resources:
        pair = Pair(arguments(), resources)
        try:
            pair.prepare()
            pair.exchange()
            resources.close()
        except Exception as error:
            pair.failed(error)
            raise
        pair.record["status"] = "PASS"
        pair.save()
