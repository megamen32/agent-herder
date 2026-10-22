#!/usr/bin/env python3
"""Install a release candidate on one fleet node, verify it, roll back on failure.

The node keeps its native values: only sourceSha of node-config.json changes,
and it changes together with the `current` symlink, because the bootstrap
refuses a node whose configuration and release disagree.

Every step is verified against the facts: the whole payload of the manifest is
recomputed on the node, the running process must come from the new release,
and the endpoints must answer. If anything fails the node is put back on the
previous release and restarted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_payload(release: Path, expected_sha: str) -> dict:
    """Recompute every file of the release against its manifest."""
    dist = release / "dist"
    manifest = json.loads((dist / "fleet-deployment-manifest.json").read_text())
    payload = manifest["payload"]
    actual = {}
    for path in sorted(dist.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        name = path.relative_to(dist).as_posix()
        if name == "fleet-deployment-manifest.json":
            continue
        actual[name] = sha256(path)
    missing = sorted(set(payload) - set(actual))
    extra = sorted(set(actual) - set(payload))
    mismatched = sorted(name for name in set(payload) & set(actual) if payload[name] != actual[name])
    return {
        "source_sha": manifest["source_sha"],
        "source_sha_ok": manifest["source_sha"] == expected_sha,
        "payload_files": len(payload),
        "missing": missing,
        "extra": extra,
        "mismatched": mismatched,
        "index_sha256": actual.get("index.js"),
        "index_ok": actual.get("index.js") == payload.get("index.js"),
        "ok": manifest["source_sha"] == expected_sha and not missing and not extra and not mismatched
                and actual.get("index.js") == payload.get("index.js"),
    }


def http_status(url: str, timeout: float = 8.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def mcp_status(port: int, timeout: float = 10.0):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "l", "version": "1"}}}).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def switch_current(fleet: Path, sha: str):
    """Move the `current` symlink with rename(2): BSD mv -f would swallow it."""
    target = fleet / "releases" / sha
    link = fleet / "current"
    temporary = fleet / ".current.new"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    os.symlink(str(target), temporary)
    os.rename(temporary, link)


def restart(command: list):
    subprocess.run(command, check=False, capture_output=True, text=True)


def wait_port(port: int, attempts: int = 30) -> bool:
    for _ in range(attempts):
        if http_status(f"http://127.0.0.1:{port}/api/sessions", 5.0) != 0:
            return True
        time.sleep(2)
    return False


def running_release(port: int) -> str:
    """The release directory the live node process actually runs from.

    The bootstrap chdirs into the resolved release, so the working directory of
    the process is the release itself: that is the fact, not a guess about the
    command line.
    """
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"dist/index.js" not in cmdline:
            continue
        try:
            cwd = os.readlink(entry / "cwd")
        except OSError:
            continue
        if "releases/" in cwd:
            return cwd.split("releases/")[1].split("/")[0]
    return ""


def disarm_state(fleet: Path) -> str:
    for candidate in (fleet.parent / "state" / "agent-herder" / "fleet-node" / "automation-disarm.json",
                      Path.home() / ".local/state/agent-herder/fleet-node/automation-disarm.json"):
        if candidate.is_file():
            return hashlib.sha256(candidate.read_bytes()).hexdigest()[:16]
    return "absent"


def prepare_packages(fleet: Path, sha: str, previous_sha: str) -> str:
    """Give the new release the packages of the node.

    The dependency set did not change between the releases (package.json and
    the lock file are identical), so the packages of the previous release are
    exactly the ones this release needs. How they are carried differs per node:
    some keep the packages inside the release, others use a shared store. The
    new release mirrors the way of the node it replaces.
    """
    target = fleet / "releases" / sha / "node_modules"
    source = fleet / "releases" / previous_sha / "node_modules"
    if target.is_symlink() and not target.exists():
        target.unlink()
    if target.exists() or target.is_symlink():
        return "already present"
    if not source.exists() and not source.is_symlink():
        return "no source"
    if source.is_symlink():
        os.symlink(os.readlink(source), target)
        return "symlink -> " + os.readlink(source)
    subprocess.run(["cp", "-al", str(source), str(target)], check=True)
    return "copied from the previous release (hard links)"


def wait_codex_socket(config: dict, attempts: int = 30) -> bool:
    """The managed Codex socket must exist before the node is restarted.

    The bootstrap refuses a node whose managed Codex socket is missing, so a
    restart that lands in the window where the socket is gone takes the node
    down. Nothing is switched before the socket is there.
    """
    socket_path = config.get("codexSocket")
    if not socket_path:
        return True
    for _ in range(attempts):
        if Path(socket_path).exists():
            return True
        time.sleep(2)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-dir", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--restart-cmd", required=True, help="command that restarts the node")
    parser.add_argument("--previous-sha", required=True)
    arguments = parser.parse_args()

    fleet = Path(arguments.fleet_dir).expanduser()
    release = fleet / "releases" / arguments.sha
    config_path = fleet / "node-config.json"

    before = disarm_state(fleet)
    print("packages:", prepare_packages(fleet, arguments.sha, arguments.previous_sha))
    verification = verify_payload(release, arguments.sha)
    print("payload:", json.dumps({k: v for k, v in verification.items()
                                  if k not in ("missing", "extra", "mismatched")}))
    if verification["missing"] or verification["extra"] or verification["mismatched"]:
        print("payload mismatch:", verification["missing"][:5], verification["extra"][:5], verification["mismatched"][:5])
        return 1
    if not verification["source_sha_ok"]:
        print("manifest source_sha does not match the requested head")
        return 1

    config = json.loads(config_path.read_text())
    if not wait_codex_socket(config):
        print("the managed Codex socket is not there; nothing was switched")
        return 1
    backup = fleet / f"node-config-before-{arguments.sha[:8]}.json"
    shutil.copy2(config_path, backup)
    previous_sha = config.get("sourceSha")
    config["sourceSha"] = arguments.sha
    temporary = config_path.with_suffix(".json.new")
    temporary.write_text(json.dumps(config, indent=1) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, config_path)
    switch_current(fleet, arguments.sha)
    print(f"switched: current -> releases/{arguments.sha}")

    restart(arguments.restart_cmd.split())
    if not wait_port(arguments.port):
        print("the node did not come back on its port")
    time.sleep(3)

    live_sha = running_release(arguments.port)
    sessions = http_status(f"http://127.0.0.1:{arguments.port}/api/sessions")
    policy = http_status(f"http://127.0.0.1:{arguments.port}/api/automation/launch-policy")
    mcp = mcp_status(arguments.port)
    after = disarm_state(fleet)
    checks = [
        ("running process comes from the new release", live_sha == arguments.sha, live_sha or "unknown"),
        ("sessions answer", sessions == 200, str(sessions)),
        ("launch policy answers", policy in (200, 503), str(policy)),
        ("mcp answers", mcp == 200, str(mcp)),
        ("automation ban state unchanged", before == after, f"{before} -> {after}"),
    ]
    failed = 0
    for name, ok, detail in checks:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1

    if failed:
        print("rolling back to", previous_sha)
        shutil.copy2(backup, config_path)
        switch_current(fleet, previous_sha)
        restart(arguments.restart_cmd.split())
        wait_port(arguments.port)
        return 1
    print(f"accepted: node on {arguments.sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
