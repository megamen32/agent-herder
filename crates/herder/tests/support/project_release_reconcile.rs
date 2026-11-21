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
                .filter(|p| {
                    let name = p.file_name();
                    let name = name.to_string_lossy();
                    name.ends_with(".reconciliation.json") || name.ends_with(".failed-reconciliation.json")
                })
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
fn reconciliation_uses_the_proof_target_when_another_resource_is_default() {
    let mut recovery = Recovery::new();
    let mut config = super::targets::two_targets(&recovery.f);
    config["mappings"][0]["default_for_project"] = json!(false);
    config["mappings"][2]["default_for_project"] = json!(true);
    let other_target = config["mappings"][2]["deployment_target"].clone();
    config["mappings"].as_array_mut().unwrap().reverse();
    write_private(&recovery.f.config, &config);
    recovery.evidence["config_sha256"] = json!(digest(&recovery.f.config));
    recovery.save_evidence();
    recovery.f.force_expired();

    let original = recovery.request["proof"]["deploymentTarget"].clone();
    recovery.request["proof"]["deploymentTarget"] = other_target;
    assert_eq!(recovery.call()["ok"], false);
    recovery.assert_unresolved();
    recovery.request["proof"]["deploymentTarget"] = original;
    assert_eq!(recovery.call()["result"]["reconciled"], true);
    let default_status = recovery.f.call(recovery.f.request("status", 0));
    assert_eq!(default_status["result"]["resourceRef"], "deployment-fleet");
    assert_eq!(default_status["result"]["nextFence"], 42);
    assert_eq!(default_status["result"]["deploymentInProgress"], false);
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


struct FailedRecovery {
    inner: Recovery,
    failure: Value,
    effects: Value,
    failure_path: PathBuf,
    observation_path: PathBuf,
    effects_path: PathBuf,
}
impl FailedRecovery {
    fn new() -> Self {
        let mut inner = Recovery::new();
        let root = inner.state_path.parent().unwrap().to_path_buf();
        let stamp = inner.evidence["validated_at_unix_ms"].as_u64().unwrap();
        let successor = inner.paired["successor_scheduler_identity"].clone();
        let request = json!({"endpoint":"http://127.0.0.1:18787/api/canonical-runtime-status",
            "challenge":"f".repeat(64),"probe":{"harness":"zcode","native_session_id":"fixture-session"}});
        let plan_path = root.join("reconciliation-plan.json");
        write_private(&plan_path, &json!({"version":1,
            "kind":"herder-canonical-rollout-reconciliation-plan-v1",
            "job_id":"rollout-fixture","challenge":request["challenge"],
            "successor_scheduler_identity":successor}));
        let failed_plan = root.join("failed-plan.json");
        write_private(&failed_plan, &json!({"version":1,"outcome":"failed"}));
        let request_path = root.join("http-request.json");
        write_private(&request_path, &json!({"version":1,"kind":"herder-reconciliation-http-request",
            "plan":pin(&plan_path),"request":request,"before":successor,
            "created_at_unix_ms":stamp,"provider_operation_id":null}));
        let body_path = root.join("http-body.json");
        write_private(&body_path, &json!({"error":"canonical_runtime_unavailable"}));
        let provider = root.join("http-provider.json");
        write_private(&provider, &json!({"status":"completed","fixture":"raw-provider"}));
        let observation_path = root.join("http-observation.json");
        let observation = json!({"version":1,"kind":"herder-canonical-http-observation",
            "request":request,"request_receipt":pin(&request_path),
            "reconciliation_plan":pin(&plan_path),"before":successor,"after":successor,
            "body":pin(&body_path),"http_body_sha256":digest(&body_path),
            "http_status":503,"http_body_complete":true,
            "response":{"error":"canonical_runtime_unavailable"},
            "started_at_unix_ms":stamp,"observed_at_unix_ms":stamp});
        write_private(&observation_path, &observation);
        let mut failure = observation.clone();
        failure["kind"] = json!("herder-canonical-runtime-failure-v1");
        failure["outcome"] = json!("failed");
        failure["operational_readiness"] = json!(false);
        failure["job_id"] = json!("rollout-fixture");
        failure["authenticated_request"] = json!(true);
        failure["provider_operation_id"] = json!("http-fixture-operation");
        failure["provider_result"] = pin(&provider);
        failure["observation"] = pin(&observation_path);
        let failure_path = root.join("http-failure.json");
        write_private(&failure_path, &failure);
        let install_plan = root.join("install-plan.json");
        let install_recipe = root.join("install-recipe.json");
        let install_receipt = root.join("install-receipt.json");
        let install_driver = root.join("install-driver.json");
        let driver_source = root.join("install-driver.py");
        let install_intent = root.join("install-intent.json");
        let start_intent = root.join("start-intent.json");
        for path in [&install_plan,&install_recipe,&driver_source,&install_intent,&start_intent] {
            write_private(path, &json!({"fixture":"pinned-install-provenance"}));
        }
        let old = &inner.state["scheduler_identity"];
        write_private(&install_receipt, &json!({"version":1,"kind":"canonical-ts-installed",
            "state":"started_pending_paired_readiness","source_commit":old["runtime"]["source_commit"],
            "pid":old["process"]["pid"],"start_ticks":old["process"]["start_ticks"],
            "entry":old["process"]["entry"],"node_binary":old["process"]["node_binary"],
            "plan_sha256":digest(&install_plan)}));
        write_private(&install_driver, &json!({"returncode":0,"stdout":json!({
            "status":"installed_listener_ready","source_commit":old["runtime"]["source_commit"],
            "pid":old["process"]["pid"],"start_ticks":old["process"]["start_ticks"]}).to_string()}));
        let restart_binding = root.join("restart-binding.json");
        let restart_provider = root.join("restart-provider.json");
        let coordinator_provider = root.join("coordinator-provider.json");
        for path in [&restart_binding,&restart_provider,&coordinator_provider] {
            write_private(path, &json!({"fixture":"terminal-original-provider"}));
        }
        let coordinator_driver = root.join("coordinator-driver.json");
        write_private(&coordinator_driver, &json!({"phase":"unknown","returncode":1,
            "state":inner.state_path,"state_sha256":digest(&inner.state_path)}));
        let effects = json!({"version":1,"kind":"herder-controlled-rollout-effects-terminal-v1",
            "job_id":"rollout-fixture","complete":true,
            "original_state_snapshot":inner.paired["original_state_snapshot"],
            "install":{"receipt":pin(&install_receipt),"plan":pin(&install_plan),
                "recipe":pin(&install_recipe),"driver":pin(&install_driver),
                "driver_source":pin(&driver_source),"intent":pin(&install_intent),
                "start_intent":pin(&start_intent)},
            "native_restart":{"binding":pin(&restart_binding),"provider_result":pin(&restart_provider)},
            "coordinator":{"provider_result":pin(&coordinator_provider),
                "driver":pin(&coordinator_driver),"provider_operation_id":"coordinator-fixture-operation"},
            "repair":null});
        let effects_path = root.join("effect-completion.json");
        write_private(&effects_path, &effects);
        inner.request["action"] = json!("reconcile_failed");
        inner.evidence["outcome"] = json!("failed");
        inner.paired["kind"] = json!("herder-paired-rollout-failed-reconciliation-v1");
        inner.paired["outcome"] = json!("failed");
        inner.paired["operational_readiness"] = json!(false);
        inner.paired.as_object_mut().unwrap().remove("scheduler_consumer");
        inner.paired["scheduler_failure"] = pin(&failure_path);
        inner.paired["effect_completion"] = pin(&effects_path);
        inner.paired["plan"] = pin(&plan_path);
        inner.paired["failed_plan"] = pin(&failed_plan);
        inner.save_paired();
        Self { inner, failure, effects, failure_path, observation_path, effects_path }
    }
    fn save_failure(&mut self) {
        let mut observation: Value = serde_json::from_slice(&fs::read(&self.observation_path).unwrap()).unwrap();
        for key in ["request","before","after","body","response","http_status","http_body_complete",
            "http_body_sha256","started_at_unix_ms","observed_at_unix_ms","request_receipt","reconciliation_plan"] {
            observation[key] = self.failure[key].clone();
        }
        write_private(&self.observation_path, &observation);
        self.failure["observation"] = pin(&self.observation_path);
        write_private(&self.failure_path, &self.failure);
        self.inner.paired["scheduler_failure"] = pin(&self.failure_path);
        self.inner.save_paired();
    }
    fn save_effects(&mut self) {
        write_private(&self.effects_path, &self.effects);
        self.inner.paired["effect_completion"] = pin(&self.effects_path);
        self.inner.save_paired();
    }
    fn repair_paths(&self) -> (PathBuf, PathBuf) {
        let intent: Value = serde_json::from_slice(&fs::read(&self.inner.intent_path).unwrap()).unwrap();
        let directory = self.inner.intent_path.parent().unwrap();
        let guard = intent["guard_id"].as_str().unwrap();
        (directory.join(format!("{guard}.ts-repair.intent.json")),
            directory.join(format!("{guard}.ts-repair.receipt.json")))
    }
    fn add_terminal_repair(&mut self) {
        let root = self.inner.state_path.parent().unwrap();
        let (intent_path, receipt_path) = self.repair_paths();
        let guard: Value = serde_json::from_slice(&fs::read(&self.inner.intent_path).unwrap()).unwrap();
        let repair_plan = root.join("repair-plan.json");
        write_private(&repair_plan, &json!({"fixture":"immutable-repair-plan"}));
        let evidence_path = root.join("repair-evidence.json");
        write_private(&evidence_path, &json!({"version":1,"kind":"herder-project-release-ts-repair-v1",
            "job_id":"rollout-fixture","guard_intent":self.inner.evidence["guard_intent"],
            "binding_sha256":self.inner.evidence["binding_sha256"],"state":pin(&self.inner.state_path),
            "repair_plan":pin(&repair_plan)}));
        let started = instant_ms();
        let intent = json!({"version":1,"kind":"herder-project-release-ts-repair-intent-v1",
            "repair_id":format!("{}:ts-repair",guard["guard_id"].as_str().unwrap()),
            "request_key":"one-repair-fixture","job_id":"rollout-fixture","guard":guard,
            "evidence":pin(&evidence_path),"repair_plan":pin(&repair_plan),
            "operator":pin(&self.inner.f.executable),"old_process":self.inner.evidence["coordinator"],
            "started_at_unix_ms":started});
        write_private(&intent_path, &intent);
        let receipt = json!({"version":1,"kind":"herder-project-release-ts-repair-receipt-v1",
            "repair_id":intent["repair_id"],"request_key":intent["request_key"],
            "job_id":"rollout-fixture","evidence":intent["evidence"],"intent":pin(&intent_path),
            "operator":intent["operator"],"old_process":intent["old_process"],
            "started_at_unix_ms":started,"finished_at_unix_ms":started,
            "systemctl":{"spawned":true,"exit_code":0,"signal":null,"timed_out":false,
                "stdout_sha256":"a".repeat(64),"stderr_sha256":"b".repeat(64),
                "stdout_bytes":0,"stderr_bytes":0,"error_code":null}});
        write_private(&receipt_path, &receipt);
        let observation_path = root.join("repair-observation.json");
        write_private(&observation_path, &json!({"version":1,
            "kind":"herder-canonical-ts-repair-observation-v1","job_id":"rollout-fixture",
            "original_outcome":"unknown","binding_resolved":false,"requires_reconciliation":true,
            "operational_readiness":false,"native_receipt":pin(&receipt_path),
            "original_state":self.inner.paired["original_state_snapshot"]}));
        self.effects["repair"] = json!({"intent":pin(&intent_path),
            "receipt":pin(&receipt_path),"observation":pin(&observation_path)});
        self.save_effects();
    }
    fn change_repair_receipt(&mut self, pointer: &str, value: Value) {
        let (_, receipt_path) = self.repair_paths();
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        *receipt.pointer_mut(pointer).unwrap() = value;
        write_private(&receipt_path, &receipt);
        self.effects["repair"]["receipt"] = pin(&receipt_path);
        let observation_path = PathBuf::from(self.effects["repair"]["observation"]["path"].as_str().unwrap());
        let mut observation: Value = serde_json::from_slice(&fs::read(&observation_path).unwrap()).unwrap();
        observation["native_receipt"] = pin(&receipt_path);
        write_private(&observation_path, &observation);
        self.effects["repair"]["observation"] = pin(&observation_path);
        self.save_effects();
    }
}
#[test]
fn canonical_failed_reconcile_preserves_unknown_and_is_separate_from_positive_success() {
    let mut f = FailedRecovery::new();
    let state = fs::read(&f.inner.state_path).unwrap();
    let intent = fs::read(&f.inner.intent_path).unwrap();
    let owner = fs::read(f.inner.f.resource_dir().join("owner.json")).unwrap();
    let ledger = fs::read(&f.inner.f.ledger).unwrap();
    let first = f.inner.call();
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["outcome"], "failed");
    assert_eq!(first["result"]["operationalReadiness"], false);
    assert!(first["result"]["receiptPath"].as_str().unwrap().ends_with(".failed-reconciliation.json"));
    assert!(first["result"]["receiptRef"].as_str().unwrap().contains(":failed-reconciled:"));
    assert_eq!(fs::read(&f.inner.state_path).unwrap(), state);
    assert_eq!(fs::read(&f.inner.intent_path).unwrap(), intent);
    assert_eq!(fs::read(f.inner.f.resource_dir().join("owner.json")).unwrap(), owner);
    assert_eq!(fs::read(&f.inner.f.ledger).unwrap(), ledger);
    assert_eq!(f.inner.call(), first);
    f.inner.request["action"] = json!("reconcile_finished");
    f.inner.evidence["outcome"] = json!("candidate");
    f.inner.save_evidence();
    assert_eq!(f.inner.call()["error"], "different_terminal_receipt");
}
#[test]
fn canonical_failed_reconcile_requires_live_claim_but_repairs_same_durable_ack_after_expiry() {
    let f = FailedRecovery::new();
    f.inner.f.force_expired();
    assert_eq!(f.inner.call()["error"], "lease_expired");
    f.inner.assert_unresolved();
    let mut f = FailedRecovery::new();
    let first = f.inner.call();
    assert_eq!(first["ok"], true, "{first}");
    fs::write(f.inner.f.resource_dir().join("execution-binding.json"), &f.inner.original_binding).unwrap();
    f.inner.f.force_expired();
    assert_eq!(f.inner.call(), first, "durable decision must repair its ACK without a new effect");
    f.inner.evidence["validated_at_unix_ms"] = json!(instant_ms()+1);
    f.inner.save_evidence();
    assert_eq!(f.inner.call()["error"], "reconciliation_conflict");
}
#[test]
fn canonical_failed_reconcile_cross_refuses_ordinary_positive_and_mismatched_action() {
    for suffix in ["receipt.json","reconciliation.json"] {
        let f = FailedRecovery::new();
        let guard: Value = serde_json::from_slice(&fs::read(&f.inner.intent_path).unwrap()).unwrap();
        let path = f.inner.intent_path.parent().unwrap()
            .join(format!("{}.{suffix}",guard["guard_id"].as_str().unwrap()));
        write_private(&path, &json!({"preserved":"foreign-terminal"}));
        let before = fs::read(&path).unwrap();
        assert_eq!(f.inner.call()["error"], "different_terminal_receipt");
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read(f.inner.f.resource_dir().join("execution-binding.json")).unwrap(), f.inner.original_binding);
    }
    let mut f = FailedRecovery::new();
    f.inner.request["action"] = json!("reconcile_finished");
    assert_eq!(f.inner.call()["ok"], false);
    f.inner.assert_unresolved();
    let mut positive = Recovery::new();
    positive.request["action"] = json!("reconcile_failed");
    assert_eq!(positive.call()["ok"], false);
    positive.assert_unresolved();
}
#[test]
fn canonical_failed_reconcile_rejects_nondefinitive_http_and_identity_changes() {
    for (pointer,value) in [
        ("/http_status",json!(401)),("/http_status",json!(200)),
        ("/http_body_complete",json!(false)),("/authenticated_request",json!(false)),
        ("/operational_readiness",json!(true)),("/observed_at_unix_ms",json!(1)),
        ("/after/process/pid",json!(2_000_000_000u32)),
        ("/request/challenge",json!("foreign-challenge")),
        ("/response/error",json!("different_error")),
        ("/http_body_sha256",json!("0".repeat(64))),
    ] {
        let mut f = FailedRecovery::new();
        *f.failure.pointer_mut(pointer).unwrap()=value;
        f.save_failure();
        assert_eq!(f.inner.call()["ok"], false, "must reject {pointer}");
        f.inner.assert_unresolved();
    }
}
#[test]
fn canonical_failed_reconcile_requires_all_terminal_effect_evidence() {
    for field in ["complete","install-provider","source","coordinator","snapshot","missing-native"] {
        let mut f = FailedRecovery::new();
        match field {
            "complete" => f.effects["complete"]=json!(false),
            "install-provider" => {
                let path=PathBuf::from(f.effects["install"]["driver"]["path"].as_str().unwrap());
                let mut driver:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                driver["returncode"]=json!(1);
                write_private(&path,&driver); f.effects["install"]["driver"]=pin(&path);
            },
            "source" => {
                let path=PathBuf::from(f.effects["install"]["receipt"]["path"].as_str().unwrap());
                let mut receipt:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                receipt["source_commit"]=json!("f".repeat(40));
                write_private(&path,&receipt); f.effects["install"]["receipt"]=pin(&path);
            },
            "coordinator" => {
                let path=PathBuf::from(f.effects["coordinator"]["driver"]["path"].as_str().unwrap());
                let mut driver:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                driver["phase"]=json!("awaiting_consumer");
                write_private(&path,&driver); f.effects["coordinator"]["driver"]=pin(&path);
            },
            "snapshot" => f.effects["original_state_snapshot"]["sha256"]=json!("0".repeat(64)),
            _ => { f.effects["native_restart"].as_object_mut().unwrap().remove("provider_result"); },
        }
        f.save_effects();
        assert_eq!(f.inner.call()["ok"],false,"must reject {field}");
        f.inner.assert_unresolved();
    }
}
#[test]
fn canonical_failed_reconcile_requires_exact_terminal_repair_and_preserves_attempt() {
    let mut f=FailedRecovery::new();
    f.add_terminal_repair();
    let (intent_path,receipt_path)=f.repair_paths();
    let intent=fs::read(&intent_path).unwrap();
    let receipt=fs::read(&receipt_path).unwrap();
    let first=f.inner.call();
    assert_eq!(first["ok"],true,"{first}");
    assert_eq!(f.inner.call(),first);
    assert_eq!(fs::read(&intent_path).unwrap(),intent);
    assert_eq!(fs::read(&receipt_path).unwrap(),receipt);
}
#[test]
fn canonical_failed_reconcile_refuses_unknown_timed_out_or_nonzero_repairs() {
    for (pointer,value) in [
        ("/systemctl/spawned",json!(false)),("/systemctl/exit_code",Value::Null),
        ("/systemctl/exit_code",json!(1)),("/systemctl/signal",json!(9)),
        ("/systemctl/timed_out",json!(true)),("/systemctl/error_code",json!("wait_failed")),
        ("/request_key",json!("another-request")),
    ] {
        let mut f=FailedRecovery::new();
        f.add_terminal_repair();
        f.change_repair_receipt(pointer,value);
        assert_eq!(f.inner.call()["ok"],false,"must reject {pointer}");
        f.inner.assert_unresolved();
    }
    for missing in ["receipt","intent","declaration"] {
        let mut f=FailedRecovery::new();
        f.add_terminal_repair();
        let (intent,receipt)=f.repair_paths();
        match missing {
            "receipt"=>fs::remove_file(receipt).unwrap(),
            "intent"=>fs::remove_file(intent).unwrap(),
            _=>{ f.effects["repair"]=Value::Null; f.save_effects(); },
        }
        assert_eq!(f.inner.call()["ok"],false,"must reject missing {missing}");
        f.inner.assert_unresolved();
    }
}
#[test]
fn canonical_failed_reconcile_preserves_exact_owner_and_execution_lock_boundaries() {
    for field in ["owner","token","fence","target","live-coordinator","lock","binding"] {
        let mut f=FailedRecovery::new();
        let mut held=None;
        match field {
            "owner"=>f.inner.request["proof"]["owner"]["nativeSessionId"]=json!("foreign"),
            "token"=>f.inner.request["proof"]["token"]=json!("d".repeat(64)),
            "fence"=>f.inner.request["proof"]["fence"]=json!(43),
            "target"=>f.inner.request["proof"]["deploymentTarget"]["unit"]=json!("foreign.service"),
            "live-coordinator"=>{ f.inner.evidence["coordinator"]=birth(std::process::id());f.inner.save_evidence(); },
            "lock"=>held=Some(TargetExecutionLock::try_acquire(&f.inner.f.authority,&f.inner.f.resource,Authorization::Authorized).unwrap()),
            _=>{ f.inner.evidence["binding_sha256"]=json!("0".repeat(64));f.inner.save_evidence(); },
        }
        assert_eq!(f.inner.call()["ok"],false,"must reject {field}");
        f.inner.assert_unresolved();
        drop(held);
    }
}
