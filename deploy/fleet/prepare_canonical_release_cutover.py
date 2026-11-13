"""Read-only proposal for a reviewed legacy release authority cutover.

This command never locks, edits, archives, releases or migrates a live owner.
Expired legacy records remain blockers until their effects are reconciled.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time


def contains_lease(value):
    if isinstance(value, dict):
        return "lease" in value or any(contains_lease(nested) for nested in value.values())
    if isinstance(value, list):
        return any(contains_lease(nested) for nested in value)
    return False


def prepare(ledger_path, config_path, bridge_path, now_ms=None):
    ledger_path, config_path, bridge_path = map(Path, (ledger_path, config_path, bridge_path))
    for path in (ledger_path, config_path, bridge_path):
        if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_file():
            raise ValueError("cutover_requires_existing_canonical_absolute_files")
    original = ledger_path.read_bytes()
    state = json.loads(original)
    config = json.loads(config_path.read_bytes())
    if state.get("version") != 1 or "canonical" in state or not isinstance(state.get("projects"), dict):
        raise ValueError("cutover_requires_unsealed_version_one_ledger")
    if (config.get("version") != 1 or config.get("ledger") != str(ledger_path)
            or not isinstance(config.get("seal_id"), str) or not config["seal_id"]
            or not isinstance(config.get("mappings"), list) or not config["mappings"]):
        raise ValueError("cutover_mapping_invalid")
    process_path = Path(config["process_config"])
    if not process_path.is_absolute() or process_path.resolve(strict=True) != process_path:
        raise ValueError("cutover_process_config_must_be_canonical")
    process = json.loads(process_path.read_bytes())
    if config.get("principal_ref") not in process.get("administrators", []):
        raise ValueError("cutover_principal_not_installed_administrator")
    authority = process["resources"]
    authority_root = Path(authority["root"])
    if not authority_root.is_absolute() or authority_root.resolve(strict=True) != authority_root:
        raise ValueError("cutover_resource_root_must_be_canonical")
    storage = json.loads((authority_root / "storage.json").read_bytes())
    if storage.get("schema") != authority["schema"] or storage.get("storage_id") != authority["storage_id"]:
        raise ValueError("cutover_storage_identity_mismatch")
    seen, aliases, units, inspected, blockers, resource_seeds = set(), {}, {}, [], [], {}
    for mapping in config["mappings"]:
        project, resource = mapping["project"], mapping["resource_ref"]
        if (project in seen or not Path(project).is_absolute() or not isinstance(resource, str)
                or not resource or resource in (".", "..") or "/" in resource or "\\" in resource):
            raise ValueError("cutover_project_or_resource_mapping_invalid")
        seen.add(project)
        target = mapping.get("deployment_target")
        if target is not None and (not isinstance(target, dict) or set(target) != {"fleetDir", "unit"}
                or not Path(target["fleetDir"]).is_absolute() or not re.fullmatch(r"[A-Za-z0-9_.:@-]+", target["unit"])):
            raise ValueError("cutover_exact_deployment_target_required")
        if target is not None:
            identity = (resource, target)
            if target["unit"] in units and units[target["unit"]] != identity:
                raise ValueError("cutover_unit_has_multiple_resource_or_target_identities")
            units[target["unit"]] = identity
        group = (mapping["revision"], target)
        if resource in aliases and aliases[resource] != group:
            raise ValueError("cutover_aliases_disagree_on_resource_generation_or_target")
        aliases[resource] = group
        previous = state["projects"].get(project, {}).get("fence", 0)
        if (not isinstance(mapping.get("previous_fence"), int) or isinstance(mapping["previous_fence"], bool)
                or mapping["previous_fence"] < previous or mapping["previous_fence"] > 9007199254740991):
            raise ValueError("cutover_cannot_decrease_legacy_fence")
        resource_seeds[resource] = max(resource_seeds.get(resource, 0), mapping["previous_fence"])
        resource_dir = authority_root / "resources" / resource
        marker = json.loads((resource_dir / "resource.json").read_bytes())
        descriptor = marker.get("descriptor", {})
        if (marker.get("schema") != authority["schema"] or marker.get("storage_id") != authority["storage_id"] or marker.get("resource_ref") != resource
                or descriptor.get("resource_ref") != resource or descriptor.get("revision") != mapping["revision"]):
            raise ValueError("cutover_resource_revision_mismatch")
        if (resource_dir / "owner.json").exists():
            blockers.append({"resource_ref": resource, "reason": "canonical_owner_requires_reconciliation"})
        if (resource_dir / "execution-binding.json").exists():
            binding = json.loads((resource_dir / "execution-binding.json").read_bytes())
            if not isinstance(binding, dict) or not binding.get("resolved_receipt"):
                blockers.append({"resource_ref": resource, "reason": "canonical_occupancy_unresolved"})
        inspected.append({"project": project, "resource_ref": resource, "revision": mapping["revision"],
                          "previous_fence": mapping["previous_fence"], "deployment_target": target,
                          "external_ref": descriptor.get("external_ref")})
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    for project, value in state["projects"].items():
        if not isinstance(value, dict):
            raise ValueError("cutover_project_record_invalid")
        if contains_lease({key: nested for key, nested in value.items() if key != "lease"}):
            blockers.append({"project": project, "reason": "legacy_nested_ownership_requires_reconciliation"})
        if "lease" in value:
            lease = value["lease"]
            blockers.append({"project": project, "reason": "legacy_owner_requires_reconciliation",
                             "fence": lease.get("fence") if isinstance(lease, dict) else None,
                             "expired": isinstance(lease, dict) and isinstance(lease.get("expiresAt"), (int, float))
                                        and lease["expiresAt"] <= now_ms})
    if contains_lease({key: nested for key, nested in state.items() if key != "projects"}):
        blockers.append({"reason": "legacy_nested_ownership_requires_reconciliation"})
    proposed = {**state, "version": 2, "canonical": {"version": 1, "config": str(config_path),
                "bridge": str(bridge_path), "seal_id": config["seal_id"]}}
    # An inadmissible proposal does not silently delete the blocking owner.
    return {"mode": "prepare_only", "data_ready": not blockers, "live_cutover_authorized": False,
            "ledger": str(ledger_path), "expected_ledger_sha256": hashlib.sha256(original).hexdigest(),
            "required_archive_sha256": hashlib.sha256(original).hexdigest(), "mappings": inspected,
            "resource_fence_seeds": resource_seeds,
            "blockers": blockers, "unmapped_projects": sorted(set(state["projects"]) - seen),
            "required_barriers": ["all_legacy_writers_and_deployment_consumers_upgraded_or_stopped",
                                  "inflight_effects_reconciled_and_legacy_execution_locks_exclusive",
                                  "legacy_ledger_transaction_lock_held_and_source_digest_rechecked",
                                  "private_original_archive_fsynced_before_atomic_version_two_seal"],
            "proposed_sealed_ledger": proposed if not blockers else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--bridge", required=True)
    args = parser.parse_args()
    proposal = prepare(args.ledger, args.config, args.bridge)
    print(json.dumps(proposal, indent=2))
    return 0 if proposal["data_ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
