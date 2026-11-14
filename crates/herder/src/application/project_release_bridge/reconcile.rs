//! Explicit success or failed-acceptance settlement of an interrupted release guard.
//! This operator never creates a guard, changes a claim, or runs an effect.
pub mod repair;
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilePin {
    pub path: PathBuf,
    pub sha256: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerProof {
    pub project: PathBuf,
    pub owner: ReleaseOwner,
    pub token: String,
    pub fence: u64,
    pub deployment_target: DeploymentTarget,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconcileRequest {
    pub version: u8,
    pub action: String,
    pub proof: OwnerProof,
    pub evidence: FilePin,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub boot_id: String,
    pub start_ticks: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    version: u8,
    kind: String,
    outcome: String,
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
    paired_proof: FilePin,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconciliationReceipt {
    version: u8,
    kind: String,
    outcome: String,
    job_id: String,
    guard: GuardEvidence,
    evidence: FilePin,
    paired_proof: FilePin,
    original_binding_sha256: String,
    operator: FilePin,
    reconciled_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision { Candidate, Failed }
impl Decision {
    fn from_action(action: &str) -> Result<Self> {
        match action {
            "reconcile_finished" => Ok(Self::Candidate),
            "reconcile_failed" => Ok(Self::Failed),
            _ => Err(invalid()),
        }
    }
    fn outcome(self) -> &'static str {
        match self { Self::Candidate => "candidate", Self::Failed => "failed" }
    }
    fn paired_kind(self) -> &'static str {
        match self {
            Self::Candidate => "herder-paired-rollout-reconciliation-v1",
            Self::Failed => "herder-paired-rollout-failed-reconciliation-v1",
        }
    }
    fn receipt_kind(self) -> &'static str {
        match self {
            Self::Candidate => "herder-project-release-reconciliation-receipt-v1",
            Self::Failed => "herder-project-release-failed-reconciliation-receipt-v1",
        }
    }
    fn suffix(self) -> &'static str {
        match self { Self::Candidate => "reconciliation.json", Self::Failed => "failed-reconciliation.json" }
    }
    fn opposite(self) -> Self {
        match self { Self::Candidate => Self::Failed, Self::Failed => Self::Candidate }
    }
    fn reference(self) -> &'static str {
        match self { Self::Candidate => "reconciled", Self::Failed => "failed-reconciled" }
    }
    fn scheduler_field(self) -> &'static str {
        match self { Self::Candidate => "scheduler_consumer", Self::Failed => "scheduler_failure" }
    }
}
fn receipt_present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(unavailable(error)),
    }
}
fn verify_live_decision(bridge: &Bridge, guard: &GuardEvidence, lock: &TargetExecutionLock) -> Result<()> {
    lock.verify_owned_claim(&bridge.authority, AUTH, &guard.claim_id,
        &guard.principal_ref, guard.revision).map_err(claim_error)?;
    Ok(())
}

fn fail(code: &'static str) -> BridgeError {
    BridgeError(code)
}
fn now_ms() -> Result<u64> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| fail("clock_unavailable"))?
            .as_millis(),
    )
    .map_err(|_| fail("clock_unavailable"))
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn file_bytes(pin: &FilePin, private: bool, limit: u64) -> Result<Vec<u8>> {
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
    let named = fs::symlink_metadata(&pin.path).map_err(unavailable)?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & (if private { 0o077 } else { 0o022 }) != 0
        || before.nlink() != 1
        || before.len() > limit
        || (before.dev(), before.ino()) != (named.dev(), named.ino())
    {
        return Err(fail("evidence_file_invalid"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(unavailable)?;
    let after = file.metadata().map_err(unavailable)?;
    let named_after = fs::symlink_metadata(&pin.path).map_err(unavailable)?;
    let stable = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    if bytes.len() as u64 > limit
        || stable(&before) != stable(&after)
        || stable(&after) != stable(&named_after)
        || hex(&Sha256::digest(&bytes)) != pin.sha256
    {
        return Err(fail("evidence_changed"));
    }
    Ok(bytes)
}
fn json_pin<T: DeserializeOwned>(pin: &FilePin) -> Result<T> {
    serde_json::from_slice(&file_bytes(pin, true, MAX_FILE)?).map_err(|_| fail("evidence_invalid"))
}
fn expected_file(path: &Path, sha: &str) -> Result<()> {
    file_bytes(
        &FilePin {
            path: path.into(),
            sha256: sha.into(),
        },
        true,
        MAX_FILE,
    )
    .map(|_| ())
}
fn artifact_pin(pin: &FilePin) -> Result<()> {
    file_bytes(pin, false, 256 * 1024 * 1024).map(|_| ())
}
fn text_at<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| fail("evidence_invalid"))
}
fn equal(value: &Value, pointer: &str, expected: Value) -> Result<()> {
    if value.pointer(pointer) != Some(&expected) {
        return Err(fail("evidence_mismatch"));
    }
    Ok(())
}
fn process_from_value(value: &Value) -> Result<ProcessIdentity> {
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 1)
        .ok_or_else(|| fail("process_identity_invalid"))?;
    let boot_id = value
        .get("boot_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .ok_or_else(|| fail("process_identity_invalid"))?
        .to_string();
    let raw = value
        .get("start_ticks")
        .ok_or_else(|| fail("process_identity_invalid"))?;
    let start_ticks = raw
        .as_u64()
        .or_else(|| {
            raw.as_str()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|s| s.parse().ok())
        })
        .filter(|v| *v > 0)
        .ok_or_else(|| fail("process_identity_invalid"))?;
    Ok(ProcessIdentity {
        pid,
        boot_id,
        start_ticks,
    })
}
fn process_live(expected: &ProcessIdentity) -> Result<bool> {
    if expected.pid <= 1 || expected.start_ticks == 0 || expected.boot_id.is_empty() {
        return Err(fail("process_identity_invalid"));
    }
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(unavailable)?;
    if boot.trim() != expected.boot_id {
        return Ok(false);
    }
    let stat = match fs::read_to_string(format!("/proc/{}/stat", expected.pid)) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(fail("process_state_unknown")),
    };
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .ok_or_else(|| fail("process_state_unknown"))?
        .1
        .split_whitespace()
        .collect();
    if fields.len() < 20 {
        return Err(fail("process_state_unknown"));
    }
    let birth: u64 = fields[19]
        .parse()
        .map_err(|_| fail("process_state_unknown"))?;
    Ok(birth == expected.start_ticks && !matches!(fields[0], "Z" | "X" | "x"))
}
fn require_dead(identity: &ProcessIdentity) -> Result<()> {
    if process_live(identity)? {
        Err(fail("coordinator_still_live"))
    } else {
        Ok(())
    }
}
fn verify_sealed_files(config_path: &Path, bridge: &Bridge, evidence: &Evidence) -> Result<()> {
    expected_file(config_path, &evidence.config_sha256)?;
    expected_file(&bridge.config.ledger, &evidence.ledger_sha256)?;
    expected_file(
        &bridge.config.process_config,
        &evidence.process_config_sha256,
    )?;
    artifact_pin(&evidence.sealed_bridge)
}
fn verify_original(
    bridge: &Bridge,
    mapping: &ProjectMapping,
    request: &ReconcileRequest,
    evidence: &Evidence,
    guard: &GuardEvidence,
) -> Result<()> {
    bridge.validate_revision(mapping)?;
    crate::ownership::migration_hold::ensure_clear(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(|_| fail("migration_hold"))?;
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
    // An expired generation is historical evidence only. No lease is extended.
    let (current, purpose) = bridge.verify(mapping, &proof_request, false)?;
    if guard.version != 1
        || guard.finished_at_seconds.is_some()
        || guard.resource_ref != mapping.resource_ref
        || guard.claim_id != current.claim_id
        || guard.principal_ref != bridge.config.principal_ref
        || guard.revision != mapping.revision
        || guard.fence != purpose.fence
        || guard.execution_ref != format!("release-{}", guard.guard_id)
        || !guard.guard_id.starts_with("guard-")
        || guard.guard_id.len() != 38
        || !guard.guard_id[6..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(proof_error());
    }
    let expected_intent = bridge
        .resource_dir(mapping)?
        .join("compat-guards")
        .join(format!("{}.intent.json", guard.guard_id));
    if evidence.guard_intent.path != expected_intent {
        return Err(proof_error());
    }
    let actual: GuardEvidence = json_pin(&evidence.guard_intent)?;
    if &actual != guard {
        return Err(proof_error());
    }
    let binding = claim::read_execution_binding(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(unavailable)?
        .ok_or_else(proof_error)?;
    if binding.resource_ref != guard.resource_ref
        || binding.claim_id != guard.claim_id
        || binding.principal_ref != guard.principal_ref
        || binding.resource_revision != guard.revision
        || binding.execution_ref != guard.execution_ref
    {
        return Err(proof_error());
    }
    Ok(())
}
fn verify_decision(
    evidence: &Evidence,
    request: &ReconcileRequest,
    bridge: &Bridge,
    mapping: &ProjectMapping,
    guard: &GuardEvidence,
    decision: Decision,
) -> Result<()> {
    let config = &bridge.config;
    let current = now_ms()?;
    if evidence.version != 1
        || evidence.kind != "herder-project-release-reconciliation-v1"
        || evidence.outcome != decision.outcome()
        || evidence.job_id.is_empty()
        || evidence.job_id.len() > 256
        || evidence.validated_at_unix_ms > current + 5000
        || current.saturating_sub(evidence.validated_at_unix_ms) > 60000
    {
        return Err(fail("candidate_evidence_invalid_or_stale"));
    }
    canonical_directory(&evidence.job_dir).map_err(unavailable)?;
    if evidence.state.path != evidence.job_dir.join("state.json") {
        return Err(fail("job_state_mismatch"));
    }
    let state: Value = json_pin(&evidence.state)?;
    equal(&state, "/job_id", json!(evidence.job_id))?;
    equal(&state, "/job_dir", json!(evidence.job_dir))?;
    equal(&state, "/coordinator", json!(evidence.coordinator))?;
    equal(
        &state,
        "/release_identity/project",
        json!(request.proof.project),
    )?;
    equal(
        &state,
        "/release_identity/owner",
        json!(request.proof.owner),
    )?;
    equal(
        &state,
        "/release_identity/fence",
        json!(request.proof.fence),
    )?;
    equal(
        &state,
        "/deployment_target",
        json!(request.proof.deployment_target),
    )?;
    equal(&state, "/release_state", json!(config.ledger))?;
    if !matches!(
        state.get("phase").and_then(Value::as_str),
        Some("unknown" | "awaiting_restart" | "awaiting_consumer" | "verified")
    ) || state
        .get("created_at_unix_ms")
        .and_then(Value::as_u64)
        .is_none_or(|v| v < guard.started_at_seconds.saturating_mul(1000))
    {
        return Err(fail("job_state_mismatch"));
    }
    if decision == Decision::Failed {
        equal(&state, "/phase", json!("unknown"))?;
        if state.get("canonical_reconciliation").is_some() { return Err(fail("different_terminal_receipt")); }
    }
    require_dead(&evidence.coordinator)?;
    let selector = PathBuf::from(text_at(&state, "/selector")?);
    let launcher = PathBuf::from(text_at(&state, "/launcher")?);
    let occupancy_path = selector.parent().ok_or_else(invalid)?.join(format!(
        ".{}.process-leases-rollout.json",
        selector
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(invalid)?
    ));
    if evidence.occupancy.path != occupancy_path {
        return Err(fail("occupancy_mismatch"));
    }
    let occupancy: Value = json_pin(&evidence.occupancy)?;
    equal(&occupancy, "/phase", json!("active"))?;
    equal(&occupancy, "/job_id", json!(evidence.job_id))?;
    equal(&occupancy, "/job_dir", json!(evidence.job_dir))?;
    equal(&occupancy, "/selector", json!(selector))?;
    let paired: Value = json_pin(&evidence.paired_proof)?;
    equal(&paired, "/version", json!(1))?;
    equal(
        &paired,
        "/kind",
        json!(decision.paired_kind()),
    )?;
    equal(&paired, "/outcome", json!(decision.outcome()))?;
    equal(&paired, "/complete", json!(true))?;
    equal(&paired, "/job_id", json!(evidence.job_id))?;
    equal(
        &paired,
        "/original_state_sha256",
        json!(evidence.state.sha256),
    )?;
    equal(
        &paired,
        "/validated_at_unix_ms",
        json!(evidence.validated_at_unix_ms),
    )?;
    let old = state
        .get("scheduler_identity")
        .ok_or_else(|| fail("evidence_invalid"))?;
    equal(&paired, "/old_scheduler_identity", old.clone())?;
    let successor = paired
        .get("successor_scheduler_identity")
        .ok_or_else(|| fail("evidence_invalid"))?;
    for key in ["runtime", "canonical"] {
        if old.get(key).is_none() || successor.get(key) != old.get(key) {
            return Err(fail("scheduler_artifact_changed"));
        }
    }
    let old_process = old.get("process").ok_or_else(|| fail("evidence_invalid"))?;
    let new_process = successor
        .get("process")
        .ok_or_else(|| fail("evidence_invalid"))?;
    for key in ["entry", "entry_sha256", "node_binary", "node_sha256"] {
        if old_process.get(key).is_none() || new_process.get(key) != old_process.get(key) {
            return Err(fail("scheduler_artifact_changed"));
        }
    }
    require_dead(&process_from_value(old_process)?)?;
    if !process_live(&process_from_value(new_process)?)? {
        return Err(fail("successor_not_live"));
    }
    let selector_sha = text_at(&state, "/selector_after_sha256")?;
    let launcher_sha = text_at(&state, "/launcher_after_sha256")?;
    equal(&paired, "/selector_sha256", json!(selector_sha))?;
    equal(&paired, "/launcher_sha256", json!(launcher_sha))?;
    artifact_pin(&FilePin {
        path: selector,
        sha256: selector_sha.into(),
    })?;
    artifact_pin(&FilePin {
        path: launcher,
        sha256: launcher_sha.into(),
    })?;
    // The operator validator preserves and validates the full native/HTTP proofs.
    // Native settlement additionally requires both pinned actual receipts here.
    for key in [
        "native_consumer",
        decision.scheduler_field(),
        "original_state_snapshot",
    ] {
        let pin: FilePin = serde_json::from_value(
            paired
                .get(key)
                .cloned()
                .ok_or_else(|| fail("evidence_invalid"))?,
        )
        .map_err(|_| fail("evidence_invalid"))?;
        let _: Value = json_pin(&pin)?;
        if key == "original_state_snapshot" && pin.sha256 != evidence.state.sha256 {
            return Err(fail("job_state_mismatch"));
        }
    }
    if decision == Decision::Failed {
        verify_failed_details(bridge, mapping, evidence, &state, &paired, guard)?;
    }
    Ok(())
}

fn value_pin(value: &Value, pointer: &str) -> Result<FilePin> {
    serde_json::from_value(value.pointer(pointer).cloned().ok_or_else(|| fail("evidence_invalid"))?)
        .map_err(|_| fail("evidence_invalid"))
}
fn pinned_value(value: &Value, pointer: &str) -> Result<Value> {
    json_pin(&value_pin(value, pointer)?)
}
fn unsigned_at(value: &Value, pointer: &str) -> Result<u64> {
    value.pointer(pointer).and_then(Value::as_u64).ok_or_else(|| fail("evidence_invalid"))
}
fn bounded_id(value: &Value, pointer: &str) -> Result<()> {
    let text = text_at(value, pointer)?;
    if text.is_empty() || text.len() > 256 || text.chars().any(char::is_control) {
        return Err(fail("evidence_invalid"));
    }
    Ok(())
}
fn verify_failed_http(evidence: &Evidence, paired: &Value) -> Result<()> {
    equal(paired, "/operational_readiness", json!(false))?;
    let failure = pinned_value(paired, "/scheduler_failure")?;
    for (key, value) in [
        ("/version", json!(1)),
        ("/kind", json!("herder-canonical-runtime-failure-v1")),
        ("/outcome", json!("failed")),
        ("/operational_readiness", json!(false)),
        ("/job_id", json!(evidence.job_id)),
        ("/http_status", json!(503)),
        ("/http_body_complete", json!(true)),
        ("/authenticated_request", json!(true)),
        ("/response/error", json!("canonical_runtime_unavailable")),
        ("/request/endpoint", json!("http://127.0.0.1:18787/api/canonical-runtime-status")),
    ] { equal(&failure, key, value)?; }
    bounded_id(&failure, "/provider_operation_id")?;
    bounded_id(&failure, "/request/challenge")?;
    bounded_id(&failure, "/request/probe/harness")?;
    bounded_id(&failure, "/request/probe/native_session_id")?;
    if failure.pointer("/request/probe/node_ref").is_some() {
        bounded_id(&failure, "/request/probe/node_ref")?;
    }
    let successor = paired.get("successor_scheduler_identity").ok_or_else(invalid)?;
    equal(&failure, "/before", successor.clone())?;
    equal(&failure, "/after", successor.clone())?;
    let observed = unsigned_at(&failure, "/observed_at_unix_ms")?;
    let started = unsigned_at(&failure, "/started_at_unix_ms")?;
    let now = now_ms()?;
    if started > observed || observed > now + 5000 || now.saturating_sub(observed) > 60000 {
        return Err(fail("failure_evidence_invalid_or_stale"));
    }
    let body_pin = value_pin(&failure, "/body")?;
    equal(&failure, "/http_body_sha256", json!(body_pin.sha256))?;
    let body: Value = json_pin(&body_pin)?;
    equal(&failure, "/response", body)?;
    // Full provider provenance is validated by the pinned Python operator. Native
    // settlement also requires the immutable raw provider and observation bytes.
    let _: Value = pinned_value(&failure, "/provider_result")?;
    let observation = pinned_value(&failure, "/observation")?;
    equal(&observation, "/version", json!(1))?;
    equal(&observation, "/kind", json!("herder-canonical-http-observation"))?;
    for key in ["request", "before", "after", "body", "response", "http_status",
        "http_body_complete", "http_body_sha256", "started_at_unix_ms", "observed_at_unix_ms",
        "request_receipt", "reconciliation_plan"] {
        equal(&observation, &format!("/{key}"),
            failure.get(key).cloned().ok_or_else(invalid)?)?;
    }
    let request_receipt = pinned_value(&failure, "/request_receipt")?;
    equal(&request_receipt, "/version", json!(1))?;
    equal(&request_receipt, "/kind", json!("herder-reconciliation-http-request"))?;
    equal(&request_receipt, "/request", failure["request"].clone())?;
    equal(&request_receipt, "/before", successor.clone())?;
    equal(&request_receipt, "/plan", failure["reconciliation_plan"].clone())?;
    if unsigned_at(&request_receipt, "/created_at_unix_ms")? > started {
        return Err(fail("failure_request_mismatch"));
    }
    let plan_pin = value_pin(&failure, "/reconciliation_plan")?;
    if plan_pin != value_pin(paired, "/plan")? {
        return Err(fail("failure_request_mismatch"));
    }
    let plan: Value = json_pin(&plan_pin)?;
    equal(&plan, "/version", json!(1))?;
    equal(&plan, "/kind", json!("herder-canonical-rollout-reconciliation-plan-v1"))?;
    equal(&plan, "/job_id", json!(evidence.job_id))?;
    equal(&plan, "/challenge", failure["request"]["challenge"].clone())?;
    equal(&plan, "/successor_scheduler_identity", successor.clone())?;
    let _: Value = pinned_value(paired, "/failed_plan")?;
    Ok(())
}
fn verify_terminal_repair(
    bridge: &Bridge, mapping: &ProjectMapping, evidence: &Evidence, state: &Value,
    effects: &Value, guard: &GuardEvidence,
) -> Result<()> {
    let directory = bridge.resource_dir(mapping)?.join("compat-guards");
    let intent_path = directory.join(format!("{}.ts-repair.intent.json", guard.guard_id));
    let receipt_path = directory.join(format!("{}.ts-repair.receipt.json", guard.guard_id));
    let intent_exists = receipt_present(&intent_path)?;
    let receipt_exists = receipt_present(&receipt_path)?;
    if !intent_exists && !receipt_exists {
        return equal(effects, "/repair", Value::Null);
    }
    if !intent_exists || !receipt_exists {
        return Err(fail("repair_effect_not_terminal"));
    }
    let repair = effects.get("repair").ok_or_else(invalid)?;
    let intent_pin = value_pin(repair, "/intent")?;
    let receipt_pin = value_pin(repair, "/receipt")?;
    if intent_pin.path != intent_path || receipt_pin.path != receipt_path {
        return Err(fail("repair_effect_not_terminal"));
    }
    let intent: Value = json_pin(&intent_pin)?;
    let receipt: Value = json_pin(&receipt_pin)?;
    equal(&intent, "/version", json!(1))?;
    equal(&receipt, "/version", json!(1))?;
    equal(&intent, "/kind", json!("herder-project-release-ts-repair-intent-v1"))?;
    equal(&receipt, "/kind", json!("herder-project-release-ts-repair-receipt-v1"))?;
    equal(&intent, "/guard", json!(guard))?;
    equal(&intent, "/repair_id", json!(format!("{}:ts-repair", guard.guard_id)))?;
    equal(&intent, "/job_id", json!(evidence.job_id))?;
    bounded_id(&intent, "/request_key")?;
    equal(&receipt, "/intent", json!(intent_pin))?;
    for key in ["repair_id", "request_key", "job_id", "evidence", "operator",
        "old_process", "started_at_unix_ms"] {
        equal(&receipt, &format!("/{key}"), intent.get(key).cloned().ok_or_else(invalid)?)?;
    }
    let result: repair::SystemctlResult = serde_json::from_value(
        receipt.get("systemctl").cloned().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !result.spawned || result.exit_code != Some(0) || result.signal.is_some()
        || result.timed_out || result.error_code.is_some()
        || !valid_hash(&result.stdout_sha256) || !valid_hash(&result.stderr_sha256) {
        return Err(fail("repair_effect_not_terminal"));
    }
    let started = unsigned_at(&intent, "/started_at_unix_ms")?;
    let finished = unsigned_at(&receipt, "/finished_at_unix_ms")?;
    if started < guard.started_at_seconds.saturating_mul(1000)
        || finished < started || finished > now_ms()? + 5000 {
        return Err(fail("repair_effect_not_terminal"));
    }
    let old = process_from_value(intent.get("old_process").ok_or_else(invalid)?)?;
    require_dead(&old)?;
    artifact_pin(&value_pin(&intent, "/operator")?)?;
    let repair_evidence = pinned_value(&intent, "/evidence")?;
    equal(&repair_evidence, "/version", json!(1))?;
    equal(&repair_evidence, "/kind", json!("herder-project-release-ts-repair-v1"))?;
    equal(&repair_evidence, "/job_id", json!(evidence.job_id))?;
    equal(&repair_evidence, "/guard_intent", json!(evidence.guard_intent))?;
    equal(&repair_evidence, "/binding_sha256", json!(evidence.binding_sha256))?;
    equal(&repair_evidence, "/repair_plan", intent["repair_plan"].clone())?;
    let repair_state_pin = value_pin(&repair_evidence, "/state")?;
    if repair_state_pin.sha256 != evidence.state.sha256 {
        return Err(fail("job_state_mismatch"));
    }
    let repair_state: Value = json_pin(&repair_state_pin)?;
    if &repair_state != state { return Err(fail("job_state_mismatch")); }
    let _: Value = pinned_value(&intent, "/repair_plan")?;
    let observation = pinned_value(repair, "/observation")?;
    for (key, value) in [
        ("/version", json!(1)),
        ("/kind", json!("herder-canonical-ts-repair-observation-v1")),
        ("/job_id", json!(evidence.job_id)),
        ("/original_outcome", json!("unknown")),
        ("/binding_resolved", json!(false)),
        ("/requires_reconciliation", json!(true)),
        ("/operational_readiness", json!(false)),
        ("/native_receipt", json!(receipt_pin)),
    ] { equal(&observation, key, value)?; }
    let original = value_pin(&observation, "/original_state")?;
    if original.sha256 != evidence.state.sha256 {
        return Err(fail("job_state_mismatch"));
    }
    let _: Value = json_pin(&original)?;
    Ok(())
}
fn verify_failed_details(
    bridge: &Bridge, mapping: &ProjectMapping, evidence: &Evidence, state: &Value,
    paired: &Value, guard: &GuardEvidence,
) -> Result<()> {
    verify_failed_http(evidence, paired)?;
    let effects = pinned_value(paired, "/effect_completion")?;
    for (key, value) in [
        ("/version", json!(1)),
        ("/kind", json!("herder-controlled-rollout-effects-terminal-v1")),
        ("/job_id", json!(evidence.job_id)),
        ("/complete", json!(true)),
    ] { equal(&effects, key, value)?; }
    let original = value_pin(&effects, "/original_state_snapshot")?;
    if original.sha256 != evidence.state.sha256 {
        return Err(fail("job_state_mismatch"));
    }
    let original_state: Value = json_pin(&original)?;
    if &original_state != state { return Err(fail("job_state_mismatch")); }
    // All effects need durable terminal evidence. Loss of a remote task archive
    // does not erase a source-pinned local driver that reaped the installer.
    for pointer in ["/install/receipt", "/install/plan", "/install/recipe",
        "/install/driver", "/install/intent", "/install/start_intent",
        "/native_restart/binding", "/native_restart/provider_result",
        "/coordinator/provider_result", "/coordinator/driver"] {
        let _: Value = pinned_value(&effects, pointer)?;
    }
    file_bytes(&value_pin(&effects, "/install/driver_source")?, true, MAX_FILE)?;
    bounded_id(&effects, "/coordinator/provider_operation_id")?;
    let install = pinned_value(&effects, "/install/receipt")?;
    equal(&install, "/version", json!(1))?;
    equal(&install, "/kind", json!("canonical-ts-installed"))?;
    equal(&install, "/state", json!("started_pending_paired_readiness"))?;
    let old = state.get("scheduler_identity").ok_or_else(invalid)?;
    for (to, from) in [
        ("/source_commit", "/runtime/source_commit"), ("/pid", "/process/pid"),
        ("/start_ticks", "/process/start_ticks"), ("/entry", "/process/entry"),
        ("/node_binary", "/process/node_binary"),
    ] { equal(&install, to, old.pointer(from).cloned().ok_or_else(invalid)?)?; }
    equal(&install, "/plan_sha256", json!(value_pin(&effects, "/install/plan")?.sha256))?;
    let driver = pinned_value(&effects, "/install/driver")?;
    equal(&driver, "/returncode", json!(0))?;
    let stdout: Value = serde_json::from_str(text_at(&driver, "/stdout")?)
        .map_err(|_| fail("effect_completion_invalid"))?;
    equal(&stdout, "/status", json!("installed_listener_ready"))?;
    for key in ["source_commit", "pid", "start_ticks"] {
        equal(&stdout, &format!("/{key}"), install.get(key).cloned().ok_or_else(invalid)?)?;
    }
    let coordinator = pinned_value(&effects, "/coordinator/driver")?;
    equal(&coordinator, "/phase", json!("unknown"))?;
    equal(&coordinator, "/returncode", json!(1))?;
    equal(&coordinator, "/state", json!(evidence.state.path))?;
    equal(&coordinator, "/state_sha256", json!(evidence.state.sha256))?;
    verify_terminal_repair(bridge, mapping, evidence, state, &effects, guard)
}

fn operator_pin() -> Result<FilePin> {
    let path = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(unavailable)?;
    let mut file = File::open(&path).map_err(unavailable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let len = file.read(&mut buffer).map_err(unavailable)?;
        if len == 0 {
            break;
        }
        digest.update(&buffer[..len]);
    }
    Ok(FilePin {
        path,
        sha256: hex(&digest.finalize()),
    })
}
fn response(path: &Path, receipt: &ReconciliationReceipt, bytes: &[u8], decision: Decision) -> Value {
    let sha = hex(&Sha256::digest(bytes));
    let mut value = json!({"finished":true,"reconciled":true,"guardId":receipt.guard.guard_id,
        "receiptRef":format!("{}:{}:{sha}",receipt.guard.execution_ref,decision.reference()),
        "receiptPath":path,"receiptSha256":sha,"evidenceSha256":receipt.evidence.sha256,"jobId":receipt.job_id});
    if decision == Decision::Failed {
        value["outcome"] = json!("failed");
        value["operationalReadiness"] = json!(false);
    }
    value
}
pub fn reconcile(config_path: &Path, request: ReconcileRequest) -> Result<Value> {
    if request.version != 1 { return Err(invalid()); }
    let decision = Decision::from_action(&request.action)?;
    let evidence: Evidence = json_pin(&request.evidence)?;
    if evidence.outcome != decision.outcome() { return Err(invalid()); }
    artifact_pin(&evidence.sealed_bridge)?;
    // This separate operator authenticates the pinned sealed bridge as provenance.
    // Bridge::open still accepts only its own registered executable.
    let bridge = Bridge::open_registered(config_path, &evidence.sealed_bridge.path)?;
    verify_sealed_files(config_path, &bridge, &evidence)?;
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
    let guard: GuardEvidence = json_pin(&evidence.guard_intent)?;
    require_dead(&evidence.coordinator)?;
    // No new HeldGuard, execution reference, ownership generation, or effects.
    let _lock = TargetExecutionLock::try_acquire(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(claim_error)?;
    verify_original(&bridge, &mapping, &request, &evidence, &guard)?;
    let directory = bridge.resource_dir(&mapping)?.join("compat-guards");
    let path = directory.join(format!("{}.{}", guard.guard_id, decision.suffix()));
    let ordinary = directory.join(format!("{}.receipt.json", guard.guard_id));
    let opposite = directory.join(format!("{}.{}", guard.guard_id, decision.opposite().suffix()));
    if receipt_present(&ordinary)? || receipt_present(&opposite)? {
        return Err(fail("different_terminal_receipt"));
    }
    let binding = claim::read_execution_binding(&bridge.authority, &mapping.resource_ref, AUTH)
        .map_err(unavailable)?
        .ok_or_else(proof_error)?;
    let receipt = match read_private::<ReconciliationReceipt>(&path, true) {
        Ok(existing) => {
            if existing.version != 1
                || existing.kind != decision.receipt_kind()
                || existing.outcome != decision.outcome()
                || existing.guard != guard
                || existing.evidence != request.evidence
                || existing.paired_proof != evidence.paired_proof
                || existing.job_id != evidence.job_id
                || existing.original_binding_sha256 != evidence.binding_sha256
            {
                return Err(fail("reconciliation_conflict"));
            }
            existing
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if binding.resolved_receipt.is_some() {
                return Err(fail("different_terminal_receipt"));
            }
            if decision == Decision::Failed { verify_live_decision(&bridge, &guard, &_lock)?; }
            expected_file(
                &bridge
                    .resource_dir(&mapping)?
                    .join("execution-binding.json"),
                &evidence.binding_sha256,
            )?;
            verify_decision(&evidence, &request, &bridge, &mapping, &guard, decision)?;
            verify_sealed_files(config_path, &bridge, &evidence)?;
            verify_original(&bridge, &mapping, &request, &evidence, &guard)?;
            // Repeat exact mutable evidence and liveness immediately before journaling.
            verify_decision(&evidence, &request, &bridge, &mapping, &guard, decision)?;
            let receipt = ReconciliationReceipt {
                version: 1,
                kind: decision.receipt_kind().into(),
                outcome: decision.outcome().into(),
                job_id: evidence.job_id.clone(),
                guard: guard.clone(),
                evidence: request.evidence.clone(),
                paired_proof: evidence.paired_proof.clone(),
                original_binding_sha256: evidence.binding_sha256.clone(),
                operator: operator_pin()?,
                reconciled_at_unix_ms: now_ms()?,
            };
            verify_original(&bridge, &mapping, &request, &evidence, &guard)?;
            require_dead(&evidence.coordinator)?;
            if now_ms()?.saturating_sub(evidence.validated_at_unix_ms) > 60000 {
                return Err(fail("candidate_evidence_invalid_or_stale"));
            }
            if decision == Decision::Failed { verify_live_decision(&bridge, &guard, &_lock)?; }
            atomic_json(&path, &receipt).map_err(unavailable)?;
            receipt
        }
        Err(_) => return Err(fail("reconciliation_receipt_invalid")),
    };
    let bytes = fs::read(&path).map_err(unavailable)?;
    let reply = response(&path, &receipt, &bytes, decision);
    let receipt_ref = reply["receiptRef"].as_str().ok_or_else(invalid)?;
    if binding
        .resolved_receipt
        .as_deref()
        .is_some_and(|r| r != receipt_ref)
    {
        return Err(fail("different_terminal_receipt"));
    }
    verify_original(&bridge, &mapping, &request, &evidence, &guard)?;
    require_dead(&evidence.coordinator)?;
    claim::clear_execution_binding(
        &bridge.authority,
        &mapping.resource_ref,
        AUTH,
        &guard.claim_id,
        &guard.principal_ref,
        &guard.execution_ref,
        receipt_ref,
    )
    .map_err(claim_error)?;
    Ok(reply)
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
            .and_then(|request| reconcile(config_path, request))
    };
    let success = result.is_ok();
    write_envelope(&mut output, result)?;
    Ok(success)
}
