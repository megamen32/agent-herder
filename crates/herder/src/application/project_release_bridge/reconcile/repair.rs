//! One explicit restart of the installed TS service under an abandoned guard.
//! A durable attempt, including one without an ACK, is never dispatched again.
use super::*;
use std::{
    os::unix::{fs::FileTypeExt, process::ExitStatusExt},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const SYSTEMCTL: &str = "/usr/bin/systemctl";
const UNIT: &str = "agent-herder.service";
const COMMAND_SECONDS: u64 = 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairEvidence {
    version: u8,
    kind: String,
    request_key: String,
    job_id: String,
    job_dir: PathBuf,
    state: FilePin,
    occupancy: FilePin,
    guard_intent: FilePin,
    binding_sha256: String,
    sealed_bridge: FilePin,
    config_sha256: String,
    ledger_sha256: String,
    process_config_sha256: String,
    coordinator: ProcessIdentity,
    validated_at_unix_ms: u64,
    repair_plan: FilePin,
}
impl RepairEvidence {
    fn context(&self) -> Evidence {
        Evidence {
            version: self.version,
            kind: self.kind.clone(),
            outcome: "repair".into(),
            job_id: self.job_id.clone(),
            job_dir: self.job_dir.clone(),
            state: self.state.clone(),
            occupancy: self.occupancy.clone(),
            guard_intent: self.guard_intent.clone(),
            binding_sha256: self.binding_sha256.clone(),
            sealed_bridge: self.sealed_bridge.clone(),
            config_sha256: self.config_sha256.clone(),
            ledger_sha256: self.ledger_sha256.clone(),
            process_config_sha256: self.process_config_sha256.clone(),
            coordinator: self.coordinator.clone(),
            validated_at_unix_ms: self.validated_at_unix_ms,
            paired_proof: self.repair_plan.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairIntent {
    version: u8,
    kind: String,
    repair_id: String,
    request_key: String,
    job_id: String,
    guard: GuardEvidence,
    evidence: FilePin,
    repair_plan: FilePin,
    operator: FilePin,
    old_process: ProcessIdentity,
    started_at_unix_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemctlResult {
    pub spawned: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub stdout_sha256: String,
    pub stderr_sha256: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairReceipt {
    version: u8,
    kind: String,
    repair_id: String,
    request_key: String,
    job_id: String,
    evidence: FilePin,
    intent: FilePin,
    operator: FilePin,
    systemctl: SystemctlResult,
    started_at_unix_ms: u64,
    finished_at_unix_ms: u64,
    old_process: ProcessIdentity,
}

fn pin_bytes(path: &Path) -> Result<FilePin> {
    let bytes = fs::read(path).map_err(unavailable)?;
    let pin = FilePin {
        path: path.into(),
        sha256: hex(&Sha256::digest(&bytes)),
    };
    let _: Value = json_pin(&pin)?;
    Ok(pin)
}
fn public_artifact(pin: &FilePin, root_only: bool) -> Result<()> {
    if !valid_hash(&pin.sha256) {
        return Err(invalid());
    }
    canonical_path(&pin.path).map_err(unavailable)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&pin.path)
        .map_err(unavailable)?;
    let before = file.metadata().map_err(unavailable)?;
    let uid = unsafe { libc::geteuid() };
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o022 != 0
        || if root_only {
            before.uid() != 0
        } else {
            before.uid() != 0 && before.uid() != uid
        }
    {
        return Err(fail("repair_artifact_untrusted"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(unavailable)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let after = file.metadata().map_err(unavailable)?;
    let named = fs::symlink_metadata(&pin.path).map_err(unavailable)?;
    let stable = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mode(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if stable(&before) != stable(&after)
        || stable(&after) != stable(&named)
        || hex(&hasher.finalize()) != pin.sha256
    {
        return Err(fail("repair_artifact_changed"));
    }
    Ok(())
}
fn plan_pin(plan: &Value, key: &str) -> Result<FilePin> {
    serde_json::from_value(
        plan.get(key)
            .cloned()
            .ok_or_else(|| fail("repair_plan_invalid"))?,
    )
    .map_err(|_| fail("repair_plan_invalid"))
}
fn current_process(plan: &Value) -> Result<ProcessIdentity> {
    process_from_value(
        plan.pointer("/old_scheduler_identity/process")
            .ok_or_else(|| fail("repair_plan_invalid"))?,
    )
}
fn verify_repair_plan(
    e: &RepairEvidence,
    request: &ReconcileRequest,
    bridge: &Bridge,
) -> Result<Value> {
    let now = now_ms()?;
    if e.version != 1
        || e.kind != "herder-project-release-ts-repair-v1"
        || e.request_key.is_empty()
        || e.request_key.len() > 256
        || e.request_key.chars().any(char::is_control)
        || e.validated_at_unix_ms > now + 5000
        || now.saturating_sub(e.validated_at_unix_ms) > 60000
    {
        return Err(fail("repair_evidence_invalid_or_stale"));
    }
    if e.state.path != e.job_dir.join("state.json") {
        return Err(fail("job_state_mismatch"));
    }
    let state: Value = json_pin(&e.state)?;
    for (key, value) in [
        ("/job_id", json!(e.job_id)),
        ("/job_dir", json!(e.job_dir)),
        ("/phase", json!("unknown")),
        ("/coordinator", json!(e.coordinator)),
        ("/release_identity/project", json!(request.proof.project)),
        ("/release_identity/owner", json!(request.proof.owner)),
        ("/release_identity/fence", json!(request.proof.fence)),
        ("/deployment_target", json!(request.proof.deployment_target)),
        ("/release_state", json!(bridge.config.ledger)),
    ] {
        equal(&state, key, value)?;
    }
    if state.get("canonical_reconciliation").is_some() {
        return Err(fail("repair_already_settled"));
    }
    let selector = PathBuf::from(text_at(&state, "/selector")?);
    let launcher = PathBuf::from(text_at(&state, "/launcher")?);
    let occupancy_path = selector.parent().ok_or_else(invalid)?.join(format!(
        ".{}.process-leases-rollout.json",
        selector
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(invalid)?
    ));
    if e.occupancy.path != occupancy_path {
        return Err(fail("occupancy_mismatch"));
    }
    let occupancy: Value = json_pin(&e.occupancy)?;
    for (key, value) in [
        ("/job_id", json!(e.job_id)),
        ("/job_dir", json!(e.job_dir)),
        ("/phase", json!("active")),
        ("/selector", json!(selector)),
    ] {
        equal(&occupancy, key, value)?;
    }
    let plan: Value = json_pin(&e.repair_plan)?;
    for (key, value) in [
        ("/version", json!(1)),
        ("/kind", json!("herder-canonical-ts-repair-plan-v1")),
        ("/operation", json!("restart_ts")),
        ("/job_id", json!(e.job_id)),
        ("/request_key", json!(e.request_key)),
    ] {
        equal(&plan, key, value)?;
    }
    let original: Value = json_pin(&plan_pin(&plan, "original_plan")?)?;
    equal(&original, "/state", json!(e.state))?;
    equal(&original, "/job_id", json!(e.job_id))?;
    equal(
        &original,
        "/original_state_snapshot/sha256",
        json!(e.state.sha256),
    )?;
    let old = state.get("scheduler_identity").ok_or_else(invalid)?;
    let actual = plan.get("old_scheduler_identity").ok_or_else(invalid)?;
    for key in ["runtime", "canonical"] {
        if old.get(key).is_none() || old.get(key) != actual.get(key) {
            return Err(fail("scheduler_artifact_changed"));
        }
    }
    for key in ["entry", "entry_sha256", "node_binary", "node_sha256"] {
        if old["process"].get(key).is_none()
            || old["process"].get(key) != actual["process"].get(key)
        {
            return Err(fail("scheduler_artifact_changed"));
        }
    }
    equal(&plan, "/old_scheduler_identity/service/unit", json!(UNIT))?;
    let selector_sha = text_at(&state, "/selector_after_sha256")?;
    let launcher_sha = text_at(&state, "/launcher_after_sha256")?;
    equal(&plan, "/selector_sha256", json!(selector_sha))?;
    equal(&plan, "/launcher_sha256", json!(launcher_sha))?;
    artifact_pin(&FilePin {
        path: selector,
        sha256: selector_sha.into(),
    })?;
    artifact_pin(&FilePin {
        path: launcher,
        sha256: launcher_sha.into(),
    })?;
    let systemctl = plan_pin(&plan, "systemctl")?;
    if systemctl.path != Path::new(SYSTEMCTL) {
        return Err(fail("repair_command_invalid"));
    }
    public_artifact(&systemctl, true)?;
    Ok(plan)
}
fn verify_live(
    bridge: &Bridge,
    mapping: &ProjectMapping,
    request: &ReconcileRequest,
    context: &Evidence,
    guard: &GuardEvidence,
    lock: &TargetExecutionLock,
) -> Result<()> {
    verify_original(bridge, mapping, request, context, guard)?;
    require_dead(&context.coordinator)?;
    let live = lock
        .verify_owned_claim(
            &bridge.authority,
            AUTH,
            &guard.claim_id,
            &guard.principal_ref,
            guard.revision,
        )
        .map_err(claim_error)?;
    let expires = live.expires_at.as_deref().ok_or_else(proof_error)?;
    let expires = claim::parse_expiry_seconds(expires).map_err(unavailable)?;
    // The lease must cover the complete bounded restart observation.
    if expires
        <= claim::now_seconds()
            .map_err(unavailable)?
            .saturating_add(COMMAND_SECONDS + 5)
    {
        return Err(fail("repair_lease_window_insufficient"));
    }
    let binding = claim::read_execution_binding(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(unavailable)?
        .ok_or_else(proof_error)?;
    if binding.resolved_receipt.is_some() {
        return Err(fail("repair_already_settled"));
    }
    expected_file(
        &bridge.resource_dir(mapping)?.join("execution-binding.json"),
        &context.binding_sha256,
    )
}
fn observe_runtime(plan: &Value) -> Result<()> {
    let process = current_process(plan)?;
    if !process_live(&process)? {
        return Err(fail("repair_process_changed"));
    }
    let owner = &plan["old_scheduler_identity"];
    let entry = FilePin {
        path: PathBuf::from(text_at(owner, "/process/entry")?),
        sha256: text_at(owner, "/process/entry_sha256")?.into(),
    };
    let node = FilePin {
        path: PathBuf::from(text_at(owner, "/process/node_binary")?),
        sha256: text_at(owner, "/process/node_sha256")?.into(),
    };
    artifact_pin(&entry)?;
    artifact_pin(&node)?;
    let manifest = FilePin {
        path: PathBuf::from(text_at(owner, "/runtime/manifest")?),
        sha256: text_at(owner, "/runtime/manifest_sha256")?.into(),
    };
    let manifest_value: Value = json_pin(&manifest)?;
    equal(
        &manifest_value,
        "/source_commit",
        json!(text_at(owner, "/runtime/source_commit")?),
    )?;
    let config = FilePin {
        path: PathBuf::from(text_at(owner, "/canonical/config")?),
        sha256: text_at(owner, "/canonical/config_sha256")?.into(),
    };
    let _: Value = json_pin(&config)?;
    let proc = PathBuf::from(format!("/proc/{}", process.pid));
    if fs::metadata(&proc).map_err(unavailable)?.uid() != unsafe { libc::geteuid() } {
        return Err(fail("repair_process_changed"));
    }
    let actual_exe = fs::metadata(proc.join("exe")).map_err(unavailable)?;
    let node_meta = fs::metadata(&node.path).map_err(unavailable)?;
    if fs::read_link(proc.join("exe")).map_err(unavailable)? != node.path
        || (actual_exe.dev(), actual_exe.ino()) != (node_meta.dev(), node_meta.ino())
    {
        return Err(fail("repair_process_changed"));
    }
    let command = fs::read(proc.join("cmdline")).map_err(unavailable)?;
    let args: Vec<_> = command
        .split(|b| *b == 0)
        .filter(|x| !x.is_empty())
        .collect();
    if args
        != vec![
            node.path.as_os_str().as_encoded_bytes(),
            entry.path.as_os_str().as_encoded_bytes(),
        ]
    {
        return Err(fail("repair_process_changed"));
    }
    let raw = fs::read(proc.join("environ")).map_err(unavailable)?;
    let env: HashMap<_, _> = raw
        .split(|b| *b == 0)
        .filter_map(|p| {
            let i = p.iter().position(|b| *b == b'=')?;
            Some((&p[..i], &p[i + 1..]))
        })
        .collect();
    for (key, value) in [
        ("AGENT_HERDER_CANONICAL_MODE", "canonical"),
        (
            "AGENT_HERDER_CANONICAL_CONFIG",
            text_at(owner, "/canonical/config")?,
        ),
        (
            "AGENT_HERDER_CANONICAL_CONFIG_SHA256",
            text_at(owner, "/canonical/config_sha256")?,
        ),
        (
            "AGENT_HERDER_TS_RUNTIME_MANIFEST",
            text_at(owner, "/runtime/manifest")?,
        ),
        (
            "AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256",
            text_at(owner, "/runtime/manifest_sha256")?,
        ),
        ("AGENT_HERDER_WEB_PORT", "18787"),
    ] {
        if env.get(key.as_bytes()).copied() != Some(value.as_bytes()) {
            return Err(fail("repair_process_environment_changed"));
        }
    }
    if ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT"]
        .iter()
        .any(|k| env.get(k.as_bytes()).is_some_and(|v| !v.is_empty()))
    {
        return Err(fail("repair_process_environment_changed"));
    }
    let files = owner
        .pointer("/service/files")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(invalid)?;
    for value in files {
        let file = FilePin {
            path: PathBuf::from(text_at(value, "/path")?),
            sha256: text_at(value, "/sha256")?.into(),
        };
        public_artifact(&file, false)?;
    }
    for key in ["compat", "core"] {
        let native = process_from_value(
            plan.pointer(&format!("/native_runtime/{key}"))
                .ok_or_else(invalid)?,
        )?;
        if !process_live(&native)? {
            return Err(fail("repair_native_runtime_changed"));
        }
    }
    if !process_live(&process)? {
        return Err(fail("repair_process_changed"));
    }
    bus_environment()?;
    Ok(())
}
fn bus_environment() -> Result<Vec<(String, String)>> {
    let uid = unsafe { libc::geteuid() };
    if uid != unsafe { libc::getuid() } {
        return Err(fail("repair_credentials_invalid"));
    }
    let runtime = PathBuf::from(format!("/run/user/{uid}"));
    canonical_directory(&runtime).map_err(|_| fail("repair_user_bus_unavailable"))?;
    let bus = runtime.join("bus");
    let meta = fs::symlink_metadata(&bus).map_err(|_| fail("repair_user_bus_unavailable"))?;
    if !meta.file_type().is_socket() || meta.uid() != uid {
        return Err(fail("repair_user_bus_unavailable"));
    }
    Ok(vec![
        (
            "XDG_RUNTIME_DIR".into(),
            runtime.to_string_lossy().into_owned(),
        ),
        (
            "DBUS_SESSION_BUS_ADDRESS".into(),
            format!("unix:path={}", bus.display()),
        ),
        ("LANG".into(), "C".into()),
        ("LC_ALL".into(), "C".into()),
    ])
}
fn output_digest(mut input: impl Read) -> io::Result<(String, u64)> {
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buffer = [0u8; 8192];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        hash.update(&buffer[..n]);
    }
    Ok((hex(&hash.finalize()), count))
}
fn restart_service() -> Result<SystemctlResult> {
    let environment = bus_environment()?;
    let mut child = match Command::new(SYSTEMCTL)
        .args(["--user", "restart", UNIT])
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            return Ok(SystemctlResult {
                spawned: false,
                exit_code: None,
                signal: None,
                timed_out: false,
                stdout_sha256: hex(&Sha256::digest([])),
                stderr_sha256: hex(&Sha256::digest([])),
                stdout_bytes: 0,
                stderr_bytes: 0,
                error_code: Some("systemctl_spawn_failed".into()),
            });
        }
    };
    let out = child.stdout.take().ok_or_else(invalid)?;
    let err = child.stderr.take().ok_or_else(invalid)?;
    let stdout = thread::spawn(move || output_digest(out));
    let stderr = thread::spawn(move || output_digest(err));
    let deadline = Instant::now() + Duration::from_secs(COMMAND_SECONDS);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                timed_out = true;
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|_| fail("repair_child_state_unknown"))?;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail("repair_child_state_unknown"));
            }
        }
    };
    let (stdout_sha256, stdout_bytes) = stdout
        .join()
        .map_err(|_| fail("repair_output_unavailable"))?
        .map_err(unavailable)?;
    let (stderr_sha256, stderr_bytes) = stderr
        .join()
        .map_err(|_| fail("repair_output_unavailable"))?
        .map_err(unavailable)?;
    Ok(SystemctlResult {
        spawned: true,
        exit_code: status.code(),
        signal: status.signal(),
        timed_out,
        stdout_sha256,
        stderr_sha256,
        stdout_bytes,
        stderr_bytes,
        error_code: timed_out.then(|| "systemctl_deadline_outcome_unknown".into()),
    })
}
fn acknowledgement(
    intent: &RepairIntent,
    intent_pin: &FilePin,
    receipt: Option<&FilePin>,
    attempted: bool,
) -> Value {
    let mut value = json!({"repairId":intent.repair_id,"requestKey":intent.request_key,"jobId":intent.job_id,
        "evidenceSha256":intent.evidence.sha256,"intentPath":intent_pin.path,"intentSha256":intent_pin.sha256,
        "status":if receipt.is_some(){"recorded"}else{"unknown"},"restartAttempted":attempted,
        "bindingResolved":false,"requiresReconciliation":true});
    if let Some(pin) = receipt {
        value["receiptPath"] = json!(pin.path);
        value["receiptSha256"] = json!(pin.sha256);
    }
    value
}
fn repair_with(
    config_path: &Path,
    request: ReconcileRequest,
    observe: impl Fn(&Value) -> Result<()>,
    execute: impl FnOnce() -> Result<SystemctlResult>,
) -> Result<Value> {
    if request.version != 1 || request.action != "repair_ts" {
        return Err(invalid());
    }
    if request.proof.deployment_target.unit != UNIT {
        return Err(fail("repair_target_mismatch"));
    }
    let e: RepairEvidence = json_pin(&request.evidence)?;
    let context = e.context();
    let bridge = Bridge::open_registered(config_path, &e.sealed_bridge.path)?;
    verify_sealed_files(config_path, &bridge, &context)?;
    let proof_request = BridgeRequest {
        action: BridgeAction::Check,
        project: Some(request.proof.project.clone()),
        owner: Some(request.proof.owner.clone()),
        token: Some(request.proof.token.clone()),
        fence: Some(request.proof.fence),
        deployment_target: Some(request.proof.deployment_target.clone()),
        ttl_seconds: None,
        cleanup: false,
    };
    let mapping = bridge.mapping(&proof_request)?.clone();
    bridge.validate_target_request(&mapping, Some(&request.proof.deployment_target))?;
    let guard: GuardEvidence = json_pin(&e.guard_intent)?;
    let lock = TargetExecutionLock::try_acquire(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(claim_error)?;
    verify_original(&bridge, &mapping, &request, &context, &guard)?;
    require_dead(&e.coordinator)?;
    let directory = bridge.resource_dir(&mapping)?.join("compat-guards");
    let intent_path = directory.join(format!("{}.ts-repair.intent.json", guard.guard_id));
    let receipt_path = directory.join(format!("{}.ts-repair.receipt.json", guard.guard_id));
    match read_private::<RepairIntent>(&intent_path, true) {
        Ok(intent) => {
            if intent.version != 1
                || intent.kind != "herder-project-release-ts-repair-intent-v1"
                || intent.guard != guard
                || intent.evidence != request.evidence
                || intent.repair_plan != e.repair_plan
                || intent.job_id != e.job_id
                || intent.request_key != e.request_key
            {
                return Err(fail("repair_idempotency_conflict"));
            }
            let intent_pin = pin_bytes(&intent_path)?;
            let receipt = match read_private::<RepairReceipt>(&receipt_path, true) {
                Ok(receipt) => {
                    if receipt.version != 1
                        || receipt.kind != "herder-project-release-ts-repair-receipt-v1"
                        || receipt.intent != intent_pin
                        || receipt.evidence != request.evidence
                        || receipt.job_id != e.job_id
                        || receipt.request_key != e.request_key
                        || receipt.repair_id != intent.repair_id
                        || receipt.old_process != intent.old_process
                        || receipt.operator != intent.operator
                    {
                        return Err(fail("repair_receipt_conflict"));
                    }
                    Some(pin_bytes(&receipt_path)?)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(_) => return Err(fail("repair_receipt_invalid")),
            };
            return Ok(acknowledgement(
                &intent,
                &intent_pin,
                receipt.as_ref(),
                false,
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err(fail("repair_attempt_unreadable")),
    }
    if receipt_path.exists() {
        return Err(fail("repair_receipt_conflict"));
    }
    verify_live(&bridge, &mapping, &request, &context, &guard, &lock)?;
    let plan = verify_repair_plan(&e, &request, &bridge)?;
    observe(&plan)?;
    let operator = operator_pin()?;
    // Last full pinned-plan and live-owner observations precede the durable attempt.
    verify_sealed_files(config_path, &bridge, &context)?;
    verify_repair_plan(&e, &request, &bridge)?;
    observe(&plan)?;
    verify_live(&bridge, &mapping, &request, &context, &guard, &lock)?;
    let intent = RepairIntent {
        version: 1,
        kind: "herder-project-release-ts-repair-intent-v1".into(),
        repair_id: format!("{}:ts-repair", guard.guard_id),
        request_key: e.request_key.clone(),
        job_id: e.job_id.clone(),
        guard: guard.clone(),
        evidence: request.evidence.clone(),
        repair_plan: e.repair_plan.clone(),
        operator: operator.clone(),
        old_process: current_process(&plan)?,
        started_at_unix_ms: now_ms()?,
    };
    atomic_json(&intent_path, &intent).map_err(unavailable)?;
    let intent_pin = pin_bytes(&intent_path)?;
    // Any failure from this point leaves a durable, non-replayable attempt.
    observe(&plan)?;
    public_artifact(&plan_pin(&plan, "systemctl")?, true)?;
    verify_live(&bridge, &mapping, &request, &context, &guard, &lock)?;
    let result = execute()?;
    let receipt = RepairReceipt {
        version: 1,
        kind: "herder-project-release-ts-repair-receipt-v1".into(),
        repair_id: intent.repair_id.clone(),
        request_key: e.request_key,
        job_id: e.job_id,
        evidence: request.evidence,
        intent: intent_pin.clone(),
        operator,
        systemctl: result,
        started_at_unix_ms: intent.started_at_unix_ms,
        finished_at_unix_ms: now_ms()?,
        old_process: intent.old_process.clone(),
    };
    atomic_json(&receipt_path, &receipt).map_err(unavailable)?;
    let receipt_pin = pin_bytes(&receipt_path)?;
    // The original binding, claim and UNKNOWN checkpoint are deliberately unchanged.
    Ok(acknowledgement(
        &intent,
        &intent_pin,
        Some(&receipt_pin),
        true,
    ))
}
pub fn repair(config_path: &Path, request: ReconcileRequest) -> Result<Value> {
    repair_with(config_path, request, observe_runtime, restart_service)
}
pub fn serve_once(
    config_path: &Path,
    mut input: impl Read,
    mut output: impl Write,
) -> io::Result<bool> {
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take((MAX_LINE + 1) as u64)
        .read_to_end(&mut bytes)?;
    let result = if bytes.len() > MAX_LINE {
        Err(invalid())
    } else {
        serde_json::from_slice::<ReconcileRequest>(&bytes)
            .map_err(|_| invalid())
            .and_then(|request| repair(config_path, request))
    };
    let ok = result.is_ok();
    write_envelope(&mut output, result)?;
    Ok(ok)
}

#[cfg(test)]
mod tests;
