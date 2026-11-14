"""Explicit UNKNOWN resource occupancy for guarded legacy release cutover."""
import hashlib
import json
import os
from pathlib import Path
import stat
from quarantine_io import publish_exclusive

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()

def lease_digest(value):
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())

def private_bytes(path, sealed=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise RuntimeError("resource_quarantine_path_invalid")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077 or sealed and info.st_mode & 0o777 != 0o400:
        raise RuntimeError("resource_quarantine_evidence_untrusted")
    return path.read_bytes()

def planned_holds(policy, state, config, archive, original, own_project):
    reviewed = policy.get("resource_quarantines", [])
    if not isinstance(reviewed, list):
        raise RuntimeError("resource_quarantine_plan_invalid")
    process = json.loads(private_bytes(config["process_config"]))
    authority = process["resources"]
    rows, projects, resources = [], set(), set()
    for item in reviewed:
        if set(item) != {"project", "resource_ref", "revision", "fence", "lease_sha256", "outcome"} or item["outcome"] != "unknown":
            raise RuntimeError("resource_quarantine_plan_invalid")
        project = item["project"]
        if project == own_project or project in projects or item["resource_ref"] in resources:
            raise RuntimeError("resource_quarantine_scope_conflict")
        mapping = next((m for m in config["mappings"] if m["project"] == project), None)
        lease = state.get("projects", {}).get(project, {}).get("lease")
        if not mapping or not isinstance(lease, dict) or mapping["resource_ref"] != item["resource_ref"] or mapping["revision"] != item["revision"] or lease.get("fence") != item["fence"] or lease_digest(lease) != item["lease_sha256"]:
            raise RuntimeError("resource_quarantine_owner_binding_changed")
        if not isinstance(lease.get("owner"), dict) or not isinstance(lease.get("tokenHash"), str) or len(lease["tokenHash"]) != 64:
            raise RuntimeError("resource_quarantine_owner_evidence_invalid")
        projects.add(project); resources.add(item["resource_ref"])
        path = Path(authority["root"]) / "resources" / item["resource_ref"] / "migration-hold.json"
        value = {"version": 1, "kind": "herder-legacy-resource-quarantine", "epoch": config["seal_id"],
                 "schema": authority["schema"], "storage_id": authority["storage_id"],
                 "resource_ref": item["resource_ref"], "resource_revision": item["revision"],
                 "source_project": project, "source_fence": item["fence"], "source_owner": lease["owner"],
                 "source_token_hash": lease["tokenHash"], "source_lease_sha256": item["lease_sha256"],
                 "archive": {"path": str(archive), "sha256": digest(original)}, "outcome": "unknown"}
        data = encoded(value)
        if path.exists() or path.is_symlink():
            existing_data = private_bytes(path, sealed=True)
            existing = json.loads(existing_data)
            expected = {k: v for k, v in value.items() if k != "archive"}
            if {k: v for k, v in existing.items() if k != "archive"} != expected:
                raise RuntimeError("resource_quarantine_existing_conflict")
            archive_data = private_bytes(existing["archive"]["path"], sealed=True)
            if digest(archive_data) != existing["archive"]["sha256"]:
                raise RuntimeError("resource_quarantine_archive_changed")
            prior = json.loads(archive_data)
            prior_lease = prior.get("projects", {}).get(project, {}).get("lease")
            if prior.get("version") != 1 or lease_digest(prior_lease) != item["lease_sha256"]:
                raise RuntimeError("resource_quarantine_original_owner_changed")
            value, data = existing, existing_data
        rows.append({"project": project, "resource_ref": item["resource_ref"], "path": str(path),
                     "sha256": digest(data), "value": value, "bytes": data})
    return rows

def publish_holds(rows):
    for row in rows:
        path = Path(row["path"])
        if path.exists():
            if private_bytes(path, sealed=True) != row["bytes"]:
                raise RuntimeError("resource_quarantine_existing_conflict")
            continue
        publish_exclusive(path, row["bytes"])
