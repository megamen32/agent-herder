use super::*;
use herder::ownership::release_runner::TargetExecutionLock;
use sha2::{Digest, Sha256};

fn reconcile_binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_herder_project_release_reconcile"))
}
fn digest(path: &Path) -> String {
    Sha256::digest(fs::read(path).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn pin(path: &Path) -> Value {
    json!({"path":path,"sha256":digest(path)})
}
fn instant_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn birth(pid: u32) -> Value {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    json!({"pid":pid,"boot_id":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),
        "start_ticks":fields[19].parse::<u64>().unwrap()})
}
fn invoke(config: &Path, request: &Value) -> Value {
    let mut child = Command::new(reconcile_binary())
        .arg("--config")
        .arg(config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    serde_json::to_writer(&mut input, request).unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.stderr.is_empty(),
        "operator must not echo owner proof"
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.success(), response["ok"] == true);
    response
}
struct Recovery {
    f: Fixture,
    request: Value,
    evidence: Value,
    state: Value,
    paired: Value,
    state_path: PathBuf,
    paired_path: PathBuf,
    evidence_path: PathBuf,
    intent_path: PathBuf,
    original_binding: Vec<u8>,
}
impl Recovery {
    fn new() -> Self {
        let f = Fixture::new();
        let token = "c".repeat(64);
        assert_eq!(f.call(f.acquire_request(0, &token))["ok"], true);
        let mut guard = f.guard(&token, 42);
        let coordinator = birth(guard.child.id());
        let binding_path = f.resource_dir().join("execution-binding.json");
        let original_binding = fs::read(&binding_path).unwrap();
        let binding: Value = serde_json::from_slice(&original_binding).unwrap();
        let guard_id = binding["execution_ref"]
            .as_str()
            .unwrap()
            .strip_prefix("release-")
            .unwrap();
        let intent_path = f
            .resource_dir()
            .join("compat-guards")
            .join(format!("{guard_id}.intent.json"));
        guard.crash();
        let root = f.root.join("rollout");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let selector = f.root.join("selector.json");
        let launcher = f.root.join("launcher.py");
        write_private(&selector, &json!({"candidate":"unchanged"}));
        write_private(&launcher, &json!({"fixture":"launcher"}));
        let old_identity = json!({"process":{
            "pid":coordinator["pid"],"boot_id":coordinator["boot_id"],
            "start_ticks":coordinator["start_ticks"].as_u64().unwrap().to_string(),
            "entry":"/fixture/entry.js","entry_sha256":"a".repeat(64),
            "node_binary":"/fixture/node","node_sha256":"b".repeat(64)},
            "runtime":{"source_commit":"d".repeat(40),"manifest":"/fixture/runtime"},
            "canonical":{"config":"/fixture/config","config_sha256":"e".repeat(64)}});
        let mut new_identity = old_identity.clone();
        let live = birth(std::process::id());
        for key in ["pid", "boot_id"] {
            new_identity["process"][key] = live[key].clone();
        }
        new_identity["process"]["start_ticks"] =
            json!(live["start_ticks"].as_u64().unwrap().to_string());
        let state = json!({"job_id":"rollout-fixture","job_dir":root,"phase":"unknown",
            "created_at_unix_ms":instant_ms(),"coordinator":coordinator,"scheduler_identity":old_identity,
            "release_identity":{"project":f.projects[0],"owner":Fixture::owner(),"fence":42},
            "deployment_target":{"fleetDir":f.fleet,"unit":"fixture.service"},"release_state":f.ledger,
            "selector":selector,"launcher":launcher,"selector_after_sha256":digest(&selector),
            "launcher_after_sha256":digest(&launcher)});
        let state_path = root.join("state.json");
        write_private(&state_path, &state);
        let snapshot = root.join("original-state.json");
        fs::copy(&state_path, &snapshot).unwrap();
        let occupancy_path = f.root.join(".selector.json.process-leases-rollout.json");
        write_private(
            &occupancy_path,
            &json!({"schema":1,"phase":"active","job_id":"rollout-fixture","job_dir":root,"selector":selector}),
        );
        let native = root.join("native-consumer.json");
        let scheduler = root.join("scheduler-consumer.json");
        write_private(&native, &json!({"fixture":"actual-native-consumer"}));
        write_private(&scheduler, &json!({"fixture":"actual-scheduler-consumer"}));
        let stamp = instant_ms();
        let paired = json!({"version":1,"kind":"herder-paired-rollout-reconciliation-v1",
            "outcome":"candidate","complete":true,"job_id":"rollout-fixture",
            "original_state_sha256":digest(&state_path),"original_state_snapshot":pin(&snapshot),
            "old_scheduler_identity":old_identity,"successor_scheduler_identity":new_identity,
            "selector_sha256":digest(&selector),"launcher_sha256":digest(&launcher),
            "validated_at_unix_ms":stamp,"native_consumer":pin(&native),"scheduler_consumer":pin(&scheduler)});
        let paired_path = root.join("paired.json");
        write_private(&paired_path, &paired);
        let evidence = json!({"version":1,"kind":"herder-project-release-reconciliation-v1",
            "outcome":"candidate","job_id":"rollout-fixture","job_dir":root,
            "state":pin(&state_path),"occupancy":pin(&occupancy_path),"guard_intent":pin(&intent_path),
            "binding_sha256":digest(&binding_path),"sealed_bridge":pin(&f.executable),
            "config_sha256":digest(&f.config),"ledger_sha256":digest(&f.ledger),
            "process_config_sha256":digest(&f.process_config),"coordinator":coordinator,
            "validated_at_unix_ms":stamp,"paired_proof":pin(&paired_path)});
        let evidence_path = root.join("evidence.json");
        write_private(&evidence_path, &evidence);
        let request = json!({"version":1,"action":"reconcile_finished",
            "proof":{"project":f.projects[0],"owner":Fixture::owner(),"token":token,"fence":42,
                "deploymentTarget":{"fleetDir":f.fleet,"unit":"fixture.service"}},
            "evidence":pin(&evidence_path)});
        Self {
            f,
            request,
            evidence,
            state,
            paired,
            state_path,
            paired_path,
            evidence_path,
            intent_path,
            original_binding,
        }
    }
    fn save_evidence(&mut self) {
        write_private(&self.evidence_path, &self.evidence);
        self.request["evidence"] = pin(&self.evidence_path);
    }
    fn save_paired(&mut self) {
        write_private(&self.paired_path, &self.paired);
        self.evidence["paired_proof"] = pin(&self.paired_path);
        self.save_evidence();
    }
    fn save_state(&mut self) {
        write_private(&self.state_path, &self.state);
        let snapshot = self
            .state_path
            .parent()
            .unwrap()
            .join("original-state.json");
        fs::copy(&self.state_path, &snapshot).unwrap();
        self.evidence["state"] = pin(&self.state_path);
        self.paired["original_state_sha256"] = json!(digest(&self.state_path));
        self.paired["original_state_snapshot"] = pin(&snapshot);
        self.save_paired();
    }
    fn call(&self) -> Value {
        invoke(&self.f.config, &self.request)
    }
    fn assert_unresolved(&self) {
        assert_eq!(
            fs::read(self.f.resource_dir().join("execution-binding.json")).unwrap(),
            self.original_binding
        );
        assert_eq!(
            fs::read_dir(self.f.resource_dir().join("compat-guards"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|p| p
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".reconciliation.json"))
                .count(),
            0
        );
    }
}
#[test]
fn canonical_reconcile_settles_exact_expired_generation_and_replays_only_same_receipt() {
    let f = Recovery::new();
    f.f.force_expired();
    let intent = fs::read(&f.intent_path).unwrap();
    let state = fs::read(&f.state_path).unwrap();
    let ledger = fs::read(&f.f.ledger).unwrap();
    let owner = fs::read(f.f.resource_dir().join("owner.json")).unwrap();
    assert_eq!(
        f.f.call(f.f.proof_request("guard", 0, &"c".repeat(64), 42))["error"],
        "lease_expired"
    );
    let result = f.call();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["reconciled"], true);
    assert_eq!(
        f.call(),
        result,
        "lost ACK must not produce another terminal receipt"
    );
    assert_eq!(fs::read(&f.intent_path).unwrap(), intent);
    assert_eq!(fs::read(&f.state_path).unwrap(), state);
    assert_eq!(fs::read(&f.f.ledger).unwrap(), ledger);
    assert_eq!(
        fs::read(f.f.resource_dir().join("owner.json")).unwrap(),
        owner
    );
    let binding: Value = serde_json::from_slice(
        &fs::read(f.f.resource_dir().join("execution-binding.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(binding["resolved_receipt"], result["result"]["receiptRef"]);
    assert!(
        !f.intent_path
            .with_file_name(format!(
                "{}.receipt.json",
                result["result"]["guardId"].as_str().unwrap()
            ))
            .exists()
    );
}
#[test]
fn canonical_reconcile_refuses_live_coordinator_and_busy_execution_lock() {
    let mut f = Recovery::new();
    let live = birth(std::process::id());
    f.evidence["coordinator"] = live.clone();
    f.state["coordinator"] = live;
    f.save_state();
    assert_eq!(f.call()["error"], "coordinator_still_live");
    f.assert_unresolved();
    let f = Recovery::new();
    let _lock =
        TargetExecutionLock::try_acquire(&f.f.authority, &f.f.resource, Authorization::Authorized)
            .unwrap();
    assert_eq!(f.call()["error"], "resource_busy");
    f.assert_unresolved();
}
#[test]
fn canonical_reconcile_rejects_wrong_owner_token_fence_and_target() {
    for field in ["token", "owner", "fence", "deploymentTarget"] {
        let mut f = Recovery::new();
        match field {
            "token" => f.request["proof"]["token"] = json!("d".repeat(64)),
            "owner" => f.request["proof"]["owner"]["nativeSessionId"] = json!("foreign"),
            "fence" => f.request["proof"]["fence"] = json!(43),
            _ => f.request["proof"]["deploymentTarget"]["unit"] = json!("foreign.service"),
        }
        assert_eq!(f.call()["ok"], false, "must reject {field}");
        f.assert_unresolved();
    }
}
#[test]
fn canonical_reconcile_rejects_stale_baseline_and_incomplete_pair() {
    for field in [
        "stale",
        "baseline",
        "incomplete",
        "different-job",
        "different-runtime",
    ] {
        let mut f = Recovery::new();
        match field {
            "stale" => {
                f.evidence["validated_at_unix_ms"] = json!(1);
                f.save_evidence();
            }
            "baseline" => {
                f.evidence["outcome"] = json!("baseline");
                f.save_evidence();
            }
            "incomplete" => {
                f.paired["complete"] = json!(false);
                f.save_paired();
            }
            "different-job" => {
                f.paired["job_id"] = json!("foreign-job");
                f.save_paired();
            }
            _ => {
                f.paired["successor_scheduler_identity"]["runtime"]["source_commit"] =
                    json!("f".repeat(40));
                f.save_paired();
            }
        }
        assert_eq!(f.call()["ok"], false, "must reject {field}");
        f.assert_unresolved();
    }
}
#[test]
fn canonical_reconcile_rejects_changed_state_binding_and_sealed_config() {
    for field in [
        "state",
        "binding",
        "config",
        "occupancy",
        "intent",
        "process-config",
    ] {
        let mut f = Recovery::new();
        match field {
            "state" => {
                let mut changed = f.state.clone();
                changed["phase"] = json!("installing");
                write_private(&f.state_path, &changed);
            }
            "binding" => {
                f.evidence["binding_sha256"] = json!("0".repeat(64));
                f.save_evidence();
            }
            "config" => {
                f.evidence["config_sha256"] = json!("0".repeat(64));
                f.save_evidence();
            }
            "occupancy" => {
                f.evidence["occupancy"]["sha256"] = json!("0".repeat(64));
                f.save_evidence();
            }
            "intent" => {
                let copy = f.f.root.join("foreign-intent.json");
                fs::copy(&f.intent_path, &copy).unwrap();
                f.evidence["guard_intent"] = pin(&copy);
                f.save_evidence();
            }
            _ => {
                f.evidence["process_config_sha256"] = json!("0".repeat(64));
                f.save_evidence();
            }
        }
        assert_eq!(f.call()["ok"], false, "must reject {field}");
        f.assert_unresolved();
    }
}
#[test]
fn canonical_reconcile_durable_receipt_repairs_only_its_original_binding() {
    let mut f = Recovery::new();
    let first = f.call();
    assert_eq!(first["ok"], true, "{first}");
    // Fixture-only crash window: terminal receipt exists, binding write was lost.
    fs::write(
        f.f.resource_dir().join("execution-binding.json"),
        &f.original_binding,
    )
    .unwrap();
    assert_eq!(f.call(), first);
    f.evidence["validated_at_unix_ms"] = json!(instant_ms() + 1);
    f.save_evidence();
    assert_eq!(f.call()["error"], "reconciliation_conflict");
    let binding: Value = serde_json::from_slice(
        &fs::read(f.f.resource_dir().join("execution-binding.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(binding["resolved_receipt"], first["result"]["receiptRef"]);
}
#[test]
fn canonical_reconcile_rejects_missing_successor_and_preserves_foreign_terminal_receipt() {
    let mut f = Recovery::new();
    f.paired["successor_scheduler_identity"]["process"]["pid"] = json!(2_000_000_000u32);
    f.save_paired();
    assert_eq!(f.call()["error"], "successor_not_live");
    f.assert_unresolved();
    let f = Recovery::new();
    let mut binding: Value = serde_json::from_slice(&f.original_binding).unwrap();
    binding["resolved_receipt"] = json!("foreign:terminal");
    write_private(&f.f.resource_dir().join("execution-binding.json"), &binding);
    assert_eq!(f.call()["error"], "different_terminal_receipt");
    let after: Value = serde_json::from_slice(
        &fs::read(f.f.resource_dir().join("execution-binding.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(after, binding);
}

#[test]
fn canonical_reconcile_preserves_an_exact_unknown_migration_hold() {
    let f = Recovery::new();
    let lease =
        json!({"fence":41,"owner":{"nativeSessionId":"foreign-owner"},"tokenHash":"0".repeat(64)});
    let archive = f.f.root.join("foreign-legacy-archive.json");
    let project = f.f.projects[0].to_string_lossy().to_string();
    let mut projects = serde_json::Map::new();
    projects.insert(project.clone(), json!({"lease":lease}));
    write_private(&archive, &json!({"version":1,"projects":projects}));
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o400)).unwrap();
    let hold = f.f.resource_dir().join("migration-hold.json");
    write_private(
        &hold,
        &json!({"version":1,"kind":"herder-legacy-resource-quarantine",
        "epoch":"foreign-unknown","schema":f.f.authority.schema,"storage_id":f.f.authority.storage_id,
        "resource_ref":f.f.resource,"resource_revision":1,"source_project":project,"source_fence":41,
        "source_owner":lease["owner"],"source_token_hash":"0".repeat(64),
        "source_lease_sha256":Sha256::digest(serde_json::to_vec(&lease).unwrap()).iter().map(|b|format!("{b:02x}")).collect::<String>(),
        "archive":pin(&archive),"outcome":"unknown"}),
    );
    fs::set_permissions(&hold, fs::Permissions::from_mode(0o400)).unwrap();
    let before = fs::read(&hold).unwrap();
    assert_eq!(f.call()["error"], "migration_hold");
    assert_eq!(fs::read(&hold).unwrap(), before);
    f.assert_unresolved();
}
