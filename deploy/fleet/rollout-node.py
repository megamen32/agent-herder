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
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_rules  # noqa: E402


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
    return subprocess.run(command, check=False, capture_output=True, text=True)


def systemd_daemon_reload() -> bool:
    result = subprocess.run(["systemctl", "--user", "daemon-reload"],
                            check=False, capture_output=True, text=True)
    return result.returncode == 0


def restore_install(fleet: Path, config_path: Path, config_backup: Path,
                    release_sha: str, previous_sha: str, dropin_path: Path | None,
                    dropin_snapshot: Path | None, restart_command: list) -> None:
    atomic_copy(config_backup, config_path)
    switch_current(fleet, previous_sha)
    if dropin_path and dropin_snapshot:
        restore_systemd_release_dropin(dropin_path, dropin_snapshot, release_sha)
        if not systemd_daemon_reload():
            print("rollback systemd daemon-reload failed")
    restart(restart_command)


def wait_port(port: int, attempts: int = 30) -> bool:
    for _ in range(attempts):
        if http_status(f"http://127.0.0.1:{port}/api/sessions", 5.0) != 0:
            return True
        time.sleep(2)
    return False


def release_from_cmdline(cmdline: bytes, fleet: Path) -> str:
    """Return the immutable SHA named by an absolute release entrypoint arg."""
    root = (fleet.expanduser().resolve() / "releases").as_posix().rstrip("/")
    prefix = root + "/"
    for argument in cmdline.split(b"\0"):
        if not argument or not argument.startswith(b"/"):
            continue
        value = os.fsdecode(argument)
        if not value.startswith(prefix):
            continue
        match = re.fullmatch(r"([a-f0-9]{40})/dist/index\.js", value[len(prefix):])
        if match:
            return match.group(1)
    return ""


def linux_running_release(fleet: Path) -> str:
    """Read release identity from the live absolute Node entrypoint argument.

    The systemd WorkingDirectory intentionally remains the canonical checkout;
    cwd therefore cannot identify the immutable runtime release.
    """
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        release = release_from_cmdline(cmdline, fleet)
        if release:
            return release
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


def running_release(fleet: Path, launchd_label: str) -> str:
    if sys.platform == "darwin":
        return darwin_running_release(launchd_label)
    return linux_running_release(fleet)


def atomic_write(path: Path, content: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError(f"refusing to replace symlink: {path}")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.tmp-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def atomic_copy(source: Path, destination: Path) -> None:
    atomic_write(destination, source.read_bytes(), stat.S_IMODE(source.stat().st_mode))


def systemd_release_dropin_path(unit: str, home: Path | None = None) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", unit) or "/" in unit or ".." in unit:
        raise ValueError("unit must be a plain systemd .service name")
    base = (home or Path.home()).expanduser()
    return base / ".config" / "systemd" / "user" / f"{unit}.d" / "10-release-exec.conf"


def preserve_systemd_release_dropin(path: Path, sha: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("release SHA must be a full Git commit")
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise RuntimeError("release drop-in is not a regular file")
    existed = path.is_file()
    content = path.read_bytes() if existed else b""
    mode = stat.S_IMODE(path.stat().st_mode) if existed else 0o644
    snapshot = path.with_name(f"{path.name}.rollback-{sha}.json")
    if snapshot.exists() or snapshot.is_symlink():
        raise FileExistsError(f"release rollback snapshot already exists: {snapshot}")
    document = {
        "schemaVersion": 1,
        "sourceSha": sha,
        "existed": existed,
        "mode": mode,
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }
    atomic_write(snapshot, (json.dumps(document, sort_keys=True) + "\n").encode(), 0o600)
    return snapshot


def systemd_exec_argument(value: str) -> str:
    if not value or any(ord(char) < 0x20 or ord(char) == 0x7f for char in value):
        raise ValueError("systemd ExecStart arguments must be nonempty and contain no control characters")
    escaped = value.replace("%", "%%")
    if any(char.isspace() for char in escaped) or any(char in escaped for char in '\\"'):
        return '"' + escaped.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return escaped


def write_systemd_release_dropin(path: Path, node_bin: str, release: Path, sha: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("release SHA must be a full Git commit")
    if not Path(node_bin).is_absolute():
        raise ValueError("nodeBin must be an absolute path")
    entrypoint = (release.expanduser().resolve() / "dist" / "index.js").as_posix()
    content = (
        f"# Agent Herder immutable release {sha}\n"
        "[Service]\n"
        "ExecStart=\n"
        f"ExecStart={systemd_exec_argument(node_bin)} {systemd_exec_argument(entrypoint)}\n"
    ).encode()
    mode = stat.S_IMODE(path.stat().st_mode) if path.is_file() and not path.is_symlink() else 0o644
    atomic_write(path, content, mode)


def restore_systemd_release_dropin(path: Path, snapshot: Path, sha: str) -> None:
    document = json.loads(snapshot.read_text())
    if document.get("schemaVersion") != 1 or document.get("sourceSha") != sha:
        raise RuntimeError("release drop-in rollback snapshot identity mismatch")
    if document.get("existed") is True:
        raw = base64.b64decode(document["contentBase64"], validate=True)
        mode = document.get("mode")
        if not isinstance(mode, int) or mode < 0 or mode > 0o7777:
            raise RuntimeError("release drop-in rollback mode is invalid")
        atomic_write(path, raw, mode)
    elif document.get("existed") is False:
        if path.is_symlink():
            raise RuntimeError("refusing to remove a release drop-in symlink")
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        if path.parent.exists():
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    else:
        raise RuntimeError("release drop-in rollback snapshot is malformed")


def disarm_state(fleet: Path, state_dir: str = "") -> str:
    """A readable snapshot of the owner-level automation lever of this node.

    The lever lives in the runtime state directory of the node, which the
    service itself declares: AGENT_HERDER_AUTOPILOT_STATE_DIR. An absent
    file is an armed runtime. That is a fact to name, not a confirmation of a
    ban, so the snapshot says which file was read and what it contains.
    """
    candidates = []
    if state_dir:
        candidates.append(Path(state_dir).expanduser() / "automation-disarm.json")
    candidates.append(Path.home() / ".local/state/agent-herder/fleet-node/autopilot/automation-disarm.json")
    candidates.append(Path.home() / ".local/state/agent-herder/autopilot-live/automation-disarm.json")
    for candidate in candidates:
        if not candidate.is_file():
            continue
        raw = candidate.read_bytes()
        try:
            document = json.loads(raw)
        except json.JSONDecodeError:
            return f"unreadable:{candidate}:sha={hashlib.sha256(raw).hexdigest()[:16]}"
        records = [r for r in (document.get("records") or []) if isinstance(r, dict)]
        scopes = sorted(str(r.get("scope")) for r in records)
        forbidden = sorted(str(r.get("scope")) for r in records if r.get("forbidden"))
        return (f"file={candidate} disarmed={document.get('disarmed')}"
                f" changedBy={document.get('changedBy')} changedAt={document.get('changedAt')}"
                f" scopes={scopes or 'none'} forbidden={forbidden or 'none'}"
                f" blockedWorkKeys={len(document.get('blockedWorkKeys') or [])}"
                f" sha={hashlib.sha256(raw).hexdigest()[:16]}")
    return "absent:no-lever-file:runtime-is-armed"


def process_environment_value(unit: str, key: str) -> str:
    """One environment value of the live node process, read from /proc."""
    try:
        pid = subprocess.run(["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"],
                             capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return ""
    if not pid.isdigit():
        return ""
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return ""
    for item in raw.split(b"\0"):
        if item.startswith(key.encode() + b"="):
            return item.split(b"=", 1)[1].decode(errors="replace")
    return ""


def system_pause_state(unit: str) -> str:
    """The state of a system unit, read without --user, as information only."""
    try:
        result = subprocess.run(["systemctl", "is-active", unit], capture_output=True,
                                text=True, check=False).stdout.strip()
    except OSError:
        return "unknown"
    return result or "unknown"



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


def own_tool_caches(source: Path, target: Path) -> list:
    """The release owns the bytes of the tool caches; the packages stay links.

    The tool caches are rewritten in place by the tools of the runtime. A hard
    link to one of them would make the bytes of this release change under a
    running service, and the release would not own its own cache. The caches
    are copied, the packages stay hard links of the store.
    """
    owned = []
    for entry in sorted(source.iterdir()):
        if not release_rules.mutable_entry(entry.name):
            continue
        destination = target / entry.name
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.is_dir():
            shutil.rmtree(destination)
        if entry.is_dir() and not entry.is_symlink():
            shutil.copytree(entry, destination, symlinks=True)
        else:
            shutil.copy2(entry, destination, follow_symlinks=False)
        owned.append(entry.name)
    return owned


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
        # The tool caches of the store are copied, not linked: the release owns
        # the bytes it writes into them.
        own_tool_caches(store, target)
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
    # The tool caches of the previous release are copied, not linked: they are
    # rewritten in place, and the new release owns the bytes it writes into them.
    own_tool_caches(source, target)
    return "copied from the previous release (hard links of the packages, own bytes of the tool caches)"


def linux_release_bytes(release: Path) -> int:
    """Count this release's allocated inode blocks once, including hard links."""
    total = 0
    seen: set[tuple[int, int]] = set()
    for path in (release, *release.rglob("*")):
        info = path.lstat()
        identity = (info.st_dev, info.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        blocks = getattr(info, "st_blocks", None)
        if not isinstance(blocks, int) or blocks < 0:
            raise RuntimeError(f"release inode physical allocation is unavailable: {path}")
        total += blocks * 512
    return total


def release_budget(fleet: Path, candidate_sha: str) -> tuple[int, int]:
    releases = [p for p in (fleet / "releases").iterdir() if p.is_dir() and not p.is_symlink()]
    candidate = fleet / "releases" / candidate_sha
    if candidate not in releases:
        raise RuntimeError("candidate release is absent from the release catalog")
    if sys.platform == "darwin":
        # Census only the candidate: the previous release remains for rollback
        # and must not be charged against the candidate's own 512 MiB budget.
        probe = fleet / "mac-artifact-probe"
        config = json.loads((fleet / "node-config.json").read_text())
        expected = config.get("launcherHashes", {}).get("mac-artifact-probe")
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected) or sha256(probe) != expected:
            raise RuntimeError("release_budget_probe_identity_mismatch")
        result = subprocess.run([str(probe), str(512 * 1024**2), "30001"],
                                cwd=candidate, capture_output=True, text=True, timeout=15)
        match = re.fullmatch(r"BYTES ([0-9]+) ENTRIES ([0-9]+)\n", result.stdout)
        if result.returncode != 0 or not match:
            raise RuntimeError("release_budget_census_failed")
        return len(releases), int(match[1])
    return len(releases), linux_release_bytes(candidate)


def release_budget_admitted(count: int, size: int) -> bool:
    return count <= 2 and size <= 512 * 1024**2


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
    parser.add_argument("--unit", default="agent-herder-fleet.service",
                        help="the user unit of the node, used to read its live environment")
    parser.add_argument("--state-dir", default="",
                        help="the runtime state directory of the node; read from the live process when empty")
    parser.add_argument("--pause-unit", default="noticeplace-ai-pause.service",
                        help="the system unit of the emergency pause; reported, never changed")
    arguments = parser.parse_args()

    fleet = Path(arguments.fleet_dir).expanduser()
    release = fleet / "releases" / arguments.sha
    config_path = fleet / "node-config.json"
    state_dir = arguments.state_dir or process_environment_value(arguments.unit,
                                                                 "AGENT_HERDER_AUTOPILOT_STATE_DIR")
    print("runtime state dir:", state_dir or "unknown")
    print("emergency pause unit:", arguments.pause_unit,
          "->", system_pause_state(arguments.pause_unit))

    before = disarm_state(fleet, state_dir)
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

    release_count, release_bytes = release_budget(fleet, arguments.sha)
    print(f"release budget: directories={release_count} bytes={release_bytes}")
    if not release_budget_admitted(release_count, release_bytes):
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
    previous_sha = config.get("sourceSha")
    if previous_sha != arguments.previous_sha or not re.fullmatch(r"[a-f0-9]{40}", str(previous_sha or "")):
        print("node-config sourceSha does not match the declared rollback release; nothing was switched")
        return 1
    backup = fleet / f"node-config-before-{arguments.sha[:8]}.json"
    if backup.exists():
        # An earlier record of this release must not be overwritten: it holds
        # the configuration of the node from before that release was installed.
        backup = fleet / (f"node-config-before-{arguments.sha[:8]}."
                          f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{time.time_ns() % 1_000_000_000:09d}.json")
    try:
        atomic_copy(config_path, backup)
    except OSError as error:
        print("node-config rollback snapshot failed:", error)
        return 1

    dropin_path: Path | None = None
    dropin_snapshot: Path | None = None
    if sys.platform.startswith("linux"):
        try:
            dropin_path = systemd_release_dropin_path(arguments.unit)
            dropin_snapshot = preserve_systemd_release_dropin(dropin_path, arguments.sha)
            write_systemd_release_dropin(dropin_path, config["nodeBin"], release, arguments.sha)
        except (KeyError, OSError, RuntimeError, ValueError) as error:
            print("systemd release drop-in update failed:", error)
            if dropin_snapshot:
                try:
                    restore_systemd_release_dropin(dropin_path, dropin_snapshot, arguments.sha)
                except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as rollback_error:
                    print("systemd release drop-in restore failed:", rollback_error)
            return 1

    config["sourceSha"] = arguments.sha
    config_mode = stat.S_IMODE(config_path.stat().st_mode)
    try:
        atomic_write(config_path, (json.dumps(config, indent=1) + "\n").encode(), config_mode)
        switch_current(fleet, arguments.sha)
        if dropin_path and not systemd_daemon_reload():
            raise RuntimeError("systemd daemon-reload failed")
    except (OSError, RuntimeError, ValueError) as error:
        print("release configuration switch failed:", error)
        try:
            restore_install(fleet, config_path, backup, arguments.sha, previous_sha,
                            dropin_path, dropin_snapshot, arguments.restart_cmd.split())
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as rollback_error:
            print("rollback configuration restore failed:", rollback_error)
        return 1
    print(f"switched: current -> releases/{arguments.sha}")

    restart_result = restart(arguments.restart_cmd.split())
    if restart_result.returncode != 0:
        print("release restart command failed:", restart_result.returncode)
    if not wait_port(arguments.port):
        print("the node did not come back on its port")
    time.sleep(3)

    live_sha = running_release(fleet, arguments.launchd_label)
    sessions = http_status(f"http://127.0.0.1:{arguments.port}/api/sessions")
    policy = http_status(f"http://127.0.0.1:{arguments.port}/api/automation/launch-policy")
    mcp = mcp_status(arguments.port)
    after = disarm_state(fleet, state_dir)
    checks = [
        ("running process comes from the new release", live_sha == arguments.sha, live_sha or "unknown"),
        ("sessions answer", sessions == 200, str(sessions)),
        ("launch policy answers", policy == 200, str(policy)),
        ("mcp answers", mcp == 200, str(mcp)),
        ("automation lever unchanged", before == after, f"{before} -> {after}"),
    ]
    failed = 0
    for name, ok, detail in checks:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1

    if failed:
        print("rolling back to", previous_sha)
        try:
            restore_install(fleet, config_path, backup, arguments.sha, previous_sha,
                            dropin_path, dropin_snapshot, arguments.restart_cmd.split())
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            print("rollback configuration restore failed:", error)
            return 1
        wait_port(arguments.port)
        rollback_live = running_release(fleet, arguments.launchd_label)
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
