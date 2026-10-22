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
import sys

WORKSPACE_PACKAGE = "agent-resume-mcp"

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


def bundle_fingerprint(entries: dict) -> str:
    payload = "".join(f"{name}\0{entries[name]}\n" for name in sorted(entries)).encode()
    return hashlib.sha256(payload).hexdigest()


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
