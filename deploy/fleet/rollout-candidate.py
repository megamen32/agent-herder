#!/usr/bin/env python3
"""Roll one release candidate out to one node, in one command.

    python3 deploy/fleet/rollout-candidate.py --sha <sha> --node 44
    python3 deploy/fleet/rollout-candidate.py --sha <sha> --node 100 --dry-run

The order of the nodes is the order of the owner: 44 and 88 first, the owner
node 100 last. This command is the only thing that touches a node. The
acceptance is a separate command, so the facts of a node are read by a
program that changes nothing.

What happens on the node:
  * the superseded releases move to rollback/ - the bytes stay, and the
    budget of releases/ holds: at most two directories and 512 MiB;
  * the release is unpacked into releases/<sha>;
  * the node is switched to it: on a fleet node the `current` symlink and the
    sourceSha of node-config.json, on the owner node the `current` symlink, the
    sourceSha of node-config.json and the systemd drop-in that points at the
    release - the working directory of the owner node stays the checkout, the
    live data paths must not move;
  * the node is restarted and the port is waited for;
  * the point of rollback stays real: on the owner node the saved drop-in
    points at the release that actually exists, wherever it now lives.

The emergency pause noticeplace-ai-pause.service is a system unit: it is
never stopped, never changed and never disabled by this command.
"""
import argparse
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

DEFAULT_CATALOG = Path.home() / "agents-projects/.fleet-candidate"
BUDGET_MIB = 512
MAX_RELEASES = 2
PACKAGED = ("dist", "packages", "package.json", "package-lock.json", "build-manifest.json")


def load_nodes() -> dict:
    return json.loads((HERE / "nodes.json").read_text())


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
    command = ["ssh", "-o", "ConnectTimeout=30", "-p", str(node.get("sshPort", 22)),
               f"{node['sshUser']}@{node['address']}", f"readlink {fleet}/current"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
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


def node_side_fleet(arguments) -> int:
    fleet = Path(arguments.fleet_dir).expanduser()
    sha = arguments.sha
    release = fleet / "releases" / sha
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
               "--state-dir", arguments.state_dir]
    result = subprocess.run(command, check=False)
    return result.returncode


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


def node_side_owner(arguments) -> int:
    catalog = Path(arguments.catalog).expanduser()
    sha = arguments.sha
    release = catalog / "releases" / sha
    drop_in = Path(arguments.drop_in).expanduser()
    # The config of the node is the node's own file: the rollout writes the
    # native values of the node into it and only the source sha changes. The
    # candidate template of the build never lands here.
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
    switch_current(catalog, sha)
    # The owner node keeps one release directory: the new one. The release that
    # is live now moves to rollback/ with its bytes, and the saved drop-in is
    # rewritten below to the place it moved to, so the rollback stays real.
    moved = trim_releases(catalog / "releases", catalog / "rollback", sha,
                           arguments.previous_sha, keep_only=True)
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
    drop_in.write_text(
        f"# Release-local runtime of the candidate {sha}.\n"
        "# The working directory stays the checkout, so the live data paths do not move.\n"
        "# Rollback: put back the saved drop-in, daemon-reload, restart.\n"
        "[Service]\n"
        "ExecStart=\n"
        f"ExecStart=/usr/local/bin/node {release}/dist/index.js\n")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    subprocess.run(["systemctl", "--user", "restart", arguments.unit], check=False)
    import urllib.request
    for _ in range(30):
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{arguments.web_port}/api/sessions?quick=1&limit=1", timeout=5) as response:
                response.read(64)
            print("owner node is back on", sha)
            return 0
        except Exception:
            time.sleep(2)
    print("the owner node did not come back on its port")
    return 1


def node_side(arguments) -> int:
    if arguments.kind == "owner":
        return node_side_owner(arguments)
    return node_side_fleet(arguments)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--node", default="", help="node id of deploy/fleet/nodes.json")
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan and check the preconditions; change nothing")
    parser.add_argument("--node-side", action="store_true", help=argparse.SUPPRESS)
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

    if arguments.node_side:
        return node_side(arguments)

    topology = load_nodes()
    node = node_spec(topology, arguments.node)
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

        remote_archive = f"/tmp/rel-{arguments.sha}.tar"
        if node["kind"] != "owner":
            host = f"{node['sshUser']}@{node['address']}"
            ssh_port = str(node.get("sshPort", 22))
            # the node side runs this same script: it and the module of the
            # rules travel with it, or the node has nothing to start
            for local, remote in ((archive, remote_archive),
                                  (HERE / "rollout-candidate.py", "/tmp/rollout-candidate.py"),
                                  (HERE / "rollout-node.py", "/tmp/rollout-node.py"),
                                  (HERE / "accept-node.py", "/tmp/accept-node.py"),
                                  (HERE / "release_rules.py", "/tmp/release_rules.py")):
                command = ["scp", "-q", "-P", ssh_port, str(local), f"{host}:{remote}"]
                copied = subprocess.run(command, capture_output=True, text=True, check=False)
                if copied.returncode != 0:
                    print(f"transfer failed: {copied.stderr.strip()}")
                    return 1
            side = ["python3", "/tmp/rollout-candidate.py", "--node-side",
                    "--kind", "fleet", "--sha", arguments.sha,
                    "--archive", remote_archive,
                    "--fleet-dir", expand(node["fleetDir"]),
                    "--previous-sha", live_sha,
                    "--restart-cmd", node["restartCmd"],
                    "--web-port", str(node["webPort"]),
                    "--unit", node["unit"],
                    "--state-dir", expand(node["stateDir"])]
            # the remote side takes a shell line: every argument is quoted, or
            # a command with spaces arrives as several arguments
            command = ["ssh", "-o", "ConnectTimeout=30", "-p", ssh_port, host,
                       " ".join(shlex.quote(item) for item in side)]
        else:
            side = ["python3", str(Path(__file__).resolve()), "--node-side",
                    "--kind", "owner", "--sha", arguments.sha,
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
