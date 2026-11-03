#!/usr/bin/env python3
"""Roll one verified release candidate out to one configured fleet node.

    python3 deploy/fleet/rollout-candidate.py --sha <sha> --node linux-a \\
      --deployment-config /absolute/private/deployment.json --dry-run

For mutation, supply the existing protected --release-proof on the controller.
The private settings file selects the exact target, interpreter and authority
mapping; there is no repository topology fallback or fleet-wide default.
The configured controller supports fleet nodes only. Owner profiles are
explicitly refused; the legacy explicit owner node-side workflow is separate.

Superseded releases remain recoverable in rollback/. Existing release budgets,
payload checks, target locks, authority fences, revision CAS and authenticated
readiness remain mandatory. Darwin startup and rollback are tied to exact
captured process generations. Unknown ownership or transport outcome is retained
for read-only reconciliation, never treated as permission to retry or signal
another process. No unrelated service or security setting is changed.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_rules  # noqa: E402
from release_gate import ReleaseGate
from remote_release_gate import RemoteReleaseGate, remote_frames, run_authorized_ssh, deployment_target
import uuid
import re
from deployment_config import load_config, validate_node, descriptor_digest, verify_descriptor, load_remote_descriptor

DEFAULT_CATALOG = Path.home() / "agents-projects/.fleet-candidate"
BUDGET_MIB = 512
MAX_RELEASES = 2
PACKAGED = ("dist", "packages", "package.json", "package-lock.json", "build-manifest.json")


def remote_python_command(node):
    node = validate_node(node)
    return [node["pythonBin"], "-I", "-B"]


def verify_remote_python(ssh, node):
    node = validate_node(node)
    command = remote_python_command(node) + ["-c",
        "import sys,json; print(json.dumps(dict(version='.'.join(map(str,sys.version_info[:3])),executable=sys.executable)))"]
    result = subprocess.run(ssh + [" ".join(shlex.quote(x) for x in command)],
                            capture_output=True, text=True, check=True, timeout=30)
    try:
        observed = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("release_remote_python_version_unverified") from None
    if observed != {"version": node["pythonVersion"], "executable": node["pythonExecutable"]}:
        raise RuntimeError("release_remote_python_identity_changed")


def load_nodes(path=None) -> dict:
    return load_config(path)


def node_spec(topology: dict, node_id: str) -> dict:
    for node in topology["nodes"]:
        if node["id"] == node_id:
            return node
    raise SystemExit(f"unknown node {node_id}; known: {[n['id'] for n in topology['nodes']]}")


def expand(value: str) -> str:
    return os.path.expanduser(value)


def remote_live_sha(node: dict) -> str:
    """The release the node runs now, read from the node itself."""
    fleet = expand(node["fleetDir"])
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "-p", str(node.get("sshPort", 22)),
               f"{node['sshUser']}@{node['address']}", "readlink " + shlex.quote(fleet + "/current")]
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=30)
    if result.returncode != 0:
        return ""
    return os.path.basename(result.stdout.strip())


def add_own_bytes(archive: tarfile.TarFile, source: Path, arcname: str) -> None:
    """The path goes into the archive as bytes of its own.

    A regular file is added as a regular file, never as a link: the hard links
    of the tree are dereferenced, so the archive cannot carry the shared inode
    of one release into the node. A symlink stays a symlink: it names a path,
    not bytes.
    """
    if source.is_symlink():
        info = archive.gettarinfo(str(source), arcname=arcname)
        info.type = tarfile.SYMTYPE
        info.linkname = os.readlink(source)
        archive.addfile(info)
        return
    if source.is_dir():
        info = archive.gettarinfo(str(source), arcname=arcname)
        info.type = tarfile.DIRTYPE
        archive.addfile(info)
        for entry in sorted(source.iterdir()):
            add_own_bytes(archive, entry, f"{arcname}/{entry.name}")
        return
    info = archive.gettarinfo(str(source), arcname=arcname)
    info.type = tarfile.REGTYPE
    info.linkname = ""
    info.size = source.stat().st_size
    with source.open("rb") as handle:
        archive.addfile(info, handle)


def pack_release(release: Path, target: Path) -> Path:
    """The release without its own node_modules: the node builds its own.

    The archive carries the bytes of every file. A hard link of the release is
    stored as a file of its own, so the node cannot receive a release whose
    bytes are the bytes of another one.
    """
    with tarfile.open(target, "w") as archive:
        for name in PACKAGED:
            source = release / name
            if source.exists():
                add_own_bytes(archive, source, f"./{name}")
    return target


def release_dirs(root: Path) -> list:
    if not root.is_dir():
        return []
    return sorted((item for item in root.iterdir() if item.is_dir()),
                  key=lambda item: item.stat().st_mtime)


def release_bytes(root: Path) -> int:
    total = 0
    for release in release_dirs(root):
        for path in release.rglob("*"):
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
    return total


def trim_releases(releases_root: Path, rollback_root: Path, keep: str, prefer: str = "",
                  keep_only: bool = False, keep_pair: bool = False) -> dict:
    """Move the superseded releases to rollback/.

    The bytes are never deleted. With keep_only the owner node keeps one
    release directory: the new one. The release that is live now is the point
    of rollback, so its drop-in is rewritten to the place it moves to, and
    the rollback stays a real, startable release.

    Without keep_only the budget decides: the release that is live now is
    moved last, so it is only given up when the budget leaves no other choice.
    """
    rollback_root.mkdir(parents=True, exist_ok=True)
    moved = {}
    if keep_only:
        for release in release_dirs(releases_root):
            if release.name == keep:
                continue
            shutil.move(str(release), str(rollback_root / release.name))
            moved[release.name] = str(rollback_root / release.name)
            print("trimmed", release.name, "-> rollback/")
        print("releases:", [item.name for item in release_dirs(releases_root)])
        print("rollback:", sorted(item.name for item in rollback_root.iterdir()))
        print("budget bytes:", release_bytes(releases_root))
        return moved
    if keep_pair:
        # a fleet node keeps two release directories: the new one and the
        # release that is live now, the point of rollback. The rest goes to
        # rollback/, the bytes are never deleted.
        for release in release_dirs(releases_root):
            if release.name in (keep, prefer):
                continue
            shutil.move(str(release), str(rollback_root / release.name))
            moved[release.name] = str(rollback_root / release.name)
            print("trimmed", release.name, "-> rollback/")
        print("releases:", [item.name for item in release_dirs(releases_root)])
        print("rollback:", sorted(item.name for item in rollback_root.iterdir()))
        print("budget bytes:", release_bytes(releases_root))
        return moved
    while True:
        current = release_dirs(releases_root)
        if len(current) <= MAX_RELEASES and release_bytes(releases_root) <= BUDGET_MIB * 1024 ** 2:
            break
        movable = [item for item in current if item.name != keep]
        if prefer:
            preferred = [item for item in movable if item.name == prefer]
            movable = [item for item in movable if item.name != prefer] + preferred
        if not movable:
            break
        oldest = movable[0]
        shutil.move(str(oldest), str(rollback_root / oldest.name))
        moved[oldest.name] = str(rollback_root / oldest.name)
        print("trimmed", oldest.name, "-> rollback/")
    print("releases:", [item.name for item in release_dirs(releases_root)])
    print("rollback:", sorted(item.name for item in rollback_root.iterdir()) if rollback_root.is_dir() else [])
    print("budget bytes:", release_bytes(releases_root))
    return moved


def unpack_release(archive: Path, release: Path) -> None:
    """The release gets its own bytes: nothing is written over a link.

    The archive is unpacked aside and the entries are put in place one by one.
    A file that is unpacked over an existing one keeps its inode, and that
    inode may belong to another release: the bytes of that release would
    change with this one.
    """
    release.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(release.parent)) as staging:
        with tarfile.open(archive) as handle:
            handle.extractall(staging)
        for entry in sorted(Path(staging).iterdir()):
            target = release / entry.name
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
            shutil.move(str(entry), str(target))


def switch_current(catalog: Path, sha: str) -> None:
    """The `current` symlink names the release that is live now.

    The link is moved with rename(2): a link that is removed and created
    again leaves a moment where `current` names nothing. The target is the
    relative name the builder writes: `releases/<sha>`.
    """
    link = catalog / "current"
    temporary = catalog / ".current.new"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    os.symlink(os.path.join("releases", sha), temporary)
    os.rename(temporary, link)


def _leased_node_side_fleet(arguments, release_gate) -> int:
    release_gate.compare_revision(Path(arguments.fleet_dir).expanduser() / "node-config.json", arguments.previous_sha)
    if arguments.sha == arguments.previous_sha:
        print("already current; no preparation or restart")
        return 0
    if sys.platform == "darwin":
        # Keep the handoff in this process, never in a caller-supplied flag or
        # proof file. Stop the exact existing owner before touching releases.
        spec = importlib.util.spec_from_file_location("fleet_rollout_owned", HERE / "rollout-node.py")
        rollout = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rollout)
        label = arguments.unit
        handoff = rollout.DarwinStoppedGeneration(Path(arguments.fleet_dir).expanduser(), label,
            arguments.previous_sha, arguments.web_port, shlex.split(arguments.restart_cmd), release_gate, arguments.sha)
        try:
            handoff.stop()
            return _node_side_fleet(arguments, rollout, handoff, release_gate)
        finally:
            # Preparation or a pre-switch refusal must not leave our known
            # previous runtime down. A new owner/configuration forbids this.
            handoff.restore_if_still_owned()
    return _node_side_fleet(arguments, release_gate=release_gate)


def _node_side_fleet(arguments, rollout=None, handoff=None, release_gate=None) -> int:
    fleet = Path(arguments.fleet_dir).expanduser()
    sha = arguments.sha
    release = fleet / "releases" / sha
    release_gate.compare_revision(fleet / "node-config.json", arguments.previous_sha)
    if sha == arguments.previous_sha:
        print("already current; no preparation or restart")
        return 0
    release_gate.candidate_descends_from(arguments.previous_sha, sha)
    trim_releases(fleet / "releases", fleet / "rollback", sha, arguments.previous_sha,
                  keep_pair=True)
    if release.exists():
        # an earlier attempt left a partial release: it is kept aside with its
        # bytes, and the release is unpacked anew
        trash = fleet / "trash" / f"{sha[:8]}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
        trash.parent.mkdir(parents=True, exist_ok=True)
        while trash.exists():
            trash = trash.with_name(trash.name + "-x")
        shutil.move(str(release), str(trash))
        print("partial release kept aside:", trash)
    release_gate.compare_revision(fleet / "node-config.json", arguments.previous_sha)
    unpack_release(Path(arguments.archive), release)
    command = [sys.executable, str(HERE / "rollout-node.py"),
               "--kind", "fleet",
               "--fleet-dir", str(fleet),
               "--sha", sha,
               "--port", str(arguments.web_port),
               "--restart-cmd", arguments.restart_cmd,
               "--previous-sha", arguments.previous_sha,
               "--release-local-packages",
               "--unit", arguments.unit,
               "--launchd-label", arguments.unit,
               "--state-dir", arguments.state_dir]
    if rollout is None:
        spec = importlib.util.spec_from_file_location("fleet_rollout_owned", HERE / "rollout-node.py")
        rollout = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rollout)
    return rollout._main(command[2:], stopped_generation=handoff, release_gate=release_gate)


def prepare_owner_area(catalog: Path, release: Path, working_directory: str) -> str:
    """The area of the owner must offer the packages to the resolver of Node.

    A release of the owner carries no copy of the packages: they live in the
    shared store of the area, and the release links them. The area itself must
    offer that store under the name the resolver of Node looks for
    ("<area>/node_modules"), or the import of a sibling of a package of the
    store leaves the store, finds the legacy root store of the area or
    nothing at all, and the runtime does not start. That is the incident R7,
    and every new area repeats it as long as nothing ensures the root.

    The packages are materialized from the store of the checkout: the working
    directory of the owner node stays the checkout, and its store is the place
    the packages of the area come from. The store of an area that already has
    one is kept and verified: the releases that run share it.
    """
    source = Path(working_directory).expanduser() / "node_modules" if working_directory else None
    identity = release_rules.dependency_identity(release)
    store_dir = release_rules.shared_store_dir(catalog, identity)
    if store_dir.is_dir():
        release_rules.verify_shared_store(store_dir, identity)
        created = False
    else:
        if source is None or source.is_symlink() or not source.is_dir():
            raise RuntimeError(f"the store of the checkout is absent: {source}")
        release_rules.materialize_shared_store(source, store_dir, identity)
        created = True
    linked = release_rules.link_release_packages(release, store_dir)
    if source is not None and not source.is_symlink() and source.is_dir():
        release_rules.own_tool_caches(source, release / "node_modules")
    takeover = release_rules.take_over_area_package_root(catalog, store_dir)
    root = release_rules.ensure_area_package_root(catalog, store_dir)
    return (f"shared store {store_dir} (created={created}); {linked}; "
            f"area package root {root['path']} state={root['state']}"
            + (f"; the legacy root store moved aside: {takeover['moved']}"
               if takeover.get("moved") else ""))


def owner_process_identity(unit: str):
    """Read the service's actual process, not its configured ExecStart."""
    try:
        result = subprocess.run(["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"],
                                capture_output=True, text=True, timeout=5, check=False)
        if result.returncode != 0:
            return None
        pid = int(result.stdout.strip())
        if pid <= 0:
            return None
        proc = Path("/proc") / str(pid)
        # comm may contain spaces/parentheses; starttime is field 22.
        start = proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19]
        argv = tuple(part.decode() for part in proc.joinpath("cmdline").read_bytes().split(b"\0") if part)
        return pid, start, argv
    except (OSError, ValueError, UnicodeError, IndexError, subprocess.SubprocessError):
        return None


def owner_listens(pid: int, port: int) -> bool:
    """An unrelated old HTTP listener must not certify the new generation."""
    try:
        proc = Path("/proc") / str(pid)
        sockets = {os.readlink(fd) for fd in (proc / "fd").iterdir()}
        for table in ("tcp", "tcp6"):
            for row in (proc / "net" / table).read_text().splitlines()[1:]:
                fields = row.split()
                if (fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) == port
                        and "socket:[" + fields[9] + "]" in sockets):
                    return True
    except (OSError, ValueError, IndexError):
        return False
    return False


def wait_owner_ready(unit: str, release: Path, port: int, previous_identity, attempts=30) -> bool:
    import urllib.request
    expected_entry = str((release / "dist/index.js").resolve())
    for _ in range(attempts):
        identity = owner_process_identity(unit)
        if (identity and (previous_identity is None or identity[:2] != previous_identity[:2])
                and expected_entry in identity[2] and owner_listens(identity[0], port)):
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/sessions?quick=1&limit=1", timeout=5) as response:
                    response.read(64)
                if owner_process_identity(unit) == identity:
                    return True
            except Exception:
                pass
        time.sleep(2)
    return False


def restart_owner_release(unit: str, release: Path, port: int) -> bool:
    previous_identity = owner_process_identity(unit)
    reload_result = subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    if reload_result.returncode != 0:
        print("owner daemon-reload failed")
        return False
    restart_result = subprocess.run(["systemctl", "--user", "restart", unit], check=False)
    if restart_result.returncode != 0:
        print("owner restart failed")
        return False
    return wait_owner_ready(unit, release, port, previous_identity)


def _leased_node_side_owner(arguments, release_gate) -> int:
    catalog = Path(arguments.catalog).expanduser()
    sha = arguments.sha
    release = catalog / "releases" / sha
    drop_in = Path(arguments.drop_in).expanduser()
    # The config of the node is the node's own file: the rollout writes the
    # native values of the node into it and only the source sha changes. The
    # candidate template of the build never lands here.
    release_gate.compare_revision(catalog / "node-config.json", arguments.previous_sha)
    release_gate.candidate_descends_from(arguments.previous_sha, sha)
    if arguments.node_config:
        native = json.loads(arguments.node_config)
        config_path = catalog / "node-config.json"
        if config_path.is_file():
            backup = Path(f"{config_path}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
            shutil.copy2(config_path, backup)
            print("the config of the node is saved:", backup)
        native["sourceSha"] = sha
        native["candidate"] = False
        native.pop("note", None)
        config_path.write_text(json.dumps(native, indent=2) + "\n")
        print("the native values of the node are written into", config_path)
    unit_dir = drop_in.parent
    previous = ""
    if drop_in.is_file():
        for line in drop_in.read_text().splitlines():
            if line.startswith("ExecStart=") and "dist/index.js" in line:
                previous = line.split("=", 1)[1].strip()
    unpack_release(Path(arguments.archive), release)
    # The area must offer the packages to the resolver of Node before the
    # release goes live: a release whose area cannot resolve the packages of
    # the store does not start, and the incident repeats itself in every new
    # area. Nothing of the node is changed when the area cannot be prepared.
    try:
        prepared = prepare_owner_area(catalog, release, arguments.working_directory)
    except (OSError, RuntimeError, ValueError) as error:
        print("the packages of the area are not ready:", error)
        return 1
    print("packages:", prepared)
    # The `current` symlink names the release that is live now. It is moved
    # before the release that was live is sent to rollback/, so the link never
    # names a directory that is gone: after the rollout it names the release
    # of this rollout, not the place the old one moved to.
    release_gate.compare_revision(catalog / "node-config.json", sha)
    switch_current(catalog, sha)
    # The owner node keeps one release directory: the new one. The release that
    # is live now moves to rollback/ with its bytes, and the saved drop-in is
    # rewritten below to the place it moved to, so the rollback stays real.
    moved = {}  # Retain previous release bytes until acceptance; cleanup is separate.
    unit_dir.mkdir(parents=True, exist_ok=True)
    backup = Path(f"{drop_in}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
    if previous:
        # The point of rollback must stay real: if the release of the old
        # drop-in moved to rollback/, the saved drop-in points at its new home.
        target = previous
        for name, new_home in moved.items():
            if name in previous:
                target = previous.replace(f"/releases/{name}/", f"/rollback/{name}/")
        backup.write_text(
            "# Rollback point of the previous release.\n"
            "[Service]\n"
            "ExecStart=\n"
            f"ExecStart={target}\n")
        print("rollback drop-in saved:", backup)
    release_gate.compare_revision(catalog / "node-config.json", sha)
    drop_in.write_text(
        f"# Release-local runtime of the candidate {sha}.\n"
        "# The working directory stays the checkout, so the live data paths do not move.\n"
        "# Rollback: put back the saved drop-in, daemon-reload, restart.\n"
        "[Service]\n"
        "ExecStart=\n"
        f"ExecStart=/usr/local/bin/node {release}/dist/index.js\n")
    if restart_owner_release(arguments.unit, release, arguments.web_port):
        release_gate.check()  # Cancellation during readiness must enter guarded cleanup.
        print("owner node is back on", sha)
        return 0
    print("the owner node did not come back on its port")
    return 1


def node_side(arguments) -> int:
    if arguments.authority_stdio:
        if (arguments.kind != "fleet" or arguments.release_proof
                or not getattr(arguments, "deployment_descriptor", "")
                or not re.fullmatch(r"[a-f0-9]{64}", getattr(arguments, "descriptor_sha", ""))
                or not re.fullmatch(r"[a-f0-9]{32}", arguments.authority_run)):
            raise RuntimeError("release_remote_command_refused")
        descriptor = load_remote_descriptor(arguments.deployment_descriptor, arguments.descriptor_sha)
        expected = {"expected_host":"hostId","unit":"unit","fleet_dir":"fleetDir",
                    "state_dir":"stateDir","web_port":"webPort","restart_cmd":"restartCmd"}
        if any(getattr(arguments,key) != descriptor[field] for key,field in expected.items()):
            raise RuntimeError("release_remote_command_refused")
        contract = {"run": arguments.authority_run, "hostId": arguments.expected_host,
                    "fleetDir": arguments.fleet_dir, "unit": arguments.unit,
                    "previousSha": arguments.previous_sha, "candidateSha": arguments.sha,
                    "descriptor":descriptor, "descriptorDigest":arguments.descriptor_sha}
        with RemoteReleaseGate(contract, remote_frames()) as gate:
            result = _leased_node_side_fleet(arguments, gate)
            gate.finish(0 if result == 0 else 1)
            return result
    target_root = Path(arguments.catalog if arguments.kind == "owner" else arguments.fleet_dir).expanduser().resolve()
    with ReleaseGate(arguments.release_proof, target={"fleetDir": str(target_root), "unit": arguments.unit}) as gate:
        if arguments.kind != "owner":
            return _leased_node_side_fleet(arguments, gate)
        config_path = target_root / "node-config.json"
        drop_in = Path(arguments.drop_in).expanduser()
        old_config = config_path.read_bytes()
        old_dropin = drop_in.read_bytes() if drop_in.exists() else None
        old_current = os.readlink(target_root / "current") if (target_root / "current").is_symlink() else None
        try:
            result = _leased_node_side_owner(arguments, gate)
            if result == 0:
                return 0
            raise RuntimeError("owner_release_not_ready")
        except Exception:
            gate.compare_cleanup_revision(config_path, (arguments.previous_sha, arguments.sha))
            # Restore only this rollout's files while still owning target serialization.
            config_path.write_bytes(old_config)
            if old_dropin is not None:
                drop_in.write_bytes(old_dropin)
            elif drop_in.exists():
                drop_in.unlink()
            if old_current is not None:
                current = target_root / "current"
                temporary = target_root / (".restore-current-" + str(os.getpid()))
                os.symlink(old_current, temporary)
                os.replace(temporary, current)
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
            subprocess.run(["systemctl", "--user", "restart", arguments.unit], check=False)
            raise


def finish_staged_rollout(command, gate, contract, ssh, stage):
    # An exception is UNKNOWN: retain evidence and do not send another command.
    result = run_authorized_ssh(command, gate, contract)
    if not re.fullmatch(r"/tmp/herder-release\.[A-Za-z0-9]{8}", stage):
        raise RuntimeError("release_remote_staging_invalid")
    cleanup = ("import os,stat,shutil,sys; p=sys.argv[1]; s=os.lstat(p); "
               "assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() "
               "and stat.S_IMODE(s.st_mode)==0o700; shutil.rmtree(p)")
    cmd = ["python3", "-c", cleanup, stage]
    try:
        cleaned = subprocess.run(ssh + [" ".join(shlex.quote(x) for x in cmd)],
                                 capture_output=True, text=True, timeout=30, check=False)
        if cleaned.returncode:
            print("confirmed rollout; private staging cleanup pending:", stage)
    except (OSError, subprocess.TimeoutExpired):
        print("confirmed rollout; private staging cleanup pending:", stage)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--release-proof", default="", help="protected proof path on the target authority host; never transferred")
    parser.add_argument("--node", default="", help="node id from private deployment configuration")
    parser.add_argument("--deployment-config", default="")
    parser.add_argument("--deployment-descriptor", default="", help=argparse.SUPPRESS)
    parser.add_argument("--descriptor-sha", default="", help=argparse.SUPPRESS)
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan and check the preconditions; change nothing")
    parser.add_argument("--node-side", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--authority-stdio", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--authority-run", default="", help=argparse.SUPPRESS)
    parser.add_argument("--expected-host", default="", help=argparse.SUPPRESS)
    parser.add_argument("--kind", choices=["owner", "fleet"], default="")
    parser.add_argument("--archive", default="")
    parser.add_argument("--fleet-dir", default="")
    parser.add_argument("--previous-sha", default="")
    parser.add_argument("--restart-cmd", default="")
    parser.add_argument("--state-dir", default="")
    parser.add_argument("--drop-in", default="")
    parser.add_argument("--working-directory", default="")
    parser.add_argument("--web-port", type=int, default=0)
    parser.add_argument("--unit", default="")
    parser.add_argument("--node-config", default="",
                        help="the native values of the node as JSON (the owner node writes them into its config)")
    arguments = parser.parse_args()
    if arguments.authority_stdio and not arguments.node_side:
        parser.error("--authority-stdio requires --node-side")
    if not arguments.dry_run and not arguments.release_proof and not arguments.authority_stdio:
        parser.error("--release-proof is required for rollout")

    if arguments.node_side:
        return node_side(arguments)

    topology = load_nodes(arguments.deployment_config)
    node = node_spec(topology, arguments.node)
    node = validate_node(node)
    pinned_descriptor = descriptor_digest(node)
    catalog = Path(arguments.catalog).expanduser()
    release = catalog / "releases" / arguments.sha

    if not release.is_dir():
        print(f"the release is not built: {release}")
        print("build it first: python3 deploy/fleet/build-release-candidate.py --sha " + arguments.sha)
        return 1
    manifest_path = release / "build-manifest.json"
    if not manifest_path.is_file():
        print(f"the release carries no bundle manifest: {manifest_path}")
        return 1
    manifest = json.loads(manifest_path.read_text())
    entries = release_rules.bundle_entries(release, exclude=("build-manifest.json",))
    fingerprint = release_rules.bundle_fingerprint(entries)
    if manifest.get("sourceSha") != arguments.sha or manifest.get("bundleFingerprint") != fingerprint:
        print("the bundle manifest does not describe this release")
        print(f"  manifest sha={manifest.get('sourceSha')} fingerprint={manifest.get('bundleFingerprint')}")
        print(f"  release  fingerprint={fingerprint}")
        return 1

    live_sha = ""
    if node["kind"] == "owner":
        current = catalog / "current"
        if current.is_symlink():
            live_sha = os.path.basename(os.readlink(current))
    else:
        # The live release of a fleet node lives on that node: it is read
        # there, not guessed here.
        live_sha = remote_live_sha(node)

    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / f"rel-{arguments.sha}.tar"
        pack_release(release, archive)
        size_mib = round(archive.stat().st_size / 1024 / 1024, 1)

        print("== rollout plan ==")
        print(f"node          : {node['id']} ({node['kind']}, {node['address']})")
        print(f"release       : {release}")
        print(f"bundle        : {fingerprint} files={len(entries)}")
        print(f"package size  : {size_mib} MiB")
        print(f"live before   : {live_sha or 'unknown'}")
        print(f"restart       : {node['restartCmd']}")
        if arguments.dry_run:
            print("== dry run: nothing was changed ==")
            print("on the node:")
            print("  1. superseded releases -> rollback/ until the budget holds")
            print("  2. unpack the release into releases/" + arguments.sha)
            if node["kind"] == "owner":
                print("  3. write the native values of the node into node-config.json (sourceSha only changes)")
                print("  4. point current at releases/" + arguments.sha)
                print("  5. write the drop-in, daemon-reload, restart " + node["unit"])
                print("     working directory stays " + expand(node["workingDirectory"]))
                last_step = 5
            else:
                print("  3. rollout-node.py: packages, payload, switch, restart, rollback proof")
                last_step = 3
            print(f"  {last_step + 1}. the acceptance is a separate command: accept-node.py")
            return 0

        if node["kind"] != "owner":
            node = verify_descriptor(node, pinned_descriptor)
            target = deployment_target(node)
            host = f"{node['sshUser']}@{node['address']}"
            ssh_port = str(node.get("sshPort", 22))
            fleet_dir = expand(node["fleetDir"])
            contract = {"run": uuid.uuid4().hex, "hostId": node["hostId"],
                        "fleetDir": fleet_dir, "unit": node["unit"],
                        "previousSha": live_sha, "candidateSha": arguments.sha,
                        "descriptor": node, "descriptorDigest": pinned_descriptor}
            # Proof and ledger never leave this authority. Its OS locks span
            # staging, remote mutation, readiness and any guarded rollback.
            with ReleaseGate(arguments.release_proof, target=target) as gate:
                gate.candidate_descends_from(live_sha, arguments.sha)
                ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                       "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10",
                       "-o", "ServerAliveCountMax=2", "-p", ssh_port, host]
                verify_remote_python(ssh, node)
                gate.check()
                staged = subprocess.run(ssh + ["umask 077; mktemp -d /tmp/herder-release.XXXXXXXX"],
                                        capture_output=True, text=True, check=True, timeout=30)
                stage = staged.stdout.strip()
                if not re.fullmatch(r"/tmp/herder-release\.[A-Za-z0-9]{8}", stage):
                    raise RuntimeError("release_remote_staging_invalid")
                remote_archive = stage + "/release.tar"
                for local, remote in ((archive, remote_archive),
                        *((HERE / name, stage + "/" + name) for name in
                          ("rollout-candidate.py", "rollout-node.py", "accept-node.py",
                           "release_rules.py", "release_gate.py", "remote_release_gate.py", "deployment_config.py"))):
                    gate.check()
                    copied = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                                             "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10",
                                             "-o", "ServerAliveCountMax=2", "-P", ssh_port,
                                             str(local), f"{host}:{remote}"], check=False, timeout=120)
                    if copied.returncode != 0:
                        raise RuntimeError("release_remote_transfer_failed")
                with tempfile.NamedTemporaryFile(mode="w", prefix="herder-descriptor-", suffix=".json") as selected:
                    os.chmod(selected.name, 0o600)
                    json.dump(verify_descriptor(node, pinned_descriptor), selected, sort_keys=True)
                    selected.flush()
                    gate.check()
                    copied = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                        "-o", "ConnectTimeout=10", "-P", ssh_port, selected.name,
                        f"{host}:{stage}/descriptor.json"], check=False, timeout=30)
                    if copied.returncode:
                        raise RuntimeError("release_remote_descriptor_transfer_failed")
                side = remote_python_command(node) + [stage + "/rollout-candidate.py", "--node-side",
                        "--authority-stdio", "--authority-run", contract["run"],
                        "--deployment-descriptor", stage + "/descriptor.json", "--descriptor-sha", pinned_descriptor,
                        "--expected-host", node["hostId"], "--kind", "fleet",
                        "--sha", arguments.sha, "--archive", remote_archive,
                        "--fleet-dir", fleet_dir, "--previous-sha", live_sha,
                        "--restart-cmd", node["restartCmd"], "--web-port", str(node["webPort"]),
                        "--unit", node["unit"], "--state-dir", expand(node["stateDir"])]
                command = ssh + [" ".join(shlex.quote(item) for item in side)]
                # Keep staged artifacts on an uncertain outcome for diagnosis;
                # never automatically retry an accepted or unknown operation.
                return finish_staged_rollout(command, gate, contract, ssh, stage)
        else:
            side = ["python3", str(Path(__file__).resolve()), "--node-side",
                    "--kind", "owner", "--sha", arguments.sha, "--release-proof", arguments.release_proof,
                    "--archive", str(archive),
                    "--catalog", str(catalog),
                    "--previous-sha", live_sha,
                    "--drop-in", expand(node["dropIn"]),
                    "--working-directory", expand(node["workingDirectory"]),
                    "--web-port", str(node["webPort"]),
                    "--unit", node["unit"],
                    "--node-config", json.dumps({key: node[key] for key in
                        ("hostId", "harnesses", "nodeBin", "webPort", "codexSocket", "codexBin")
                        if key in node})]
            command = side
        result = subprocess.run(command, check=False)
        return result.returncode


if __name__ == "__main__":
    sys.exit(main())
