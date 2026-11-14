#![cfg(any(target_os = "linux", target_os = "macos"))]

use herder::{
    application::{
        process_bindings::{BindingHooks, ProcessRuntimeConfig, add_delegation, write_delegation},
        process_diagnostics::{
            self, DiagnosticError, NextAction, ObservationAvailability, ProcessDiagnostics,
            RENEWAL_OBSERVATIONS_FILE, WaitDiagnosticContext,
        },
    },
    auth::identity::PrincipalId,
    domain::{
        address::{Authorization, NodeRef, SessionRef},
        resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope},
    },
    mcp::catalog::{ProcessLeaseBinding, ProcessLeaseExit},
    ownership::{
        claim::{self, OwnerRecord},
        manifest::{AuthorityRoute, StorageAuthority, StorageId, StorageMarker},
        resource,
    },
    process::{
        self, CompletionReason, CompletionReceipt, ExecutionHooks, ExecutionObservation,
        ExecutionRecord, ExecutionSnapshot, ExecutionState, ExecutionStore, StartRequest,
    },
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, symlink},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const NONCE: &str = "01234567-89ab-4cde-8fab-0123456789ab";

struct Fixture {
    root: PathBuf,
    config: ProcessRuntimeConfig,
    store: ExecutionStore,
    record: ExecutionRecord,
    binding: ProcessLeaseBinding,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "herder-diagnostics-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let resources = root.join("authority");
        fs::create_dir_all(&resources).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("diagnostic-fixture".into()),
            authority_node: NodeRef("fixture-node".into()),
            root: resources,
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        private(
            &authority.root.join("storage.json"),
            &StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            },
        );
        let store = ExecutionStore::open(root.join("executions"), "fixture-node").unwrap();
        let config = ProcessRuntimeConfig {
            version: 1,
            node_ref: "fixture-node".into(),
            worker: "/bin/true".into(),
            execution_root: store.root().into(),
            resources: authority,
            administrators: vec!["alice".into()],
            remote_executors: vec![],
        };
        let resource_ref = ResourceRef("fixture-build-slot".into());
        resource::register_or_update(
            &config.resources,
            ResourceDescriptor::new(
                resource_ref.clone(),
                ResourceScope::Global,
                ResourceKind::Other("build".into()),
                "diagnostic-fixture".into(),
                config.resources.storage_id.0.clone(),
                None,
                0,
            ),
            Authorization::Authorized,
            None,
        )
        .unwrap();
        let now = claim::now_seconds().unwrap();
        claim::claim(
            &config.resources,
            &resource_ref,
            Authorization::Authorized,
            ResourceClaim {
                resource_ref: resource_ref.clone(),
                principal_ref: "alice".into(),
                session_ref: Some(SessionRef("session-fixture".into())),
                claim_id: NONCE.into(),
                purpose: "diagnostic fixture".into(),
                acquired_at: format!("unix-seconds:{now}"),
                expires_at: Some(format!("unix-seconds:{}", now + 60)),
            },
        )
        .unwrap();
        let binding = ProcessLeaseBinding {
            resource_ref,
            claim_id: NONCE.into(),
            revision: 1,
            ttl_seconds: 10,
            on_exit: ProcessLeaseExit::Release,
            handback_seconds: None,
        };
        let record = store
            .prepare_start(StartRequest {
                principal_ref: "alice".into(),
                session_ref: "session-fixture".into(),
                request_key: "fixture-request".into(),
                argv: vec!["/bin/true".into()],
                cwd: root.clone(),
                deadline_unix_ms: Some(process::unix_millis().unwrap() + 60_000),
                stop_grace_ms: 100,
            })
            .unwrap();
        write_delegation(
            &store,
            &record.execution_ref,
            "alice",
            &config.resources,
            vec![binding.clone()],
        )
        .unwrap();
        Self {
            root,
            config,
            store,
            record,
            binding,
        }
    }
    fn hooks(&self) -> BindingHooks {
        BindingHooks::new(&self.store, &self.record.execution_ref, "alice").unwrap()
    }
    fn dir(&self) -> PathBuf {
        self.store
            .execution_directory(&self.record.execution_ref)
            .unwrap()
    }
    fn owner_path(&self) -> PathBuf {
        self.config
            .resources
            .root
            .join("resources")
            .join(&self.binding.resource_ref.0)
            .join("owner.json")
    }
    fn expire(&self) {
        let mut owner: OwnerRecord =
            serde_json::from_slice(&fs::read(self.owner_path()).unwrap()).unwrap();
        owner.claim.expires_at = Some("unix-seconds:0".into());
        private(&self.owner_path(), &owner);
    }
    fn current(&self) -> ResourceClaim {
        claim::read_current(
            &self.config.resources,
            &self.binding.resource_ref,
            Authorization::Authorized,
        )
        .unwrap()
        .unwrap()
    }
    fn snapshot(&self) -> ExecutionSnapshot {
        self.store.status(&self.record.execution_ref).unwrap()
    }
    fn observe(&self) -> ProcessDiagnostics {
        process_diagnostics::observe(
            &self.store,
            &self.snapshot(),
            &self.config,
            &PrincipalId("alice".into()),
            std::slice::from_ref(&self.binding),
            context("armed"),
            process::unix_millis().unwrap(),
        )
    }
    fn receipt(&self, complete: bool) -> CompletionReceipt {
        CompletionReceipt {
            execution_ref: self.record.execution_ref.clone(),
            node_ref: self.record.node_ref.clone(),
            reason: if complete {
                CompletionReason::Exited
            } else {
                CompletionReason::ObservationLost
            },
            started_at_unix_ms: None,
            finished_at_unix_ms: process::unix_millis().unwrap(),
            exit_code: complete.then_some(0),
            signal: None,
            descendant_failure: false,
            tree_complete: complete,
            process_may_be_running: !complete,
            evidence_source: "test-fixture".into(),
            stdout_path: self.dir().join("stdout.log"),
            stderr_path: self.dir().join("stderr.log"),
            detail: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn private(path: &Path, value: &impl serde::Serialize) {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(&serde_json::to_vec(value).unwrap()).unwrap();
    file.sync_all().unwrap();
}
fn context(phase: &str) -> WaitDiagnosticContext<'_> {
    WaitDiagnosticContext {
        phase,
        intent_state: Ok(None),
        hold_active: None,
        native_idle_blocked: None,
    }
}

#[test]
fn historical_absence_stays_null_and_read_projection_does_not_create_metadata() {
    let f = Fixture::new();
    let before = fs::read(f.owner_path()).unwrap();
    let observed = f.observe();
    assert_eq!(
        observed.renewal.availability,
        ObservationAvailability::NoEvidence
    );
    assert!(observed.renewal.recorded.is_none());
    assert!(!observed.renewal.history_complete);
    assert_eq!(observed.hold_active, None);
    assert_eq!(observed.native_idle_blocked, None);
    assert_eq!(observed.next_action, NextAction::EndTurn);
    assert!(!f.dir().join(RENEWAL_OBSERVATIONS_FILE).exists());
    assert_eq!(fs::read(f.owner_path()).unwrap(), before);
    assert_eq!(
        observed.resources[0]
            .current_generation
            .as_ref()
            .unwrap()
            .claim_id,
        NONCE
    );
    assert_eq!(observed.resources[0].claim_generation_matches, Some(true));
    assert_eq!(observed.resources[0].claim_live, Some(true));
    assert!(observed.resources[0].remaining_ttl_ms.unwrap() <= 60_000);
    let gauges = process_diagnostics::list_gauges(&[json!({"diagnostics":observed})], true);
    assert_eq!(gauges.recorded_renewal_attempts, None);
    assert_eq!(gauges.lifetime_renewal_attempts, None);
    assert!(gauges.complete);
}

#[test]
fn renewal_results_keep_exact_generation_and_expiry_is_read_from_canonical_owner() {
    let f = Fixture::new();
    let mut hooks = f.hooks();
    hooks.before_spawn(&f.record).unwrap();
    hooks.tick(&f.record).unwrap();
    let current = f.current();
    let first = f.observe();
    let recorded = first.renewal.recorded.unwrap();
    assert_eq!(
        (
            recorded.history.attempt_count,
            recorded.history.success_count,
            recorded.history.failure_count
        ),
        (2, 2, 0)
    );
    let success = recorded.history.last_success.unwrap();
    assert_eq!(success.generation.claim_id, NONCE);
    assert_eq!(success.generation.principal_ref, "alice");
    assert_eq!(success.generation.resource_revision, 1);
    assert_eq!(success.renewed_expires_at, current.expires_at);
    let metadata = fs::metadata(f.dir().join(RENEWAL_OBSERVATIONS_FILE)).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(metadata.nlink(), 1);
    f.expire();
    let before = fs::read(f.owner_path()).unwrap();
    let failure = hooks.tick(&f.record).unwrap_err();
    assert_eq!(failure.kind(), std::io::ErrorKind::TimedOut);
    let failed = f.observe();
    let telemetry = failed.renewal.recorded.unwrap();
    assert_eq!(
        (
            telemetry.history.attempt_count,
            telemetry.history.success_count,
            telemetry.history.failure_count
        ),
        (3, 2, 1)
    );
    assert_eq!(
        telemetry.history.last_failure.unwrap().reason,
        Some(DiagnosticError::TimedOut)
    );
    assert_eq!(failed.resources[0].claim_live, Some(false));
    assert_eq!(failed.resources[0].remaining_ttl_ms, Some(0));
    assert_eq!(fs::read(f.owner_path()).unwrap(), before);
    assert!(
        claim::read_execution_binding(
            &f.config.resources,
            &f.binding.resource_ref,
            Authorization::Authorized
        )
        .unwrap()
        .unwrap()
        .resolved_receipt
        .is_none()
    );
}

#[test]
fn telemetry_storage_failure_never_changes_success_or_canonical_error() {
    let f = Fixture::new();
    fs::create_dir(f.dir().join(RENEWAL_OBSERVATIONS_FILE)).unwrap();
    f.hooks().tick(&f.record).unwrap();
    assert_eq!(f.current().claim_id, NONCE);
    assert!(f.current().expires_at.is_some());
    assert_eq!(
        f.observe().renewal.availability,
        ObservationAvailability::Unavailable
    );
    f.expire();
    let before = fs::read(f.owner_path()).unwrap();
    assert_eq!(
        f.hooks().tick(&f.record).unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
    assert_eq!(fs::read(f.owner_path()).unwrap(), before);
}

#[test]
fn untrusted_observation_files_are_not_followed_repaired_or_used_as_authority() {
    for damage in ["identity", "json", "oversize", "symlink", "hardlink"] {
        let f = Fixture::new();
        f.hooks().tick(&f.record).unwrap();
        let path = f.dir().join(RENEWAL_OBSERVATIONS_FILE);
        let victim = f.root.join("unrelated-private-file");
        private(
            &victim,
            &json!({"secret":"never expose credential details"}),
        );
        let victim_before = fs::read(&victim).unwrap();
        match damage {
            "identity" => {
                let mut data: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                data["execution_ref"] = json!("execution-another");
                private(&path, &data);
            }
            "json" => fs::write(&path, b"credential=secret-not-json").unwrap(),
            "oversize" => fs::write(&path, vec![b'x'; 262_145]).unwrap(),
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink(&victim, &path).unwrap();
            }
            "hardlink" => {
                fs::remove_file(&path).unwrap();
                fs::hard_link(&victim, &path).unwrap();
            }
            _ => unreachable!(),
        }
        let damaged = fs::symlink_metadata(&path).unwrap();
        f.hooks().tick(&f.record).unwrap();
        let observed = f.observe();
        assert_eq!(
            observed.renewal.availability,
            ObservationAvailability::Unavailable,
            "{damage}"
        );
        assert!(observed.renewal.recorded.is_none());
        assert_eq!(observed.resources[0].claim_live, Some(true));
        assert_eq!(fs::read(&victim).unwrap(), victim_before);
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), damaged.ino());
        assert!(
            !serde_json::to_string(&observed)
                .unwrap()
                .contains("secret-not-json")
        );
    }
}

#[test]
fn current_installed_authority_and_admin_grants_control_resource_join() {
    let f = Fixture::new();
    f.hooks().tick(&f.record).unwrap();
    let path = f.dir().join("bindings.json");
    let mut delegation: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let foreign = f.root.join("not-an-authority");
    delegation["authority"]["root"] = json!(foreign);
    private(&path, &delegation);
    let mismatch = f.observe();
    assert_eq!(
        mismatch.binding_set_availability,
        ObservationAvailability::Unavailable
    );
    assert_eq!(
        mismatch.binding_set_error,
        Some(DiagnosticError::PermissionDenied)
    );
    assert!(
        mismatch.resources.is_empty(),
        "join accepted a mismatched delegated authority"
    );
    assert!(!mismatch.resources_complete);
    assert!(!foreign.exists());
    let mut config = f.config.clone();
    config.administrators.clear();
    let observed = process_diagnostics::observe(
        &f.store,
        &f.snapshot(),
        &config,
        &PrincipalId("alice".into()),
        std::slice::from_ref(&f.binding),
        context("armed"),
        process::unix_millis().unwrap(),
    );
    assert_eq!(
        observed.renewal.availability,
        ObservationAvailability::Unauthorized
    );
    assert!(observed.renewal.recorded.is_none());
    assert_eq!(
        observed.binding_set_availability,
        ObservationAvailability::Unauthorized
    );
    assert!(observed.resources.is_empty());
    assert!(!observed.resources_complete);
}

#[test]
fn existing_binding_lock_serializes_counters_across_worker_instances() {
    let f = Fixture::new();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let f = &f;
            scope.spawn(move || f.hooks().tick(&f.record).unwrap());
        }
    });
    let observed = f.observe();
    let telemetry = observed.renewal.recorded.unwrap();
    assert_eq!(telemetry.history.attempt_count, 8);
    assert_eq!(telemetry.history.success_count, 8);
    assert_eq!(telemetry.history.failure_count, 0);
    assert_eq!(telemetry.resources.len(), 1);
    assert_eq!(telemetry.resources[0].history.attempt_count, 8);
    assert_eq!(f.current().claim_id, NONCE);
}

#[test]
fn late_binding_is_joined_without_changing_the_original_rule_or_renewing_on_read() {
    let mut f = Fixture::new();
    f.hooks().tick(&f.record).unwrap();
    let resource_ref = ResourceRef("late-build-slot".into());
    resource::register_or_update(
        &f.config.resources,
        ResourceDescriptor::new(
            resource_ref.clone(),
            ResourceScope::Global,
            ResourceKind::Device,
            "late-fixture".into(),
            f.config.resources.storage_id.0.clone(),
            None,
            0,
        ),
        Authorization::Authorized,
        None,
    )
    .unwrap();
    let now = claim::now_seconds().unwrap();
    let late_nonce = "fedcba98-7654-4321-8abc-fedcba987654";
    claim::claim(
        &f.config.resources,
        &resource_ref,
        Authorization::Authorized,
        ResourceClaim {
            resource_ref: resource_ref.clone(),
            principal_ref: "alice".into(),
            session_ref: Some(SessionRef("session-fixture".into())),
            claim_id: late_nonce.into(),
            purpose: "late diagnostic fixture".into(),
            acquired_at: format!("unix-seconds:{now}"),
            expires_at: Some(format!("unix-seconds:{}", now + 60)),
        },
    )
    .unwrap();
    let late = ProcessLeaseBinding {
        resource_ref: resource_ref.clone(),
        claim_id: late_nonce.into(),
        revision: 1,
        ttl_seconds: 10,
        on_exit: ProcessLeaseExit::Release,
        handback_seconds: None,
    };
    // This is the existing admission fixture: the test process supplies a real
    // immutable birth identity and held worker lock. No child command is started.
    let worker_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(f.dir().join("worker.lock"))
        .unwrap();
    worker_lock.lock().unwrap();
    let identity = process::capture_process(std::process::id(), f.store.node_ref()).unwrap();
    f.record.worker = Some(identity.clone());
    f.record.process = Some(identity);
    f.record.state = ExecutionState::Running;
    f.record.started_at_unix_ms = Some(process::unix_millis().unwrap());
    f.record.heartbeat_at_unix_ms = f.record.started_at_unix_ms;
    private(&f.dir().join("record.json"), &f.record);
    assert!(f.snapshot().confirmed_live);
    add_delegation(&f.store, &f.record.execution_ref, "alice", late).unwrap();
    let owner_path = f
        .config
        .resources
        .root
        .join("resources")
        .join(&resource_ref.0)
        .join("owner.json");
    let before = fs::read(&owner_path).unwrap();
    let observed = f.observe();
    assert_eq!(observed.resources_scope, "current_validated_delegation");
    assert_eq!(
        observed.binding_set_availability,
        ObservationAvailability::Available
    );
    assert!(observed.resources_complete);
    assert_eq!(
        observed.resources.len(),
        2,
        "late delegation was omitted by the original single-binding rule"
    );
    let joined = observed
        .resources
        .iter()
        .find(|r| r.expected_generation.resource_ref == resource_ref)
        .unwrap();
    assert_eq!(
        joined.current_generation.as_ref().unwrap().claim_id,
        late_nonce
    );
    assert_eq!(joined.claim_generation_matches, Some(true));
    assert_eq!(joined.execution_binding_matches, Some(true));
    assert_eq!(
        fs::read(&owner_path).unwrap(),
        before,
        "diagnostic read changed the late claim"
    );
}

#[test]
fn missing_or_untrusted_current_delegation_never_looks_like_a_complete_rule_only_join() {
    for damage in [
        "missing",
        "json",
        "oversize",
        "symlink",
        "hardlink",
        "principal",
        "omitted-binding",
    ] {
        let f = Fixture::new();
        let path = f.dir().join("bindings.json");
        let before = fs::read(f.owner_path()).unwrap();
        let victim = f.root.join("unrelated");
        private(&victim, &json!({"secret":"private-credential"}));
        match damage {
            "missing" => fs::remove_file(&path).unwrap(),
            "json" => fs::write(&path, "private-credential-invalid-json").unwrap(),
            "oversize" => fs::write(&path, vec![b'x'; 262_145]).unwrap(),
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink(&victim, &path).unwrap();
            }
            "hardlink" => {
                fs::remove_file(&path).unwrap();
                fs::hard_link(&victim, &path).unwrap();
            }
            "principal" | "omitted-binding" => {
                let mut d: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                if damage == "principal" {
                    d["principal_ref"] = json!("mallory");
                } else {
                    d["bindings"] = json!([]);
                }
                private(&path, &d);
            }
            _ => unreachable!(),
        }
        let observed = f.observe();
        assert_ne!(
            observed.binding_set_availability,
            ObservationAvailability::Available,
            "{damage}"
        );
        assert!(!observed.resources_complete, "{damage}");
        assert!(observed.resources.is_empty(), "{damage}");
        assert_eq!(fs::read(f.owner_path()).unwrap(), before);
        assert!(
            !serde_json::to_string(&observed)
                .unwrap()
                .contains("private-credential")
        );
    }
}

#[test]
fn next_actions_never_suggest_resend_or_finalization_without_completion_proof() {
    let f = Fixture::new();
    let call = |snapshot: &ExecutionSnapshot, context| {
        process_diagnostics::observe(
            &f.store,
            snapshot,
            &f.config,
            &PrincipalId("alice".into()),
            &[],
            context,
            process::unix_millis().unwrap(),
        )
        .next_action
    };
    let mut snapshot = f.snapshot();
    assert_eq!(call(&snapshot, context("armed")), NextAction::EndTurn);
    let mut wait = context("armed");
    wait.hold_active = Some(true);
    assert_eq!(call(&snapshot, wait), NextAction::StopHold);
    assert_eq!(
        call(&snapshot, context("paused")),
        NextAction::ExplicitResumeOrDelete
    );
    assert_eq!(
        call(&snapshot, context("cancelled")),
        NextAction::ReconcileOriginal
    );
    snapshot.record.state = ExecutionState::Unknown;
    snapshot.observation = ExecutionObservation::Unknown;
    snapshot.record.receipt = Some(f.receipt(false));
    snapshot.record.finalization_pending = true;
    assert_eq!(
        call(&snapshot, context("cancelled")),
        NextAction::NoResendUnknown
    );
    snapshot.record.state = ExecutionState::Finished;
    snapshot.observation = ExecutionObservation::Terminal;
    snapshot.record.receipt = Some(f.receipt(true));
    assert_eq!(
        call(&snapshot, context("cancelled")),
        NextAction::FinalizeClaim
    );
    snapshot.record.finalization_pending = false;
    assert_eq!(call(&snapshot, context("cancelled")), NextAction::None);
    assert_eq!(
        call(&snapshot, context("confirmed")),
        NextAction::InspectReceipt
    );
    let mut wait = context("armed");
    wait.intent_state = Ok(Some("unknown"));
    assert_eq!(call(&snapshot, wait), NextAction::NoResendUnknown);
    wait.intent_state = Err(());
    assert_eq!(call(&snapshot, wait), NextAction::NoResendUnknown);
    wait.intent_state = Ok(Some("dispatching"));
    assert_eq!(call(&snapshot, wait), NextAction::ReconcileOriginal);
    wait.intent_state = Ok(None);
    wait.native_idle_blocked = Some(true);
    assert_eq!(call(&snapshot, wait), NextAction::WaitNativeIdle);
}

#[test]
fn list_gauges_are_bounded_to_returned_snapshots_and_do_not_invent_lifetime_totals() {
    let f = Fixture::new();
    f.hooks().tick(&f.record).unwrap();
    let entry =
        json!({"diagnostics": f.observe(),"wait":{"phase":"armed"},"execution":f.snapshot()});
    let items = vec![entry; process_diagnostics::MAX_DIAGNOSTIC_SAMPLES + 1];
    let gauges = process_diagnostics::list_gauges(&items, true);
    assert_eq!(gauges.sampled, 256);
    assert_eq!(gauges.recorded_renewal_attempts, Some(256));
    assert_eq!(gauges.lifetime_renewal_attempts, None);
    assert_eq!(gauges.lifetime_delivery_admitted, None);
    assert_eq!(gauges.lifetime_delivery_deduplicated, None);
    assert_eq!(gauges.waits_pending, 256);
    assert!(gauges.oldest_pending_created_at_unix_ms.is_some());
    assert!(!gauges.oldest_pending_complete);
    assert!(gauges.truncated);
    assert!(!gauges.complete);
    assert!(!process_diagnostics::list_gauges(&items[..1], false).complete);
    let single = process_diagnostics::list_gauges(&items[..1], true);
    assert!(single.oldest_pending_complete);
    let missing =
        process_diagnostics::list_gauges(&[json!({"rule_ref":"legacy-without-diagnostics"})], true);
    assert_eq!(missing.unavailable, 1);
    assert_eq!(missing.recorded_renewal_attempts, None);
    assert!(!missing.complete);
}
