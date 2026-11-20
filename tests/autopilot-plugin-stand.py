#!/usr/bin/env python3
"""Install the projected Codex plugin and operate one rule from its slash script and the inspector."""
import argparse
from contextlib import ExitStack, closing
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tests/native"))
import codex_recovery_stand as stand
from chatgpt_opencode_mesh_stand import Peer
sys.path.insert(0, str(REPO / "tests/fixtures"))
from autopilot_registered_hub import canonical_environment


def dump(path, value):
    stand.private_write(path, json.dumps(value))


def inside(parent):
    assert stand.namespace() != parent and {name for _, name in socket.if_nameindex()} == {"lo"}
    root = Path("/stand")
    assert root.is_mount()
    root.chmod(0o700)
    os.umask(0o077)
    home, work, state = root / "codex-home", root / "project", root / "state"
    for path in (home, work, state):
        path.mkdir()
    env = {**os.environ, "HOME": str(root), "CODEX_HOME": str(home), "AGENT_HERDER_AUTOPILOT_STATE_DIR": str(state),
           "AGENT_HERDER_HUMAN_STOP_STORE": str(state / "human-stops.json")}
    native = root / "codex"
    shutil.copyfile("/fixture/codex", native)
    native.chmod(0o500)
    def install(source):
        for args in (["marketplace", "add", str(source)], ["add", "agent-herder@agent-herder-local"]):
            subprocess.run([native, "plugin", *args], cwd=work, env=env, check=True, timeout=40)
        version = json.loads((source / ".codex-plugin/plugin.json").read_text())["version"]
        cache = home / "plugins/cache/agent-herder-local/agent-herder" / version
        script = cache / "skills/autopilot/scripts/run.sh"
        assert stand.digest(script) == stand.digest(source / "skills/autopilot/scripts/run.sh")
        return script

    previous = Path("/previous-plugin")
    script = install(previous if previous.exists() else Path("/plugin"))

    endpoint = root / "codex.sock"
    gate, db = stand.make_authority(root, REPO / "crates/herder/src/store")
    dummy = root / "unused-adapter"
    stand.private_write(dummy, "#!/bin/sh\nexit 125\n")
    dummy.chmod(0o700)
    holds = {}
    for name, field in [("human_stops", "sessions"), ("human_requests", "requests"),
                        ("choices", "requests"), ("unfinished_sessions", "sessions")]:
        file = state / (name.replace("_", "-") + ".json")
        dump(file, {"version": 1, field: []})
        holds[name] = str(file)
    profile = root / "owner.json"
    dump(profile, {"database": str(db), "gate": str(gate), "generation": "fixture", "owner": {
        "kind": "codex", "principal": "fixture-owner", "node": "fixture-node", "instance": stand.INSTANCE,
        "executable": str(dummy), "ahap_script": str(dummy), "code_home": str(home), "cwd": str(work),
        "ahap_env": {"AHAP_CODEX_BIN": str(native), "CODEX_HOME": str(home), "AHAP_CODEX_CWD": str(work),
                     "AHAP_CODEX_SOCKET": str(endpoint)},
        "codex_autopilot": {"state_dir": str(state), "holds": holds,
                            "judge": {"base_url": "http://127.0.0.1:1/v1", "model": "unused-judge"}}}})
    manifest = root / "manifest.json"
    paths = dict(core=Path("/fixture/owner"), compat=Path("/fixture/compat"), node=dummy, bootstrap=dummy)
    dump(manifest, {**{k: str(p) for k, p in paths.items()}, "adapters": {"codex": str(dummy)}, "source_commit": "fixture",
                    "sha256": {**{k: stand.digest(p) for k, p in paths.items()}, "adapters": {"codex": stand.digest(dummy)}}})
    config_dir = root / ".config/agent-herder"
    config_dir.mkdir(parents=True)
    registered = config_dir / "gptadmin-entry.json"
    default = config_dir / "v1-entry.json"
    selection = {"manifest": str(manifest), "manifest_sha256": stand.digest(manifest)}
    dump(registered, {**selection, "profiles": [str(profile)]})
    decoy = root / "decoy-owner.json"
    alternate = json.loads(profile.read_text())
    alternate["owner"]["instance"] = "different-unregistered-writer"
    dump(decoy, alternate)
    dump(default, {**selection, "profiles": [str(decoy)]})
    tripwire = root / ".local/bin/agent-herder-v1"
    tripwire.parent.mkdir(parents=True)
    stand.private_write(tripwire, "#!/bin/sh\necho spawn >>/stand/unexpected-writer\nexit 93\n")
    tripwire.chmod(0o700)
    module = stand.model_fixture()
    with ExitStack() as stack:
        url = stack.enter_context(stand.http_fixture(module.Handler))
        # Keep the marketplace tables written by the installer.
        config = home / "config.toml"
        stand.private_write(config, f'''model = "fixture-model"
model_provider = "opencodex"
sandbox_mode = "read-only"
approval_policy = "never"
[model_providers.opencodex]
name = "fixture"
base_url = "{url}"
wire_api = "responses"
experimental_bearer_token = "fixture-only"
''' + config.read_text())
        stack.enter_context(stand.codex_server(native, endpoint, env, work))
        read, wait = stack.enter_context(stand.native_client(endpoint, home))
        owner = Peer([sys.executable, str(REPO / "deploy/fleet/launch-v1-core.py")],
                     {**env, "HERDER_V1_ENTRY": str(registered)}, root)
        stack.callback(owner.close)
        hello = owner.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                              "clientInfo": {"name": "fixture-gptadmin", "version": "1"}})
        assert hello["protocolVersion"] == "2025-06-18", hello
        owner.process.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        owner.process.stdin.flush()
        canonical_env, calls, unavailable = canonical_environment(stack, root, owner)
        session = read("thread/start", {"cwd": str(work)})["thread"]["id"]
        turn = read("turn/start", {"threadId": session, "input": [{"type": "text", "text": "Fixture baseline."}]})["turn"]["id"]
        assert wait(session, turn)["status"] == "completed"
        foreign = {"harness": "minimax-code", "sessionId": "neighbour", "enabled": True, "cwd": str(work),
                   "updatedAt": "2026-11-20T00:00:00.000Z", "opaqueField": {"keep": 1}}
        dump(state / "sessions.json", {"version": 1, "sessions": [foreign]})

        before_status = stand.digest(state / "sessions.json")
        if previous.exists():
            red = subprocess.run(["bash", script, "status"], cwd=work, env={**env, "CODEX_THREAD_ID": session},
                                 text=True, capture_output=True, timeout=35)
            assert red.returncode == 1 and "unsupported autopilot harness" in red.stderr, red.stderr
            assert stand.digest(state / "sessions.json") == before_status
            print(json.dumps({"cmd": ["bash", str(script), "status"], "exit": 1, "error": "unsupported autopilot harness",
                              "session": session, "state_sha256": before_status}), flush=True)
            old_cache = script.parents[3]
            archive = root / "prior-cache"
            shutil.copytree(old_cache, archive)
            def inventory(directory):
                return {p.relative_to(directory): stand.digest(p) for p in directory.rglob("*") if p.is_file()}
            assert inventory(archive) == inventory(old_cache)
            subprocess.run([native, "plugin", "marketplace", "remove", "agent-herder-local"], cwd=work, env=env, check=True)
            script = install(Path("/plugin"))

        operator_token = secrets.token_hex(24)
        panel_env = {**env, **canonical_env, "AGENT_HERDER_HTTP_TOKEN": operator_token, "STAND_SESSION": session}
        panel = subprocess.Popen(["node", "--input-type=module", "-e", """
          import { createWebServer } from '/work/dist/web/server.js';
          import { AutopilotSessionStore } from '/work/dist/autopilot/session-store.js';
          import { AutopilotPolicyStore } from '/work/dist/autopilot/policy-store.js';
          const state = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
          import { createCanonicalAutomationClient } from '/work/dist/canonical-herder.js';
          import { SessionSupervisor } from '/work/dist/session-supervisor.js';
          const selected = {id:process.env.STAND_SESSION, harness:'codex', title:'Стенд автопилота', cwd:'/stand/project',
            status:'idle', lastActivity:new Date().toISOString(), meta:{}};
          const supervisor = new SessionSupervisor(new Map(), {});
          supervisor.listSessionsFast = () => ({sessions:[selected], warming:false});
          supervisor.listSessions = async () => [selected];
          supervisor.getSessionDetails = async () => ({session:selected, messages:[], events:[]});
          const server = createWebServer({supervisor, adapters:new Map(), converter:{},
            canonicalClient: await createCanonicalAutomationClient(), mcpAuthToken:process.env.AGENT_HERDER_HTTP_TOKEN,
            autopilotSessionStore:
            new AutopilotSessionStore(state + '/sessions.json'), autopilotPolicyStore: new AutopilotPolicyStore(state + '/autopilot-policy.json') });
          server.listen(18787, '127.0.0.1', () => console.log(server.address().port));
        """], cwd=work, env=panel_env, stdout=subprocess.PIPE, text=True)
        stack.callback(panel.wait, 8)
        stack.callback(panel.terminate)
        base = "http://127.0.0.1:" + str(int(panel.stdout.readline()))
        # The installed command knows only the local panel and its thread.
        env["AGENT_HERDER_HTTP_TOKEN"] = operator_token
        env["CODEX_THREAD_ID"] = session
        api = base + "/api/autopilot/sessions/codex/" + session

        def slash(command, enabled):
            run = subprocess.run(["bash", script, command], cwd=work, env=env, timeout=35, text=True, capture_output=True)
            assert not (root / "unexpected-writer").exists(), f"installed {command} started the alternate writer"
            assert run.returncode == 0, (command, run.stderr)
            assert ("включён" if enabled else "выключен") in run.stdout and session in run.stdout, run.stdout

        def inspect(enabled=None):
            data = None if enabled is None else json.dumps({"enabled": enabled, "cwd": str(work)}).encode()
            request = Request(api + "?cwd=/stand/project", data=data, method="GET" if data is None else "PUT",
                              headers={"Content-Type": "application/json"})
            try:
                with urlopen(request, timeout=35) as response:
                    return json.load(response)
            except HTTPError as error:
                raise AssertionError((enabled, error.code, error.read().decode())) from error

        browser = Path("/fixture/chrome/chrome").is_file()

        def switch(format, before, click=False):
            if not browser:
                return inspect(not before if click else None)
            output = subprocess.check_output(["node", "/work/tests/fixtures/autopilot-inspector-switch.mjs", base,
                session, format, str(before).lower(), "click" if click else "read"], env=env, cwd=work, text=True, timeout=35)
            return json.loads(output)

        revisions = []
        rule_ref = None
        for format in ["absent", "old", "current"]:
            if format != "absent":
                policy = {"schemaVersion": 1, "enabled": False, "scope": {"mode": "all_ingress"},
                          "maxContinuationsPerSession": 3, "timeout": {"mode": "hold", "delayMs": 60000},
                          "card": {"includeUserMessage": True, "includeAssistantMessage": True, "includeReason": True}}
                if format == "current":
                    policy.update(judgeMode="llm", harnesses=["codex"])
                dump(state / "autopilot-policy.json", {"schemaVersion": 1, "revision": format, "policy": policy,
                                                       "updatedAt": "2026-11-20T00:00:00.000Z"})
            slash("status", False)
            if format == "absent":
                assert stand.digest(state / "sessions.json") == before_status
                print(json.dumps({"cmd": ["bash", str(script), "status"], "exit": 0, "enabled": False,
                                  "session": session, "state_sha256": before_status}), flush=True)
            if format == "current":
                active = switch(format, False, click=True)
            else:
                slash("on", True)
                active = switch(format, True)
            assert active["enabled"] and active["executor"] == "rust", active
            rule_ref = rule_ref or active["rule_ref"]
            assert active["rule_ref"] == rule_ref and inspect(True)["revision"] == active["revision"]
            slash("status", True)
            if format == "current":
                slash("off", False)
                paused = switch(format, False)
            else:
                paused = switch(format, True, click=True)
            slash("off", False)
            slash("status", False)
            observed = inspect()
            assert not observed["enabled"] and observed["phase"] == "paused" and observed["rule_ref"] == rule_ref, observed
            assert paused["revision"] == observed["revision"] == active["revision"] + 1
            revisions.append([active["revision"], paused["revision"]])
        assert revisions == [[1, 2], [3, 4], [5, 6]], revisions
        unavailable.set()
        for action in ("status", "on", "off"):
            failed = subprocess.run(["bash", script, action], cwd=work, env=env, timeout=35, text=True, capture_output=True)
            assert failed.returncode != 0 and "503" in failed.stderr, (action, failed.stderr)
        unavailable.clear()
        slash("status", False)
        row = next(row for row in json.loads((state / "sessions.json").read_text())["sessions"]
                   if row.get("sessionId") == session)
        assert row["executor"] == "rust" and not row["enabled"]
        assert owner.process.poll() is None and not (root / "unexpected-writer").exists()
        assert {("session","resolve"), ("session","register"), ("automation","list"), ("automation","get"),
                ("automation","create"), ("automation","update"), ("automation","pause")}.issubset(calls)
        assert foreign in json.loads((state / "sessions.json").read_text())["sessions"]
        assert [t["id"] for t in stand.turns(read, session)] == [turn]
        with closing(sqlite3.connect(db)) as conn:
            deliveries = conn.execute("SELECT count(*) FROM intents WHERE request_key LIKE 'codex-autopilot:%'").fetchone()[0]
        assert deliveries == 0
        print(json.dumps({"result": "PASS", "script": str(script), "plugin_version": script.parents[3].name,
                          "script_sha256": stand.digest(script), "owner_sha256": stand.digest(Path("/fixture/owner")),
                          "session": session, "rule_ref": rule_ref, "policy_revisions": revisions,
                          "registered_selector_sha256": stand.digest(registered), "default_selector_sha256": stand.digest(default),
                          "browser_switch": browser, "registered_owner_pid": owner.process.pid, "unexpected_writer_spawns": 0, "native_turns": 1, "autopilot_deliveries": deliveries, "foreign_row_preserved": True}))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        args = argparse.ArgumentParser(description=__doc__)
        for name in ("codex", "owner", "compat", "plugin"):
            args.add_argument("--" + name, type=Path, required=True)
        args.add_argument("--previous-plugin", type=Path, help="installed 0.2.5 package for the upgrade regression")
        args.add_argument("--chrome", type=Path, help="Chrome installation directory containing chrome")
        args.add_argument("--playwright", type=Path, help="playwright-core package directory")
        args.add_argument("--browser-evidence", type=Path, help="directory for isolated inspector screenshots")
        selected = args.parse_args()
        mounts = []
        for name in ("codex", "owner", "compat", "plugin"):
            path = getattr(selected, name).resolve(strict=True)
            mounts += ["--ro-bind", str(path), "/plugin" if name == "plugin" else "/fixture/" + name]
        if selected.previous_plugin:
            mounts += ["--ro-bind", str(selected.previous_plugin.resolve(strict=True)), "/previous-plugin"]
        browser_paths = [selected.chrome, selected.playwright, selected.browser_evidence]
        if any(browser_paths):
            if not all(browser_paths):
                args.error("pass --chrome, --playwright and --browser-evidence together")
            mounts += ["--ro-bind", str(selected.chrome.resolve(strict=True)), "/fixture/chrome",
                       "--ro-bind", str(selected.playwright.resolve(strict=True)), "/fixture/playwright",
                       "--ro-bind", "/etc/fonts", "/etc/fonts", "--bind", str(selected.browser_evidence.resolve(strict=True)), "/receipt"]
        subprocess.run(["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--unshare-pid",
                        "--die-with-parent", "--new-session", "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
                        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
                        "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                        "--tmpfs", "/etc", "--ro-bind", "/etc/passwd", "/etc/passwd", "--tmpfs", "/stand", "--chdir", "/stand", "--ro-bind", str(REPO), "/work", *mounts,
                        "--", "/usr/bin/python3", "-uB", "/work/tests/autopilot-plugin-stand.py", "--inside", stand.namespace()],
                       check=True)
