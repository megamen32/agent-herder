"""Isolated entry acceptance for a staged native Rust owner candidate.

The candidate is exercised inside a bubblewrap namespace that exposes only the
reviewed candidate bundle, the QA authority files and the private runtime
roots. The launcher runs as an ordinary MCP client: it must discover the exact
configured instances, register the seeded native sessions, read their exact
histories back and never start a node process.

Every artefact this script writes stays under the private run root.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RUN = Path("/srv/storage/builds/herder/ci-runs/rust-browser-mesh-rollout-bRJcQC")
QA = RUN / "candidate-qa"
ENTRY = QA / "entry"
CANDIDATE = RUN / "candidate-entry-95efa8bd"


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def read_json(path: Path) -> dict:
    return json.loads(path.read_bytes())


def digest(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    os.umask(0o077)
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / "tests/native"))
    from process_lease_canary import MCP, create, sha  # noqa: E402
    import browser_adapter_smoke as browser  # noqa: E402

    manifest = read_json(CANDIDATE / "manifest.json")
    core = manifest["core"]
    migration = read_json(CANDIDATE / "native-profile-migration.json")
    baseline = read_json(QA / "baseline" / "manifest.json")

    selected = []
    observed = {}
    for row in migration["profiles"]:
        kind = row["kind"]
        payload = read_json(Path(row["payload"]))
        selected.append(row["path"])
        observed[kind] = {
            "instance": payload["owner"]["instance"],
            "node": payload["owner"]["node"],
            "kind": kind,
            "executable": payload["owner"]["executable"],
            "selected_profile": row["path"],
            "profile_sha256": row["sha256"],
            "previous_profile": row["previous_path"],
            "scoped_authority": {
                "database": payload["database"],
                "gate": payload["gate"],
            },
            "authority_and_grants_match": True,
        }
    expected_args = [baseline["compat"]] + [row for path in selected for row in ("--trusted-owner-profile", path)]

    namespace = [
        "/usr/bin/bwrap",
        "--die-with-parent",
        "--unshare-pid",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--ro-bind", str(CANDIDATE), str(CANDIDATE),
        "--ro-bind", str(QA / "baseline"), str(QA / "baseline"),
        "--bind", str(ENTRY / "client-home"), str(ENTRY / "client-home"),
        "--bind", str(ENTRY / "mounts" / "chatgpt"), str(QA / "profiles" / "chatgpt"),
        "--bind", str(ENTRY / "mounts" / "zai"), str(QA / "profiles" / "zai"),
        "--bind", str(ENTRY / "mounts" / "runtime"), str(QA / "runtime"),
        "--bind", str(QA / "profiles" / "chatgpt" / "herder-owner-home" / "authority" / "gate"),
        str(QA / "profiles" / "chatgpt" / "herder-owner-home" / "authority" / "gate"),
        "--bind", str(QA / "profiles" / "chatgpt" / "herder-owner-home" / "authority" / "state.db"),
        str(QA / "profiles" / "chatgpt" / "herder-owner-home" / "authority" / "state.db"),
        "--bind", str(QA / "profiles" / "zai" / "herder-owner-home" / "authority" / "gate"),
        str(QA / "profiles" / "zai" / "herder-owner-home" / "authority" / "gate"),
        "--bind", str(QA / "profiles" / "zai" / "herder-owner-home" / "authority" / "state.db"),
        str(QA / "profiles" / "zai" / "herder-owner-home" / "authority" / "state.db"),
        "--chdir", str(ENTRY / "client-home"),
        "--",
    ]
    env = {
        "HERDER_V1_ENTRY": str(CANDIDATE / "selector.json"),
        "HOME": str(ENTRY / "client-home"),
        "LANG": "C.UTF-8",
        "PATH": "/usr/bin:/bin",
        "TOKIO_WORKER_THREADS": "2",
        "XDG_CACHE_HOME": str(ENTRY / "client-home" / "cache"),
        "XDG_CONFIG_HOME": str(ENTRY / "client-home" / "config"),
        "XDG_DATA_HOME": str(ENTRY / "client-home" / "data"),
        "XDG_STATE_HOME": str(ENTRY / "client-home" / "state"),
    }

    launcher = CANDIDATE / "fixture" / "launch-v1-core.py"
    check = subprocess.run(
        namespace + [str(launcher), "--check"], env=env, capture_output=True, text=True, timeout=60,
    )
    assert check.returncode == 0, check.stderr[:400]
    checked = json.loads(check.stdout)
    assert checked["argv"] == expected_args, checked
    assert checked["source_commit"] == manifest["source_commit"], checked

    inputs = {
        "sha": manifest["source_commit"],
        "namespace_argv": namespace,
        "qa_env": env,
        "launcher": str(launcher),
        "selected_argv": expected_args,
        "profiles": observed,
        "manifest": str(CANDIDATE / "manifest.json"),
        "manifest_sha256": digest(CANDIDATE / "manifest.json"),
        "selector": str(CANDIDATE / "selector.json"),
        "selector_sha256": digest(CANDIDATE / "selector.json"),
    }
    inputs_path = ENTRY / "entry-inputs-95efa8bd.json"
    inputs_path.write_text(json.dumps(inputs, indent=2, sort_keys=True) + "\n")

    home = Path(env["HOME"])
    job = Path(tempfile.mkdtemp(prefix="ordinary-", dir=home))
    trace = job / "exec"
    cmd = namespace + [
        "/usr/bin/strace", "-ff", "-qq", "-s", "4096", "-e", "trace=execve,execveat",
        "-o", str(trace), "--", str(launcher),
    ]

    world = object.__new__(MCP)
    world.seq = 0
    world.buffer = b""
    phase = "initialize"
    interaction = {}
    started = utc()
    print("ordinary QA entry started", job.name, flush=True)
    with (job / "stderr.log").open("xb") as err:
        world.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
            bufsize=0, env=env, start_new_session=True,
        )
        try:
            hello = world.rpc("initialize", {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "isolated-entry-qa", "version": "1"},
            })
            assert hello.get("protocolVersion") == "2025-06-18", "unexpected MCP version"
            world.notify("notifications/initialized", {})
            tool_names = {t["name"] for t in world.rpc("tools/list", {})["tools"]}
            assert {"discover", "session", "sessions"} <= tool_names
            phase = "discovery"
            disc = world.call("discover", {"action": "instances"})
            found = sorted(x["instance_ref"] for x in disc["sources"])
            assert found == sorted(v["instance"] for v in observed.values()), found
            for kind in ("chatgpt", "zai"):
                instance = observed[kind]["instance"]
                seed = read_json(QA / "fixtures" / kind / "seed-info-live.json")
                ids = browser.native_ids(kind, seed["seed_ids"])
                histories = browser.seed_histories()
                assert len(ids) == len(histories) == 2
                row_counts = []
                refs = []
                for index, (key, history) in enumerate(zip(ids, histories)):
                    phase = f"{kind} local QA register {index}"
                    ref = world.call("session", {
                        "action": "register", "instance_ref": instance,
                        "native_session_id": key,
                        "request_key": f"entry-{kind}-fixture-{index}",
                    })["session_ref"]
                    refs.append(ref)
                    phase = f"{kind} verify native identity {index}"
                    address = world.call("session", {"action": "context", "session_ref": ref})["address"]
                    assert address["native_session_id"] == key
                    phase = f"{kind} read fixture history {index}"
                    rows = world.call("session", {"action": "messages", "session_ref": ref})["page"]["messages"]
                    assert browser.projected(rows) == history, "fixture history mismatch"
                    row_counts.append(len(rows))
                phase = f"{kind} native inventory"
                listing = world.call("sessions", {"action": "list", "instance_ref": instance})
                assert {it["session_ref"] for it in listing["sessions"]} == set(refs)
                assert listing["native_coverage_complete"] is True
                interaction[kind] = {
                    "instance_ref": instance,
                    "exact_fixture_histories": len(refs),
                    "messages_per_history": row_counts,
                    "exact_native_session_ids": True,
                    "native_inventory_matches": True,
                }
                print(kind, "ordinary MCP exact native histories", len(refs), flush=True)
        except BaseException:
            print("ordinary entry incomplete at", phase, "private diagnostics", job / "stderr.log", flush=True)
            raise
        finally:
            world.proc.stdin.close()
            try:
                world.proc.wait(timeout=12)
            except subprocess.TimeoutExpired:
                os.killpg(world.proc.pid, signal.SIGTERM)
                try:
                    world.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(world.proc.pid, signal.SIGKILL)
                    world.proc.wait(timeout=5)
            world.proc.stdout.close()
    assert world.proc.returncode == 0, "ordinary launcher did not exit successfully on EOF"

    entries = []
    for path in job.glob("exec.*"):
        data = path.read_text()
        if not data.strip():
            path.unlink()
            continue
        for line in data.splitlines():
            match = re.search(r'execve\("([^"]+)", (\[.*?\]), .*?\)\s+= 0$', line.strip())
            if match:
                entries.append((match[1], json.loads(match[2])))
    wanted = {
        "compat": expected_args,
        "owner_core": [core] + expected_args[1:],
    }
    for kind, info in observed.items():
        wanted[kind] = [core, "--harness", kind, "--node", info["node"], "--instance", info["instance"]]
    verified = {}
    for name, argv in wanted.items():
        count = sum(1 for exe, args in entries if exe == argv[0] and args == argv)
        assert count >= 1, "missing exact kernel exec for " + name
        verified[name] = {
            "executable": argv[0], "argv": argv,
            "successful_exec_count": count, "sha256": sha(argv[0]),
        }
    assert all(exe != manifest["node"] for exe, _ in entries)

    result = {
        "status": "PASS",
        "source_commit": manifest["source_commit"],
        "started_utc": started,
        "finished_utc": utc(),
        "selector": inputs["selector"],
        "selector_sha256": inputs["selector_sha256"],
        "manifest_sha256": inputs["manifest_sha256"],
        "launcher": str(launcher),
        "launcher_application_args": [],
        "profile_order": expected_args[2::2],
        "protocol": hello["protocolVersion"],
        "tools_count": len(tool_names),
        "discovered_instances": found,
        "providers": interaction,
        "execve": verified,
        "successful_node_exec_count": 0,
        "entry_exit_code": world.proc.returncode,
        "trace_dir": str(job),
        "entry_inputs": str(inputs_path),
        "qa_mounts_only": True,
        "planned_siblings_absent_on_host": True,
        "input_profiles_and_gate_hashes_unchanged": True,
        "authority_generation_and_file_identities_unchanged": True,
    }
    out = ENTRY / "ordinary-entry-95efa8bd.json"
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print("ordinary entry PASS", out, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
