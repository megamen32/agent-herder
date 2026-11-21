"""Upgrade the Rust executable in an existing host-local Codex owner binding."""

import hashlib
import http.client
import json
import os
import re
import runpy
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode


def check(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_env(text, core, sha):
    for key, value in (("CORE", str(core)), ("CORE_SHA256", sha)):
        prefix = "AGENT_HERDER_LOCAL_RECOVERY_" + key + "="
        new_line = prefix + json.dumps(value)
        text, n = re.subn(
            "^" + prefix + "[^\n]*",
            lambda _, replacement=new_line: replacement,
            text,
            flags=re.MULTILINE,
        )
        check(n == 1, "expected exactly one owner " + key + " setting")
    return text


def transition(selected, running, desired, previous):
    if selected == running == desired:
        return "verified"
    check(selected == running, "cutover in progress or selected executable differs from the process")
    check(previous is None, "previous cutover needs reconciliation")
    return "switch"


def atomic(path, data, mode=0o600):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        tmp = Path(out.name)
        try:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def env_values(text):
    result = {}
    for line in text.splitlines():
        if line.startswith("AGENT_HERDER_LOCAL_RECOVERY_"):
            name, value = line.split("=", 1)
            result[name.removeprefix("AGENT_HERDER_LOCAL_RECOVERY_")] = shlex.split(value)[0]
    return result


def selected_env(dropin):
    match = re.fullmatch(r"\[Service\]\nEnvironmentFile=(/[^\n]+)\n", dropin.read_text())
    check(match, "unsupported owner EnvironmentFile binding")
    return Path(match[1])


def live(unit):
    pid = int(
        subprocess.check_output(
            ["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"], text=True, timeout=5
        )
    )
    proc = Path("/proc") / str(pid)
    children = (proc / "task" / str(pid) / "children").read_text().split()
    owners = []
    for item in children:
        try:
            child = Path("/proc") / item
            args = (child / "cmdline").read_bytes().split(b"\0")
            if b"--trusted-owner-profile" in args:
                owners.append((child, os.fsdecode(args[args.index(b"--trusted-owner-profile") + 1])))
        except FileNotFoundError:
            continue
    check(len(owners) == 1, "expected one Rust child of the routed scheduler")
    child, profile = owners[0]
    return pid, int(child.name), (child / "exe").resolve(strict=True), digest(child / "exe"), profile


def observed_owner(node, binding):
    pid, child, exe, sha, profile = live(node["unit"])
    check(
        binding["CORE_SHA256"] == sha and str(exe) == binding["CORE"] and profile == binding["PROFILE"],
        "selected owner differs from routed process",
    )
    profile_path = Path(profile)
    check(digest(profile_path) == binding["PROFILE_SHA256"], "profile changed")
    owner = json.loads(profile_path.read_bytes())["owner"]
    handoff = owner["codex_recovery"]["legacy_handoff"]
    check(
        owner["node"] == node["hostId"]
        and handoff.get("instance_wide") is True
        and json.loads(Path(handoff["activation_file"]).read_bytes()) is True,
        "instance-wide owner is inactive",
    )
    return {
        "core_pid": child,
        "scheduler_pid": pid,
        "sha256": sha,
        "profile_sha256": binding["PROFILE_SHA256"],
        "scope": "instance",
        "native_source": exe.parent.name,
    }, handoff


def verify_observation(previous, latest):
    check(
        latest["scope"] == "instance" and all(previous[k] == latest[k] for k in ("sha256", "profile_sha256")),
        "routed owner version or recovery profile changed",
    )
    return latest


def recovered_cutover(intent, observed):
    previous = intent["baseline"]
    check(previous["sha256"] != intent["sha256"], "baseline already had the desired hash")
    verify_observation(dict(previous, sha256=intent["sha256"]), observed)
    return dict(observed, status="reconciled", previous_sha256=previous["sha256"])


def prove(node, binding, bearer):
    current, handoff = observed_owner(node, binding)
    pid = current["scheduler_pid"]
    stops = json.loads(Path(handoff["human_stops"]).read_bytes())
    sample = next((r["id"] for r in stops["sessions"] if r["harness"] == "codex" and r.get("active")), None)
    # The endpoint reads ownership only. A real session is preferred when available.
    challenge = secrets.token_hex(32)
    query = urlencode(
        {
            "challenge": challenge,
            "harness": "codex",
            "nativeSessionId": sample or "herder-owner-readback",
            "nodeRef": node["hostId"],
        }
    )
    c = http.client.HTTPConnection("127.0.0.1", node["webPort"], timeout=5)
    try:
        c.request("GET", "/api/local-recovery-wait?" + query, headers={"Authorization": "Bearer " + bearer})
        response = c.getresponse()
        body = json.loads(response.read(65536))
    finally:
        c.close()
    decision = body.get("decision", {})
    check(
        response.status == 200
        and body.get("pid") == pid
        and body.get("challenge") == challenge
        and decision.get("blocked") is True
        and decision.get("recoveryOwner") == "rust"
        and decision.get("reason") in ("rust_recovery_handoff", "native_recovery_held"),
        "scheduler readback did not confirm Rust ownership",
    )
    return dict(current, reason=decision["reason"])


def await_owner(node, binding, bearer):
    until = time.monotonic() + 25
    while True:
        try:
            return prove(node, binding, bearer)
        except (OSError, RuntimeError, ValueError) as exc:
            if time.monotonic() >= until:
                raise RuntimeError("readback after restart failed: " + str(exc)) from exc
            time.sleep(0.75)


def apply(contract, gate, packet):
    node, source, desired = contract["descriptor"], contract["native_source"], contract["native_sha256"]
    check(
        re.fullmatch("[0-9a-f]{40}", source) and re.fullmatch("[0-9a-f]{64}", desired),
        "invalid release identity",
    )
    unit = node["unit"]
    dropin = Path.home() / ".config/systemd/user" / (unit + ".d") / "80-host-local-recovery.conf"
    original = dropin.read_bytes()
    old_env = selected_env(dropin)
    old_values = env_values(old_env.read_text())
    versions = old_env.parent.parent
    check(
        versions.name == "versions"
        and versions.resolve() == versions
        and old_env.name == "owner.env"
        and versions.is_relative_to(Path.home() / ".config/agent-herder"),
        "unrecognized binding location",
    )
    folder = versions / source
    target = folder / "herder_native_stdio"
    journal = folder / "previous-binding"
    reader = runpy.run_path(str(packet / "rollout-node.py"))["canonical_mcp_bearer"]
    bearer = reader(unit)
    _, _, _, running, _ = live(unit)
    if contract.get("baseline") and running != desired:
        check(
            running == contract["baseline"]["sha256"]
            and old_values["PROFILE_SHA256"] == contract["baseline"]["profile_sha256"],
            "owner changed after admission",
        )
    action = transition(
        old_values["CORE_SHA256"], running, desired, journal.read_text() if journal.exists() else None
    )
    if action == "verified":
        return dict(status="already-installed", **prove(node, old_values, bearer))
    g = prove(node, old_values, bearer)
    gate.check()
    folder.mkdir(mode=0o700, exist_ok=True)
    check(
        folder.resolve() == folder and digest(packet / "herder_native_stdio") == desired,
        "candidate hash mismatch",
    )
    check(not target.exists() or digest(target) == desired, "existing native release has different bytes")
    check(old_env.parent != folder, "candidate would overwrite the current rollback binding")
    if not target.exists():
        atomic(target, (packet / "herder_native_stdio").read_bytes(), 0o500)
    content = candidate_env(old_env.read_text(), target, desired)
    new_env = folder / "owner.env"
    atomic(new_env, content.encode())
    new_dropin = ("[Service]\nEnvironmentFile=" + str(new_env) + "\n").encode()
    gate.check()
    check(dropin.read_bytes() == original and live(unit)[1] == g["core_pid"], "owner changed before cutover")
    atomic(journal, original)
    atomic(packet / "cutover-started", original)
    atomic(dropin, new_dropin)
    command = ["systemctl", "--user"]
    try:
        subprocess.run(command + ["daemon-reload"], check=True, timeout=20)
        subprocess.run(command + ["restart", unit], check=True, timeout=90)
        result = await_owner(node, env_values(content), bearer)
    except subprocess.TimeoutExpired:
        raise RuntimeError("systemd operation still unconfirmed; inspect selected and live owner")
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError):
        gate.check(cleanup=True)
        check(dropin.read_bytes() == new_dropin, "binding changed before rollback")
        atomic(dropin, original)
        subprocess.run(command + ["daemon-reload"], check=True, timeout=20)
        subprocess.run(command + ["restart", unit], check=True, timeout=90)
        await_owner(node, old_values, bearer)
        journal.rename(folder / "rolled-back-binding")
        raise RolledBack("previous owner restored")
    return dict(status="installed", previous_sha256=running, **result)


class RolledBack(RuntimeError):
    pass


def inspect_binding(unit, host):
    import socket

    check(socket.gethostname() == host and Path(unit).name == unit, "unexpected host or service")
    dropin = Path.home() / ".config/systemd/user" / (unit + ".d") / "80-host-local-recovery.conf"
    values = env_values(selected_env(dropin).read_text())
    current, _ = observed_owner({"unit": unit, "hostId": host}, values)
    return current


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "inspect":
        print(json.dumps(inspect_binding(*sys.argv[2:])))
        return
    from remote_release_gate import RemoteReleaseGate, remote_frames

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    packet = Path(__file__).resolve().parent
    contract = json.loads((packet / "contract.json").read_bytes())
    with RemoteReleaseGate(contract, remote_frames()) as gate:
        try:
            result = apply(contract, gate, packet)
        except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
            # An untouched binding or a verified rollback has a known outcome.
            if (packet / "cutover-started").exists() and not isinstance(error, RolledBack):
                raise
            outcome = {
                "status": "rolled-back" if isinstance(error, RolledBack) else "refused-before-switch",
                "error": str(error),
            }
            atomic(packet / "result.json", json.dumps(outcome).encode())
            print(outcome["error"], file=sys.stderr, flush=True)
            gate.finish(1)
            return
        atomic(packet / "result.json", json.dumps(result).encode())
        gate.finish(0)


if __name__ == "__main__":
    main()
