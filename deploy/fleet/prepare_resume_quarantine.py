"""Stage exact legacy evidence and scoped native quarantine; never change authority.

Input config names the epoch, writer_drain pin, original wait/receipt/job paths,
and reviewed native profiles. Scope overrides are explicit record_ref -> holds.
Apply is a separate command after known writers are drained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
from quarantine_io import publish_exclusive

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()

def private(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("canonical_private_path_required")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError("canonical_private_file_required")
    return path.read_bytes()

def exact(value):
    return isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 4096 and value.strip() == value and not any(ord(x) < 32 or 0x7f <= ord(x) <= 0x9f for x in value)

def directory(path):
    path = Path(path)
    info = path.lstat()
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("canonical_private_directory_required")
    return path, {"device": str(info.st_dev), "inode": str(info.st_ino)}

def wait_settled(row):
    delivery = row.get("delivery") or {}
    receipt = delivery.get("receipt") or {}
    if row.get("state") == "resumed" and delivery.get("status") == "accepted":
        return "accepted"
    if row.get("state") in ("cancelled", "delivery_blocked", "delivery_failed") and delivery.get("status") == "rejected" and receipt.get("notSubmitted") is True and receipt.get("admitted") is not True and receipt.get("admissionUnknown") is not True:
        return "not_submitted"
    return "unknown"

def receipt_settled(row):
    if row.get("status") == "accepted" and exact(row.get("receipt_ref")) and exact(row.get("result_ref")) and isinstance(row.get("target"), dict):
        return "accepted"
    if row.get("status") in ("rejected", "failed") and row.get("admitted") is not True and row.get("admissionUnknown") is not True and row.get("admission_unknown") is not True:
        if row.get("notSubmitted") is True:
            return "not_submitted"
        if row.get("status") == "rejected" and row.get("target", {}).get("agent") == "opencode" and row.get("transport") == "opencode-api" and row.get("error") == "OpenCode v2 config has an invalid shape" and all(row.get(k) is False for k in ("executed", "pending", "admitted", "admission_unknown")):
            return "not_submitted"
    return "unknown"

def job_settled(row):
    result = row.get("resume_result")
    target = row.get("resume") or {}
    if not isinstance(result, dict) or result.get("agent") != target.get("agent") or result.get("session_id") != target.get("session_id") or result.get("used_last") is not False:
        return "unknown"
    if result.get("admission_unknown") is True or result.get("admissionUnknown") is True:
        return "unknown"
    if row.get("execute_resume") is False and result.get("executed") is False and result.get("ok") is True and result.get("admitted") is not True:
        return "not_submitted"
    if result.get("notSubmitted") is True and result.get("admitted") is not True:
        return "not_submitted"
    if result.get("ok") is True and result.get("executed") is True and result.get("admitted") is True:
        return "accepted"
    # A detached shell PID and launch_returncode=0 are not native admission.
    return "unknown"


def validate_snapshot(snapshot):
    """Match the native reader before an immutable authority import."""
    import re
    def sha(value):
        return isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None
    fields = {"version", "kind", "epoch", "authority_generation", "node_ref", "instance_ref",
              "writer_drain_sha256", "inventory_sha256", "sources", "records"}
    if not isinstance(snapshot, dict) or set(snapshot) != fields or type(snapshot["version"]) is not int or snapshot["version"] != 1 or snapshot["kind"] != "herder-legacy-quarantine":
        raise ValueError("quarantine_snapshot_shape_invalid")
    if any(not exact(snapshot[k]) for k in ("epoch", "authority_generation", "node_ref", "instance_ref")) or len(snapshot["epoch"].encode()) > 128 or any(not sha(snapshot[k]) for k in ("writer_drain_sha256", "inventory_sha256")):
        raise ValueError("quarantine_snapshot_identity_invalid")
    sources, records = snapshot["sources"], snapshot["records"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= 20000 or not isinstance(records, list) or len(records) > 20000:
        raise ValueError("quarantine_snapshot_inventory_invalid")
    known = {}
    for source in sources:
        if not isinstance(source, dict) or set(source) != {"path", "sha256"} or not exact(source["path"]) or not Path(source["path"]).is_absolute() or not sha(source["sha256"]) or source["path"] in known:
            raise ValueError("quarantine_snapshot_source_invalid")
        known[source["path"]] = source["sha256"]
    expected = digest("".join(sorted(k + "\0" + v + "\n" for k, v in known.items())).encode())
    if snapshot["inventory_sha256"] != expected:
        raise ValueError("quarantine_snapshot_inventory_mismatch")
    seen = set()
    for row in records:
        if not isinstance(row, dict) or set(row) != {"record_ref", "source_path", "source_sha256", "record_sha256", "request_keys", "outcome", "holds"}:
            raise ValueError("quarantine_snapshot_record_invalid")
        if not exact(row["record_ref"]) or row["record_ref"] in seen or not sha(row["record_sha256"]) or known.get(row["source_path"]) != row["source_sha256"]:
            raise ValueError("quarantine_snapshot_record_invalid")
        seen.add(row["record_ref"])
        if not isinstance(row["request_keys"], list) or not 1 <= len(row["request_keys"]) <= 32 or any(not exact(key) for key in row["request_keys"]):
            raise ValueError("quarantine_snapshot_keys_invalid")
        if row["outcome"] not in ("accepted", "not_submitted", "unknown") or not isinstance(row["holds"], list) or len(row["holds"]) > 64 or (row["outcome"] == "unknown") != bool(row["holds"]):
            raise ValueError("quarantine_snapshot_outcome_invalid")
        for hold in row["holds"]:
            if not isinstance(hold, dict) or set(hold) != {"node_ref", "instance_ref", "native_session_id"} or not exact(hold["node_ref"]) or not exact(hold["instance_ref"]) or (hold["native_session_id"] is not None and (not exact(hold["native_session_id"]) or hold["native_session_id"] == "*")):
                raise ValueError("quarantine_snapshot_hold_invalid")

def stage(config, output):
    from datetime import datetime, timezone
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory(output)
    epoch = config["epoch"]
    if config.get("version") != 1 or not exact(epoch) or len(epoch.encode("utf-8")) > 128 or any(0x7f <= ord(c) <= 0x9f for c in epoch):
        raise ValueError("invalid_migration_epoch")
    drain = config["writer_drain"]
    if digest(private(drain["path"])) != drain["sha256"]:
        raise ValueError("writer_drain_pin_mismatch")
    profiles = config["profiles"]
    if not profiles or len(profiles) > 128:
        raise ValueError("native_profile_inventory_required")
    seen = set()
    for p in profiles:
        if any(not exact(p.get(k)) for k in ("harness", "node_ref", "instance_ref", "authority_generation", "database", "gate")):
            raise ValueError("native_profile_identity_invalid")
        ident = (p["node_ref"], p["instance_ref"])
        if ident in seen:
            raise ValueError("duplicate_native_profile")
        seen.add(ident)
        for k in ("database", "gate"):
            private(p[k])
    sources, records, seals = {}, [], {}
    overrides = config.get("scope_overrides", {})

    def add(ref, file, original, row, keys, outcome, owner):
        source_sha = digest(original)
        sources[str(file)] = source_sha
        holds = []
        if outcome == "unknown":
            if ref in overrides:
                holds = overrides[ref]
            else:
                host = owner.get("hostId") or config.get("node_ref")
                for p in profiles:
                    if p["harness"] != owner.get("harness"):
                        continue
                    if host and p["node_ref"] != host and host not in p.get("legacy_host_ids", []):
                        continue
                    holds.append({"node_ref": p["node_ref"], "instance_ref": p["instance_ref"],
                                  "native_session_id": owner.get("sessionId") or None})
            if not holds:
                raise ValueError("reviewed_scope_required:" + ref)
            for hold in holds:
                if (hold.get("node_ref"), hold.get("instance_ref")) not in seen or (hold.get("native_session_id") is not None and (not exact(hold["native_session_id"]) or hold["native_session_id"] == "*")):
                    raise ValueError("reviewed_scope_invalid:" + ref)
        records.append({"record_ref": ref, "source_path": str(file), "source_sha256": source_sha,
                        "record_sha256": digest(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()),
                        "request_keys": keys, "outcome": outcome, "holds": holds})

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    waits, wi = directory(config["resume_after"])
    wait_rows = []
    for file in sorted(waits.iterdir()):
        if not file.name.startswith("wait_") or file.suffix != ".json":
            raise ValueError("unexpected_resume_after_inventory")
        raw = private(file)
        row = json.loads(raw)
        if row.get("id") != file.stem:
            raise ValueError("wait_identity_mismatch")
        wait_rows.append({"id": row["id"], "sha256": digest(raw)})
        add("resume-after:" + row["id"], file, raw, row, [row["id"], "resume-after:" + row["id"]], wait_settled(row), row["owner"])
    seals["resume_after"] = {"version": 1, "kind": "herder-resume-after-retained", "epoch": epoch,
                             "directory": str(waits), "directory_identity": wi, "sealed_at": now, "records": wait_rows}
    receipt_path = Path(config["resume_receipts"])
    raw = private(receipt_path)
    ledger = json.loads(raw)
    sources[str(receipt_path)] = digest(raw)
    for key, row in sorted(ledger["receipts"].items()):
        if row.get("idempotency_key") != key:
            raise ValueError("receipt_key_mismatch")
        target = row.get("target") or {}
        add("resume-receipt:" + digest(key.encode()), receipt_path, raw, row,
            [key, "compat-resume:v1:" + digest(key.encode())], receipt_settled(row),
            {"harness": target.get("agent"), "sessionId": target.get("session_id"), "hostId": target.get("hostId")})
    ri = receipt_path.stat()
    seals["resume_receipts"] = {"version": 1, "kind": "herder-resume-receipts-retained", "epoch": epoch,
                                "path": str(receipt_path), "sha256": digest(raw), "sealed_at": now,
                                "file_identity": {"device": str(ri.st_dev), "inode": str(ri.st_ino)}}
    jobs, ji = directory(config["legacy_jobs"])
    job_rows = []
    for folder in sorted(jobs.iterdir()):
        directory(folder)
        file = folder / "meta.json"
        raw = private(file)
        row = json.loads(raw)
        if row.get("job_id") != folder.name:
            raise ValueError("job_identity_mismatch")
        job_rows.append({"id": folder.name, "sha256": digest(raw)})
        key = "agent-resume:job:" + folder.name
        outcome = job_settled(row)
        resume = row.get("resume") or {}
        add("agent-resume-job:" + folder.name, file, raw, row, [folder.name, key, "compat-resume:v1:" + digest(key.encode())], outcome,
            {"harness": resume.get("agent"), "sessionId": resume.get("session_id")})
    seals["legacy_jobs"] = {"version": 1, "kind": "herder-legacy-jobs-retained", "epoch": epoch,
                            "directory": str(jobs), "directory_identity": ji, "sealed_at": now, "records": job_rows}

    def publish(name, value):
        file = output / name
        data = encoded(value)
        if file.exists():
            if file.read_bytes() != data:
                raise ValueError("staging_artifact_already_exists:" + name)
        else:
            publish_exclusive(file, data)
        return {"path": str(file), "sha256": digest(data)}

    pins = {key: publish(key + "-seal.json", value) for key, value in seals.items()}
    source_rows = [{"path": key, "sha256": value} for key, value in sorted(sources.items())]
    inventory = digest("".join(sorted(key + "\0" + value + "\n" for key, value in sources.items())).encode())
    snapshots = []
    imports = []
    for p in profiles:
        snapshot = {"version": 1, "kind": "herder-legacy-quarantine", "epoch": epoch,
                    "authority_generation": p["authority_generation"], "node_ref": p["node_ref"], "instance_ref": p["instance_ref"],
                    "writer_drain_sha256": drain["sha256"], "inventory_sha256": inventory, "sources": source_rows, "records": records}
        validate_snapshot(snapshot)
        pin = publish("quarantine-" + digest((p["node_ref"] + "\0" + p["instance_ref"]).encode())[:20] + ".json", snapshot)
        projection = {key: p[key] for key in ("harness", "node_ref", "instance_ref", "authority_generation")}
        if p.get("legacy_host_ids"):
            projection["legacy_host_ids"] = p["legacy_host_ids"]
        snapshots.append({**projection, **pin})
        imports.append({**projection, **pin, "database": p["database"], "gate": p["gate"]})
    canonical = {"version": 1, "mode": "canonical", "epoch": epoch, "authority": config["authority"],
                 "node_ref": config["node_ref"], "writer_drain": drain,
                 "resume_after": {"directory": str(waits), "snapshot": pins["resume_after"]["path"], "sha256": pins["resume_after"]["sha256"]},
                 "resume_receipts": {"path": str(receipt_path), "snapshot": pins["resume_receipts"]["path"], "sha256": pins["resume_receipts"]["sha256"]},
                 "quarantine": {"inventory_sha256": inventory,
                    "legacy_jobs": {"directory": str(jobs), "snapshot": pins["legacy_jobs"]["path"], "sha256": pins["legacy_jobs"]["sha256"]},
                    "snapshots": snapshots}}
    config_pin = publish("canonical-config.json", canonical)
    plan = {"version": 1, "kind": "herder-quarantine-import-plan", "epoch": epoch,
            "canonical_config": config_pin, "writer_drain": drain, "sources": source_rows,
            "seal_directories": [str(waits), str(jobs)] + [str(jobs / x["id"]) for x in job_rows],
            "imports": imports, "counts": {"waits": len(wait_rows), "receipts": len(ledger["receipts"]), "jobs": len(job_rows),
                "unknown": sum(r["outcome"] == "unknown" for r in records)}, "effects": "none"}
    return publish("import-plan.json", plan), plan

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-directory", required=True)
    args = parser.parse_args()
    pin, plan = stage(json.loads(private(args.config)), args.output_directory)
    print(json.dumps({"plan": pin, "counts": plan["counts"], "effects": "none"}, sort_keys=True))

if __name__ == "__main__":
    main()
