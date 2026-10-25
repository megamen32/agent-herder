#!/usr/bin/env python3
"""The rules of a release: its package set, its size and its fingerprint.

Both the build and the acceptance read this module, so the thing the build
claims and the thing the acceptance checks can never drift apart.

The package rule: a release carries the full set of the store of its host as
hard links - nothing is trimmed, nothing is copied. A release with a partial
node_modules would let the resolution drift into the shared store, and the
import from the release would be lost. The workspace package agent-resume-mcp
is the one exception: it is a link into the release, not a copy of a package,
and it is checked separately.

The size rule: the budget of a release is measured by its UNIQUE blocks - the
files that are not shared with the store. The apparent size counts the bytes
of the store again for every release that links them, so it is not a disk
figure and is never presented as one. Both numbers are always printed, each
named.

The fingerprint rule: the fingerprint of a bundle is the hash of every file
and every link of the release, by name. The manifest of the bundle carries
that fingerprint, so a changed file changes the fingerprint and a manifest of
an older build can never pass for the current one.

    python3 deploy/fleet/release-rules.py --lock package-lock.json --list
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

WORKSPACE_PACKAGE = "agent-resume-mcp"

# The name the resolver of Node looks for: a directory named node_modules in
# every parent of the file it resolves.
PACKAGE_ROOT_NAME = "node_modules"

# The tool caches of a store are rewritten by every build. A hard link to one
# of them would make the bytes of a release change under a running service,
# so the release owns these bytes instead of sharing them.
MUTABLE_ENTRIES = (".vite", ".vite-temp", ".cache", ".turbo", ".eslintcache", ".package-lock.json")


def mutable_entry(name: str) -> bool:
    """Is this entry of a store a tool cache that is rewritten in place?"""
    return name in MUTABLE_ENTRIES


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def store_contents(root: Path) -> list[str]:
    """The packages a node_modules directory carries.

    The workspace package is not counted: it is a link into the release, not
    a copy of a package, and it is checked separately.
    """
    root = Path(root)
    if not root.is_dir():
        return []
    names = []
    for entry in root.iterdir():
        if entry.name == WORKSPACE_PACKAGE:
            continue
        # The offer of the store itself (see ensure_store_package_root) is
        # not a package of the store.
        if entry.name == PACKAGE_ROOT_NAME:
            continue
        if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink():
            names.extend(f"{entry.name}/{child.name}" for child in entry.iterdir())
        else:
            names.append(entry.name)
    return sorted(names)


def diff(expected: list[str], actual: list[str]) -> dict:
    expected_set, actual_set = set(expected), set(actual)
    return {
        "expected": len(expected_set),
        "actual": len(actual_set),
        "missing": sorted(expected_set - actual_set),
        "extra": sorted(actual_set - expected_set),
    }


def size_report(root: Path) -> dict:
    """The unique blocks of a tree and its apparent size.

    unique_bytes  - the bytes this tree owns: the files that are not shared
                    with anything else (st_nlink == 1). This is the disk
                    increment and the number the budget is measured by.
    apparent_bytes - the sum of the sizes of the files, shared ones included.
                    It counts the store again for every link to it, so it is
                    not a disk figure.
    """
    unique_bytes = 0
    unique_files = 0
    apparent_bytes = 0
    shared_bytes = 0
    shared_files = 0
    for path in Path(root).rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        info = path.stat()
        apparent_bytes += info.st_size
        if info.st_nlink == 1:
            unique_bytes += info.st_size
            unique_files += 1
        else:
            shared_bytes += info.st_size
            shared_files += 1
    return {
        "unique_bytes": unique_bytes,
        "unique_files": unique_files,
        "apparent_bytes": apparent_bytes,
        "shared_bytes": shared_bytes,
        "shared_files": shared_files,
        "unique_mib": round(unique_bytes / 1024 / 1024, 1),
        "apparent_mib": round(apparent_bytes / 1024 / 1024, 1),
    }


def copied_bytes(root: Path) -> tuple[int, list[str]]:
    """The bytes of the tree that were copied instead of linked."""
    copied = 0
    offenders = []
    for path in Path(root).rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        if path.stat().st_nlink == 1:
            copied += path.stat().st_size
            offenders.append(path.relative_to(root).as_posix())
    return copied, offenders


def file_state(path: Path) -> str:
    """The identity of a file: inode, modification time and size."""
    info = Path(path).stat()
    return f"{info.st_ino}:{info.st_mtime_ns}:{info.st_size}"


def mutable_state(root: Path) -> dict:
    """The state of the tool caches of a store, file by file.

    The build writes into those caches. A build that changed them would
    change the store, and the bytes of every release that shares the store
    would change with it.
    """
    root = Path(root)
    state = {}
    for name in MUTABLE_ENTRIES:
        base = root / name
        if base.is_symlink() or not base.exists():
            continue
        if base.is_file():
            state[name] = file_state(base)
            continue
        for path in sorted(base.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            state[path.relative_to(root).as_posix()] = file_state(path)
    return state


def shared_cache_files(root: Path) -> list[str]:
    """The tool caches of a release that are still shared with the store."""
    root = Path(root)
    shared = []
    for name in MUTABLE_ENTRIES:
        base = root / name
        if base.is_symlink() or not base.exists():
            continue
        candidates = [base] if base.is_file() else [p for p in sorted(base.rglob("*"))
                                                    if p.is_file() and not p.is_symlink()]
        for path in candidates:
            if path.stat().st_nlink > 1:
                shared.append(path.relative_to(root).as_posix())
    return shared


def bundle_entries(root: Path, exclude=()) -> dict:
    """Every file and every link of a bundle, by name."""
    entries = {}
    for path in sorted(Path(root).rglob("*")):
        name = path.relative_to(root).as_posix()
        if name in exclude:
            continue
        if path.is_symlink():
            entries[name] = "symlink:" + os.readlink(path)
        elif path.is_file():
            entries[name] = sha256_file(path)
    return entries


def payload_entries(root: Path, exclude=("build-manifest.json",)) -> dict:
    """The part of the release that is the same on every node.

    The package farm of a node is the property of that node: every node keeps
    its own store, so the whole bundle differs from node to node. The build
    itself does not: its payload is the same everywhere.
    """
    entries = bundle_entries(root, exclude=exclude)
    return {name: value for name, value in entries.items()
            if not name.startswith("node_modules/")}


def payload_fingerprint(entries: dict) -> str:
    """The fingerprint of the build payload of a release."""
    return bundle_fingerprint(entries)


def bundle_fingerprint(entries: dict) -> str:
    payload = "".join(f"{name}\0{entries[name]}\n" for name in sorted(entries)).encode()
    return hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# The shared package store: one directory per dependency set.
#
# The packages of a release do not live in the release. They live in one
# directory of the shared store, named by the hash of the lock file of the
# release, and the release links them. Two releases with the same lock file
# share one directory, and the bytes of the packages are hard links of the
# store of the host, so the shared store costs no new disk.
#
# The workspace package is never shared: it is a link into the release, so the
# runtime imports the package of the release and not the one of the store.
# The acceptance of the fleet requires exactly that.
# ---------------------------------------------------------------------------

SHARED_STORE_DIRNAME = "shared-node-modules"
SHARED_STORE_MANIFEST = "shared-node-modules.json"


def fleet_root_of(release: Path) -> Path:
    """The area of the fleet that holds the releases of a release directory.

    The area is the parent of the directory of the releases: the catalog of a
    build and the farm of a node have the same shape, and the shared store of
    the area lives next to the releases of the area.
    """
    release = Path(release).resolve()
    for parent in release.parents:
        if parent.name == "releases":
            return parent.parent
    return release.parent.parent


def shared_store_root(fleet_root: Path) -> Path:
    """The directory of the shared store of an area."""
    return Path(fleet_root) / SHARED_STORE_DIRNAME


def shared_store_dir(fleet_root: Path, identity: str) -> Path:
    """The directory of the shared store of one dependency set."""
    return shared_store_root(fleet_root) / identity


def area_package_root_state(fleet_root: Path, store_dir: Path) -> dict:
    """The state of the package root of the area, read only.

    "link" - the area offers the shared store under the name the resolver of
    Node looks for; "points_at_store" tells whether it offers the store of the
    dependency set in question.
    "legacy-directory" - a real directory at that place: the legacy root store
    of a node, which is the source the shared store is materialized from.
    "absent" - nothing there: the runtime of a release of this area cannot
    resolve the siblings of a package of the store.
    """
    fleet_root = Path(fleet_root)
    root = fleet_root / "node_modules"
    if root.is_symlink():
        current = (root.parent / os.readlink(root)).resolve()
        try:
            points = current == Path(store_dir).resolve()
        except OSError:
            points = False
        return {"state": "link", "path": str(root), "target": str(current),
                "points_at_store": points}
    if root.exists():
        return {"state": "legacy-directory", "path": str(root)}
    return {"state": "absent", "path": str(root)}


def store_package_root_state(store_dir: Path) -> dict:
    """The state of the package root of the shared store, read only.

    "link" - the store offers its own packages under the name the resolver of
    Node looks for; "points_at_store" tells whether it offers the store
    itself and not another directory.
    "directory" - a real directory at that place: the store carries packages
    of its own at the place the resolver looks for, which is not the store.
    "absent" - nothing there: the resolver of Node walks out of the store and
    reaches the area of the node.
    """
    store_dir = Path(store_dir)
    root = store_dir / PACKAGE_ROOT_NAME
    if root.is_symlink():
        current = (root.parent / os.readlink(root)).resolve()
        try:
            points = current == store_dir.resolve()
        except OSError:
            points = False
        return {"state": "link", "path": str(root), "target": str(current),
                "points_at_store": points}
    if root.exists():
        return {"state": "directory", "path": str(root)}
    return {"state": "absent", "path": str(root)}


def ensure_store_package_root(store_dir: Path) -> dict:
    """The store must offer its packages to the resolver of Node.

    The store is named "shared-node-modules/<identity>": the resolver of Node
    looks for a directory named "node_modules" in every parent of the file it
    resolves, so it walks out of the store, and the import of a sibling of a
    package of the store lands in the legacy root store of the area - or
    nowhere at all.

    The store therefore offers itself under that name: "<store>/node_modules"
    is a link to the store. The link is relative, so the store travels with
    the releases, and the resolver of every release stays inside the store it
    was verified against - the release that is live now and the release that
    is the point of rollback alike.
    """
    store_dir = Path(store_dir)
    if not store_dir.is_dir():
        raise RuntimeError(f"the shared store is absent: {store_dir}")
    root = store_dir / PACKAGE_ROOT_NAME
    state = store_package_root_state(store_dir)
    if state["state"] == "link":
        if state["points_at_store"]:
            return {"state": "already", "path": str(root), "target": str(store_dir)}
        os.unlink(root)
    elif state["state"] == "directory":
        raise RuntimeError(
            f"the store carries a real directory at its package root: {root}")
    os.symlink(".", root)
    return {"state": "created", "path": str(root), "target": str(store_dir)}


def ensure_area_package_root(fleet_root: Path, store_dir: Path) -> dict:
    """The area must offer the store of the packages to the resolver of Node.

    A package of the store is a link of the release, and the resolver of Node
    follows the real path of the file: it walks up the parents of the file and
    looks for a directory named "node_modules" in every one of them. The store
    is named "shared-node-modules/<identity>", so the walk leaves the store and
    finds nothing - the import of a sibling package fails with
    ERR_MODULE_NOT_FOUND, and the runtime does not start.

    The area therefore offers the store under the name the resolver looks for:
    "<area>/node_modules" is a link to the store of the dependency set of the
    release. The link is relative, so the area travels with its releases.

    A real directory at that place is the legacy root store of a node: it is
    the source the shared store is materialized from, and it is left alone.
    The runtime of such a node then resolves its imports from that legacy
    directory instead of the verified store - the acceptance has to see that,
    because the new store would not be the source of the resolution.
    """
    fleet_root = Path(fleet_root)
    store_dir = Path(store_dir)
    root = fleet_root / "node_modules"
    state = area_package_root_state(fleet_root, store_dir)
    if state["state"] == "link":
        if state["points_at_store"]:
            return {"state": "already", "path": str(root), "target": str(store_dir)}
        # A link of ours to an older dependency set: it follows the current one.
        os.unlink(root)
    elif state["state"] == "legacy-directory":
        return {"state": "legacy-directory", "path": str(root),
                "target": str(store_dir),
                "note": "the legacy root store of the area resolves the imports; "
                        "the shared store is not their source"}
    if not store_dir.is_dir():
        raise RuntimeError(f"the shared store of the area is absent: {store_dir}")
    relative = os.path.relpath(store_dir, root.parent)
    os.symlink(relative, root)
    return {"state": "created", "path": str(root), "target": str(store_dir)}


def take_over_area_package_root(fleet_root: Path, store_dir: Path) -> dict:
    """The legacy root store of the area moves aside, the store takes its place.

    Nothing happens when the root of the area already offers the store.

    The area offers the packages of the release under the name the resolver
    of Node looks for ("<area>/node_modules"). A real directory at that place
    is the legacy root store of the node: it holds the resolution of the
    runtime, and the shared store of the release is not its source.

    The legacy store moves under a name the resolver does not look for. Its
    bytes stay, nothing is deleted, and the place it moved to is named, so
    the owner can decide about it. The link to the store is prepared before
    the legacy store moves, and the legacy store goes back to its place if
    the link cannot be put in.
    """
    fleet_root = Path(fleet_root)
    root = fleet_root / PACKAGE_ROOT_NAME
    state = area_package_root_state(fleet_root, store_dir)
    if state["state"] != "legacy-directory":
        return {"moved": "", "path": str(root), "target": str(store_dir)}
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    moved = fleet_root / f"node_modules.legacy-{stamp}"
    index = 0
    while moved.exists() or moved.is_symlink():
        index += 1
        moved = fleet_root / f"node_modules.legacy-{stamp}-{index}"
    link = fleet_root / ".node_modules.link.new"
    if link.is_symlink() or link.exists():
        link.unlink()
    os.symlink(os.path.relpath(Path(store_dir), root.parent), link)
    os.rename(root, moved)
    try:
        os.rename(link, root)
    except OSError:
        os.rename(moved, root)
        raise
    return {"moved": str(moved), "path": str(root), "target": str(store_dir)}


def lock_digest(release: Path) -> str | None:
    """The identity of the dependency set of a release: the hash of its lock.

    None when the release carries no lock file: the node materializes a
    release before the archive of the rollout carries one.
    """
    lock = Path(release) / "package-lock.json"
    if not lock.is_file():
        return None
    return sha256_file(lock)


def package_set_digest(source: Path) -> str:
    """The identity of a package set that has no lock file.

    The names of the packages and the hash of their content: two releases
    with the same packages share one directory of the store.
    """
    entries = {}
    for name in store_contents(source):
        path = Path(source) / name
        if path.is_symlink():
            entries[name] = "symlink:" + os.readlink(path)
        elif path.is_file():
            entries[name] = sha256_file(path)
        else:
            entries[name] = "tree:" + bundle_fingerprint(bundle_entries(path))
    payload = "".join(f"{name}\0{entries[name]}\n" for name in sorted(entries)).encode()
    return hashlib.sha256(payload).hexdigest()


def dependency_identity(release: Path, fallback: Path | None = None,
                        source: Path | None = None) -> str:
    """The name of the shared store of a release.

    The hash of the lock file of the release names the store of that
    dependency set. A release without a lock file takes the lock of the
    release it replaces: the dependency set did not change between them.
    Without any lock file the identity is the hash of the package set
    itself, under a name that can never be the name of a lock file.
    """
    for candidate in (release, fallback):
        if candidate is None:
            continue
        digest = lock_digest(candidate)
        if digest:
            return digest
    if source is not None and Path(source).is_dir():
        return "packages-" + package_set_digest(source)
    raise RuntimeError(f"no lock file names the dependency set of the release: {release}")


def shared_store_packages(source: Path) -> list[str]:
    """The packages of the shared store: the runtime set of the host store.

    The workspace package is not shared: it is a link into the release. The
    tool caches are not shared either: they are rewritten in place, and the
    release owns its own bytes of them.
    """
    return [name for name in store_contents(source)
            if name != SHARED_STORE_MANIFEST
            and not mutable_entry(name.split("/")[0])]


def shared_store_manifest_path(store_dir: Path) -> Path:
    """The manifest of a shared store: what it holds and for which lock."""
    return Path(store_dir) / SHARED_STORE_MANIFEST


def verify_shared_store(store_dir: Path, identity: str) -> dict:
    """The shared store must be the store of this dependency set.

    A store of another lock file, or one that lost a package, is refused: a
    release that links it would resolve a set of packages that its own lock
    file does not name.
    """
    store_dir = Path(store_dir)
    if not store_dir.is_dir():
        raise RuntimeError(f"the shared package store is absent: {store_dir}")
    manifest_path = shared_store_manifest_path(store_dir)
    if not manifest_path.is_file():
        raise RuntimeError(f"the shared package store has no manifest: {manifest_path}")
    document = json.loads(manifest_path.read_text())
    if document.get("identity") != identity:
        raise RuntimeError(
            f"the shared package store belongs to another dependency set: {store_dir} "
            f"({document.get('identity')} != {identity})")
    missing = sorted(set(document.get("packages") or []) - set(store_contents(store_dir)))
    if missing:
        raise RuntimeError(
            f"the shared package store lost {len(missing)} packages: {missing[:5]}")
    return document


def materialize_shared_store(source: Path, store_dir: Path, identity: str) -> dict:
    """Materialize the shared store of one dependency set, once.

    The bytes of the packages are hard links of the store of the host: the
    shared store costs no new disk, and every release of that dependency set
    shares the same bytes. An existing store is never rewritten: a live
    release may be using it.
    """
    store_dir = Path(store_dir)
    if store_dir.is_dir():
        verify_shared_store(store_dir, identity)
        ensure_store_package_root(store_dir)
        return {"created": False, "dir": str(store_dir)}
    packages = shared_store_packages(source)
    store_dir.mkdir(parents=True, exist_ok=True)
    for name in packages:
        entry = Path(source) / name
        destination = store_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if entry.is_symlink():
            resolved = entry.resolve()
            if resolved.is_dir():
                subprocess.run(["cp", "-al", str(resolved), str(destination)], check=True)
            elif resolved.is_file():
                os.link(resolved, destination)
            else:
                os.symlink(os.readlink(entry), destination)
            continue
        subprocess.run(["cp", "-al", str(entry), str(destination)], check=True)
    document = {
        "kind": "fleet-shared-node-modules",
        "identity": identity,
        "packages": sorted(packages),
        "source": str(source),
    }
    manifest_path = shared_store_manifest_path(store_dir)
    temporary = manifest_path.with_name(manifest_path.name + ".tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n")
    os.replace(temporary, manifest_path)
    ensure_store_package_root(store_dir)
    return {"created": True, "dir": str(store_dir), "packages": len(packages)}


def is_package_farm(target: Path) -> bool:
    """Is this node_modules a farm of links into a shared store?

    A farm holds links and its own tool caches, and nothing else. A
    directory of real packages is not a farm: it is a package tree of its
    own, and nothing may replace it silently.
    """
    target = Path(target)
    if target.is_symlink() or not target.is_dir():
        return False
    for entry in target.iterdir():
        if mutable_entry(entry.name):
            continue
        if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink():
            # A scope is a real directory of links, not a package.
            for child in entry.iterdir():
                if not child.is_symlink():
                    return False
            continue
        if not entry.is_symlink():
            return False
    return True


def link_release_packages(release: Path, store_dir: Path) -> str:
    """Give the release its packages as links into the shared store.

    The release carries no copy of the packages: every entry of its
    node_modules is a link into the store of its dependency set. The
    workspace package is the one exception: it is a link into the release
    itself, so the runtime imports the package of the release and not the
    one of the store - the invariant of the acceptance.
    """
    release = Path(release)
    target = release / "node_modules"
    target.mkdir(parents=True, exist_ok=True)
    linked = 0
    for name in shared_store_packages(store_dir):
        destination = target / name
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.is_dir():
            shutil.rmtree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # The link is relative to the directory that holds it: the store and
        # the release travel together, from the build host to the node.
        os.symlink(os.path.relpath(Path(store_dir) / name, destination.parent), destination)
        linked += 1
    resume = target / WORKSPACE_PACKAGE
    if resume.exists() or resume.is_symlink():
        resume.unlink()
    os.symlink("../packages/agent-resume", resume)
    return (f"{linked} packages linked into {store_dir}; "
            f"{WORKSPACE_PACKAGE} -> ../packages/agent-resume")


def own_tool_caches(source: Path, target: Path) -> list[str]:
    """The release owns the bytes of the tool caches.

    The tool caches are rewritten in place by the tools of the runtime. A
    link to one of them would make the bytes of this release change under a
    running service, and the release would not own its own cache. The caches
    are copied, the packages stay links of the shared store.
    """
    owned = []
    source = Path(source)
    target = Path(target)
    if source.is_symlink() or not source.is_dir():
        return owned
    for entry in sorted(source.iterdir()):
        if not mutable_entry(entry.name):
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-modules", default="", help="a node_modules directory to inspect")
    parser.add_argument("--size", default="", help="a directory to measure")
    arguments = parser.parse_args()

    if arguments.size:
        print(json.dumps(size_report(Path(arguments.size)), indent=2))
        return 0
    if not arguments.node_modules:
        parser.error("--node-modules or --size is required")
    root = Path(arguments.node_modules)
    print(json.dumps({
        "packages": len(store_contents(root)),
        "size": size_report(root),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
