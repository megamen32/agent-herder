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
import re
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


def linux_running_release() -> str:
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


def darwin_running_release(label: str) -> str:
    """Read the Node child of the owned launchd job, without Linux /proc."""
    try:
        job = subprocess.run(["launchctl", "list", label], capture_output=True,
                             text=True, check=True).stdout
        match = re.search(r'"PID"\s*=\s*(\d+)\s*;', job)
        if not match:
            return ""
        watchdog_pid = int(match.group(1))
        processes = subprocess.run(["ps", "-axo", "pid=,ppid=,command="],
                                   capture_output=True, text=True, check=True).stdout
        for line in processes.splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
                continue
            if int(fields[1]) != watchdog_pid or "dist/index.js" not in fields[2]:
                continue
            entry = re.search(r"/releases/([0-9a-f]{40})/dist/index\.js(?:\s|$)", fields[2])
            if entry:
                return entry.group(1)
    except (OSError, subprocess.SubprocessError):
        return ""
    return ""


def running_release(launchd_label: str) -> str:
    if sys.platform == "darwin":
        return darwin_running_release(launchd_label)
    return linux_running_release()


def disarm_state(fleet: Path) -> str:
    for candidate in (fleet.parent / "state" / "agent-herder" / "fleet-node" / "automation-disarm.json",
                      Path.home() / ".local/state/agent-herder/fleet-node/automation-disarm.json"):
        if candidate.is_file():
            return hashlib.sha256(candidate.read_bytes()).hexdigest()[:16]
    return "absent"


def package_resolution(release: Path) -> str:
    package = release / "node_modules" / "agent-resume-mcp"
    if not package.exists():
        return ""
    try:
        return str(package.resolve(strict=True))
    except OSError:
        return ""


def package_tree_digest(root: Path) -> tuple[str, int]:
    files = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            files[path.relative_to(root).as_posix()] = "symlink:" + os.readlink(path)
        elif path.is_file():
            files[path.relative_to(root).as_posix()] = sha256(path)
    payload = "".join(f"{name}\0{files[name]}\n" for name in sorted(files)).encode()
    return hashlib.sha256(payload).hexdigest(), len(files)


def archived_runtime_lines(package: Path) -> int:
    source = package / "dist" / "harness" / "opencode" / "client.js"
    if not source.is_file():
        return -1
    return sum("archived" in line for line in source.read_text(errors="replace").splitlines())


def verify_agent_resume_layout(fleet: Path, sha: str) -> bool:
    release = fleet / "releases" / sha
    expected_package = release / "packages" / "agent-resume"
    try:
        config = json.loads((fleet / "node-config.json").read_text())
        resolver = (
            'const {createRequire}=require("module");'
            'const fs=require("fs");'
            'const entry=process.argv[1];'
            'console.log(fs.realpathSync(createRequire(entry).resolve("agent-resume-mcp")))'
        )
        result = subprocess.run([config["nodeBin"], "-e", resolver,
                                 str(release / "dist" / "index.js")],
                                capture_output=True, text=True, check=True, timeout=10)
        imported_entry = Path(result.stdout.strip()).resolve(strict=True)
        imported_package = imported_entry.parent.parent
        imported_digest, imported_files = package_tree_digest(imported_package)
        expected_digest, expected_files = package_tree_digest(expected_package.resolve(strict=True))
        store_package = Path(os.path.realpath(fleet / "node_modules" / "agent-resume-mcp"))
        imported_archived = archived_runtime_lines(imported_package)
        store_archived = archived_runtime_lines(store_package)
        print("agent-resume:", json.dumps({
            "imported_entry": str(imported_entry),
            "imported_package_sha256": imported_digest,
            "release_package_sha256": expected_digest,
            "imported_files": imported_files,
            "release_files": expected_files,
            "imported_archived_lines": imported_archived,
            "root_store_archived_lines": store_archived,
        }))
        within_release = os.path.commonpath([str(imported_package), str(release.resolve())]) == str(release.resolve())
        return (within_release and imported_package == expected_package.resolve(strict=True)
                and imported_digest == expected_digest and imported_files == expected_files
                and imported_archived == 9 and store_archived == 0)
    except (KeyError, OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        print("agent-resume: verification failed")
        return False


def prepare_packages(fleet: Path, sha: str, previous_sha: str,
                     release_local_packages: bool = False) -> str:
    """Give the new release the packages of the node.

    The dependency set did not change between the releases (package.json and
    the lock file are identical), so the packages of the previous release are
    exactly the ones this release needs. How they are carried differs per node:
    some keep the packages inside the release, others use a shared store. The
    new release mirrors the way of the node it replaces.
    """
    target = fleet / "releases" / sha / "node_modules"
    source = fleet / "releases" / previous_sha / "node_modules"
    if release_local_packages:
        store = fleet / "node_modules"
        candidate_package = fleet / "releases" / sha / "packages" / "agent-resume"
        package_json = candidate_package / "package.json"
        if not store.is_dir() or store.is_symlink():
            raise RuntimeError("release-local package mode requires the root node_modules store")
        if not candidate_package.is_dir() or not package_json.is_file():
            raise RuntimeError("candidate release is missing packages/agent-resume")
        metadata = json.loads(package_json.read_text())
        if metadata.get("name") != "agent-resume-mcp":
            raise RuntimeError("candidate packages/agent-resume is not agent-resume-mcp")
        if target.exists() or target.is_symlink():
            # Only the symlink to the store may be replaced: a symlink carries
            # no bytes, and the store itself stays untouched, because the
            # rollback release still resolves its package through it.
            link_target = os.path.realpath(target.parent / os.readlink(target)) if target.is_symlink() else ""
            if link_target != os.path.realpath(store):
                raise RuntimeError("release-local node_modules must be absent before package preparation")
            target.unlink()
        previous_resolution = package_resolution(fleet / "releases" / previous_sha)
        target.mkdir(parents=True)
        # Hard links: the release gets its own tree that shares the bytes of
        # the store. The store element agent-resume-mcp is left out on purpose,
        # because the release must use its own package, not the one of the
        # store. The store element may be a symlink or a real directory; in
        # both cases it stays exactly as it is.
        children = [child for child in sorted(store.iterdir()) if child.name != "agent-resume-mcp"]
        if children:
            subprocess.run(["cp", "-al"] + [str(child) for child in children] + [str(target)], check=True)
        resume = target / "agent-resume-mcp"
        if resume.exists() or resume.is_symlink():
            raise RuntimeError("release-local node_modules already carries agent-resume-mcp")
        os.symlink("../packages/agent-resume", resume)
        candidate_resolution = package_resolution(fleet / "releases" / sha)
        if candidate_resolution != str(candidate_package.resolve(strict=True)):
            raise RuntimeError("candidate agent-resume-mcp does not resolve inside the new release")
        if previous_resolution and package_resolution(fleet / "releases" / previous_sha) != previous_resolution:
            raise RuntimeError("previous release package resolution changed during preparation")
        return f"release-local hard-link copy of {store}; agent-resume-mcp -> {candidate_resolution}; rollback resolves to {previous_resolution or 'UNRESOLVED'}"
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


def release_budget(fleet: Path) -> tuple[int, int]:
    releases = [p for p in (fleet / "releases").iterdir() if p.is_dir() and not p.is_symlink()]
    total = 0
    for release in releases:
        for path in release.rglob("*"):
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
    return len(releases), total


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
    parser.add_argument("--launchd-label", default="com.bezrabotnyi.agent-herder-fleet-node")
    parser.add_argument("--release-local-packages", action="store_true",
                        help="copy the root package store into this release and bind agent-resume-mcp to this release's packages/agent-resume")
    arguments = parser.parse_args()

    fleet = Path(arguments.fleet_dir).expanduser()
    release = fleet / "releases" / arguments.sha
    config_path = fleet / "node-config.json"

    before = disarm_state(fleet)
    try:
        package_result = prepare_packages(fleet, arguments.sha, arguments.previous_sha,
                                          arguments.release_local_packages)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        print("package preparation failed:", error)
        return 1
    print("packages:", package_result)
    verification = verify_payload(release, arguments.sha)
    print("payload:", json.dumps({k: v for k, v in verification.items()
                                  if k not in ("missing", "extra", "mismatched")}))
    if verification["missing"] or verification["extra"] or verification["mismatched"]:
        print("payload mismatch:", verification["missing"][:5], verification["extra"][:5], verification["mismatched"][:5])
        return 1
    if not verification["source_sha_ok"]:
        print("manifest source_sha does not match the requested head")
        return 1

    if arguments.release_local_packages and not verify_agent_resume_layout(fleet, arguments.sha):
        print("imported agent-resume is not the exact package inside this release; nothing was switched")
        return 1

    release_count, release_bytes = release_budget(fleet)
    print(f"release budget: directories={release_count} bytes={release_bytes}")
    if release_count > 2 or release_bytes > 512 * 1024**2:
        print("release budget exceeded; nothing was switched")
        return 1
    previous_resolution = package_resolution(fleet / "releases" / arguments.previous_sha)
    if arguments.release_local_packages and not previous_resolution:
        print("rollback release agent-resume-mcp does not resolve; nothing was switched")
        return 1

    config = json.loads(config_path.read_text())
    if not wait_codex_socket(config):
        print("the managed Codex socket is not there; nothing was switched")
        return 1
    backup = fleet / f"node-config-before-{arguments.sha[:8]}.json"
    if backup.exists():
        # An earlier record of this release must not be overwritten: it holds
        # the configuration of the node from before that release was installed.
        backup = fleet / (f"node-config-before-{arguments.sha[:8]}."
                          f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json")
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

    live_sha = running_release(arguments.launchd_label)
    sessions = http_status(f"http://127.0.0.1:{arguments.port}/api/sessions")
    policy = http_status(f"http://127.0.0.1:{arguments.port}/api/automation/launch-policy")
    mcp = mcp_status(arguments.port)
    after = disarm_state(fleet)
    checks = [
        ("running process comes from the new release", live_sha == arguments.sha, live_sha or "unknown"),
        ("sessions answer", sessions == 200, str(sessions)),
        ("launch policy answers", policy == 200, str(policy)),
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
        rollback_live = running_release(arguments.launchd_label)
        rollback_sessions = http_status(f"http://127.0.0.1:{arguments.port}/api/sessions")
        rollback_policy = http_status(f"http://127.0.0.1:{arguments.port}/api/automation/launch-policy")
        rollback_mcp = mcp_status(arguments.port)
        rollback_resolution = package_resolution(fleet / "releases" / previous_sha)
        print(f"rollback proof: process={rollback_live} sessions={rollback_sessions} policy={rollback_policy} mcp={rollback_mcp} agent-resume={rollback_resolution or 'UNRESOLVED'}")
        return 1
    print(f"accepted: node on {arguments.sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
