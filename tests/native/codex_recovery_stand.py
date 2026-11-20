#!/usr/bin/env python3
"""Prove real Codex crash and quota recovery with a disposable shared Unix socket.

Build herder_native_stdio from the worktree, then pass it as --owner and pass
the installed official Codex ELF as --codex. Linux Bubblewrap, user/network
namespaces and Python websocket-client are required. The failed thread must be
unloaded: Codex can ignore resume overrides when reattaching to a warm thread.
The profile and quota backups stay inside the sandbox.
"""

import argparse
from contextlib import ExitStack, closing, contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer


INSTANCE = "shared-codex-fixture"
SOURCE_PROVIDER = "fixture-source"
FALLBACK_PROVIDER = "fixture-omniroute"
FALLBACK_MODEL = "codex/gpt-5.6-luna"
ACCOUNT = "authorized-fixture-account"
OTHER_ACCOUNT = "other-fixture-account"
SOURCE_MODEL = "source-429-fixture"
CRASH_MODEL = "source-restart-fixture"
MCP_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "codex-recovery-fixture", "version": "1"},
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def namespace():
    info = os.stat("/proc/self/ns/net")
    return f"{info.st_dev}:{info.st_ino}"


def private_write(path, text):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
        out.write(text)


def digest(path):
    with path.open("rb") as stream:
        sha = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
        return sha.hexdigest()


def wait_for(description, check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise TimeoutError(description)


@contextmanager
def http_fixture(handler):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        server.scenario = "text"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/v1"
        finally:
            server.shutdown()
            thread.join()


def model_fixture():
    path = Path(__file__).with_name("test-model-server.py")
    spec = importlib.util.spec_from_file_location("fixture_model", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_providers(source_token, fallback_token, module):
    class Source(module.Handler):
        statuses = []
        crash_requests = 0
        crash_entered = threading.Event()
        crash_release = threading.Event()

        def send_responses(self, request, sequence):
            if (request.get("model") == CRASH_MODEL
                    and self.headers.get("Authorization") == f"Bearer {source_token}"):
                Source.crash_requests += 1
                if Source.crash_requests == 1:
                    Source.crash_entered.set()
                    Source.crash_release.wait(20)
                    return
                return super().send_responses(request, sequence)
            authorized = (request.get("model") == SOURCE_MODEL
                          and self.headers.get("Authorization") == f"Bearer {source_token}")
            status = 429 if authorized else 403
            self.statuses.append(status)
            error = {"error": {"type": "usage_limit_reached", "plan_type": "pro",
                               "message": "Isolated source quota exhausted"}}
            return self.reply(status, "application/json", json.dumps(error).encode())

    class Fallback(module.Handler):
        accepted = []

        def send_responses(self, request, sequence):
            if (request.get("model") != FALLBACK_MODEL
                    or self.headers.get("Authorization") != f"Bearer {fallback_token}"):
                return self.reply(403, "text/plain", b"fixture route rejected")
            self.accepted.append(request["model"])
            return super().send_responses(request, sequence)

    return Source, Fallback


def make_authority(root, migrations):
    gate, database = root / "gate", root / "herder.sqlite"
    gate.touch(mode=0o600, exist_ok=False)
    database.touch(mode=0o600, exist_ok=False)
    with closing(sqlite3.connect(database)) as conn:
        conn.create_function("herder_writer_version", 0, lambda: 3, deterministic=True)
        for sql in ["schema.sql", "migration_v1_v2.sql", "migration_v2_v3.sql"]:
            conn.executescript("BEGIN;\n" + (migrations / sql).read_text() + "\nCOMMIT;")
        g, d = gate.stat(), database.stat()
        conn.execute(
            "INSERT INTO humanstop_authority VALUES (1, ?, ?, ?, ?, ?, ?)",
            ("fixture", g.st_dev, g.st_ino, d.st_dev, d.st_ino, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    return gate, database


def quota_backup(destination, token, allowed_account):
    """Back up a synthetic OmniRoute schema with two independently cached accounts."""
    with closing(sqlite3.connect(":memory:")) as staging:
        staging.executescript("""
            CREATE TABLE api_keys (
                id TEXT PRIMARY KEY, key_hash TEXT, expires_at TEXT, revoked_at TEXT,
                is_active INTEGER DEFAULT 1, is_banned INTEGER DEFAULT 0,
                model_access_mode TEXT, allowed_connections TEXT, allowed_models TEXT,
                blocked_models TEXT, allowed_quotas TEXT, auto_resolve INTEGER DEFAULT 0,
                forced_model TEXT
            );
            CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER);
            CREATE TABLE key_value (
                namespace TEXT, key TEXT, value TEXT, PRIMARY KEY (namespace, key)
            );
            CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE model_combo_mappings (combo_id TEXT, pattern TEXT, enabled INTEGER);
            CREATE TABLE reasoning_routing_rules (
                scope TEXT, api_key_id TEXT, connection_id TEXT, model_pattern TEXT,
                target_kind TEXT, enabled INTEGER
            );
        """)
        staging.execute(
            """INSERT INTO api_keys
               (id, key_hash, model_access_mode, allowed_connections, allowed_models)
               VALUES ('fixture-key', ?, 'restricted', ?, ?)""",
            (hashlib.sha256(token.encode()).hexdigest(), json.dumps([allowed_account]),
             json.dumps([FALLBACK_MODEL])),
        )
        now = datetime.now(timezone.utc)
        window = {"used": 25, "remaining": 75, "total": 100, "unlimited": False,
                  "resetAt": (now + timedelta(hours=1)).isoformat()}
        cache = json.dumps({"source": "manual", "fetchedAt": now.isoformat(),
                            "quotas": {"session": window, "weekly": window}})
        for account in (ACCOUNT, OTHER_ACCOUNT):
            staging.execute("INSERT INTO provider_connections VALUES (?, 'codex', 1)", (account,))
            staging.execute("INSERT INTO key_value VALUES ('providerLimitsCache', ?, ?)", (account, cache))
        staging.commit()
        with closing(sqlite3.connect(destination)) as backup:
            staging.backup(backup)
    destination.chmod(0o400)


@contextmanager
def codex_server(binary, endpoint, env, project):
    with subprocess.Popen(
        [binary, "app-server", "--listen", f"unix://{endpoint}"], env=env, cwd=project,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) as daemon:
        def listening():
            require(daemon.poll() is None, f"isolated Codex server exited: {daemon.returncode}")
            return endpoint.is_socket()

        try:
            wait_for("isolated Codex socket did not become ready", listening, seconds=8)
            yield daemon
        finally:
            if daemon.poll() is None:
                daemon.send_signal(signal.SIGINT)
                try:
                    daemon.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait(timeout=3)


@contextmanager
def native_client(endpoint, home):
    import websocket

    with socket.socket(socket.AF_UNIX) as transport:
        transport.settimeout(6)
        transport.connect(str(endpoint))
        with closing(websocket.create_connection(
            "ws://localhost/rpc", socket=transport, timeout=6, suppress_origin=True
        )) as ws:
            next_id = 0
            completions = {}

            def receive(deadline):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("native Codex read deadline elapsed")
                ws.settimeout(remaining)
                message = json.loads(ws.recv())
                if message.get("method") == "turn/completed":
                    params = message["params"]
                    completions[(params["threadId"], params["turn"]["id"])] = params["turn"]
                return message

            def call(method, params):
                nonlocal next_id
                next_id += 1
                ws.send(json.dumps({"id": next_id, "method": method, "params": params}))
                deadline = time.monotonic() + 6
                while True:
                    message = receive(deadline)
                    if message.get("id") != next_id:
                        continue
                    require("error" not in message, f"native {method} error: {message.get('error')}")
                    return message["result"]

            def wait_for_turn(thread, turn):
                deadline = time.monotonic() + 20
                while (thread, turn) not in completions:
                    receive(deadline)
                return completions.pop((thread, turn))

            response = call("initialize", {
                "clientInfo": {"name": "codex-recovery-native-observer", "version": "1"},
                "capabilities": {"experimentalApi": True},
            })
            require(response.get("codexHome") == str(home), "unexpected native Codex home")
            ws.send(json.dumps({"method": "initialized", "params": {}}))
            yield call, wait_for_turn


def turns(call, session):
    return call("thread/turns/list", {"threadId": session, "limit": 8,
                                    "itemsView": "full", "sortDirection": "asc"})["data"]


def seed_failure(call, wait_for_turn, project, source):
    thread = call("thread/start", {"cwd": str(project)})["thread"]["id"]
    turn = call("turn/start", {"threadId": thread, "input": [
        {"type": "text", "text": "Synthetic quota recovery check. Reply without using tools."},
    ]})["turn"]["id"]

    failed = wait_for_turn(thread, turn)
    require(failed["status"] == "failed" and failed["completedAt"] >= failed["startedAt"],
            "terminal turn identity or timing mismatch")
    failure = failed["error"]["codexErrorInfo"]
    require(failure == "usageLimitExceeded", f"unexpected Codex terminal failure: {failure}")
    require(source.statuses == [429] and source.count == 1, "expected exactly one local HTTP 429")
    print(json.dumps({"phase": "terminal_429", "thread": thread, "turn": turn,
                      "native_error": failure, "http_status": 429}), flush=True)
    return thread, turn


def receipt_rows(database):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        return conn.execute(
            """SELECT b.native_session_id, i.state, i.native_receipt, t.result_json
               FROM intents i JOIN session_bindings b ON b.session_ref=i.target
               JOIN tasks t ON t.task_id=i.task_id
               WHERE i.request_key LIKE 'codex-recovery:%'"""
        ).fetchall()


def thread_fields(thread):
    return {**{key: thread.get(key) for key in ("id", "cwd", "modelProvider", "status")},
            "model_present": "model" in thread, "model": thread.get("model")}


def diagnose_rejection(read, thread, row):
    diagnostic = json.loads(row[3]) if row[3] else None
    print(json.dumps({"phase": "owner_rejected", "task": diagnostic}), flush=True)
    prior = read("thread/read", {"threadId": thread, "includeTurns": False})["thread"]
    print(json.dumps({"phase": "owner_rejected_thread_read", "thread": thread_fields(prior)}), flush=True)
    raise RuntimeError("owner rejected recovery before turn/start")


def attest_proxies(owner, codex, socket_path):
    tasks = Path(f"/proc/{owner.process.pid}/task")
    children = set()
    for task in tasks.iterdir():
        try:
            children.update((task / "children").read_text().split())
        except FileNotFoundError:
            continue
    require(len(children) == 3, f"expected three independent native Codex proxy processes, got {len(children)}")
    command = [str(codex), "app-server", "proxy", "--sock", str(socket_path.resolve(strict=True))]
    for pid in children:
        process = Path(f"/proc/{pid}")
        require((process / "exe").samefile(codex), "unexpected Codex proxy binary")
        argv = (process / "cmdline").read_bytes().decode().rstrip("\0").split("\0")
        require(argv == command, f"owner proxy command mismatch: {argv!r}")
    return len(children)


@contextmanager
def owner_client(binary, profile, env):
    from ahap_opencode_stand import RpcProcess

    client = RpcProcess(binary, profile, env)
    try:
        tools = client.request("tools/list", {"_meta": MCP_META})["tools"]
        require(any(tool["name"] == "session" for tool in tools), "native session tool unavailable")
        yield client
    finally:
        client.close()


def session_tool(owner, **arguments):
    result = owner.request("tools/call", {"_meta": MCP_META, "name": "session", "arguments": arguments})
    require(not result.get("isError"), f"session {arguments['action']} failed: {result}")
    return result["structuredContent"]


def checked_transcript(call, session, failure_id):
    current = turns(call, session)
    require(len(current) == 2 and current[0]["id"] == failure_id and current[0]["status"] == "failed",
            "native transcript does not contain exactly the original failure and one recovery")
    require(current[1]["status"] == "completed" and current[1]["id"] != failure_id,
            "native recovery did not complete as a distinct turn")
    return current[1]["id"]


def exercise(root, codex, owner, source_url, fallback_url, source, fallback, answer,
             source_token, fallback_token):
    home, project = root / "codex-home", root / "project"
    home.mkdir(mode=0o700)
    project.mkdir(mode=0o700)
    env = {"HOME": str(home), "CODEX_HOME": str(home), "PATH": "/usr/bin:/bin"}
    native_config = home / "config.toml"
    private_write(native_config, f'''
model = "{SOURCE_MODEL}"
model_provider = "{SOURCE_PROVIDER}"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.{SOURCE_PROVIDER}]
name = "Isolated 429 source"
base_url = "{source_url}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
experimental_bearer_token = "{source_token}"
[model_providers.{FALLBACK_PROVIDER}]
name = "Isolated OmniRoute endpoint"
base_url = "{fallback_url}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
experimental_bearer_token = "{fallback_token}"
''')
    native_config_hash = digest(native_config)
    # A fresh fixture daemon exposes the durable failed thread as a cold
    # resume. The recovery and owner restart below share one daemon.
    endpoint, alias = root / "codex.sock", root / "control.sock"
    alias.symlink_to(endpoint.name)
    with codex_server(codex, endpoint, env, project):
        with native_client(alias, home) as (seed, wait_for_turn):
            thread, failure_id = seed_failure(seed, wait_for_turn, project, source)

    gate, database = make_authority(root, Path("/fixture/store"))
    profile = root / "owner.json"
    tripwire = root / "legacy-runner"
    private_write(tripwire, "#!/bin/sh\nexit 99\n")
    tripwire.chmod(0o700)
    binding = {
        "kind": "codex", "principal": "fixture-owner", "node": "fixture-node", "instance": INSTANCE,
        "executable": str(tripwire), "ahap_script": str(tripwire),
        "code_home": str(home), "cwd": str(project),
        "ahap_env": {"AHAP_CODEX_BIN": str(codex), "CODEX_HOME": str(home),
                     "AHAP_CODEX_CWD": str(project), "AHAP_CODEX_SOCKET": str(alias)},
    }
    data = {"database": str(database), "gate": str(gate), "generation": "fixture", "owner": binding}
    private_write(profile, json.dumps(data))
    wrong_backup, exact_backup = root / "wrong-account.sqlite", root / "exact-account.sqlite"
    quota_backup(wrong_backup, fallback_token, OTHER_ACCOUNT)
    quota_backup(exact_backup, fallback_token, ACCOUNT)
    backup_hashes = [digest(wrong_backup), digest(exact_backup)]
    private_write(root / "session-autostart.json", json.dumps({
        "version": 8, "enabled": True, "recoverOnFailure": True, "recoverOnDisconnect": False,
        "waitForQuota": True, "fallbackForQuota": True, "sessions": [],
    }))

    with codex_server(codex, endpoint, env, project) as daemon, native_client(alias, home) as (read, _):
        failed = turns(read, thread)
        require(len(failed) == 1 and failed[0]["id"] == failure_id and failed[0]["status"] == "failed",
                "original terminal turn did not survive the fixture daemon restart")
        cold = read("thread/read", {"threadId": thread, "includeTurns": False})["thread"]
        require(cold["id"] == thread and cold["status"]["type"] == "notLoaded"
                and cold["modelProvider"] == SOURCE_PROVIDER and cold["model"] == SOURCE_MODEL,
                "cold thread did not retain the original provider and model")
        with owner_client(owner, profile, env) as provision:
            proxy_count = attest_proxies(provision, codex, endpoint)
            registration = session_tool(provision, action="register", instance_ref=INSTANCE,
                                        native_session_id=thread, request_key="fixture-register")
        require(registration["address"]["native_session_id"] == thread, "wrong registered native thread")
        ref = registration["session_ref"]

        route = {"workspace": str(project), "provider": FALLBACK_PROVIDER, "model": FALLBACK_MODEL,
                 "omniroute": {"endpoint": fallback_url, "database": str(wrong_backup),
                               "account": ACCOUNT, "upstream_provider": "codex"}}
        binding["codex_recovery"] = {"autopilot_state_dir": str(root), "fallback_routes": [route]}
        private_write(profile, json.dumps(data))
        with owner_client(owner, profile, env):
            time.sleep(3)  # The owner automation's initial tick runs immediately, then every two seconds.
        require(fallback.count == 0 and not receipt_rows(database),
                "the backup with quota on a different account admitted recovery")

        route["omniroute"]["database"] = str(exact_backup)
        private_write(profile, json.dumps(data))
        with owner_client(owner, profile, env) as active:
            require(attest_proxies(active, codex, endpoint) == proxy_count, "lost shared proxy identity")

            def completed():
                rows = receipt_rows(database)
                if len(rows) == 1 and rows[0][1] == "rejected":
                    require(fallback.count == 0, "rejected recovery reached the fallback provider")
                    diagnose_rejection(read, thread, rows[0])
                if len(rows) != 1 or rows[0][1] != "confirmed" or not rows[0][2]:
                    return None
                native_turns = turns(read, thread)
                return rows if len(native_turns) == 2 and native_turns[1]["status"] == "completed" else None

            try:
                # A receipt observed before native completion is reconciled on
                # the next 30-second owner scan.
                rows = wait_for("no confirmed owner recovery intent", completed, seconds=45)
            except TimeoutError as error:
                states = [row[1] for row in receipt_rows(database)]
                outcomes = [turn["status"] for turn in turns(read, thread)]
                raise RuntimeError(f"{error}; intent states={states}, native turns={outcomes}, "
                                   f"source requests={source.count}, fallback requests={fallback.count}") from error
            recovery_id = checked_transcript(read, thread, failure_id)
            live = read("thread/read", {"threadId": thread, "includeTurns": False})["thread"]
            require(live["id"] == thread and live["modelProvider"] == SOURCE_PROVIDER
                    and live["model"] == FALLBACK_MODEL,
                    "recovery did not keep the pinned provider ID and select the alternate model")
            receipt = json.loads(rows[0][2])
            require(rows[0][0] == receipt["address"]["native_session_id"] == thread
                    and receipt["native_id"] == recovery_id, "durable receipt points to another thread or turn")
            messages = session_tool(active, action="messages", session_ref=ref)
            require(answer in json.dumps(messages), "fallback reply unavailable in the owner transcript")

        with owner_client(owner, profile, env) as restarted:
            require(attest_proxies(restarted, codex, endpoint) == proxy_count, "restarted owner lost proxy identity")
            time.sleep(3)
            messages = session_tool(restarted, action="messages", session_ref=ref)
            require(answer in json.dumps(messages), "restarted owner lost the fallback reply")
            require(daemon.poll() is None and checked_transcript(read, thread, failure_id) == recovery_id,
                    "shared server or native recovery turn changed during owner restart")
        require(receipt_rows(database) == rows, "owner restarted with a changed recovery receipt")
        require(source.count == 1 and fallback.count == 1 and fallback.accepted == [FALLBACK_MODEL],
                "provider request counts changed or fallback did not use the authorized model")
        require([digest(wrong_backup), digest(exact_backup)] == backup_hashes,
                "quota backup contents changed")
        require(digest(native_config) == native_config_hash, "native Codex profile changed")
        return {"result": "PASS", "thread": thread, "failed_turn": failure_id,
                "recovery_turn": recovery_id, "source_http_status": 429, "source_requests": 1,
                "fallback_requests": 1, "fallback_model": FALLBACK_MODEL,
                "pinned_provider_id": SOURCE_PROVIDER, "exact_fallback_authorization": True,
                "fixture_account": ACCOUNT, "native_profile_unchanged": True,
                "other_account_blocked": True, "receipt_state": rows[0][1], "proxy_children": proxy_count,
                "owner_restart_repeat": 0, "sqlite_backups_unchanged": True}


def exercise_crash(root, codex, owner, source, fallback, answer):
    home, project = root / "codex-home", root / "project"
    endpoint, alias = root / "codex.sock", root / "control.sock"
    env = {"HOME": str(home), "CODEX_HOME": str(home), "PATH": "/usr/bin:/bin"}
    original_prompt = "Continue after an isolated server crash. Reply without using tools."
    profile = root / "owner.json"
    enabled = json.loads(profile.read_text())
    database = Path(enabled["database"])
    settings_path = root / "session-autostart.json"
    settings = json.loads(settings_path.read_text())
    settings["recoverOnDisconnect"] = True
    private_write(settings_path, json.dumps(settings))
    activation = root / "activate-crash-recovery.json"
    handoff = {"activation_file": str(activation)}
    for name, field in (("human_stops", "sessions"), ("human_requests", "requests"),
                        ("choices", "requests"), ("unfinished_sessions", "sessions")):
        registry = root / f"{name}.json"
        private_write(registry, json.dumps({"version": 1, field: []}))
        handoff[name] = str(registry)

    with ExitStack() as running_owner:
        with codex_server(codex, endpoint, env, project) as daemon, native_client(alias, home) as (seed, _):
            thread = seed("thread/start", {"cwd": str(project), "model": CRASH_MODEL})["thread"]["id"]
            interrupted = seed("turn/start", {"threadId": thread, "input": [
                {"type": "text", "text": original_prompt},
            ]})["turn"]["id"]
            require(source.crash_entered.wait(10), "the original request did not reach the fixture model")
            handoff["native_sessions"] = [thread]
            enabled["owner"]["codex_recovery"]["legacy_handoff"] = handoff
            private_write(profile, json.dumps(enabled))
            active = running_owner.enter_context(owner_client(owner, profile, env))
            registered = session_tool(active, action="register", instance_ref=INSTANCE,
                                      native_session_id=thread, request_key="crash-fixture-register")
            ref = registered["session_ref"]
            daemon.kill()
            daemon.wait(timeout=5)
            source.crash_release.set()
        endpoint.unlink(missing_ok=True)
        with codex_server(codex, endpoint, env, project), native_client(alias, home) as (read, _):
            receipt = verify_crash(read, active, database, thread, interrupted, ref,
                                   original_prompt, answer, activation)
            running_owner.close()
            with owner_client(owner, profile, env) as reopened:
                time.sleep(3)
                require(crash_receipt(read, database, thread) == receipt
                        and answer in json.dumps(session_tool(reopened, action="messages", session_ref=ref)),
                        "crash recovery evidence changed on owner restart")
    require(source.crash_requests == 2 and fallback.count == 1,
            "crash recovery repeated a request or changed provider")
    return {"crash_requests": source.crash_requests, "crash_owner_restart_repeat": 0,
            "crash_owner_survived_app_server_restart": True,
            "crash_original_turn": interrupted, "crash_recovery_turn": receipt["native_id"]}


def crash_receipt(read, database, thread):
    rows = [row for row in receipt_rows(database) if row[0] == thread]
    if rows and rows[0][1] == "rejected":
        diagnose_rejection(read, thread, rows[0])
    if len(rows) != 1 or rows[0][1] != "confirmed":
        return None
    packet = turns(read, thread)
    if len(packet) != 2 or packet[1]["status"] != "completed":
        return None
    receipt = json.loads(rows[0][2])
    require(receipt["address"]["native_session_id"] == thread
            and receipt["native_id"] == packet[1]["id"], "crash receipt does not match")
    return receipt


def verify_crash(read, active, database, thread, interrupted, ref, original_prompt, answer, activation):
    before = turns(read, thread)
    require(len(before) == 1 and before[0]["id"] == interrupted
            and before[0]["completedAt"] is None and before[0]["status"] == "interrupted"
            and original_prompt in json.dumps(before[0]),
            "the restarted server did not expose the original interrupted turn")
    require(not any(row[0] == thread for row in receipt_rows(database)),
            "recovery dispatch preceded the ownership handoff")
    private_write(activation, "true\n")
    try:
        receipt = wait_for("Codex did not reconcile the crash turn with the same owner",
                           lambda: crash_receipt(read, database, thread), seconds=45)
    except TimeoutError as error:
        retained = [row[1] for row in receipt_rows(database) if row[0] == thread]
        statuses = [turn["status"] for turn in turns(read, thread)]
        raise RuntimeError(f"{error}; intent states={retained}, native turns={statuses}") from error
    require(turns(read, thread)[0] == before[0], "crash recovery replaced the original input")
    require(answer in json.dumps(session_tool(active, action="messages", session_ref=ref)),
            "Codex owner cannot read back the crash recovery answer")
    return receipt


def inside(parent_namespace):
    require(namespace() != parent_namespace and {name for _, name in socket.if_nameindex()} == {"lo"},
            "isolated loopback-only network required")
    root = Path("/stand")
    require(root.is_mount() and root.stat().st_uid == os.geteuid(), "private fixture mount required")
    root.chmod(0o700)
    os.umask(0o077)
    # Keep the exact installed bytes in a private executable. The profile
    # rejects group-writable launcher paths, including read-only bind mounts.
    codex = root / "codex"
    installed = Path("/fixture/codex")
    shutil.copyfile(installed, codex)
    codex.chmod(0o500)
    require(digest(codex) == digest(installed), "isolated Codex binary copy differs from installed bytes")
    owner = Path("/fixture/owner")
    source_token = "fixture-source-" + secrets.token_hex(24)
    fallback_token = "fixture-fallback-" + secrets.token_hex(24)
    module = model_fixture()
    source, fallback = model_providers(source_token, fallback_token, module)
    with http_fixture(source) as primary_url, http_fixture(fallback) as fallback_url:
        proof = exercise(root, codex, owner, primary_url, fallback_url, source,
                         fallback, module.ANSWER, source_token, fallback_token)
        proof.update(exercise_crash(root, codex, owner, source, fallback, module.ANSWER))
    proof.update({"codex_sha256": digest(codex), "owner_sha256": digest(owner), "network": "loopback-only"})
    print(json.dumps(proof, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--owner", type=Path, required=True)
    args = parser.parse_args()
    codex, owner = (path.resolve(strict=True) for path in (args.codex, args.owner))
    for executable in (codex, owner):
        require(stat.S_ISREG(executable.stat().st_mode) and os.access(executable, os.X_OK),
                f"expected an executable regular file: {executable}")
        with executable.open("rb") as stream:
            require(stream.read(4) == b"\x7fELF", f"expected a native ELF binary: {executable}")
    bwrap = shutil.which("bwrap")
    require(bwrap, "Bubblewrap required")
    tests = Path(__file__).resolve().parent
    store = tests.parents[1] / "crates/herder/src/store"
    command = [
        bwrap, "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--unshare-pid",
        "--die-with-parent", "--new-session", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc",
        "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/stand", "--chdir", "/stand",
        "--ro-bind", str(tests), "/fixture/native", "--ro-bind", str(store), "/fixture/store",
        "--ro-bind", str(codex), "/fixture/codex", "--ro-bind", str(owner), "/fixture/owner",
        "--", "/usr/bin/python3", "-uB", f"/fixture/native/{Path(__file__).name}", "--inside", namespace(),
    ]
    subprocess.run(command, check=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        main()
