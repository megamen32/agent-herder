#!/usr/bin/env python3
"""Normalize the packages of a fleet node: store in the root, two releases.

The store of the packages must live in the root of the fleet directory under
the exact name node_modules, and every release must point at it. A release
that is removed later must not be the one the other releases depend on: the
accepted node may not depend on a directory that will be trimmed tomorrow.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request


def http_status(url, data=None, headers=None, timeout=8.0):
    request = urllib.request.Request(url, data=data, headers=headers or {},
                                     method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-dir", required=True)
    parser.add_argument("--trim", action="append", default=[], help="release directory to move to rollback/")
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()

    fleet = Path(arguments.fleet_dir).expanduser()
    releases = fleet / "releases"
    store = fleet / "node_modules"
    rollback = fleet / "rollback"
    rollback.mkdir(parents=True, exist_ok=True)

    # 1. The store of the packages belongs to the root, under the exact name.
    if not store.exists():
        for release in sorted(releases.iterdir()):
            candidate = release / "node_modules"
            if candidate.is_dir() and not candidate.is_symlink():
                os.rename(candidate, store)
                print(f"store moved from {release.name} into the root")
                break
    print("store:", store, "exists" if store.exists() else "MISSING")

    # 2. Every release points at the store, not at another release.
    for release in sorted(releases.iterdir()):
        link = release / "node_modules"
        if link.is_symlink() and os.readlink(link) == str(store):
            continue
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            print(f"  {release.name}: keeps its own packages")
            continue
        os.symlink(str(store), link)
        print(f"  {release.name}: linked to the root store")

    # 3. Trim the superseded releases, keeping the bytes in rollback.
    for name in arguments.trim:
        directory = releases / name
        if directory.exists():
            shutil.move(str(directory), str(rollback / name))
            print(f"trimmed {name} -> rollback/")

    print("releases:", sorted(p.name for p in releases.iterdir()))
    print("rollback:", sorted(p.name for p in rollback.iterdir()))
    try:
        count = len(os.listdir(store))
        print(f"store packages: {count}")
    except OSError as error:
        print("store unreadable:", error)
    for release in sorted(releases.iterdir()):
        link = release / "node_modules"
        print(f"  {release.name[:8]} node_modules -> {os.readlink(link) if link.is_symlink() else 'own directory'}")
    print("current ->", os.readlink(fleet / "current"))

    port = arguments.port
    print("sessions:", http_status(f"http://127.0.0.1:{port}/api/sessions"))
    print("policy:", http_status(f"http://127.0.0.1:{port}/api/automation/launch-policy"))
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "l", "version": "1"}}}).encode()
    print("mcp:", http_status(f"http://127.0.0.1:{port}/mcp", data=body,
                              headers={"Content-Type": "application/json",
                                       "Accept": "application/json, text/event-stream"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
