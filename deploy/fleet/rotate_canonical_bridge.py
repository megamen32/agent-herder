#!/usr/bin/env python3
"""CAS-protected rotation of an already sealed canonical release bridge.

This operation changes only the v2 canonical marker and its private config.
It preserves the previous ledger/config bytes, refuses active effects, validates
the successor bridge against an isolated ledger copy, and never performs a
lease acquisition or deployment itself.
"""
import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

from apply_canonical_release_cutover import ledger_barrier, protected_directory, validate_lock


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private(path):
    p = Path(path)
    if not p.is_absolute() or p.resolve(strict=True) != p:
        raise ValueError("path must be canonical")
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077 or s.st_nlink != 1:
        raise ValueError("file must be private and owned")
    return p


def bridge(path):
    p = private(path)
    if not os.access(p, os.X_OK):
        raise ValueError("bridge must be executable")
    return p


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def atomic(path, data, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".rotate-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def bridge_status(binary, config, project):
    request = {"action": "status", "project": project}
    result = subprocess.run([str(binary), "--config", str(config)], input=json.dumps(request) + "\n",
                            text=True, capture_output=True, timeout=15, check=False)
    if result.returncode != 0:
        raise RuntimeError("successor bridge status failed")
    line = next((line for line in result.stdout.splitlines() if line.strip()), "")
    value = json.loads(line)
    if value.get("ok") is not True:
        raise RuntimeError("successor bridge rejected staged authority")
    return value["result"]


@contextmanager
def idle_execution_locks(config):
    # A running controller pins the sealed marker until its guarded effect
    # finishes. Rust holds the target's execution.lock exclusively for that time.
    runtime = json.loads(private(config["process_config"]).read_bytes())
    registry = protected_directory(Path(runtime["resources"]["root"]) / "resources")
    with ExitStack() as stack:
        for ref in sorted({m["resource_ref"] for m in config["mappings"]}):
            if not ref or ref in (".", "..") or Path(ref).name != ref:
                raise ValueError("invalid resource reference")
            path = protected_directory(registry / ref) / "execution.lock"
            fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            stack.callback(os.close, fd)
            validate_lock(path, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("active deployment prevents bridge rotation") from None
        yield


def rotate(ledger, config, binary, archive_dir, expected_sha256, project, successor_config=None):
    ledger = private(ledger)
    old_config = private(config)
    binary = bridge(binary)
    archive_dir = Path(archive_dir)
    if not archive_dir.is_absolute() or archive_dir.resolve() != archive_dir:
        raise ValueError("archive directory must be canonical")
    if archive_dir.exists():
        raise FileExistsError("archive directory already exists")
    before = ledger.read_bytes()
    if hashlib.sha256(before).hexdigest() != expected_sha256:
        raise RuntimeError("ledger CAS failed")
    state = json.loads(before)
    marker = state.get("canonical")
    if state.get("version") != 2 or not isinstance(marker, dict):
        raise RuntimeError("sealed v2 ledger required")
    if any(isinstance(value, dict) and value.get("lease") for value in state.get("projects", {}).values()):
        raise RuntimeError("active lease prevents bridge rotation")
    old_marker_config = private(marker["config"])
    old_marker_bridge = bridge(marker["bridge"])
    if old_marker_config != old_config:
        raise RuntimeError("config does not match current canonical marker")
    archive_dir.mkdir(mode=0o700, parents=False)
    atomic(archive_dir / "ledger.json", before, 0o400)
    old_config_bytes = old_config.read_bytes()
    atomic(archive_dir / "config.json", old_config_bytes, 0o400)
    atomic(archive_dir / "manifest.json", encoded({"version": 1, "ledger_sha256": expected_sha256,
        "config_sha256": hashlib.sha256(old_config_bytes).hexdigest(), "bridge_sha256": digest(old_marker_bridge),
        "archived_at_unix_ms": int(time.time() * 1000)}), 0o400)

    new_config = Path(config).with_name(Path(config).stem + ".rotated.json")
    original = json.loads(old_config_bytes)
    config_data = json.loads(private(successor_config).read_bytes()) if successor_config else dict(original)
    config_data["ledger"] = str(ledger)
    staged_ledger = archive_dir / "staged-ledger.json"
    staged = dict(state)
    staged["canonical"] = {"version": 1, "config": str(archive_dir / "staged-config.json"), "bridge": str(binary),
                            "seal_id": marker.get("seal_id")}
    atomic(staged_ledger, encoded(staged), 0o600)
    # Validate with the successor against the exact staged marker. The config's
    # ledger path is temporarily swapped only for this isolated readback.
    staged_config = archive_dir / "staged-config.json"
    staged_data = dict(config_data)
    staged_data["ledger"] = str(staged_ledger)
    atomic(staged_config, encoded(staged_data), 0o600)
    readback = bridge_status(binary, staged_config, project)
    final = dict(state)
    final["canonical"] = {"version": 1, "config": str(new_config), "bridge": str(binary),
                          "seal_id": marker.get("seal_id")}
    with ledger_barrier(ledger) as verify_barrier:
        if ledger.read_bytes() != before or old_config.read_bytes() != old_config_bytes:
            raise RuntimeError("ledger or config CAS failed")
        with idle_execution_locks(original):
            if new_config.exists():
                if private(new_config).read_bytes() != encoded(config_data):
                    raise RuntimeError("successor config already exists with different bytes")
            else:
                atomic(new_config, encoded(config_data), 0o600)
            verify_barrier()
            atomic(ledger, encoded(final), 0o600)
    return {"rotated": True, "ledger": str(ledger), "config": str(new_config), "bridge": str(binary),
            "archive": str(archive_dir), "before_sha256": digest(archive_dir / "ledger.json"),
            "after_sha256": digest(ledger), "successor_status": readback}


def main():
    p = argparse.ArgumentParser()
    for name in ("ledger", "config", "bridge", "archive", "expected-ledger-sha256", "project"):
        p.add_argument("--" + name, required=True)
    p.add_argument("--successor-config")
    args = p.parse_args()
    lock = Path(args.ledger + ".bridge-rotation.lock")
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(rotate(Path(args.ledger), Path(args.config), Path(args.bridge), Path(args.archive),
                                 args.expected_ledger_sha256, args.project,
                                 Path(args.successor_config) if args.successor_config else None), sort_keys=True))
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
