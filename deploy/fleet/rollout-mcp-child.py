#!/usr/bin/env python3
"""Guarded atomic entrypoint switch for the registered GPTAdmin root AgentHerder MCP child.

Does not restart gptadmin-hub.service, install a second service, or touch credentials.
The normal fleet owner-node rollout targets a different UID1000 process.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_rules
from release_gate import ReleaseGate

REPO = Path("/home/roomhacker/agents-projects/agent-herder")
ENTRYPOINT = REPO / "dist/index.js"
CATALOG = Path("/home/roomhacker/agents-projects/.fleet-candidate/pr20-prepared/releases")
LEDGER = Path("/root/.local/state/agent-herder/project-release-leases.json")
PARENT_UNIT = "gptadmin-hub.service"
TARGET = {"fleetDir": str(REPO), "unit": PARENT_UNIT}
ROLLBACK_ROOT = LEDGER.parent / "release-backups" / "gptadmin-agentherder-child"
KNOWN_RECOVERY_RELEASE = Path("/home/roomhacker/agents-projects/.fleet-candidate/releases/4049a99c78674c5e01ea90451a4479dff77f894c")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_preflight(sha: str) -> tuple[Path, str, str]:
    if re.fullmatch(r"[a-f0-9]{40}", sha) is None:
        raise RuntimeError("invalid_candidate_sha")
    release = CATALOG / sha
    if release.resolve(strict=True) != release:
        raise RuntimeError("candidate_catalog_alias")
    meta = json.loads((release / "build-manifest.json").read_text())
    if meta.get("sourceSha") != sha:
        raise RuntimeError("candidate_build_manifest_sha_mismatch")
    fingerprint = release_rules.bundle_fingerprint(
        release_rules.bundle_entries(release, exclude=("build-manifest.json",)))
    if meta.get("bundleFingerprint") != fingerprint:
        raise RuntimeError("candidate_bundle_fingerprint_mismatch")
    dist = release / "dist"
    payload = json.loads((dist / "fleet-deployment-manifest.json").read_text())
    if payload.get("source_sha") != sha:
        raise RuntimeError("candidate_deployment_manifest_sha_mismatch")
    files = {
        x.relative_to(dist).as_posix(): sha256(x)
        for x in dist.rglob("*") if x.is_file() and not x.is_symlink()
        and x.name != "fleet-deployment-manifest.json"
    }
    if files != payload.get("payload"):
        raise RuntimeError("candidate_payload_mismatch")
    return (dist / "index.js", sha, fingerprint)


def existing_source() -> tuple[Path, str]:
    # Resolve the CURRENT, actual entrypoint. A symlink into a previous release
    # remains a valid and recoverable old version.
    old = ENTRYPOINT.resolve(strict=True)
    manifest = json.loads((old.parent / "fleet-deployment-manifest.json").read_text())
    previous = manifest.get("source_sha")
    if not isinstance(previous, str) or not re.fullmatch(r"[a-f0-9]{40}", previous):
        raise RuntimeError("previous_release_source_unverified")
    declared_index = manifest.get("payload", {}).get("index.js")
    if declared_index == sha256(old):
        return old, previous
    # Existing root child is a known historical mixed dist: an older manifest
    # survived targeted repairs. Accept only the exact already-reviewed release
    # code for its entrypoint and release-control modules; do not trust the
    # stale manifest alone or accept arbitrary hand-modified executables.
    reviewed = KNOWN_RECOVERY_RELEASE / "dist"
    reviewed_manifest = json.loads((reviewed / "fleet-deployment-manifest.json").read_text())
    if reviewed_manifest.get("source_sha") != KNOWN_RECOVERY_RELEASE.name:
        raise RuntimeError("recovery_release_identity_mismatch")
    for name in ("index.js", "mcp/project-release-tools.js", "project-release-lease.js"):
        if sha256(REPO / "dist" / name) != sha256(reviewed / name):
            raise RuntimeError("mixed_runtime_unverified_" + name.replace("/", "_"))
    return old, KNOWN_RECOVERY_RELEASE.name


def assert_parent():
    result = subprocess.run(
        ["systemctl", "show", PARENT_UNIT, "-p", "MainPID", "--value"],
        capture_output=True, text=True, timeout=8, check=True)
    value = result.stdout.strip()
    if not value.isdigit() or int(value) <= 1:
        raise RuntimeError("gptadmin_hub_parent_not_running")
    # No restart or lifecycle mutation.
    args = subprocess.run(["ps", "-p", value, "-o", "args="],
                          capture_output=True, text=True, timeout=8, check=True).stdout
    if "/gptadmin-node" not in args:
        raise RuntimeError("gptadmin_hub_parent_identity_mismatch")


def owner_git(arguments):
    owner = REPO.stat()
    def drop_to_owner():
        os.setgroups([])
        os.setgid(owner.st_gid)
        os.setuid(owner.st_uid)
    return subprocess.run(
        ["git", "-C", str(REPO), *arguments],
        capture_output=True, text=True, timeout=10,
        preexec_fn=drop_to_owner if os.geteuid() == 0 else None)


def assert_project_binding(gate):
    result = owner_git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if result.returncode:
        raise RuntimeError("release_project_canonicalization_failed")
    project = str(Path(result.stdout.strip()).resolve(strict=True))
    if gate.proof.get("project") != project:
        raise RuntimeError("release_lease_project_mismatch")


def owner_ancestry(previous: str, candidate: str):
    result = owner_git(["merge-base", "--is-ancestor", previous, candidate])
    if result.returncode:
        raise RuntimeError("candidate_not_descended_from_installed_revision")


def entrypoint_snapshot(entrypoint: Path):
    info = entrypoint.lstat()
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
            os.readlink(entrypoint) if entrypoint.is_symlink() else None,
            str(entrypoint.resolve(strict=True)), sha256(entrypoint))


def assert_entrypoint_snapshot(entrypoint: Path, expected):
    try:
        unchanged = entrypoint_snapshot(entrypoint) == expected
    except OSError:
        unchanged = False
    if not unchanged:
        raise RuntimeError("live_entrypoint_changed_before_commit")


def atomic_entrypoint_switch(entrypoint: Path, new_entrypoint: Path,
                             backup_dir: Path, gate, expected_snapshot=None) -> Path:
    """Switch ONE file atomically; symlink realpath loads the full candidate tree."""
    if expected_snapshot is None:
        expected_snapshot = entrypoint_snapshot(entrypoint)
    assert_entrypoint_snapshot(entrypoint, expected_snapshot)
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    previous = backup_dir / "index.js"
    if entrypoint.is_symlink():
        previous.symlink_to(os.readlink(entrypoint))
    else:
        shutil.copy2(entrypoint, previous)
    staged = entrypoint.parent / (".mcp-entrypoint-" + uuid.uuid4().hex)
    installed_identity = None
    try:
        staged.symlink_to(new_entrypoint)
        staged_info = staged.lstat()
        installed_identity = (staged_info.st_dev, staged_info.st_ino)
        gate.check()  # Recheck token/fence immediately before the commit.
        assert_entrypoint_snapshot(entrypoint, expected_snapshot)
        os.replace(staged, entrypoint)
        if entrypoint.resolve(strict=True) != new_entrypoint.resolve(strict=True):
            raise RuntimeError("entrypoint_switch_readback_failed")
    except BaseException:
        if staged.is_symlink():
            staged.unlink()
        # Only rollback this exact switch while the same guard owns the lock.
        try:
            current = entrypoint.lstat()
            owns_switch = (current.st_dev, current.st_ino) == installed_identity
        except FileNotFoundError:
            owns_switch = False
        if owns_switch:
            gate.check(cleanup=True)
            recover = entrypoint.parent / (".mcp-recover-" + uuid.uuid4().hex)
            if previous.is_symlink():
                recover.symlink_to(os.readlink(previous))
            else:
                shutil.copy2(previous, recover)
            os.replace(recover, entrypoint)
        raise
    return previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--release-proof")
    arguments = parser.parse_args()
    candidate_entry, sha, fingerprint = candidate_preflight(arguments.sha)
    old, previous_sha = existing_source()
    old_digest = sha256(old)
    expected_snapshot = entrypoint_snapshot(ENTRYPOINT)
    assert_parent()
    if arguments.dry_run:
        print(json.dumps({"preflight": "ok", "candidateSha": sha,
                          "previousSha": previous_sha, "bundleFingerprint": fingerprint,
                          "entrypoint": str(ENTRYPOINT), "parentUnit": PARENT_UNIT,
                          "target": TARGET, "state": "NOT_INSTALLED"}))
        return
    if os.geteuid() != 0 or not arguments.release_proof:
        raise RuntimeError("root_authority_release_proof_required")
    if REPO.resolve(strict=True) != REPO or ENTRYPOINT.parent.resolve(strict=True) != ENTRYPOINT.parent:
        raise RuntimeError("registered_entrypoint_parent_not_canonical")
    if LEDGER.is_symlink() or LEDGER.resolve(strict=True) != LEDGER:
        raise RuntimeError("authority_ledger_not_canonical")
    if socket.gethostname() != "roomhacker-server-100":
        raise RuntimeError("authority_host_mismatch")
    gate = ReleaseGate(arguments.release_proof, state_path=LEDGER, target=TARGET)
    assert_project_binding(gate)
    with gate:
        gate.check()
        fresh_entry, _, fresh_fingerprint = candidate_preflight(sha)
        if fresh_entry != candidate_entry or fresh_fingerprint != fingerprint:
            raise RuntimeError("candidate_changed_after_preflight")
        observed, observed_sha = existing_source()
        if observed != old or observed_sha != previous_sha or sha256(observed) != old_digest:
            raise RuntimeError("live_entrypoint_changed_after_preflight")
        owner_ancestry(previous_sha, sha)
        # An older manifest remains in this reviewed mixed legacy dist.
        # Its declared ancestor must also be on the candidate lineage.
        observed_manifest = json.loads((old.parent / "fleet-deployment-manifest.json").read_text())
        if observed_manifest["source_sha"] != previous_sha:
            owner_ancestry(observed_manifest["source_sha"], sha)
        assert_parent()
        if ENTRYPOINT.resolve() == candidate_entry.resolve():
            raise RuntimeError("candidate_already_current")
        backup = ROLLBACK_ROOT / (previous_sha[:12] + "-" + uuid.uuid4().hex)
        saved = atomic_entrypoint_switch(
            ENTRYPOINT, candidate_entry, backup, gate, expected_snapshot)
        print(json.dumps({"installed": True, "candidateSha": sha,
                          "previousSha": previous_sha, "entrypoint": str(ENTRYPOINT),
                          "sourceRealpath": str(ENTRYPOINT.resolve()),
                          "rollbackEntry": str(saved), "parentUnit": PARENT_UNIT,
                          "parentRestarted": False, "liveChildAccepted": False}))
        # liveChildAccepted requires a *new* observed child generation + tool receipt.


if __name__ == "__main__":
    main()
