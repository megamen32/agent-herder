//! Read-only diagnostics and best-effort observations of canonical renewal.
//!
//! No value in this module authorizes an effect, extends a lease, clears an
//! execution binding, or changes UNKNOWN. Counters cover only recorded results;
//! missing observations cannot be interpreted as zero attempts. Logs, receipts,
//! deduplication records and tombstones are retained indefinitely.
use crate::{
    application::process_bindings::{ProcessRuntimeConfig, read_delegation_for_diagnostics},
    auth::identity::PrincipalId,
    domain::{
        address::Authorization,
        resource::{ResourceClaim, ResourceDescriptor, ResourceRef},
    },
    mcp::catalog::ProcessLeaseBinding,
    ownership::{
        claim::{self, ExecutionBinding},
        manifest::StorageAuthority,
        resource,
    },
    process::{ExecutionObservation, ExecutionSnapshot, ExecutionState, ExecutionStore},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub const RENEWAL_OBSERVATIONS_FILE: &str = "renewal-observations.json";
pub const MAX_DIAGNOSTIC_SAMPLES: usize = 256;
const MAX_TELEMETRY_BYTES: u64 = 262_144;
const MAX_BINDINGS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticError {
    PermissionDenied,
    NotFound,
    TimedOut,
    InvalidData,
    InvalidInput,
    WouldBlock,
    StorageFailure,
    SnapshotChanged,
}
impl DiagnosticError {
    fn from_io(error: &io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::TimedOut => Self::TimedOut,
            io::ErrorKind::InvalidData => Self::InvalidData,
            io::ErrorKind::InvalidInput => Self::InvalidInput,
            io::ErrorKind::WouldBlock => Self::WouldBlock,
            _ => Self::StorageFailure,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimGeneration {
    pub resource_ref: ResourceRef,
    pub claim_id: String,
    pub principal_ref: String,
    pub resource_revision: u64,
}
impl ClaimGeneration {
    fn expected(binding: &ProcessLeaseBinding, principal: &str) -> Self {
        Self {
            resource_ref: binding.resource_ref.clone(),
            claim_id: binding.claim_id.clone(),
            principal_ref: principal.into(),
            resource_revision: binding.revision,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenewalStage {
    BindExecution,
    RenewLease,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewalAttempt {
    pub observed_at_unix_ms: u64,
    pub generation: ClaimGeneration,
    pub stage: RenewalStage,
    pub succeeded: bool,
    pub reason: Option<DiagnosticError>,
    /// The result returned by canonical renew, never a requested replacement TTL.
    pub renewed_expires_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewalHistory {
    pub attempt_count: u64,
    pub success_count: u64,
    pub failure_count: u64,
    pub last_attempt: Option<RenewalAttempt>,
    pub last_success: Option<RenewalAttempt>,
    pub last_failure: Option<RenewalAttempt>,
}
impl RenewalHistory {
    fn add(&mut self, attempt: RenewalAttempt) -> io::Result<()> {
        self.attempt_count = self
            .attempt_count
            .checked_add(1)
            .ok_or_else(invalid_telemetry)?;
        if attempt.succeeded {
            self.success_count = self
                .success_count
                .checked_add(1)
                .ok_or_else(invalid_telemetry)?;
            self.last_success = Some(attempt.clone());
        } else {
            self.failure_count = self
                .failure_count
                .checked_add(1)
                .ok_or_else(invalid_telemetry)?;
            self.last_failure = Some(attempt.clone());
        }
        self.last_attempt = Some(attempt);
        Ok(())
    }
    fn valid(&self) -> bool {
        self.success_count.checked_add(self.failure_count) == Some(self.attempt_count)
            && (self.attempt_count != 0) == self.last_attempt.is_some()
            && (self.success_count != 0) == self.last_success.is_some()
            && (self.failure_count != 0) == self.last_failure.is_some()
            && self
                .last_success
                .as_ref()
                .is_none_or(|a| a.succeeded && a.reason.is_none())
            && self
                .last_failure
                .as_ref()
                .is_none_or(|a| !a.succeeded && a.reason.is_some())
            && self
                .last_attempt
                .as_ref()
                .is_none_or(|a| a.succeeded == a.reason.is_none())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRenewalHistory {
    pub generation: ClaimGeneration,
    pub history: RenewalHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewalTelemetry {
    pub version: u8,
    pub execution_ref: String,
    pub principal_ref: String,
    pub observed_since_unix_ms: u64,
    pub history: RenewalHistory,
    pub resources: Vec<ResourceRenewalHistory>,
}
impl RenewalTelemetry {
    fn validate(&self, execution_ref: &str, principal_ref: &str) -> io::Result<()> {
        if self.version != 1
            || self.execution_ref != execution_ref
            || self.principal_ref != principal_ref
            || !self.history.valid()
            || self.resources.len() > MAX_BINDINGS
        {
            return Err(invalid_telemetry());
        }
        let mut seen = std::collections::HashSet::new();
        let mut totals = (0_u64, 0_u64, 0_u64);
        for resource in &self.resources {
            let g = &resource.generation;
            if g.principal_ref != principal_ref
                || g.claim_id.is_empty()
                || g.resource_revision == 0
                || !seen.insert(&g.resource_ref)
                || !resource.history.valid()
                || [
                    &resource.history.last_attempt,
                    &resource.history.last_success,
                    &resource.history.last_failure,
                ]
                .iter()
                .any(|attempt| attempt.as_ref().is_some_and(|a| &a.generation != g))
            {
                return Err(invalid_telemetry());
            }
            totals.0 = totals
                .0
                .checked_add(resource.history.attempt_count)
                .ok_or_else(invalid_telemetry)?;
            totals.1 = totals
                .1
                .checked_add(resource.history.success_count)
                .ok_or_else(invalid_telemetry)?;
            totals.2 = totals
                .2
                .checked_add(resource.history.failure_count)
                .ok_or_else(invalid_telemetry)?;
        }
        if totals
            != (
                self.history.attempt_count,
                self.history.success_count,
                self.history.failure_count,
            )
        {
            return Err(invalid_telemetry());
        }
        Ok(())
    }
}

/// Caller holds the existing bindings.lock. This records a completed canonical
/// bind/renew attempt and its exact result. Its error MUST be discarded by the
/// caller: telemetry is not part of the ownership transaction.
pub(crate) fn record_renewal_attempt(
    execution_dir: &Path,
    execution_ref: &str,
    principal_ref: &str,
    binding: &ProcessLeaseBinding,
    stage: RenewalStage,
    result: Result<&ResourceClaim, &io::Error>,
    observed_at_unix_ms: u64,
) -> io::Result<()> {
    let mut telemetry = read_telemetry(execution_dir, execution_ref, principal_ref)?
        .unwrap_or_else(|| RenewalTelemetry {
            version: 1,
            execution_ref: execution_ref.into(),
            principal_ref: principal_ref.into(),
            observed_since_unix_ms: observed_at_unix_ms,
            history: RenewalHistory::default(),
            resources: Vec::new(),
        });
    let generation = ClaimGeneration::expected(binding, principal_ref);
    let attempt = RenewalAttempt {
        observed_at_unix_ms,
        generation: generation.clone(),
        stage,
        succeeded: result.is_ok(),
        reason: result.as_ref().err().map(|e| DiagnosticError::from_io(e)),
        renewed_expires_at: result.ok().and_then(|claim| claim.expires_at.clone()),
    };
    let resource = match telemetry
        .resources
        .iter()
        .position(|r| r.generation.resource_ref == binding.resource_ref)
    {
        Some(index) if telemetry.resources[index].generation == generation => {
            &mut telemetry.resources[index]
        }
        Some(_) => return Err(invalid_telemetry()),
        None if telemetry.resources.len() < MAX_BINDINGS => {
            telemetry.resources.push(ResourceRenewalHistory {
                generation,
                history: RenewalHistory::default(),
            });
            telemetry
                .resources
                .last_mut()
                .ok_or_else(invalid_telemetry)?
        }
        None => return Err(invalid_telemetry()),
    };
    resource.history.add(attempt.clone())?;
    telemetry.history.add(attempt)?;
    telemetry.validate(execution_ref, principal_ref)?;
    write_telemetry(execution_dir, &telemetry)
}

fn invalid_telemetry() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid renewal observation")
}

fn read_telemetry(
    dir: &Path,
    execution_ref: &str,
    principal_ref: &str,
) -> io::Result<Option<RenewalTelemetry>> {
    let path = dir.join(RENEWAL_OBSERVATIONS_FILE);
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let opened = file.metadata()?;
    let named = fs::symlink_metadata(&path)?;
    if !opened.is_file()
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.nlink() != 1
        || opened.mode() & 0o077 != 0
        || opened.len() > MAX_TELEMETRY_BYTES
        || (opened.dev(), opened.ino()) != (named.dev(), named.ino())
    {
        return Err(invalid_telemetry());
    }
    let mut bytes = Vec::new();
    file.take(MAX_TELEMETRY_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_TELEMETRY_BYTES {
        return Err(invalid_telemetry());
    }
    let telemetry: RenewalTelemetry =
        serde_json::from_slice(&bytes).map_err(|_| invalid_telemetry())?;
    telemetry.validate(execution_ref, principal_ref)?;
    Ok(Some(telemetry))
}

fn write_telemetry(dir: &Path, telemetry: &RenewalTelemetry) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let bytes = serde_json::to_vec(telemetry).map_err(|_| invalid_telemetry())?;
    if bytes.len() as u64 > MAX_TELEMETRY_BYTES {
        return Err(invalid_telemetry());
    }
    let temporary = dir.join(format!(
        ".renewal-observations-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, dir.join(RENEWAL_OBSERVATIONS_FILE))?;
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationAvailability {
    Available,
    NoEvidence,
    Unavailable,
    Unauthorized,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenewalDiagnostics {
    pub availability: ObservationAvailability,
    pub coverage: String,
    pub history_complete: bool,
    pub recorded: Option<RenewalTelemetry>,
    pub error: Option<DiagnosticError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceDiagnostics {
    pub expected_generation: ClaimGeneration,
    pub observed_at_unix_ms: u64,
    pub availability: ObservationAvailability,
    pub error: Option<DiagnosticError>,
    pub resource: Option<ResourceDescriptor>,
    pub claim: Option<ResourceClaim>,
    pub claim_live: Option<bool>,
    pub execution_binding: Option<ExecutionBinding>,
    pub current_generation: Option<ClaimGeneration>,
    pub claim_generation_matches: Option<bool>,
    pub execution_binding_matches: Option<bool>,
    /// Null means no bounded expiry was observed, never infinite permission.
    pub remaining_ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NextAction {
    EndTurn,
    ReconcileOriginal,
    InspectReceipt,
    WaitNativeIdle,
    FinalizeClaim,
    NoResendUnknown,
    StopHold,
    ExplicitResumeOrDelete,
    ResolveRejection,
    None,
}

/// Unknown facts stay None. Creating diagnostics must never perform native I/O
/// to fill these fields, or use unstructured error/detail strings as evidence.
#[derive(Debug, Clone, Copy)]
pub struct WaitDiagnosticContext<'a> {
    pub phase: &'a str,
    pub intent_state: Result<Option<&'a str>, ()>,
    pub hold_active: Option<bool>,
    pub native_idle_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessDiagnostics {
    pub version: u8,
    pub non_authoritative: bool,
    pub observed_at_unix_ms: u64,
    pub execution_state: ExecutionState,
    pub observation: ExecutionObservation,
    pub confirmed_live: bool,
    pub finalization_pending: bool,
    pub hold_active: Option<bool>,
    pub native_idle_blocked: Option<bool>,
    pub intent_readable: bool,
    pub intent_state: Option<String>,
    pub next_action: NextAction,
    pub renewal: RenewalDiagnostics,
    pub resources_scope: String,
    pub binding_set_availability: ObservationAvailability,
    pub binding_set_error: Option<DiagnosticError>,
    pub resources: Vec<ResourceDiagnostics>,
    pub resources_complete: bool,
    pub retention: RetentionPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub logs: String,
    pub receipts: String,
    pub deduplication: String,
    pub tombstones: String,
}

/// The installed configuration and authenticated principal are supplied by the
/// caller. Persisted delegation/telemetry metadata never grants read access.
/// Reads are bounded and errors are projected; valid automation reads keep
/// working when diagnostic metadata is absent or damaged.
pub fn observe(
    store: &ExecutionStore,
    snapshot: &ExecutionSnapshot,
    config: &ProcessRuntimeConfig,
    principal: &PrincipalId,
    bindings: &[ProcessLeaseBinding],
    wait: WaitDiagnosticContext<'_>,
    observed_at_unix_ms: u64,
) -> ProcessDiagnostics {
    let authorized = config.authorizes_principal(principal)
        && snapshot.record.principal_ref == principal.0
        && config.node_ref == store.node_ref()
        && config.execution_root == store.root();
    let (availability, recorded, error) = if !authorized {
        (
            ObservationAvailability::Unauthorized,
            None,
            Some(DiagnosticError::PermissionDenied),
        )
    } else {
        match store
            .execution_directory(&snapshot.record.execution_ref)
            .and_then(|dir| read_telemetry(&dir, &snapshot.record.execution_ref, &principal.0))
        {
            Ok(Some(recorded)) => (ObservationAvailability::Available, Some(recorded), None),
            Ok(None) => (ObservationAvailability::NoEvidence, None, None),
            Err(e) => (
                ObservationAvailability::Unavailable,
                None,
                Some(DiagnosticError::from_io(&e)),
            ),
        }
    };
    let (binding_set_availability, binding_set_error, current_bindings) = if !authorized {
        (
            ObservationAvailability::Unauthorized,
            Some(DiagnosticError::PermissionDenied),
            Vec::new(),
        )
    } else {
        match read_delegation_for_diagnostics(
            store,
            &snapshot.record.execution_ref,
            principal,
            config,
        ) {
            Ok(d)
                if bindings.len() <= MAX_BINDINGS
                    && bindings.iter().all(|b| d.bindings.contains(b)) =>
            {
                (ObservationAvailability::Available, None, d.bindings)
            }
            Ok(_) => (
                ObservationAvailability::Unavailable,
                Some(DiagnosticError::InvalidData),
                Vec::new(),
            ),
            Err(error) => (
                if error.kind() == io::ErrorKind::NotFound {
                    ObservationAvailability::NoEvidence
                } else {
                    ObservationAvailability::Unavailable
                },
                Some(DiagnosticError::from_io(&error)),
                Vec::new(),
            ),
        }
    };
    let resources = current_bindings
        .iter()
        .map(|binding| {
            observe_resource(
                &config.resources,
                authorized,
                &snapshot.record.execution_ref,
                &principal.0,
                binding,
                observed_at_unix_ms,
            )
        })
        .collect::<Vec<_>>();
    ProcessDiagnostics {
        version: 1,
        non_authoritative: true,
        observed_at_unix_ms,
        execution_state: snapshot.record.state.clone(),
        observation: snapshot.observation.clone(),
        confirmed_live: snapshot.confirmed_live,
        finalization_pending: snapshot.record.finalization_pending,
        hold_active: wait.hold_active,
        native_idle_blocked: wait.native_idle_blocked,
        intent_readable: wait.intent_state.is_ok(),
        intent_state: wait.intent_state.ok().flatten().map(str::to_owned),
        next_action: next_action(snapshot, wait),
        renewal: RenewalDiagnostics {
            availability,
            coverage: "best_effort_since_first_recorded_result".into(),
            history_complete: false,
            recorded,
            error,
        },
        resources_scope: "current_validated_delegation".into(),
        binding_set_availability,
        binding_set_error,
        resources_complete: binding_set_availability == ObservationAvailability::Available
            && resources
                .iter()
                .all(|r| r.availability == ObservationAvailability::Available),
        resources,
        retention: RetentionPolicy {
            logs: "keep_all".into(),
            receipts: "indefinite".into(),
            deduplication: "indefinite".into(),
            tombstones: "indefinite".into(),
        },
    }
}

fn next_action(snapshot: &ExecutionSnapshot, wait: WaitDiagnosticContext<'_>) -> NextAction {
    if wait.hold_active == Some(true) {
        return NextAction::StopHold;
    }
    let receipt = snapshot.record.receipt.as_ref();
    if matches!(snapshot.observation, ExecutionObservation::Unknown)
        || receipt.is_some_and(|r| !r.tree_complete || r.process_may_be_running)
    {
        return NextAction::NoResendUnknown;
    }
    if snapshot.record.finalization_pending
        && receipt.is_some_and(|r| r.tree_complete && !r.process_may_be_running)
    {
        return NextAction::FinalizeClaim;
    }
    match wait.intent_state {
        Err(()) | Ok(Some("unknown")) => return NextAction::NoResendUnknown,
        Ok(Some("dispatching" | "admitted")) => return NextAction::ReconcileOriginal,
        Ok(Some("prepared")) => return NextAction::ReconcileOriginal,
        Ok(Some("confirmed" | "rejected")) | Ok(None) => {}
        Ok(Some(_)) => return NextAction::NoResendUnknown,
    }
    if wait.phase == "paused" {
        return NextAction::ExplicitResumeOrDelete;
    }
    if wait.phase == "rejected" {
        return NextAction::ResolveRejection;
    }
    if wait.native_idle_blocked == Some(true) {
        return NextAction::WaitNativeIdle;
    }
    match wait.phase {
        "armed" if snapshot.confirmed_live || receipt.is_none() => NextAction::EndTurn,
        "armed" => NextAction::ReconcileOriginal,
        "ready" | "confirmed" => NextAction::InspectReceipt,
        "cancelled"
            if receipt.is_some_and(|r| r.tree_complete && !r.process_may_be_running)
                && !snapshot.record.finalization_pending =>
        {
            NextAction::None
        }
        "cancelled" => NextAction::ReconcileOriginal,
        "delivery_unknown" => NextAction::NoResendUnknown,
        _ => NextAction::ReconcileOriginal,
    }
}

type ResourceRead = (
    ResourceDescriptor,
    Option<ResourceClaim>,
    Option<ExecutionBinding>,
    bool,
);
fn read_resource(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
) -> io::Result<ResourceRead> {
    let descriptor = resource::get(authority, resource_ref, Authorization::Authorized)?;
    let owner = claim::read_current(authority, resource_ref, Authorization::Authorized)?;
    let occupancy =
        claim::read_execution_binding(authority, resource_ref, Authorization::Authorized)?;
    let live = match &owner {
        Some(owner) => match claim::read_live_by_claim_id(
            authority,
            resource_ref,
            Authorization::Authorized,
            &owner.claim_id,
        ) {
            Ok(current) => current.as_ref() == Some(owner),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::PermissionDenied
                ) =>
            {
                false
            }
            Err(error) => return Err(error),
        },
        None => false,
    };
    Ok((descriptor, owner, occupancy, live))
}

fn observe_resource(
    authority: &StorageAuthority,
    authorized: bool,
    execution_ref: &str,
    principal_ref: &str,
    binding: &ProcessLeaseBinding,
    now: u64,
) -> ResourceDiagnostics {
    let mut out = ResourceDiagnostics {
        expected_generation: ClaimGeneration::expected(binding, principal_ref),
        observed_at_unix_ms: now,
        availability: ObservationAvailability::Unavailable,
        error: None,
        resource: None,
        claim: None,
        claim_live: None,
        execution_binding: None,
        current_generation: None,
        claim_generation_matches: None,
        execution_binding_matches: None,
        remaining_ttl_ms: None,
    };
    if !authorized {
        out.availability = ObservationAvailability::Unauthorized;
        out.error = Some(DiagnosticError::PermissionDenied);
        return out;
    }
    let result = (|| {
        let first = read_resource(authority, &binding.resource_ref)?;
        let second = read_resource(authority, &binding.resource_ref)?;
        if first != second {
            return Ok(None);
        }
        let remaining = first
            .1
            .as_ref()
            .and_then(|c| c.expires_at.as_ref())
            .map(|expiry| {
                claim::parse_expiry_seconds(expiry)
                    .and_then(|seconds| seconds.checked_mul(1000).ok_or_else(invalid_telemetry))
                    .map(|deadline| deadline.saturating_sub(now))
            })
            .transpose()?;
        Ok(Some((first, remaining)))
    })();
    match result {
        Err(error) => out.error = Some(DiagnosticError::from_io(&error)),
        Ok(None) => out.error = Some(DiagnosticError::SnapshotChanged),
        Ok(Some(((descriptor, owner, occupancy, live), remaining))) => {
            out.current_generation = owner.as_ref().map(|owner| ClaimGeneration {
                resource_ref: binding.resource_ref.clone(),
                claim_id: owner.claim_id.clone(),
                principal_ref: owner.principal_ref.clone(),
                resource_revision: descriptor.revision,
            });
            out.claim_generation_matches =
                Some(out.current_generation.as_ref() == Some(&out.expected_generation));
            out.execution_binding_matches = Some(occupancy.as_ref().is_some_and(|b| {
                b.execution_ref == execution_ref
                    && b.claim_id == binding.claim_id
                    && b.principal_ref == principal_ref
                    && b.resource_revision == binding.revision
                    && b.resolved_receipt.is_none()
            }));
            out.resource = Some(descriptor);
            out.claim = owner;
            out.claim_live = Some(live);
            out.execution_binding = occupancy;
            out.remaining_ttl_ms = remaining;
            out.availability = ObservationAvailability::Available;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotGauges {
    pub scope: String,
    pub sample_limit: usize,
    pub returned_items: usize,
    pub sampled: usize,
    pub unavailable: usize,
    pub truncated: bool,
    pub complete: bool,
    pub confirmed_live: usize,
    pub unknown: usize,
    pub terminal: usize,
    pub prepared: usize,
    pub finalization_pending: usize,
    pub expired_claims: usize,
    pub resource_joins_incomplete: usize,
    pub latest_renewal_failed: usize,
    pub waits_pending: usize,
    pub waits_ready: usize,
    pub waits_confirmed: usize,
    pub delivery_unknown: usize,
    pub delivery_admitted: usize,
    pub delivery_state_unavailable: usize,
    pub oldest_pending_created_at_unix_ms: Option<u64>,
    pub oldest_pending_age_ms: Option<u64>,
    pub oldest_pending_complete: bool,
    pub lifetime_delivery_admitted: Option<u64>,
    pub lifetime_delivery_deduplicated: Option<u64>,
    pub renewal_samples_with_evidence: usize,
    pub recorded_renewal_attempts: Option<u64>,
    /// Historical totals cannot be recovered from best-effort observations.
    pub lifetime_renewal_attempts: Option<u64>,
}

/// Derive bounded gauges solely from the Get/List projections already returned.
/// This helper never enumerates storage or opens an execution/resource file.
pub fn list_gauges(items: &[serde_json::Value], source_complete: bool) -> SnapshotGauges {
    let mut out = SnapshotGauges {
        scope: "returned_process_automation_list".into(),
        sample_limit: MAX_DIAGNOSTIC_SAMPLES,
        returned_items: items.len(),
        sampled: 0,
        unavailable: 0,
        truncated: items.len() > MAX_DIAGNOSTIC_SAMPLES,
        complete: false,
        confirmed_live: 0,
        unknown: 0,
        terminal: 0,
        prepared: 0,
        finalization_pending: 0,
        expired_claims: 0,
        resource_joins_incomplete: 0,
        latest_renewal_failed: 0,
        renewal_samples_with_evidence: 0,
        waits_pending: 0,
        waits_ready: 0,
        waits_confirmed: 0,
        delivery_unknown: 0,
        delivery_admitted: 0,
        delivery_state_unavailable: 0,
        oldest_pending_created_at_unix_ms: None,
        oldest_pending_age_ms: None,
        oldest_pending_complete: source_complete && items.len() <= MAX_DIAGNOSTIC_SAMPLES,
        lifetime_delivery_admitted: None,
        lifetime_delivery_deduplicated: None,
        recorded_renewal_attempts: None,
        lifetime_renewal_attempts: None,
    };
    let mut attempts = Some(0_u64);
    for item in items.iter().take(MAX_DIAGNOSTIC_SAMPLES) {
        let Some(value) = item.get("diagnostics") else {
            out.unavailable += 1;
            out.oldest_pending_complete = false;
            continue;
        };
        let Ok(diagnostic) = serde_json::from_value::<ProcessDiagnostics>(value.clone()) else {
            out.unavailable += 1;
            out.oldest_pending_complete = false;
            continue;
        };
        if diagnostic.version != 1 || !diagnostic.non_authoritative {
            out.unavailable += 1;
            out.oldest_pending_complete = false;
            continue;
        }
        out.sampled += 1;
        out.resource_joins_incomplete += usize::from(!diagnostic.resources_complete);
        let phase = item
            .get("wait")
            .and_then(|v| v.get("phase"))
            .and_then(|v| v.as_str());
        out.waits_pending += usize::from(phase == Some("armed"));
        out.waits_ready += usize::from(phase == Some("ready"));
        out.waits_confirmed += usize::from(phase == Some("confirmed"));
        out.delivery_unknown += usize::from(
            phase == Some("delivery_unknown")
                || diagnostic.intent_state.as_deref() == Some("unknown"),
        );
        out.delivery_admitted +=
            usize::from(diagnostic.intent_state.as_deref() == Some("admitted"));
        out.delivery_state_unavailable += usize::from(!diagnostic.intent_readable);
        let pending = matches!(phase, Some("armed" | "delivery_unknown"))
            || matches!(
                diagnostic.intent_state.as_deref(),
                Some("prepared" | "dispatching" | "admitted" | "unknown")
            )
            || !diagnostic.intent_readable;
        if phase.is_none() {
            out.oldest_pending_complete = false;
        }
        if pending {
            match item
                .get("execution")
                .and_then(|v| v.get("record"))
                .and_then(|v| v.get("created_at_unix_ms"))
                .and_then(|v| v.as_u64())
            {
                Some(created_at) if created_at <= diagnostic.observed_at_unix_ms => {
                    if out
                        .oldest_pending_created_at_unix_ms
                        .is_none_or(|old| created_at < old)
                    {
                        out.oldest_pending_created_at_unix_ms = Some(created_at);
                        out.oldest_pending_age_ms =
                            Some(diagnostic.observed_at_unix_ms - created_at);
                    }
                }
                _ => out.oldest_pending_complete = false,
            }
        }
        out.confirmed_live += usize::from(diagnostic.confirmed_live);
        out.unknown += usize::from(diagnostic.observation == ExecutionObservation::Unknown);
        out.terminal += usize::from(diagnostic.observation == ExecutionObservation::Terminal);
        out.prepared += usize::from(diagnostic.execution_state == ExecutionState::Prepared);
        out.finalization_pending += usize::from(diagnostic.finalization_pending);
        out.expired_claims += diagnostic
            .resources
            .iter()
            .filter(|r| {
                r.claim.is_some() && r.claim_live == Some(false) && r.remaining_ttl_ms == Some(0)
            })
            .count();
        if let Some(telemetry) = diagnostic.renewal.recorded {
            out.renewal_samples_with_evidence += 1;
            attempts = attempts.and_then(|n| n.checked_add(telemetry.history.attempt_count));
            out.latest_renewal_failed +=
                usize::from(telemetry.history.last_attempt.is_some_and(|a| !a.succeeded));
        }
    }
    if out.renewal_samples_with_evidence != 0 {
        out.recorded_renewal_attempts = attempts;
    }
    out.complete = source_complete
        && !out.truncated
        && out.unavailable == 0
        && out.resource_joins_incomplete == 0;
    out
}
