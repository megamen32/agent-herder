//! Isolated resource fixtures with an injected restart executor. No service calls.
use super::*;
use crate::{
    domain::{
        address::NodeRef,
        resource::{ResourceDescriptor, ResourceKind, ResourceScope},
    },
    ownership::manifest::{
        AuthorityRoute, ResourceMarker, StorageAuthority, StorageId, StorageMarker,
    },
};
use std::{cell::Cell, os::unix::fs::PermissionsExt, process::Command};

fn private(path: &Path, value: &impl Serialize) {
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    serde_json::to_writer(&mut f, value).unwrap();
    f.write_all(b"\n").unwrap();
    f.sync_all().unwrap();
}
fn pin(path: &Path) -> FilePin {
    FilePin {
        path: path.into(),
        sha256: hex(&Sha256::digest(fs::read(path).unwrap())),
    }
}
fn identity(pid: u32) -> ProcessIdentity {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    ProcessIdentity {
        pid,
        boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .unwrap()
            .trim()
            .into(),
        start_ticks: fields[19].parse().unwrap(),
    }
}
fn success() -> SystemctlResult {
    SystemctlResult {
        spawned: true,
        exit_code: Some(0),
        signal: None,
        timed_out: false,
        stdout_sha256: hex(&Sha256::digest([])),
        stderr_sha256: hex(&Sha256::digest([])),
        stdout_bytes: 0,
        stderr_bytes: 0,
        error_code: None,
    }
}
struct Fixture {
    root: PathBuf,
    config: PathBuf,
    evidence: PathBuf,
    plan: PathBuf,
    request: Value,
    authority: StorageAuthority,
    resource: ResourceRef,
    binding: Vec<u8>,
    intent: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::with_target(UNIT)
    }
    fn with_target(target_unit: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-ts-repair-fixture-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        create_private_directory(&root).unwrap();
        let project = root.join("project.git");
        let fleet = root.join("fleet");
        create_private_directory(&project).unwrap();
        create_private_directory(&fleet).unwrap();
        let executable = root.join("sealed-bridge");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("repair-storage".into()),
            authority_node: NodeRef("repair-node".into()),
            root: root.join("authority"),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        let resource = ResourceRef("repair-deployment".into());
        let resource_dir = authority.root.join("resources").join(&resource.0);
        for dir in [
            &authority.root,
            &authority.root.join("resources"),
            &resource_dir,
        ] {
            create_private_directory(dir).unwrap();
        }
        private(
            &authority.root.join("storage.json"),
            &StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            },
        );
        private(
            &resource_dir.join("resource.json"),
            &ResourceMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                resource_ref: resource.clone(),
                scope: ResourceScope::Global,
                descriptor: Some(ResourceDescriptor::new(
                    resource.clone(),
                    ResourceScope::Global,
                    ResourceKind::Deployment,
                    "repair-fixture".into(),
                    authority.storage_id.0.clone(),
                    None,
                    1,
                )),
            },
        );
        let process = root.join("process.json");
        private(
            &process,
            &json!({"version":1,"node_ref":"repair-node","worker":executable,
            "execution_root":root.join("executions"),"resources":authority,"administrators":["repair-owner"]}),
        );
        let config = root.join("config.json");
        let runtime_settings = root.join("harness-runtime-settings.json");
        let ledger = root.join("ledger.json");
        private(
            &runtime_settings,
            &json!({"version":1,"releaseOccupancyEnabled":true}),
        );
        private(
            &config,
            &json!({"version":1,"process_config":process,"ledger":ledger,"seal_id":"repair-seal",
            "principal_ref":"repair-owner","runtime_settings_path":runtime_settings,
            "mappings":[{"project":project,"resource_ref":resource,"revision":1,
                "previous_fence":121,"deployment_target":{"fleetDir":fleet,"unit":target_unit}}]}),
        );
        private(
            &ledger,
            &json!({"version":2,"canonical":{"version":1,"config":config,"bridge":executable,
            "seal_id":"repair-seal"},"projects":{}}),
        );
        let owner_process = identity(std::process::id());
        let owner = json!({"hostId":"fixture-host","harness":"fixture","nativeSessionId":"fixture-session",
            "process":{"pid":owner_process.pid,"bootId":owner_process.boot_id,"startTicks":owner_process.start_ticks}});
        let token = "a".repeat(64);
        let mut bridge = Bridge::open_registered(&config, &executable).unwrap();
        let acquired = bridge
            .handle(
                serde_json::from_value(json!({"action":"acquire","project":project,
            "owner":owner,"token":token,"ttlSeconds":300}))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(acquired["lease"]["fence"], 122);
        let proof = json!({"project":project,"owner":owner,"token":token,"fence":122,
            "deploymentTarget":{"fleetDir":fleet,"unit":target_unit}});
        let guarded=bridge.handle(serde_json::from_value(json!({"action":"guard","project":project,
            "owner":owner,"token":token,"fence":122,"deploymentTarget":{"fleetDir":fleet,"unit":target_unit}})).unwrap()).unwrap();
        let guard_id = guarded["guardId"].as_str().unwrap();
        let original_intent = resource_dir
            .join("compat-guards")
            .join(format!("{guard_id}.intent.json"));
        let intent = resource_dir
            .join("compat-guards")
            .join(format!("{guard_id}.ts-repair.intent.json"));
        drop(bridge);
        let binding = fs::read(resource_dir.join("execution-binding.json")).unwrap();
        let mut old = Command::new("/usr/bin/sleep").arg("30").spawn().unwrap();
        let coordinator = identity(old.id());
        old.kill().unwrap();
        old.wait().unwrap();
        let live = identity(std::process::id());
        let node_file = root.join("runtime-node");
        private(&node_file, &json!({"fixture":"node"}));
        let entry = root.join("entry.js");
        private(&entry, &json!({"fixture":"entry"}));
        let current = json!({"process":{"pid":live.pid,"boot_id":live.boot_id,"start_ticks":live.start_ticks.to_string(),
            "entry":entry,"entry_sha256":pin(&entry).sha256,"node_binary":node_file,"node_sha256":pin(&node_file).sha256},
            "runtime":{"source_commit":"d".repeat(40)},"canonical":{"config":"fixture-canonical"},
            "service":{"unit":UNIT}});
        let job = root.join("job");
        create_private_directory(&job).unwrap();
        let selector = root.join("selector.json");
        let launcher = root.join("launcher.py");
        private(&selector, &json!({"fixture":"selector"}));
        private(&launcher, &json!({"fixture":"launcher"}));
        let state = job.join("state.json");
        private(
            &state,
            &json!({"job_id":"rollout-fixture","job_dir":job,"phase":"unknown","coordinator":coordinator,
            "scheduler_identity":current,"release_identity":{"project":project,"owner":owner,"fence":122},
            "deployment_target":{"fleetDir":fleet,"unit":target_unit},"release_state":ledger,
            "selector":selector,"launcher":launcher,"selector_after_sha256":pin(&selector).sha256,
            "launcher_after_sha256":pin(&launcher).sha256}),
        );
        let snapshot = job.join("original-state.json");
        fs::copy(&state, &snapshot).unwrap();
        let original_plan = job.join("original-plan.json");
        private(
            &original_plan,
            &json!({"state":pin(&state),"job_id":"rollout-fixture","original_state_snapshot":pin(&snapshot)}),
        );
        let occupancy = root.join(".selector.json.process-leases-rollout.json");
        private(
            &occupancy,
            &json!({"phase":"active","job_id":"rollout-fixture","job_dir":job,"selector":selector}),
        );
        let plan = job.join("repair-plan.json");
        private(
            &plan,
            &json!({"version":1,"kind":"herder-canonical-ts-repair-plan-v1","operation":"restart_ts",
            "job_id":"rollout-fixture","request_key":"repair-fixture-one","original_plan":pin(&original_plan),
            "old_scheduler_identity":current,"native_runtime":{},
            "selector_sha256":pin(&selector).sha256,"launcher_sha256":pin(&launcher).sha256,
            "systemctl":pin(Path::new(SYSTEMCTL))}),
        );
        let evidence = job.join("repair-evidence.json");
        private(
            &evidence,
            &RepairEvidence {
                version: 1,
                kind: "herder-project-release-ts-repair-v1".into(),
                request_key: "repair-fixture-one".into(),
                job_id: "rollout-fixture".into(),
                job_dir: job,
                state: pin(&state),
                occupancy: pin(&occupancy),
                guard_intent: pin(&original_intent),
                binding_sha256: hex(&Sha256::digest(&binding)),
                sealed_bridge: pin(&executable),
                config_sha256: pin(&config).sha256,
                ledger_sha256: pin(&ledger).sha256,
                process_config_sha256: pin(&process).sha256,
                coordinator,
                validated_at_unix_ms: now_ms().unwrap(),
                repair_plan: pin(&plan),
            },
        );
        let request =
            json!({"version":1,"action":"repair_ts","proof":proof,"evidence":pin(&evidence)});
        Self {
            root,
            config,
            evidence,
            plan,
            request,
            authority,
            resource,
            binding,
            intent,
        }
    }
    fn request(&self) -> ReconcileRequest {
        serde_json::from_value(self.request.clone()).unwrap()
    }
    fn refresh(&mut self) {
        self.request["evidence"] = json!(pin(&self.evidence));
    }
    fn assert_binding(&self) {
        assert_eq!(
            fs::read(
                self.authority
                    .root
                    .join("resources")
                    .join(&self.resource.0)
                    .join("execution-binding.json")
            )
            .unwrap(),
            self.binding
        );
    }
    fn expire(&self) {
        let path = self
            .authority
            .root
            .join("resources")
            .join(&self.resource.0)
            .join("owner.json");
        let mut owner: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        owner["claim"]["expires_at"] = json!("unix-seconds:1");
        private(&path, &owner);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn held_repair_journals_before_effect_and_preserves_original_binding() {
    let f = Fixture::new();
    let calls = Cell::new(0);
    let original_state = fs::read(f.evidence.parent().unwrap().join("state.json")).unwrap();
    let reply = repair_with(
        &f.config,
        f.request(),
        |_| Ok(()),
        || {
            assert!(f.intent.exists(), "attempt must be durable before effect");
            assert!(
                matches!(TargetExecutionLock::try_acquire(&f.authority,&f.resource,AUTH),
            Err(ref e)if e.kind()==io::ErrorKind::WouldBlock),
                "target lock must span effect"
            );
            calls.set(calls.get() + 1);
            Ok(success())
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(reply["status"], "recorded");
    assert_eq!(reply["bindingResolved"], false);
    assert_eq!(
        fs::read(f.evidence.parent().unwrap().join("state.json")).unwrap(),
        original_state
    );
    f.assert_binding();
    let replay = repair_with(
        &f.config,
        f.request(),
        |_| panic!("replay must not observe or dispatch"),
        || panic!("never redispatch"),
    )
    .unwrap();
    assert_eq!(replay["status"], "recorded");
    assert_eq!(replay["restartAttempted"], false);
    f.assert_binding();
}
#[test]
fn attempt_without_ack_is_unknown_and_cannot_be_replayed_or_rekeyed() {
    let mut f = Fixture::new();
    assert_eq!(
        repair_with(
            &f.config,
            f.request(),
            |_| Ok(()),
            || Err(fail("fixture_lost_ack"))
        )
        .unwrap_err()
        .0,
        "fixture_lost_ack"
    );
    let replay = repair_with(
        &f.config,
        f.request(),
        |_| panic!("no replay"),
        || panic!("no replay"),
    )
    .unwrap();
    assert_eq!(replay["status"], "unknown");
    assert_eq!(replay["restartAttempted"], false);
    let mut e: Value = serde_json::from_slice(&fs::read(&f.evidence).unwrap()).unwrap();
    e["request_key"] = json!("another-key");
    private(&f.evidence, &e);
    f.refresh();
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("no new key"))
            .unwrap_err()
            .0,
        "repair_idempotency_conflict"
    );
    f.assert_binding();
}
#[test]
fn live_coordinator_busy_lock_and_expired_owner_cannot_authorize_repair() {
    let f = Fixture::new();
    let lock = TargetExecutionLock::try_acquire(&f.authority, &f.resource, AUTH).unwrap();
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("busy"))
            .unwrap_err()
            .0,
        "resource_busy"
    );
    drop(lock);
    f.expire();
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("expired"))
            .unwrap_err()
            .0,
        "lease_expired"
    );
    assert!(!f.intent.exists());
    f.assert_binding();
    let mut f = Fixture::new();
    let mut e: Value = serde_json::from_slice(&fs::read(&f.evidence).unwrap()).unwrap();
    e["coordinator"] = json!(identity(std::process::id()));
    private(&f.evidence, &e);
    f.refresh();
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("live"))
            .unwrap_err()
            .0,
        "coordinator_still_live"
    );
    assert!(!f.intent.exists());
    f.assert_binding();
}
#[test]
fn live_lease_is_rechecked_after_durable_intent_before_effect() {
    let f = Fixture::new();
    let observations = Cell::new(0);
    let error = repair_with(
        &f.config,
        f.request(),
        |_| {
            observations.set(observations.get() + 1);
            if f.intent.exists() {
                f.expire();
            }
            Ok(())
        },
        || panic!("expired lease must not reach executor"),
    )
    .unwrap_err();
    assert_eq!(error.0, "lease_expired");
    assert!(f.intent.exists());
    f.assert_binding();
    let replay = repair_with(
        &f.config,
        f.request(),
        |_| panic!("no retry"),
        || panic!("no retry"),
    )
    .unwrap();
    assert_eq!(replay["status"], "unknown");
}
#[test]
fn foreign_owner_and_stale_pins_fail_before_any_attempt() {
    for mode in ["token", "fence", "owner", "state", "plan"] {
        let mut f = Fixture::new();
        match mode {
            "token" => f.request["proof"]["token"] = json!("f".repeat(64)),
            "fence" => f.request["proof"]["fence"] = json!(123),
            "owner" => f.request["proof"]["owner"]["nativeSessionId"] = json!("foreign"),
            "state" => private(
                &f.evidence.parent().unwrap().join("state.json"),
                &json!({"changed":true}),
            ),
            _ => private(&f.plan, &json!({"changed":true})),
        }
        assert!(
            repair_with(
                &f.config,
                f.request(),
                |_| Ok(()),
                || panic!("invalid proof")
            )
            .is_err(),
            "{mode}"
        );
        assert!(!f.intent.exists());
        f.assert_binding();
    }
}
#[test]
fn partial_attempt_and_foreign_target_are_never_replaced() {
    let f = Fixture::new();
    private(&f.intent, &json!({"partial":true}));
    let before = fs::read(&f.intent).unwrap();
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("partial"))
            .unwrap_err()
            .0,
        "repair_attempt_unreadable"
    );
    assert_eq!(fs::read(&f.intent).unwrap(), before);
    f.assert_binding();
    let mut f = Fixture::new();
    f.request["proof"]["deploymentTarget"]["unit"] = json!("foreign.service");
    assert!(
        repair_with(
            &f.config,
            f.request(),
            |_| Ok(()),
            || panic!("foreign target")
        )
        .is_err()
    );
    assert!(!f.intent.exists());
    f.assert_binding();
}
#[test]
fn unavailable_runtime_and_short_lease_window_do_not_create_attempts() {
    let f = Fixture::new();
    assert_eq!(
        repair_with(
            &f.config,
            f.request(),
            |_| Err(fail("fixture_runtime_changed")),
            || panic!("stale runtime")
        )
        .unwrap_err()
        .0,
        "fixture_runtime_changed"
    );
    assert!(!f.intent.exists());
    f.assert_binding();
    let owner_path = f
        .authority
        .root
        .join("resources")
        .join(&f.resource.0)
        .join("owner.json");
    let mut owner: Value = serde_json::from_slice(&fs::read(&owner_path).unwrap()).unwrap();
    owner["claim"]["expires_at"] = json!(format!(
        "unix-seconds:{}",
        claim::now_seconds().unwrap() + 30
    ));
    private(&owner_path, &owner);
    assert_eq!(
        repair_with(&f.config, f.request(), |_| Ok(()), || panic!("short lease"))
            .unwrap_err()
            .0,
        "repair_lease_window_insufficient"
    );
    assert!(!f.intent.exists());
    f.assert_binding();
}
#[test]
fn unsuccessful_restart_receipt_never_resolves_or_redispatches() {
    let f = Fixture::new();
    let reply = repair_with(
        &f.config,
        f.request(),
        |_| Ok(()),
        || {
            let mut outcome = success();
            outcome.exit_code = Some(1);
            Ok(outcome)
        },
    )
    .unwrap();
    let receipt: RepairReceipt =
        read_private(Path::new(reply["receiptPath"].as_str().unwrap()), true).unwrap();
    assert_eq!(receipt.systemctl.exit_code, Some(1));
    assert_eq!(reply["bindingResolved"], false);
    f.assert_binding();
    let replay = repair_with(
        &f.config,
        f.request(),
        |_| panic!("no retry"),
        || panic!("no retry"),
    )
    .unwrap();
    assert_eq!(replay["restartAttempted"], false);
}

#[test]
fn fully_owned_foreign_service_guard_cannot_restart_the_fixed_ts_service() {
    let f = Fixture::with_target("foreign.service");
    let calls = Cell::new(0);
    let result = repair_with(
        &f.config,
        f.request(),
        |_| Ok(()),
        || {
            calls.set(calls.get() + 1);
            Ok(success())
        },
    );
    assert_eq!(result.unwrap_err().0, "repair_target_mismatch");
    assert_eq!(calls.get(), 0);
    assert!(!f.intent.exists());
    f.assert_binding();
}
