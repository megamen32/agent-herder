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
import plistlib
from pathlib import Path
import re
import shutil
import shlex
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


def canonical_mcp_bearer(unit: str) -> str:
    """Resolve the existing runtime credential; never provision a new one.

    Darwin's watchdog starts the normal runtime, whose loadSecretEnvironment
    resolves herder.env fingerprints through the protected secret store.
    Linux continues to use the effective running process environment.
    """
    if sys.platform != "darwin":
        return process_environment_value(unit, "AGENT_HERDER_HTTP_TOKEN").strip()

    def protected_text(path: Path) -> str:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            before = os.fstat(handle.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                    or before.st_mode & 0o077 or before.st_size > 65536):
                raise ValueError("canonical_mcp_credential_unverified")
            content = handle.read(65537)
            after = os.fstat(handle.fileno())
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
            if identity(before) != identity(after) or len(content) > 65536:
                raise ValueError("canonical_mcp_credential_changed")
            return content

    base = Path.home() / ".config" / "agent-herder"
    marker = ""
    for line in protected_text(base / "herder.env").splitlines():
        match = re.fullmatch(r"\s*(?:export\s+)?AGENT_HERDER_HTTP_TOKEN\s*=\s*(.*?)\s*", line)
        if match:
            parts = shlex.split(match.group(1), comments=True, posix=True)
            if len(parts) != 1:
                raise ValueError("canonical_mcp_credential_invalid")
            marker = parts[0]
    if not marker:
        raise ValueError("canonical_mcp_credential_missing")
    if not re.fullmatch(r"sha256:[0-9a-f]{16}", marker):
        return marker
    store = json.loads(protected_text(base / "secrets.json"))
    token = store.get("secrets", {}).get("AGENT_HERDER_HTTP_TOKEN")
    if (not isinstance(token, str) or not token
            or "sha256:" + hashlib.sha256(token.encode()).hexdigest()[:16] != marker):
        raise ValueError("canonical_mcp_credential_fingerprint_mismatch")
    return token


def mcp_status(port: int, timeout: float = 10.0, unit: str = "agent-herder-fleet.service", input_id: str = "", canonical_bearer: str | None = None):
    """Readiness uses native owner authentication; a 401 is never success.

    Reuse the running unit's canonical bearer when configured. A tokenless
    managed node can issue one ephemeral token through its existing local
    owner API. Keep it in memory and revoke it before returning.
    """
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "l", "version": "1"}}}).encode()
    origin = f"http://127.0.0.1:{port}"
    token = (process_environment_value(unit, "AGENT_HERDER_HTTP_TOKEN")
             if canonical_bearer is None else canonical_bearer).strip()
    issued_id = None
    status = 0
    def owner_action(payload):
        request = urllib.request.Request(origin + "/api/mcp-connection", data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "Origin": origin})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(16384))
    def initialize(bearer):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        request = urllib.request.Request(origin + "/mcp", data=body, method="POST", headers=headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(256)
            return response.status
    try:
        try:
            status = initialize(token)
        except urllib.error.HTTPError as error:
            status = error.code
        if status == 401 and not token:
            # The deployment identity is durable across a lost issue reply:
            # another invocation cannot silently issue a second credential.
            issued = owner_action({"action": "issue", "name": "Herder deploy readiness", "inputId": input_id or f"deploy-readiness-{unit}-{port}"})
            issued_id = issued.get("record", {}).get("id")
            token = issued.get("token", "")
            if not issued_id or not token:
                return 0
            status = initialize(token)
        return status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0
    finally:
        if issued_id:
            try:
                owner_action({"action": "revoke", "id": issued_id})
            except Exception:
                # Do not hide an orphaned deploy token behind a successful
                # readiness response. No automatic reissue/retry occurs here.
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


def wait_release_ready(fleet: Path, sha: str, port: int, launchd_label: str,
                       unit: str, budget_seconds: float = 210.0,
                       canonical_bearer: str | None = None) -> dict:
    """Wait for the selected generation, within the former 30*(5+2)s window.

    An old listener cannot satisfy readiness. Retry transport/startup failures,
    never authentication or contract refusals. Tokenless MCP issuance retains
    its existing UNKNOWN/no-reissue boundary.
    """
    deadline = time.monotonic() + budget_seconds
    result = {"live_sha": "", "sessions": 0, "policy": 0, "mcp": 0,
              "reason": "startup_deadline"}
    transient = {0, 408, 425, 429, 500, 502, 503, 504}
    while time.monotonic() < deadline:
        result["live_sha"] = running_release(fleet, launchd_label)
        if result["live_sha"] == sha:
            for key, path in (("sessions", "/api/sessions"),
                              ("policy", "/api/automation/launch-policy")):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return result
                result[key] = http_status(f"http://127.0.0.1:{port}{path}",
                                          timeout=min(8.0, remaining))
                if result[key] != 200:
                    if result[key] not in transient:
                        result["reason"] = f"{key}_refused"
                        return result
                    break
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return result
                # MCP may perform initialize/issue/initialize/revoke. Divide
                # remaining time across all four calls rather than extending
                # the startup window with another independent timeout.
                has_canonical_bearer = bool((process_environment_value(unit, "AGENT_HERDER_HTTP_TOKEN")
                    if canonical_bearer is None else canonical_bearer).strip())
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return result
                result["mcp"] = mcp_status(port, timeout=min(10.0, remaining / 4), unit=unit,
                    input_id=f"deploy-readiness-{sha}-{unit}", canonical_bearer=canonical_bearer)
                if result["mcp"] == 200:
                    result["live_sha"] = running_release(fleet, launchd_label)
                    result["reason"] = "ready" if result["live_sha"] == sha else "generation_changed"
                    return result
                if result["mcp"] not in transient:
                    result["reason"] = "mcp_refused"
                    return result
                if not has_canonical_bearer:
                    result["reason"] = "mcp_credential_outcome_unknown"
                    return result
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(2.0, remaining))
    return result


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


def unit_entrypoint(unit: str) -> str:
    """The ExecStart of the live unit, as systemd reports it.

    The entrypoint is the fact that says what kind of node this is: the owner
    node runs the release itself, the fleet node runs the node through its
    bootstrap. A fleet node that is started by its bootstrap must keep it.
    """
    result = subprocess.run(["systemctl", "--user", "show", unit, "-p", "ExecStart", "--value"],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip()


def darwin_fleet_launchd_proof(fleet: Path, label: str) -> dict:
    """Prove the loaded LaunchAgent owns this fleet watchdog on Darwin."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", label):
        raise ValueError("launchagent_label_invalid")
    uid = os.getuid()
    base = fleet.expanduser().resolve(strict=True)
    watchdog = (base / "mac-node-watchdog.py").resolve(strict=True)
    if watchdog.parent != base or not watchdog.is_file():
        raise ValueError("launchagent_watchdog_invalid")

    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
    try:
        plist_stat = plist_path.lstat()
        if (not stat.S_ISREG(plist_stat.st_mode) or plist_stat.st_uid != uid
                or stat.S_IMODE(plist_stat.st_mode) & 0o022):
            raise ValueError("launchagent_identity_mismatch")
        plist = plistlib.loads(plist_path.read_bytes())
    except (OSError, plistlib.InvalidFileException) as error:
        raise ValueError("launchagent_unavailable") from error
    if not isinstance(plist, dict):
        raise ValueError("launchagent_format_invalid")
    args = plist.get("ProgramArguments")
    if (plist.get("Label") != label or not isinstance(args, list) or len(args) != 5
            or args[1:4] != ["-I", "-S", "-B"]
            or not isinstance(args[0], str) or not Path(args[0]).is_absolute()
            or not Path(args[0]).is_file() or not os.access(args[0], os.X_OK)
            or not isinstance(args[-1], str)
            or Path(args[-1]).resolve() != watchdog
            or plist.get("RunAtLoad") is not True or plist.get("KeepAlive") is not False):
        raise ValueError("launchagent_program_mismatch")

    plist_realpath = str(plist_path.resolve(strict=True))
    matches = []
    for domain in (f"gui/{uid}", f"user/{uid}"):
        result = subprocess.run(["launchctl", "print", f"{domain}/{label}"],
                                capture_output=True, text=True, check=False, timeout=5)
        if result.returncode != 0:
            # A missing service in one domain is expected when the same user
            # has only one active LaunchAgent domain. Other failures are not.
            if "Could not find service" in result.stderr:
                continue
            raise ValueError("launchagent_domain_unverifiable")
        fields = {}
        for line in result.stdout.splitlines():
            match = re.match(r"\s*(path|state|pid|program)\s*=\s*(.*?)\s*$", line)
            if match:
                fields[match.group(1)] = match.group(2)
        if (fields.get("path") != plist_realpath or fields.get("state") != "running"
                or not (fields.get("pid") or "").isdigit()
                or fields.get("program") != args[0]):
            raise ValueError("launchagent_runtime_mismatch")
        matches.append({"domain": domain, "pid": fields["pid"]})
    if len(matches) != 1:
        raise ValueError("launchagent_domain_ambiguous" if matches else "launchagent_not_loaded")
    return {**matches[0], "plist": plist_realpath, "program": args[0],
            "entrypoint": str(watchdog)}


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
    """A diagnostic only: the lines of the client that hold the word "archived".

    The word belongs to the archived sessions of the harness, so the number
    says nothing about the origin of a package: it is an accident of the
    content of the file. The published package of another version had none of
    them, the package of the repo has nine, and the next publish of the
    package moves the number. It is printed as a fact of the two packages and
    it is not a condition of the acceptance.
    """
    source = package / "dist" / "harness" / "opencode" / "client.js"
    if not source.is_file():
        return -1
    return sum("archived" in line for line in source.read_text(errors="replace").splitlines())


def root_store_offers_release_copy(store_package: Path, expected_digest: str) -> dict:
    """Does the root store of the area offer the package of the release as a copy?

    The import of the workspace package must come from the release. The
    resolver of Node looks for a directory named node_modules in every parent
    of the file it resolves, so a copy of the package that lies in the root
    store of the area is reachable, and the runtime can import that copy
    instead of the package of the release.

    The root store of the area is the shared store of the area since the
    takeover of the root, and the shared store does not carry the workspace
    package at all: it is a link into the release. The legacy layout of the
    root store carried the published package of another version. Neither of
    them is a copy of the package of the release, and neither of them is a
    source the import can come from. A copy of the package of the release in
    the root store is the archived copy the resolver could reach, and it is
    refused.
    """
    if not store_package.exists():
        return {"state": "absent", "copy": False, "sha256": ""}
    digest, _ = package_tree_digest(store_package)
    return {"state": "present", "copy": digest == expected_digest, "sha256": digest}


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
        root_store = root_store_offers_release_copy(store_package, expected_digest)
        print("agent-resume:", json.dumps({
            "imported_entry": str(imported_entry),
            "imported_package_sha256": imported_digest,
            "release_package_sha256": expected_digest,
            "imported_files": imported_files,
            "release_files": expected_files,
            "imported_archived_lines": imported_archived,
            "root_store_archived_lines": store_archived,
            "root_store": root_store,
        }))
        within_release = os.path.commonpath([str(imported_package), str(release.resolve())]) == str(release.resolve())
        # The import must be the package of the release: the same path, the
        # same bytes, the same number of files. The root store of the area
        # must not offer that package as a copy - the resolver of Node can
        # reach it, and the import could come from that copy instead.
        return (within_release and imported_package == expected_package.resolve(strict=True)
                and imported_digest == expected_digest and imported_files == expected_files
                and not root_store["copy"])
    except (KeyError, OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        print("agent-resume: verification failed")
        return False


def own_tool_caches(source: Path, target: Path) -> list:
    """The release owns the bytes of its tool caches; the packages stay links.

    The tool caches are rewritten in place by the tools of the runtime. A hard
    link to one of them would make the bytes of this release change under a
    running service, and the release would not own its own cache. The caches
    are copied, the packages stay links of the shared store.
    """
    return release_rules.own_tool_caches(source, target)

def prepare_packages(fleet: Path, sha: str, previous_sha: str,
                     release_local_packages: bool = False) -> str:
    """Give the new release the packages of the node.

    The packages live in the shared store of the node: one directory per
    dependency set, named by the hash of the lock file of the release. The
    release links them, and the bytes of the packages are hard links of the
    store of the node, so the shared store costs no new disk. The workspace
    package stays a link into the release, so the import from the release is
    never lost.

    A node whose store is absent is refused with a clear reason: the release
    is never given a link that points nowhere.
    """
    release = fleet / "releases" / sha
    target = release / "node_modules"
    previous = fleet / "releases" / previous_sha
    store = fleet / "node_modules"
    if release_local_packages:
        source = store
    else:
        source = previous / "node_modules"
        if source.is_symlink() or not source.is_dir():
            source = store
    # The root of the area can be the link to the shared store of the
    # dependency set (ensure_area_package_root): a link carries no packages of
    # its own, so the store it names is the source of the packages.
    materialization_source = source
    if materialization_source.is_symlink():
        resolved = materialization_source.resolve()
        if resolved.is_dir():
            materialization_source = resolved
    if materialization_source.is_symlink() or not materialization_source.is_dir():
        raise RuntimeError(
            f"the shared package store of the node is absent: {store}")
    identity = release_rules.dependency_identity(release, previous, materialization_source)
    store_dir = release_rules.shared_store_dir(fleet, identity)
    if store_dir.is_dir():
        release_rules.verify_shared_store(store_dir, identity)
        created = False
    else:
        release_rules.materialize_shared_store(materialization_source, store_dir, identity)
        created = True
    # The store must offer its packages to the resolver of Node under the
    # name the resolver looks for. The store is named
    # shared-node-modules/<identity>, so the resolver of a package of the
    # store walks out of it and reaches the area of the node - and there the
    # legacy root store of the node holds the resolution.
    store_root = release_rules.ensure_store_package_root(store_dir)
    # The release that is the point of rollback must stay resolvable: its
    # store offers its own packages, so the resolver of that release stays
    # inside the store it was verified against.
    rollback_store_root = {"state": "absent"}
    try:
        previous_store = release_rules.shared_store_dir(
            fleet, release_rules.dependency_identity(previous))
    except RuntimeError:
        previous_store = None
    if previous_store is not None and previous_store.is_dir():
        rollback_store_root = release_rules.ensure_store_package_root(previous_store)
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        if not release_rules.is_package_farm(target):
            raise RuntimeError(
                f"the release already carries a package tree of its own: {target}")
        shutil.rmtree(target)
    linked = release_rules.link_release_packages(release, store_dir)
    caches = release_rules.own_tool_caches(source, target)
    candidate_package = release / "packages" / "agent-resume"
    if not candidate_package.is_dir():
        raise RuntimeError("candidate release is missing packages/agent-resume")
    candidate_resolution = package_resolution(release)
    if candidate_resolution != str(candidate_package.resolve(strict=True)):
        raise RuntimeError("candidate agent-resume-mcp does not resolve inside the new release")
    previous_resolution = package_resolution(previous)
    if previous_resolution and package_resolution(previous) != previous_resolution:
        raise RuntimeError("previous release package resolution changed during preparation")
    # The resolver of Node walks up the real path of a package of the store and
    # looks for a directory named "node_modules" in every parent. The area must
    # offer the store under that name, or the runtime does not start at all.
    # The root of the area must offer the store to the resolver of Node. A
    # legacy root store of the node holds the resolution there, so it moves
    # aside before the root is taken: its bytes stay, and the owner decides
    # about them.
    takeover = release_rules.take_over_area_package_root(fleet, store_dir)
    area_root = release_rules.ensure_area_package_root(fleet, store_dir)
    moved = takeover.get("moved")
    return (f"shared store {store_dir} (created={created}); {linked}; "
            f"{len(caches)} tool caches owned by the release; "
            f"agent-resume-mcp -> {candidate_resolution}; "
            f"store package root {store_root['path']} state={store_root['state']}; "
            f"rollback store package root state={rollback_store_root['state']}; "
            f"area package root {area_root['path']} state={area_root['state']}"
            + (f"; the legacy root store moved aside: {moved}" if moved else ""))

def linux_release_bytes(release: Path) -> int:
    """Count allocated blocks introduced by this release, once per inode.

    The installer hard-links packages from the rollback release. Those blocks
    already exist on disk and must not be charged as new candidate allocation.
    """
    paths = (release, *release.rglob("*"))
    inodes: dict[tuple[int, int], tuple[os.stat_result, int, Path]] = {}
    for path in paths:
        info = path.lstat()
        identity = (info.st_dev, info.st_ino)
        previous = inodes.get(identity)
        inodes[identity] = (info, 1 if previous is None else previous[1] + 1,
                            path if previous is None else previous[2])

    total = 0
    for info, candidate_links, path in inodes.values():
        # A link count larger than the number of candidate paths means this
        # inode is shared with an already-existing release or package store.
        if stat.S_ISREG(info.st_mode) and info.st_nlink > candidate_links:
            continue
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
    parser.add_argument("--kind", required=True, choices=["owner", "fleet"],
                        help="owner: the unit runs the release itself, a release drop-in names it; "
                             "fleet: the unit starts the node through bootstrap.py, the release is "
                             "selected by the current symlink and no release drop-in is written")
    parser.add_argument("--state-dir", default="",
                        help="the runtime state directory of the node; read from the live process when empty")
    parser.add_argument("--pause-unit", default="noticeplace-ai-pause.service",
                        help="the system unit of the emergency pause; reported, never changed")
    arguments = parser.parse_args()

    fleet = Path(arguments.fleet_dir).expanduser()
    release = fleet / "releases" / arguments.sha
    config_path = fleet / "node-config.json"
    try:
        readiness_bearer = canonical_mcp_bearer(arguments.unit) if sys.platform == "darwin" else None
    except (OSError, ValueError, TypeError):
        print("canonical MCP credential could not be verified; nothing was switched")
        return 1
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
    if arguments.kind == "fleet":
        # A fleet node is started through its bootstrap: the release is chosen
        # by the current symlink and the sourceSha of the node config. A
        # release drop-in would replace the bootstrap with the release itself,
        # and the node would lose the port of its own config: it would take
        # the port of the unit, which another service may own.
        if sys.platform == "darwin":
            try:
                proof = darwin_fleet_launchd_proof(fleet, arguments.launchd_label)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                print("the fleet LaunchAgent is not verified; nothing was switched:", str(error))
                return 1
            expected_restart = ["launchctl", "kickstart", "-k",
                                f"{proof['domain']}/{arguments.launchd_label}"]
            if arguments.restart_cmd.split() != expected_restart:
                print("the restart command does not target the verified fleet LaunchAgent; nothing was switched")
                return 1
            print("fleet node: verified LaunchAgent selects the release through node-config/current; no release drop-in is written")
        else:
            entrypoint = unit_entrypoint(arguments.unit)
            if "bootstrap.py" not in entrypoint:
                print("the fleet unit does not start the node through bootstrap.py; nothing was switched:",
                      entrypoint[:160])
                return 1
            print("fleet node: the release is selected by the current symlink; no release drop-in is written")
    elif sys.platform.startswith("linux"):
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
    readiness = wait_release_ready(fleet, arguments.sha, arguments.port,
                                   arguments.launchd_label, arguments.unit,
                                   canonical_bearer=readiness_bearer)
    print("release readiness:", readiness["reason"])
    live_sha, sessions, policy, mcp = (readiness[key] for key in ("live_sha", "sessions", "policy", "mcp"))
    after = disarm_state(fleet, state_dir)
    checks = [
        ("readiness belongs to the new generation", readiness["reason"] == "ready", readiness["reason"]),
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
        rollback_mcp = mcp_status(arguments.port, unit=arguments.unit, input_id=f"deploy-readiness-{previous_sha}-{arguments.unit}", canonical_bearer=readiness_bearer)
        rollback_resolution = package_resolution(fleet / "releases" / previous_sha)
        print(f"rollback proof: process={rollback_live} sessions={rollback_sessions} policy={rollback_policy} mcp={rollback_mcp} agent-resume={rollback_resolution or 'UNRESOLVED'}")
        return 1
    print(f"accepted: node on {arguments.sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
