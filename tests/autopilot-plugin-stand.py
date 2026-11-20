#!/usr/bin/env python3
"""Install the projected Codex plugin and operate one rule from its slash script and the inspector."""
import argparse
from contextlib import ExitStack, closing
import json
import os
from pathlib import Path
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
    # Use the supported installer, then run the file the installer actually cached.
    for args in (["marketplace", "add", "/plugin"], ["add", "agent-herder@agent-herder-local"]):
        subprocess.run([native, "plugin", *args], cwd=work, env=env, check=True, timeout=40)
    cache = home / "plugins/cache/agent-herder-local/agent-herder"
    (script,) = cache.glob("*/skills/autopilot/scripts/run.sh")
    assert stand.digest(script) == stand.digest(Path("/plugin/skills/autopilot/scripts/run.sh"))

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
    selector = root / "selector.json"
    dump(selector, {"manifest": str(manifest), "manifest_sha256": stand.digest(manifest), "profiles": [str(profile)]})
    launcher = root / ".local/bin/agent-herder-v1"
    launcher.parent.mkdir(parents=True)
    shutil.copyfile(REPO / "deploy/fleet/launch-v1-core.py", launcher)
    launcher.chmod(0o700)
    env["HERDER_V1_ENTRY"] = str(selector)
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
        session = read("thread/start", {"cwd": str(work)})["thread"]["id"]
        turn = read("turn/start", {"threadId": session, "input": [{"type": "text", "text": "Fixture baseline."}]})["turn"]["id"]
        assert wait(session, turn)["status"] == "completed"
        foreign = {"harness": "minimax-code", "sessionId": "neighbour", "enabled": True, "cwd": str(work),
                   "updatedAt": "2026-11-20T00:00:00.000Z", "opaqueField": {"keep": 1}}
        dump(state / "sessions.json", {"version": 1, "sessions": [foreign]})

        panel = subprocess.Popen(["node", "--input-type=module", "-e", """
          import { createWebServer } from '/work/dist/web/server.js';
          import { AutopilotSessionStore } from '/work/dist/autopilot/session-store.js';
          import { AutopilotPolicyStore } from '/work/dist/autopilot/policy-store.js';
          const state = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
          const server = createWebServer({ adapters: new Map(), converter: {}, autopilotSessionStore:
            new AutopilotSessionStore(state + '/sessions.json'), autopilotPolicyStore: new AutopilotPolicyStore(state + '/autopilot-policy.json') });
          server.listen(18787, '127.0.0.1', () => console.log(server.address().port));
        """], cwd=work, env=env, stdout=subprocess.PIPE, text=True)
        stack.callback(panel.wait, 8)
        stack.callback(panel.terminate)
        base = "http://127.0.0.1:" + str(int(panel.stdout.readline()))
        env.pop("HERDER_V1_ENTRY")  # The plugin only has its normal thread ID and the installed launcher.
        env["CODEX_THREAD_ID"] = session
        api = base + "/api/autopilot/sessions/codex/" + session

        def slash(command, enabled):
            text = subprocess.check_output(["bash", script, command], cwd=work, env=env, timeout=35, text=True)
            assert ("включён" if enabled else "выключен") in text and session in text, text

        def inspect(enabled=None):
            data = None if enabled is None else json.dumps({"enabled": enabled, "cwd": str(work)}).encode()
            request = Request(api + "?cwd=/stand/project", data=data, method="GET" if data is None else "PUT",
                              headers={"Content-Type": "application/json"})
            try:
                with urlopen(request, timeout=35) as response:
                    return json.load(response)
            except HTTPError as error:
                raise AssertionError((enabled, error.code, error.read().decode())) from error

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
            slash("on", True)
            active = inspect()
            assert active["enabled"] and active["executor"] == "rust", active
            rule_ref = rule_ref or active["rule_ref"]
            assert active["rule_ref"] == rule_ref and inspect(True)["revision"] == active["revision"]
            slash("status", True)
            paused = inspect(False)
            slash("off", False)
            slash("status", False)
            observed = inspect()
            assert not observed["enabled"] and observed["phase"] == "paused" and observed["rule_ref"] == rule_ref, observed
            assert paused["revision"] == observed["revision"] == active["revision"] + 1
            revisions.append([active["revision"], paused["revision"]])
        assert revisions == [[1, 2], [3, 4], [5, 6]], revisions
        assert foreign in json.loads((state / "sessions.json").read_text())["sessions"]
        assert [t["id"] for t in stand.turns(read, session)] == [turn]
        with closing(sqlite3.connect(db)) as conn:
            deliveries = conn.execute("SELECT count(*) FROM intents WHERE request_key LIKE 'codex-autopilot:%'").fetchone()[0]
        assert deliveries == 0
        print(json.dumps({"result": "PASS", "script": str(script), "plugin_version": script.parents[3].name,
                          "script_sha256": stand.digest(script), "owner_sha256": stand.digest(Path("/fixture/owner")),
                          "session": session, "rule_ref": rule_ref, "policy_revisions": revisions,
                          "native_turns": 1, "autopilot_deliveries": deliveries, "foreign_row_preserved": True}))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        args = argparse.ArgumentParser(description=__doc__)
        for name in ("codex", "owner", "compat", "plugin"):
            args.add_argument("--" + name, type=Path, required=True)
        selected = vars(args.parse_args())
        mounts = []
        for name, path in selected.items():
            mounts += ["--ro-bind", str(path.resolve(strict=True)), "/plugin" if name == "plugin" else "/fixture/" + name]
        subprocess.run(["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--unshare-pid",
                        "--die-with-parent", "--new-session", "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
                        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
                        "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                        "--ro-bind", "/etc/passwd", "/etc/passwd", "--tmpfs", "/stand", "--chdir", "/stand", "--ro-bind", str(REPO), "/work", *mounts,
                        "--", "/usr/bin/python3", "-uB", "/work/tests/autopilot-plugin-stand.py", "--inside", stand.namespace()],
                       check=True)
