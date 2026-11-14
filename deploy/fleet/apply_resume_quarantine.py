"""Import a reviewed sealed quarantine under existing native authority gates.

This command sends no agent input and never changes a historical outcome.
A partial import is safe to reconcile by running the same exact plan; differing
settings or source bytes refuse. Only the cutover owner should invoke --apply.
"""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import time
import urllib.parse

from prepare_resume_quarantine import private, digest, encoded, directory, validate_snapshot
from quarantine_io import publish_exclusive

def process_birth(pid):
    try:
        value = Path("/proc", str(pid), "stat").read_text()
    except FileNotFoundError:
        return None
    parts = value[value.rfind(")") + 2:].split()
    if len(parts) < 20:
        raise ValueError("writer_identity_unavailable")
    return parts[19]

def verify_drain(plan, canonical):
    pin = plan["writer_drain"]
    raw = private(pin["path"])
    if digest(raw) != pin["sha256"]:
        raise ValueError("writer_drain_pin_mismatch")
    proof = json.loads(raw)
    if proof.get("version") != 1 or proof.get("kind") != "herder-legacy-writer-drain" or proof.get("epoch") != plan["epoch"] or proof.get("platform") != "linux" or proof.get("hostname") != socket.gethostname():
        raise ValueError("writer_drain_identity_mismatch")
    completed = datetime.fromisoformat(proof["completed_at"].replace("Z", "+00:00")).timestamp()
    if completed > time.time() + 5:
        raise ValueError("writer_drain_future")
    sources = proof.get("sources", [])
    required = {canonical["resume_after"]["directory"], canonical["resume_receipts"]["path"],
                canonical["quarantine"]["legacy_jobs"]["directory"]}
    if not required.issubset(sources) or len(set(sources)) != len(sources):
        raise ValueError("writer_drain_scope_mismatch")
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    writers = proof.get("writers")
    if not isinstance(writers, list) or not 1 <= len(writers) <= 256:
        raise ValueError("writer_drain_inventory_required")
    covered, seen = set(), set()
    for writer in writers:
        observation = writer.get("observation", {})
        ident = (writer.get("boot_id"), writer.get("pid"), writer.get("start_ticks"))
        if ident in seen or not isinstance(writer.get("pid"), int) or writer["pid"] <= 1 or not str(writer.get("start_ticks", "")).isdigit() or len(writer.get("executable_sha256", "")) != 64:
            raise ValueError("writer_drain_identity_invalid")
        seen.add(ident)
        if not writer.get("sources") or not set(writer["sources"]).issubset(sources) or observation.get("result") != "identity_absent" or not all(observation.get(k) for k in ("provider_operation_id", "target", "method", "observed_at")):
            raise ValueError("writer_drain_observation_invalid")
        observed = datetime.fromisoformat(observation["observed_at"].replace("Z", "+00:00")).timestamp()
        if observed > completed:
            raise ValueError("writer_drain_observation_after_completion")
        if writer["boot_id"] == boot and process_birth(writer["pid"]) == writer["start_ticks"]:
            raise ValueError("legacy_writer_still_alive")
        covered.update(writer["sources"])
    if set(sources) != covered:
        raise ValueError("writer_drain_scope_incomplete")

def source_cas(plan):
    for source in plan["sources"]:
        if digest(private(source["path"])) != source["sha256"]:
            raise ValueError("legacy_source_changed:" + source["path"])

def gate(path):
    file = Path(path)
    private(file)
    fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        named, opened = file.lstat(), os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError("authority_gate_changed")
        return fd
    except BaseException:
        os.close(fd)
        raise

def apply(plan_path, expected_sha256, receipt_path):
    raw = private(plan_path)
    if digest(raw) != expected_sha256:
        raise ValueError("import_plan_pin_mismatch")
    plan = json.loads(raw)
    if plan.get("version") != 1 or plan.get("kind") != "herder-quarantine-import-plan":
        raise ValueError("import_plan_invalid")
    config_raw = private(plan["canonical_config"]["path"])
    if digest(config_raw) != plan["canonical_config"]["sha256"]:
        raise ValueError("canonical_config_pin_mismatch")
    canonical = json.loads(config_raw)
    if canonical.get("epoch") != plan["epoch"] or canonical.get("writer_drain") != plan["writer_drain"]:
        raise ValueError("canonical_epoch_mismatch")
    verify_drain(plan, canonical)
    source_cas(plan)
    imports = plan["imports"]
    if not imports or len({item["database"] for item in imports}) != len(imports):
        raise ValueError("duplicate_authority_import")
    projections = [{key: value for key, value in item.items() if key not in ("database", "gate")} for item in imports]
    if projections != canonical["quarantine"]["snapshots"]:
        raise ValueError("quarantine_config_import_mismatch")
    receipt_path = Path(receipt_path)
    if not receipt_path.is_absolute() or receipt_path.parent.resolve(strict=True) != receipt_path.parent:
        raise ValueError("receipt_path_invalid")
    directory(receipt_path.parent)
    # Refuse a foreign receipt before touching even a single authority.
    def existing_receipt():
        if not receipt_path.exists() and not receipt_path.is_symlink():
            return None
        prior = json.loads(private(receipt_path))
        if prior.get("version") != 1 or prior.get("kind") != "herder-quarantine-import-receipt" or prior.get("plan_sha256") != expected_sha256 or prior.get("epoch") != plan["epoch"] or prior.get("canonical_config") != plan["canonical_config"] or prior.get("native_handoffs") != 0 or prior.get("historical_outcomes_changed") != 0:
            raise ValueError("import_receipt_conflict")
        return prior
    existing_receipt()
    with ExitStack() as stack:
        fds = {}
        for item in sorted(imports, key=lambda i: i["gate"]):
            fd = gate(item["gate"])
            stack.callback(os.close, fd)
            fds[item["gate"]] = fd
        opened = []
        for item in imports:
            data = private(item["path"])
            if digest(data) != item["sha256"]:
                raise ValueError("quarantine_snapshot_pin_mismatch")
            snapshot = json.loads(data)
            validate_snapshot(snapshot)
            if snapshot["epoch"] != plan["epoch"] or snapshot["authority_generation"] != item["authority_generation"] or snapshot["node_ref"] != item["node_ref"] or snapshot["instance_ref"] != item["instance_ref"] or snapshot["writer_drain_sha256"] != plan["writer_drain"]["sha256"]:
                raise ValueError("quarantine_snapshot_identity_mismatch")
            if snapshot["sources"] != plan["sources"]:
                raise ValueError("quarantine_source_inventory_mismatch")
            private(item["database"])
            dbmeta = Path(item["database"]).lstat()
            gm = os.fstat(fds[item["gate"]])
            db = sqlite3.connect("file:" + urllib.parse.quote(item["database"], safe="/") + "?mode=rw", uri=True, timeout=0)
            stack.callback(db.close)
            db.execute("BEGIN IMMEDIATE")
            stack.callback(lambda connection=db: connection.rollback() if connection.in_transaction else None)
            binding = db.execute("SELECT generation,gate_device,gate_inode,database_device,database_inode FROM humanstop_authority WHERE singleton=1").fetchone()
            if binding != (item["authority_generation"], gm.st_dev, gm.st_ino, dbmeta.st_dev, dbmeta.st_ino):
                raise ValueError("authority_inode_generation_mismatch")
            current = Path(item["database"]).lstat()
            if (current.st_dev, current.st_ino) != (dbmeta.st_dev, dbmeta.st_ino):
                raise ValueError("authority_database_changed")
            existing = db.execute("SELECT value_json FROM settings WHERE scope='migration:legacy' AND setting_key='quarantine:v1'").fetchone()
            text = data.decode("utf-8")
            if existing is not None and existing[0] != text:
                raise ValueError("quarantine_existing_epoch_conflict")
            opened.append((item, db, text, existing is not None))
        verify_drain(plan, canonical)
        source_cas(plan)
        # Original bytes are retained. Permission sealing alone is not writer
        # drain; the exact reviewed birth identities were independently checked.
        for source in plan["sources"]:
            path = Path(source["path"])
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.fchmod(fd, 0o400)
                os.fsync(fd)
            finally:
                os.close(fd)
        for folder in sorted(plan["seal_directories"], key=len, reverse=True):
            path, _ = directory(folder)
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fchmod(fd, 0o500)
                os.fsync(fd)
            finally:
                os.close(fd)
        installed = []
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for item, db, text, existing in opened:
            if not existing:
                db.execute("INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES('migration:legacy','quarantine:v1',?,1,?)", (text, now))
            db.commit()
            installed.append({"node_ref": item["node_ref"], "instance_ref": item["instance_ref"],
                              "authority_generation": item["authority_generation"], "snapshot_sha256": item["sha256"],
                              "admission": "existing" if existing else "stored"})
        source_cas(plan)
    receipt = {"version": 1, "kind": "herder-quarantine-import-receipt", "epoch": plan["epoch"],
               "plan_sha256": expected_sha256, "canonical_config": plan["canonical_config"],
               "installed": installed, "native_handoffs": 0, "historical_outcomes_changed": 0, "completed_at": now}
    data = encoded(receipt)
    prior = existing_receipt()
    if prior is not None:
        return prior
    try:
        publish_exclusive(receipt_path, data)
    except FileExistsError:
        prior = existing_receipt()
        if prior is None:
            raise ValueError("import_receipt_changed")
        return prior
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--apply", action="store_true", required=True)
    args = parser.parse_args()
    print(json.dumps(apply(args.plan, args.expected_plan_sha256, args.receipt), sort_keys=True))

if __name__ == "__main__":
    main()
