use super::*;
use herder::ownership::resource::register_or_update;
use std::{collections::BTreeMap, sync::Barrier};

const FLEET: &str = "deployment-fleet";

pub(super) fn two_targets(f: &Fixture) -> Value {
    let fleet_dir = f.root.join("fleet-nodes");
    fs::create_dir(&fleet_dir).unwrap();
    let descriptor = ResourceDescriptor::new(
        ResourceRef(FLEET.into()),
        ResourceScope::Global,
        ResourceKind::Deployment,
        "fixture-fleet-target".into(),
        f.authority.storage_id.0.clone(),
        None,
        1,
    );
    register_or_update(&f.authority, descriptor, Authorization::Authorized, None).unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["version"] = json!(2);
    config["mappings"][0]["default_for_project"] = json!(true);
    config["mappings"].as_array_mut().unwrap().push(json!({
        "project": f.projects[0], "resource_ref": FLEET, "revision": 1, "previous_fence": 41,
        "deployment_target": {"fleetDir": fleet_dir, "unit": "fixture-fleet.service"}
    }));
    write_private(&f.config, &config);
    config
}

fn at(mut request: Value, target: &Value) -> Value {
    request["deploymentTarget"] = target.clone();
    request
}

// Include empty directories and lock files as well as owner/receipt bytes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut entries = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            entries.extend(snapshot(&path));
            entries.insert(path, Vec::new());
        } else {
            let bytes = fs::read(&path).unwrap();
            entries.insert(path, bytes);
        }
    }
    entries
}

#[test]
fn exact_target_and_default_are_order_independent_and_status_is_read_only() {
    let f = Fixture::new();
    let mut config = two_targets(&f);
    let owner = config["mappings"][0]["deployment_target"].clone();
    let fleet = config["mappings"][2]["deployment_target"].clone();
    config["mappings"].as_array_mut().unwrap().reverse();
    write_private(&f.config, &config);
    let before = snapshot(&f.authority.root);
    let ledger = fs::read(&f.ledger).unwrap();
    let status = f.request("status", 0);
    let default_status = f.call(status.clone());
    assert_eq!(default_status["result"]["resourceRef"], f.resource.0);
    assert!(default_status["result"].get("deploymentTarget").is_none());
    assert_eq!(
        f.call(f.request("status", 1))["result"]["resourceRef"],
        f.resource.0
    );
    let selected = f.call(at(status.clone(), &fleet));
    assert_eq!(selected["result"]["resourceRef"], FLEET);
    assert_eq!(selected["result"]["deploymentTarget"], fleet);
    assert_eq!(selected["result"]["releaseOccupancyEnabled"], true);
    assert_eq!(selected["result"]["nextFence"], 42);
    // Request paths canonicalize. The configured tuple must itself be canonical.
    let link = f.root.join("fleet-link");
    std::os::unix::fs::symlink(fleet["fleetDir"].as_str().unwrap(), &link).unwrap();
    let mut equivalent = fleet.clone();
    equivalent["fleetDir"] = json!(link);
    assert_eq!(f.call(at(status.clone(), &equivalent)), selected);
    let unknown = json!({"fleetDir":owner["fleetDir"], "unit":fleet["unit"]});
    assert_eq!(
        f.call(at(status.clone(), &unknown))["error"],
        "proof_mismatch"
    );
    assert_eq!(
        f.call(at(f.request("status", 1), &fleet))["error"],
        "proof_mismatch"
    );
    let other_project = json!({"action":"status","project":f.root.join("unregistered.git")});
    assert_eq!(
        f.call(at(other_project, &fleet))["error"],
        "project_unmapped"
    );

    config["mappings"][2]
        .as_object_mut()
        .unwrap()
        .remove("default_for_project");
    write_private(&f.config, &config);
    for action in ["status", "acquire", "check", "renew", "release", "guard"] {
        assert_eq!(
            f.call(f.request(action, 0))["error"],
            "deployment_target_required",
            "{action}"
        );
    }
    assert_eq!(
        f.call(at(status.clone(), &owner))["result"]["resourceRef"],
        f.resource.0
    );
    assert_eq!(f.call(at(status, &fleet)), selected);
    assert!(snapshot(&f.authority.root) == before);
    assert!(fs::read(&f.ledger).unwrap() == ledger);
}

#[test]
fn duplicate_routes_default_unit_alias_and_downgrade_errors_are_read_only() {
    let f = Fixture::new();
    let base = two_targets(&f);
    let before = snapshot(&f.authority.root);
    for (case, expected) in [
        ("duplicate", "configuration_invalid"),
        ("same tuple different resource", "configuration_invalid"),
        ("same unit different directory", "configuration_invalid"),
        ("same resource different target", "configuration_invalid"),
        ("alias revision", "configuration_invalid"),
        ("two defaults", "configuration_invalid"),
        ("unregistered resource", "configuration_invalid"),
        ("stale revision", "revision_mismatch"),
        ("unknown field", "configuration_invalid"),
        ("null default", "configuration_invalid"),
        ("unknown version", "configuration_invalid"),
        ("v1 repeated project", "configuration_invalid"),
        ("v1 with v2 flag", "configuration_invalid"),
    ] {
        let mut cfg = base.clone();
        match case {
            "duplicate" => {
                let same = cfg["mappings"][2].clone();
                cfg["mappings"].as_array_mut().unwrap().push(same);
            }
            "same tuple different resource" => {
                cfg["mappings"][2]["deployment_target"] =
                    cfg["mappings"][0]["deployment_target"].clone()
            }
            "same unit different directory" => {
                cfg["mappings"][2]["deployment_target"]["unit"] = json!("fixture.service")
            }
            "same resource different target" => {
                cfg["mappings"][2]["resource_ref"] = json!(f.resource)
            }
            "alias revision" => cfg["mappings"][1]["revision"] = json!(2),
            "two defaults" => cfg["mappings"][2]["default_for_project"] = json!(true),
            "unregistered resource" => cfg["mappings"][2]["resource_ref"] = json!("missing"),
            "stale revision" => cfg["mappings"][2]["revision"] = json!(2),
            "unknown field" => cfg["mappings"][2]["node_selector"] = json!("node"),
            "null default" => cfg["mappings"][0]["default_for_project"] = Value::Null,
            "unknown version" => cfg["version"] = json!(3),
            "v1 repeated project" => {
                cfg["version"] = json!(1);
                cfg["mappings"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("default_for_project");
            }
            "v1 with v2 flag" => {
                cfg["version"] = json!(1);
                cfg["mappings"].as_array_mut().unwrap().pop();
                cfg["mappings"][0]["default_for_project"] = json!(false);
            }
            _ => unreachable!(),
        }
        write_private(&f.config, &cfg);
        assert_eq!(f.call(f.request("status", 0))["error"], expected, "{case}");
    }
    assert!(snapshot(&f.authority.root) == before);
}

#[test]
fn owner_and_fleet_proofs_with_equal_fences_remain_separate_through_rollback() {
    let f = Fixture::new();
    let old_config = fs::read(&f.config).unwrap();
    let ledger = fs::read(&f.ledger).unwrap();
    let owner_token = "1".repeat(64);
    let fleet_token = "2".repeat(64);
    assert_eq!(
        f.call(f.acquire_request(0, &owner_token))["result"]["lease"]["fence"],
        42
    );
    let config = two_targets(&f);
    let owner = &config["mappings"][0]["deployment_target"];
    let fleet = &config["mappings"][2]["deployment_target"];
    assert_eq!(
        f.call(f.proof_request("check", 0, &owner_token, 42))["result"]["deploymentTarget"],
        *owner
    );
    let fleet_acquire = at(f.acquire_request(0, &fleet_token), fleet);
    let first = f.call(fleet_acquire.clone());
    assert_eq!(first["result"]["lease"]["fence"], 42);
    assert!(first == f.call(fleet_acquire));
    let before = snapshot(&f.authority.root);
    for action in ["check", "renew", "release", "guard"] {
        assert_eq!(
            f.call(at(f.proof_request(action, 0, &owner_token, 42), fleet))["error"],
            "proof_mismatch",
            "{action}"
        );
        assert_eq!(
            f.call(f.proof_request(action, 0, &fleet_token, 42))["error"],
            "proof_mismatch",
            "{action}"
        );
    }
    assert_eq!(
        f.call(at(f.acquire_request(0, &owner_token), fleet))["error"],
        "idempotency_conflict"
    );
    assert_eq!(
        f.call(f.acquire_request(1, &fleet_token))["error"],
        "idempotency_conflict"
    );
    assert!(snapshot(&f.authority.root) == before);

    let mut owner_guard = f.guard(&owner_token, 42);
    let mut fleet_guard = GuardProcess::start(&f.executable, &f.config);
    let admitted = fleet_guard.send(at(f.proof_request("guard", 0, &fleet_token, 42), fleet));
    assert_eq!(admitted["result"]["lease"]["deploymentTarget"], *fleet);
    // Disabling admission mid-rollout leaves the admitted guard responsible
    // for cleanup of its own execution only.
    f.set_occupancy_enabled(false);
    assert_eq!(
        fleet_guard.send(at(json!({"action":"check","cleanup":true}), owner))["error"],
        "invalid_request"
    );
    assert_eq!(
        fleet_guard.send(json!({"action":"check","cleanup":true}))["result"]["deploymentTarget"],
        *fleet
    );
    assert_eq!(
        fleet_guard.send(json!({"action":"finished"}))["result"]["finished"],
        true
    );
    f.set_occupancy_enabled(true);
    assert_eq!(
        f.call(at(f.request("status", 0), fleet))["result"]["deploymentInProgress"],
        false
    );
    assert_eq!(
        f.call(f.request("status", 1))["result"]["deploymentInProgress"],
        true
    );
    assert_eq!(
        owner_guard.send(json!({"action":"finished"}))["result"]["finished"],
        true
    );

    let before_rollback = snapshot(&f.authority.root);
    fs::write(&f.config, old_config).unwrap();
    assert_eq!(
        f.call(f.proof_request("check", 0, &owner_token, 42))["ok"],
        true
    );
    let fleet_proof = f.proof_request("check", 0, &fleet_token, 42);
    assert_eq!(
        f.call(at(fleet_proof.clone(), fleet))["error"],
        "proof_mismatch"
    );
    assert_eq!(f.call(fleet_proof.clone())["error"], "proof_mismatch");
    assert_eq!(
        f.call(f.acquire_request(0, &fleet_token))["error"],
        "idempotency_conflict"
    );
    assert!(snapshot(&f.authority.root) == before_rollback);
    write_private(&f.config, &config);
    assert_eq!(f.call(at(fleet_proof, fleet))["ok"], true);
    assert_eq!(
        f.call(at(f.proof_request("release", 0, &fleet_token, 42), fleet))["result"]["released"],
        true
    );
    let next = f.call(at(f.acquire_request(0, &"7".repeat(64)), fleet));
    assert_eq!(next["result"]["lease"]["fence"], 43);
    assert_eq!(
        f.call(at(f.proof_request("check", 0, &fleet_token, 42), fleet))["error"],
        "proof_mismatch"
    );
    assert_eq!(f.call(f.request("status", 0))["result"]["nextFence"], 43);
    assert_eq!(
        f.call(at(f.request("status", 0), fleet))["result"]["nextFence"],
        44
    );
    assert_eq!(
        f.call(f.proof_request("check", 0, &owner_token, 42))["ok"],
        true
    );
    assert!(fs::read(&f.ledger).unwrap() == ledger);
}

#[test]
fn simultaneous_acquires_cannot_issue_the_same_token_on_two_targets() {
    let f = Fixture::new();
    let cfg = two_targets(&f);
    let fleet = &cfg["mappings"][2]["deployment_target"];
    let token = "3".repeat(64);
    let start = Barrier::new(2);
    let acquire = |request| {
        start.wait();
        f.call(request)
    };
    let (owner, remote) = thread::scope(|s| {
        let a = s.spawn(|| acquire(f.acquire_request(1, &token)));
        let b = s.spawn(|| acquire(at(f.acquire_request(0, &token), fleet)));
        (a.join().unwrap(), b.join().unwrap())
    });
    let (winner, loser) = if owner["ok"] == true {
        (owner, remote)
    } else {
        (remote, owner)
    };
    assert_eq!(winner["result"]["lease"]["fence"], 42);
    assert_eq!(loser["error"], "idempotency_conflict");
    let mut fences = [
        f.call(f.request("status", 1))["result"]["nextFence"]
            .as_u64()
            .unwrap(),
        f.call(at(f.request("status", 0), fleet))["result"]["nextFence"]
            .as_u64()
            .unwrap(),
    ];
    fences.sort();
    assert_eq!(fences, [42, 43]);
}

#[test]
fn disabled_v2_reports_the_selected_target_and_cannot_open_a_guard() {
    let f = Fixture::new();
    let cfg = two_targets(&f);
    let fleet = &cfg["mappings"][2]["deployment_target"];
    f.set_occupancy_enabled(false);
    let before = snapshot(&f.authority.root);
    let status = f.call(at(f.request("status", 0), fleet));
    assert_eq!(status["result"]["disabled"], true);
    assert_eq!(status["result"]["releaseOccupancyEnabled"], false);
    assert_eq!(status["result"]["deploymentTarget"], *fleet);
    assert_eq!(
        f.call(at(f.acquire_request(0, &"4".repeat(64)), fleet))["result"]["acquired"],
        false
    );
    for action in ["check", "guard", "renew", "release"] {
        assert_eq!(
            f.call(at(f.request(action, 0), fleet))["error"],
            "release_occupancy_disabled"
        );
    }
    assert!(snapshot(&f.authority.root) == before);
}

fn disabled_trace(f: &Fixture, project: &Value, target: Option<&Value>) -> Vec<Value> {
    let mut bridge = GuardProcess::start(&f.executable, &f.config);
    let mut replies = Vec::new();
    for action in ["status", "acquire", "check", "renew", "release", "guard"] {
        let mut request = json!({"action":action, "project":project});
        if let Some(target) = target {
            request["deploymentTarget"] = target.clone();
        }
        replies.push(bridge.send(request));
    }
    replies.push(bridge.send(json!({"action":"check"})));
    replies.push(bridge.send(json!({"action":"finished"})));
    replies
}

#[test]
fn opting_in_one_of_28_projects_preserves_every_legacy_disabled_reply_and_unrelated_tokens() {
    let f = Fixture::new();
    let mut old: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    let mappings = old["mappings"].as_array_mut().unwrap();
    mappings.truncate(1);
    for index in 1..=27 {
        let id = format!("neighbor-{index}");
        let project = f.root.join(format!("{id}.git"));
        fs::create_dir(&project).unwrap();
        let descriptor = ResourceDescriptor::new(
            ResourceRef(id.clone()),
            ResourceScope::Global,
            ResourceKind::Deployment,
            id.clone(),
            f.authority.storage_id.0.clone(),
            None,
            1,
        );
        register_or_update(&f.authority, descriptor, Authorization::Authorized, None).unwrap();
        mappings.push(
            json!({"project":project,"resource_ref":id,"revision":1,"previous_fence":7,
            "deployment_target":{"fleetDir":f.fleet,"unit":format!("{id}.service")}}),
        );
    }
    write_private(&f.config, &old);
    f.set_occupancy_enabled(false);
    let entries = old["mappings"].as_array().unwrap();
    let traces: Vec<_> = entries
        .iter()
        .map(|m| disabled_trace(&f, &m["project"], None))
        .collect();
    assert_eq!(traces[0][5]["result"]["bypassed"], true);
    let cfg = two_targets(&f);
    let before = snapshot(&f.authority.root);
    for (row, trace) in entries.iter().zip(traces) {
        assert_eq!(disabled_trace(&f, &row["project"], None), trace);
        assert_eq!(
            disabled_trace(&f, &row["project"], Some(&row["deployment_target"])),
            trace
        );
    }
    let fleet = &cfg["mappings"].as_array().unwrap().last().unwrap()["deployment_target"];
    let denied = f.call(at(f.request("guard", 0), fleet));
    assert_eq!(denied["error"], "release_occupancy_disabled");
    assert!(snapshot(&f.authority.root) == before);

    // A previously independent project's own idempotency namespace survives
    // the upgrade, including equal owner, fence and caller-supplied nonce.
    f.set_occupancy_enabled(true);
    let token = "5".repeat(64);
    let owner = f.acquire_request(0, &token);
    let mut neighbor = owner.clone();
    neighbor["project"] = entries[1]["project"].clone();
    assert_eq!(f.call(neighbor)["result"]["lease"]["fence"], 8);
    assert_eq!(f.call(owner)["result"]["lease"]["fence"], 8);
    let mut check = f.proof_request("check", 0, &token, 8);
    assert_eq!(f.call(check.clone())["ok"], true);
    check["project"] = entries[1]["project"].clone();
    assert_eq!(f.call(check)["ok"], true);
}

#[test]
fn legacy_project_only_default_survives_adding_a_concrete_target() {
    let f = Fixture::new();
    let mut legacy: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    for mapping in legacy["mappings"].as_array_mut().unwrap() {
        mapping.as_object_mut().unwrap().remove("deployment_target");
    }
    write_private(&f.config, &legacy);
    let token = "6".repeat(64);
    let acquired = f.call(f.acquire_request(0, &token));
    assert_eq!(acquired["result"]["lease"]["fence"], 42);
    assert!(
        acquired["result"]["lease"]
            .get("deploymentTarget")
            .is_none()
    );
    let cfg = two_targets(&f);
    let fleet = &cfg["mappings"][2]["deployment_target"];
    assert_eq!(f.call(f.proof_request("check", 0, &token, 42))["ok"], true);
    assert_eq!(
        f.call(at(f.proof_request("guard", 0, &token, 42), fleet))["error"],
        "proof_mismatch"
    );
}
