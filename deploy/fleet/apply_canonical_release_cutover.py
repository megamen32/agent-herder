"""Explicit guarded cutover of a drained legacy release authority.

No service is stopped automatically. Apply requires reviewed runtime evidence,
all known writers stopped, exact source CAS and only the caller's migration
lease remaining. Reconcile never restores an old writable authority or wakes
agents. The original private ledger remains archived byte for byte.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import threading
import time
import uuid

from prepare_canonical_release_cutover import prepare
from release_gate import ReleaseGate
from release_quarantine import planned_holds, publish_holds


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def canonical_file(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_file():
        raise RuntimeError("cutover_requires_canonical_file")
    return path


def private_file(value):
    path = canonical_file(value)
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
        raise RuntimeError("cutover_private_file_required")
    return path


def protected_directory(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir():
        raise RuntimeError("cutover_canonical_directory_required")
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise RuntimeError("cutover_protected_directory_required")
    return path


def validate_lock(path, fd):
    named, opened = path.lstat(), os.fstat(fd)
    if ((named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino)
            or not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid()
            or opened.st_mode & 0o022 or opened.st_nlink != 1):
        raise RuntimeError("cutover_lock_identity_invalid")


def atomic_write(path, data):
    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def checkpoint_write(path, record, phase):
    record["phase"] = phase
    record["updated_at_unix_ms"] = int(time.time() * 1000)
    atomic_write(path, encoded(record))


def process_identity(proc_root, pid):
    try:
        stat = (proc_root / str(pid) / "stat").read_text()
    except FileNotFoundError:
        return None
    fields = stat[stat.rfind(")") + 2:].split()
    if len(fields) < 20:
        raise RuntimeError("cutover_process_identity_unknown")
    return {"pid": int(pid), "start_ticks": int(fields[19]),
            "boot_id": (proc_root / "sys/kernel/random/boot_id").read_text().strip()}


def verify_runtime(manifest, proc_root=Path("/proc")):
    if (manifest.get("version") != 1 or manifest.get("host") != socket.gethostname()
            or not manifest.get("drained_processes") or not manifest.get("writer_entrypoints")):
        raise RuntimeError("cutover_runtime_inventory_required")
    entries = {str(canonical_file(value)) for value in manifest["writer_entrypoints"]}
    entry_names = {Path(value).name for value in entries}
    for expected in manifest["drained_processes"]:
        if (not isinstance(expected.get("pid"), int) or expected["pid"] <= 0
                or not isinstance(expected.get("start_ticks"), int) or expected["start_ticks"] <= 0
                or not expected.get("boot_id") or expected.get("entrypoint") not in entries):
            raise RuntimeError("cutover_writer_identity_invalid")
        actual = process_identity(proc_root, expected["pid"])
        if actual and all(actual[key] == expected[key] for key in ("pid", "start_ticks", "boot_id")):
            raise RuntimeError("cutover_old_writer_still_alive")
    # Verify current processes as well as historical PID identities. Command
    # lines are used for exact matching only and are never printed or archived.
    for process in proc_root.iterdir():
        if not process.name.isdecimal():
            continue
        try:
            args = (process / "cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            continue
        except PermissionError:
            raise RuntimeError("cutover_writer_inventory_unobservable") from None
        for arg in args:
            value = os.fsdecode(arg)
            if value in entries:
                raise RuntimeError("cutover_writer_still_running")
            if value and (Path(value).is_absolute() or Path(value).name in entry_names):
                try:
                    candidate = Path(value) if Path(value).is_absolute() else (process / "cwd").resolve(strict=True) / value
                    if str(candidate.resolve(strict=True)) in entries:
                        raise RuntimeError("cutover_writer_still_running")
                except (FileNotFoundError, NotADirectoryError, PermissionError):
                    pass
    kinds = set()
    for item in manifest.get("consumer_verifications", []):
        kind = item.get("kind")
        if kind in kinds:
            raise RuntimeError("cutover_duplicate_consumer_evidence")
        kinds.add(kind)
        artifact = canonical_file(item["artifact"])
        receipt = private_file(item["receipt"])
        if digest(artifact.read_bytes()) != item.get("artifact_sha256") or digest(receipt.read_bytes()) != item.get("receipt_sha256"):
            raise RuntimeError("cutover_consumer_evidence_digest_changed")
        evidence = json.loads(receipt.read_bytes())
        if (evidence.get("protocol") != "canonical-release-v1" or evidence.get("kind") != kind
                or evidence.get("result") != "passed" or evidence.get("artifact_sha256") != item["artifact_sha256"]
                or not isinstance(evidence.get("observed_process"), dict)):
            raise RuntimeError("cutover_consumer_runtime_verification_required")
        observed = evidence["observed_process"]
        if (not isinstance(observed.get("pid"), int) or observed["pid"] <= 0
                or not isinstance(observed.get("start_ticks"), int) or observed["start_ticks"] <= 0
                or not observed.get("boot_id") or not evidence.get("checks")):
            raise RuntimeError("cutover_consumer_runtime_verification_required")
        actual = process_identity(proc_root, observed["pid"])
        if actual and all(actual[key] == observed[key] for key in ("pid", "start_ticks", "boot_id")):
            raise RuntimeError("cutover_verified_consumer_not_drained")
    if kinds != {"typescript_facade", "python_gate", "native_rollout"}:
        raise RuntimeError("cutover_all_consumers_must_be_verified")
    selectors = manifest.get("occupancy_selectors")
    if not isinstance(selectors, list) or not selectors:
        raise RuntimeError("cutover_selector_occupancy_inventory_required")
    for value in selectors:
        selector = Path(value)
        if not selector.is_absolute() or selector.parent.resolve(strict=True) != selector.parent:
            raise RuntimeError("cutover_selector_path_invalid")
        pointer = selector.parent / ("." + selector.name + ".process-leases-rollout.json")
        data = json.loads(private_file(pointer).read_bytes())
        if data.get("schema") != 1 or data.get("phase") != "resolved" or data.get("selector") != str(selector):
            raise RuntimeError("cutover_rollout_occupancy_unresolved")
        job_dir = protected_directory(data["job_dir"])
        job_state = private_file(job_dir / "state.json")
        final = job_state.read_bytes()
        state = json.loads(final)
        if (state.get("schema") != 1 or not isinstance(data.get("job_id"), str) or not data["job_id"]
                or digest(final) != data.get("final_state_sha256") or state.get("job_id") != data["job_id"]
                or state.get("job_dir") != str(job_dir)
                or state.get("selector") != str(selector)
                or state.get("phase") not in ("completed", "recovered_baseline", "recovered_candidate")):
            raise RuntimeError("cutover_rollout_terminal_evidence_invalid")


@contextmanager
def ledger_barrier(ledger):
    # proper-lockfile uses this exact empty directory with realpath:false.
    path = Path(str(ledger) + ".lock")
    path.mkdir(mode=0o700)
    identity = (path.stat().st_dev, path.stat().st_ino)
    stopped = threading.Event()
    lost = threading.Event()

    def verify():
        stat = path.lstat()
        if lost.is_set() or (stat.st_dev, stat.st_ino) != identity or not path.is_dir():
            raise RuntimeError("cutover_ledger_barrier_lost")

    def heartbeat():
        while not stopped.wait(5):
            try:
                verify()
                os.utime(path, None)
            except OSError:
                lost.set()
                return
            except RuntimeError:
                lost.set()
                return
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        yield verify
    finally:
        stopped.set()
        thread.join(timeout=1)
        try:
            stat = path.lstat()
            if (stat.st_dev, stat.st_ino) == identity:
                path.rmdir()
        except FileNotFoundError:
            pass


@contextmanager
def other_effect_locks(ledger, state, mappings, own_project, own_target):
    paths = {ledger.parent / ("deploy-" + digest(project.encode()) + ".lock") for project in state["projects"]}
    paths |= {ledger.parent / ("deploy-unit-" + digest(m["deployment_target"]["unit"].encode()) + ".lock")
              for m in mappings if m.get("deployment_target")}
    paths.discard(ledger.parent / ("deploy-" + digest(own_project.encode()) + ".lock"))
    if own_target:
        paths.discard(ledger.parent / ("deploy-unit-" + digest(own_target["unit"].encode()) + ".lock"))
    descriptors = []
    try:
        for path in sorted(paths):
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            validate_lock(path, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("cutover_legacy_effect_still_running") from None
        yield
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


@contextmanager
def operation_lock(checkpoint):
    if not checkpoint.is_absolute() or protected_directory(checkpoint.parent) != checkpoint.parent:
        raise RuntimeError("cutover_checkpoint_path_invalid")
    fd = os.open(str(checkpoint) + ".operation.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        validate_lock(Path(str(checkpoint) + ".operation.lock"), fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


@contextmanager
def canonical_resource_barrier(config_data):
    process = json.loads(private_file(config_data["process_config"]).read_bytes())
    root = protected_directory(process["resources"]["root"])
    protected_directory(root / "resources")
    # These are the actual Rust registry, effect and owner guard inodes, not a
    # migration-only ownership store. Nonblocking acquisition avoids lock-order
    # deadlocks with a concurrent native release or expiry takeover.
    paths = [root / "resource-registry.lock"]
    for resource in sorted({m["resource_ref"] for m in config_data["mappings"]}):
        protected_directory(root / "resources" / resource)
        paths += [root / "resources" / resource / "execution.lock", root / "resources" / resource / "guard.lock"]
    descriptors = []
    try:
        for path in paths:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            validate_lock(path, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("cutover_canonical_resource_busy") from None
        yield
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def apply(ledger, config, bridge, proof, manifest, checkpoint, proc_root=Path("/proc")):
    ledger, config, proof, manifest = map(private_file, (ledger, config, proof, manifest))
    bridge = canonical_file(bridge)
    binary_metadata = bridge.stat()
    if binary_metadata.st_uid != os.geteuid() or binary_metadata.st_mode & 0o022 or not binary_metadata.st_mode & 0o100:
        raise RuntimeError("cutover_protected_bridge_required")
    checkpoint = Path(checkpoint)
    with operation_lock(checkpoint):
        if checkpoint.exists() or checkpoint.is_symlink():
            raise RuntimeError("cutover_checkpoint_exists_reconcile_first")
        policy = json.loads(manifest.read_bytes())
        config_data = json.loads(config.read_bytes())
        if policy.get("seal_id") != config_data.get("seal_id"):
            raise RuntimeError("cutover_manifest_seal_mismatch")
        verify_runtime(policy, proc_root)
        before = ledger.read_bytes()
        if digest(before) != policy.get("ledger_sha256"):
            raise RuntimeError("cutover_source_cas_failed")
        state = json.loads(before)
        owner_proof = json.loads(proof.read_bytes())
        own_project = owner_proof["project"]
        own_lease = state.get("projects", {}).get(own_project, {}).get("lease")
        if not own_lease:
            raise RuntimeError("cutover_own_migration_lease_required")
        own_target = own_lease.get("deploymentTarget")
        # Validate every canonical root/ref before creating any of its locks.
        prepare(ledger, config, bridge)
        with ReleaseGate(proof, ledger, target=own_target) as gate:
            with other_effect_locks(ledger, state, config_data["mappings"], own_project, own_target):
                with ledger_barrier(ledger) as barrier, canonical_resource_barrier(config_data):
                    verify_runtime(policy, proc_root)
                    gate.check()
                    if ledger.read_bytes() != before:
                        raise RuntimeError("cutover_source_cas_failed")
                    proposal = prepare(ledger, config, bridge)
                    if proposal["unmapped_projects"]:
                        raise RuntimeError("cutover_mapping_inventory_incomplete")
                    archive = checkpoint.parent / (checkpoint.name + ".legacy.json")
                    quarantines = planned_holds(policy, state, config_data, archive, before, own_project)
                    held_projects = {q["project"] for q in quarantines}
                    held_resources = {q["resource_ref"] for q in quarantines}
                    blockers = [b for b in proposal["blockers"] if not (
                        b.get("project") in held_projects | {own_project}
                        and b.get("reason") == "legacy_owner_requires_reconciliation")
                        and not (b.get("resource_ref") in held_resources
                                 and b.get("reason") == "canonical_migration_occupancy_unknown")]
                    if blockers:
                        raise RuntimeError("cutover_other_ownership_requires_reconciliation")
                    sealed = json.loads(before)
                    # Release exactly the admitted migration generation. Every
                    # prior record, including its proof hash, remains in archive.
                    del sealed["projects"][own_project]["lease"]
                    for quarantine in quarantines:
                        del sealed["projects"][quarantine["project"]]["lease"]
                        sealed["projects"][quarantine["project"]]["migrationQuarantine"] = {
                            "outcome": "unknown", "resourceRef": quarantine["resource_ref"],
                            "evidenceSha256": quarantine["sha256"]}
                    sealed["version"] = 2
                    sealed["canonical"] = {"version": 1, "config": str(config), "bridge": str(bridge), "seal_id": config_data["seal_id"]}
                    after = encoded(sealed)
                    archive = checkpoint.parent / (checkpoint.name + ".legacy.json")
                    record = {"version": 1, "seal_id": config_data["seal_id"], "ledger": str(ledger), "config": str(config), "bridge": str(bridge),
                              "archive": str(archive), "archive_sha256": digest(before), "source_sha256": digest(before), "sealed_sha256": digest(after),
                              "config_sha256": digest(config.read_bytes()), "bridge_sha256": digest(bridge.read_bytes()),
                              "process_config_sha256": digest(canonical_file(config_data["process_config"]).read_bytes()),
                              "manifest_sha256": digest(manifest.read_bytes()), "manifest": str(manifest),
                              "retired_migration_owner": {"project": own_project, "owner": own_lease["owner"], "fence": own_lease["fence"]},
                              "resource_fence_seeds": proposal["resource_fence_seeds"],
                              "resource_quarantines": [{k: q[k] for k in ("project", "resource_ref", "path", "sha256")} for q in quarantines],
                              "inventory": [{"project": p, "fence": v.get("fence", 0), "record_sha256": digest(encoded(v)),
                                  "mapping": next(m for m in config_data["mappings"] if m["project"] == p)} for p, v in state["projects"].items()]}
                    checkpoint_write(checkpoint, record, "prepared")
                    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as output:
                        output.write(before)
                        output.flush()
                        os.fchmod(output.fileno(), 0o400)
                        os.fsync(output.fileno())
                    parent = os.open(archive.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(parent)
                    finally:
                        os.close(parent)
                    checkpoint_write(checkpoint, record, "archived")
                    # The same registry/effect/claim barriers remain held. A
                    # crash here leaves conservative native occupancy and the
                    # unchanged original ledger, never a newly free resource.
                    publish_holds(quarantines)
                    if quarantines:
                        checkpoint_write(checkpoint, record, "quarantined")
                    barrier()
                    verify_runtime(policy, proc_root)
                    gate.check()
                    if (ledger.read_bytes() != before or digest(config.read_bytes()) != record["config_sha256"]
                            or digest(bridge.read_bytes()) != record["bridge_sha256"]
                            or digest(manifest.read_bytes()) != record["manifest_sha256"]
                            or digest(canonical_file(config_data["process_config"]).read_bytes()) != record["process_config_sha256"]):
                        raise RuntimeError("cutover_source_cas_failed")
                    atomic_write(ledger, after)
                    checkpoint_write(checkpoint, record, "sealed_requires_consumer_verification")
                    return {"sealed": True, "consumer_verification_required": True, "checkpoint": str(checkpoint),
                            "archive_sha256": record["archive_sha256"], "inventory_count": len(record["inventory"])}


def reconcile(checkpoint):
    checkpoint = private_file(checkpoint)
    with operation_lock(checkpoint):
        record = json.loads(checkpoint.read_bytes())
        current = private_file(record["ledger"]).read_bytes()
        archive = Path(record["archive"])
        if archive.exists():
            if digest(private_file(archive).read_bytes()) != record["archive_sha256"]:
                raise RuntimeError("cutover_archive_evidence_changed")
        elif record.get("phase") != "prepared" or digest(current) != record["source_sha256"]:
            raise RuntimeError("cutover_archive_evidence_missing")
        for item in record.get("resource_quarantines", []):
            path = Path(item["path"])
            if not path.exists() and record.get("phase") in ("prepared", "archived"):
                continue
            if digest(private_file(path).read_bytes()) != item["sha256"] or path.stat().st_mode & 0o777 != 0o400:
                raise RuntimeError("cutover_quarantine_evidence_changed")
        if digest(current) == record["source_sha256"]:
            outcome = "source_unchanged_requires_fresh_guard_and_proposal"
        elif digest(current) == record["sealed_sha256"]:
            outcome = "sealed_requires_consumer_verification"
        else:
            state = json.loads(current)
            marker = state.get("canonical", {})
            outcome = "sealed_changed_requires_review" if state.get("version") == 2 and marker.get("seal_id") == record["seal_id"] else "unknown_requires_review"
        # Classification is evidence, never an automatic success, rollback,
        # lease release, artifact deletion or agent wake.
        record["reconciliation"] = {"outcome": outcome, "observed_ledger_sha256": digest(current), "observed_at_unix_ms": int(time.time() * 1000)}
        atomic_write(checkpoint, encoded(record))
        return {"outcome": outcome, "checkpoint": str(checkpoint), "automatic_resume": False, "automatic_rollback": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    install = sub.add_parser("apply")
    for option in ("ledger", "config", "bridge", "proof", "manifest", "checkpoint"):
        install.add_argument("--" + option, required=True)
    recovery = sub.add_parser("reconcile")
    recovery.add_argument("--checkpoint", required=True)
    args = vars(parser.parse_args())
    action = args.pop("action")
    result = apply(**args) if action == "apply" else reconcile(**args)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
