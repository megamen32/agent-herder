#![cfg(target_os = "linux")]

use herder::{
    application::process_bindings::{BindingHooks, Delegation, add_delegation, write_delegation},
    domain::{address::{Authorization, NodeRef, SessionRef}, resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope}},
    mcp::catalog::{ProcessLeaseBinding, ProcessLeaseExit},
    ownership::{claim::{self, ClaimOutcome, OwnerRecord}, manifest::{AuthorityRoute, StorageAuthority, StorageId, StorageMarker}, resource},
    process::{self, CompletionReason, CompletionReceipt, ExecutionHooks, ExecutionRecord, ExecutionState, ExecutionStore, StartRequest, WorkerBackend},
};
use std::{fs::{self, File, OpenOptions}, io, os::unix::fs::OpenOptionsExt, path::{Path, PathBuf},
    sync::mpsc, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

const FIRST: &str = "01234567-89ab-4cde-8fab-0123456789ab";
const SECOND: &str = "fedcba98-7654-4321-8abc-fedcba987654";

struct Fixture {
    root: PathBuf,
    authority: StorageAuthority,
    store: ExecutionStore,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("herder-binding-test-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let resources = root.join("resource-authority");
        fs::create_dir_all(&resources).unwrap();
        let authority = StorageAuthority { storage_id: StorageId("fixture-authority".into()),
            authority_node: NodeRef("fixture-node".into()), root: resources, schema: "v1".into(), route: AuthorityRoute::Local };
        fs::write(authority.root.join("storage.json"), serde_json::to_vec(&StorageMarker {
            schema: "v1".into(), storage_id: authority.storage_id.clone() }).unwrap()).unwrap();
        let store = ExecutionStore::open(root.join("executions"), "fixture-node").unwrap();
        Self { root, authority, store }
    }

    fn resource(&self, name: &str, nonce: &str, ttl: u64) -> ProcessLeaseBinding {
        let resource_ref = ResourceRef(name.into());
        resource::register_or_update(&self.authority, ResourceDescriptor::new(resource_ref.clone(),
            ResourceScope::Global, ResourceKind::Other("fixture-build-slot".into()), format!("fixture:{name}"),
            self.authority.storage_id.0.clone(), None, 0), Authorization::Authorized, None).unwrap();
        let now = claim::now_seconds().unwrap();
        claim::claim(&self.authority, &resource_ref, Authorization::Authorized, ResourceClaim {
            resource_ref: resource_ref.clone(), principal_ref: "alice".into(), session_ref: Some(SessionRef("session-a".into())),
            claim_id: nonce.into(), purpose: "process binding fixture".into(), acquired_at: format!("unix-seconds:{now}"),
            expires_at: Some(format!("unix-seconds:{}", now + ttl)) }).unwrap();
        ProcessLeaseBinding { resource_ref, claim_id: nonce.into(), revision: 1, ttl_seconds: 10,
            on_exit: ProcessLeaseExit::Release, handback_seconds: None }
    }

    fn prepare(&self, key: &str, argv: Vec<String>) -> ExecutionRecord {
        self.store.prepare_start(StartRequest { principal_ref: "alice".into(), session_ref: "session-a".into(),
            request_key: key.into(), argv, cwd: self.root.clone(), deadline_unix_ms: Some(process::unix_millis().unwrap()+20_000),
            stop_grace_ms: 200 }).unwrap()
    }

    fn delegate(&self, record: &ExecutionRecord, bindings: Vec<ProcessLeaseBinding>) -> BindingHooks {
        write_delegation(&self.store, &record.execution_ref, "alice", &self.authority, bindings).unwrap();
        BindingHooks::new(&self.store, &record.execution_ref, "alice").unwrap()
    }

    fn current(&self, binding: &ProcessLeaseBinding) -> Option<ResourceClaim> {
        claim::read_current(&self.authority, &binding.resource_ref, Authorization::Authorized).unwrap()
    }

    fn expire(&self, binding: &ProcessLeaseBinding) {
        let path = self.authority.root.join("resources").join(&binding.resource_ref.0).join("owner.json");
        let mut owner: OwnerRecord = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        owner.claim.expires_at = Some("unix-seconds:0".into());
        fs::write(path, serde_json::to_vec(&owner).unwrap()).unwrap();
    }

    fn receipt(&self, record: &ExecutionRecord, complete: bool) -> CompletionReceipt {
        let dir = self.store.execution_directory(&record.execution_ref).unwrap();
        CompletionReceipt { execution_ref: record.execution_ref.clone(), node_ref: record.node_ref.clone(),
            reason: if complete {CompletionReason::Exited} else {CompletionReason::ObservationLost},
            started_at_unix_ms: record.started_at_unix_ms, finished_at_unix_ms: process::unix_millis().unwrap(),
            exit_code: complete.then_some(0), signal: None, descendant_failure: false,
            tree_complete: complete, process_may_be_running: !complete, evidence_source: "fixture-durable-receipt".into(),
            stdout_path: dir.join("stdout.log"), stderr_path: dir.join("stderr.log"), detail: None }
    }

    fn persist_terminal(&self, record: &mut ExecutionRecord, receipt: &CompletionReceipt) {
        let dir = self.store.execution_directory(&record.execution_ref).unwrap();
        write_private(&dir.join("receipt.json"), receipt);
        record.state = if receipt.tree_complete { ExecutionState::Finished } else { ExecutionState::Unknown };
        record.receipt = Some(receipt.clone());
        record.finalization_pending = true;
        write_private(&dir.join("record.json"), record);
    }

    /// A controlled live-status fixture, with the real test process identity
    /// and lock. It executes no child command and is used only for admission races.
    fn simulate_live(&self, record: &mut ExecutionRecord) -> File {
        let dir = self.store.execution_directory(&record.execution_ref).unwrap();
        let worker_lock = OpenOptions::new().read(true).write(true).create(true).mode(0o600).open(dir.join("worker.lock")).unwrap();
        worker_lock.lock().unwrap();
        let identity = process::capture_process(std::process::id(), self.store.node_ref()).unwrap();
        record.worker = Some(identity.clone());
        record.process = Some(identity);
        record.state = ExecutionState::Running;
        record.started_at_unix_ms = Some(process::unix_millis().unwrap());
        record.heartbeat_at_unix_ms = record.started_at_unix_ms;
        write_private(&dir.join("record.json"), record);
        assert!(self.store.status(&record.execution_ref).unwrap().confirmed_live);
        worker_lock
    }

    fn launch(&self, record: &ExecutionRecord) {
        self.store.launch_prepared_with_backend(&record.execution_ref,
            Path::new(env!("CARGO_BIN_EXE_herder_process_worker")), WorkerBackend::Direct).unwrap();
    }

    fn terminal(&self, execution_ref: &str) -> ExecutionRecord {
        let deadline = Instant::now()+Duration::from_secs(15);
        loop {
            let snapshot = self.store.status(execution_ref).unwrap();
            if snapshot.record.receipt.is_some() && !snapshot.record.finalization_pending {return snapshot.record;}
            assert!(Instant::now()<deadline, "worker did not finalize: {snapshot:?}");
            thread::sleep(Duration::from_millis(40));
        }
    }
}

impl Drop for Fixture { fn drop(&mut self) {let _=fs::remove_dir_all(&self.root);} }

fn write_private<T: serde::Serialize>(path: &Path, value: &T) {
    use std::io::Write;
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).unwrap();
    file.write_all(&serde_json::to_vec(value).unwrap()).unwrap();
    file.sync_all().unwrap();
}

#[test]
fn real_worker_renews_past_initial_deadline_then_releases_after_tree_receipt() {
    let f = Fixture::new();
    let binding = f.resource("long-build", FIRST, 3);
    let initial_expiry = claim::parse_expiry_seconds(f.current(&binding).unwrap().expires_at.as_deref().unwrap()).unwrap();
    let record = f.prepare("long-build", vec!["/bin/sleep".into(), "5".into()]);
    f.delegate(&record, vec![binding.clone()]);
    f.launch(&record);
    let deadline = Instant::now()+Duration::from_secs(8);
    loop {
        let snapshot = f.store.status(&record.execution_ref).unwrap();
        if claim::now_seconds().unwrap() >= initial_expiry && snapshot.confirmed_live {
            let current = claim::read_live_by_claim_id(&f.authority, &binding.resource_ref, Authorization::Authorized, FIRST).unwrap().unwrap();
            assert_eq!(current.principal_ref, "alice");
            assert!(claim::parse_expiry_seconds(current.expires_at.as_deref().unwrap()).unwrap()>initial_expiry);
            break;
        }
        assert!(snapshot.record.receipt.is_none(), "execution ended before renewal was observed: {snapshot:?}");
        assert!(Instant::now()<deadline, "worker never remained live past initial TTL");
        thread::sleep(Duration::from_millis(40));
    }
    let terminal = f.terminal(&record.execution_ref);
    assert!(terminal.receipt.unwrap().succeeded());
    assert!(f.current(&binding).is_none());
    assert!(claim::read_execution_binding(&f.authority, &binding.resource_ref, Authorization::Authorized).unwrap().unwrap().resolved_receipt.is_some());
}

#[test]
fn terminal_handback_is_bounded_by_receipt_and_never_resurrects_an_expired_generation() {
    let f = Fixture::new();
    let mut binding = f.resource("handback", FIRST, 60);
    binding.on_exit = ProcessLeaseExit::Handback;
    binding.handback_seconds = Some(30);
    let mut record = f.prepare("handback", vec!["/bin/true".into()]);
    let mut hooks = f.delegate(&record, vec![binding.clone()]);
    hooks.before_spawn(&record).unwrap();
    let original = f.current(&binding).unwrap();
    let mut receipt = f.receipt(&record, true);
    receipt.finished_at_unix_ms -= 3_000;
    f.persist_terminal(&mut record, &receipt);
    hooks.terminal(&record, &receipt).unwrap();
    let handback = f.current(&binding).unwrap();
    assert_eq!(handback.claim_id, original.claim_id);
    assert_eq!(handback.principal_ref, original.principal_ref);
    assert_eq!(handback.session_ref, original.session_ref);
    assert_eq!(handback.expires_at, Some(format!("unix-seconds:{}", receipt.finished_at_unix_ms/1000+30)));
    let mut retry = BindingHooks::new(&f.store, &record.execution_ref, "alice").unwrap();
    retry.terminal(&record, &receipt).unwrap();
    assert_eq!(f.current(&binding).unwrap(), handback, "receipt retry moved the handback deadline");
    f.expire(&binding);
    retry.terminal(&record, &receipt).unwrap();
    assert_eq!(f.current(&binding).unwrap().expires_at.as_deref(), Some("unix-seconds:0"));
    assert_eq!(claim::read_live_by_claim_id(&f.authority, &binding.resource_ref, Authorization::Authorized, FIRST).unwrap_err().kind(), io::ErrorKind::TimedOut);
}

#[test]
fn unknown_or_wrong_execution_receipts_cannot_release_occupancy() {
    let f = Fixture::new();
    let binding = f.resource("unknown", FIRST, 60);
    let record = f.prepare("unknown", vec!["/bin/true".into()]);
    let mut hooks = f.delegate(&record, vec![binding.clone()]);
    hooks.before_spawn(&record).unwrap();
    hooks.terminal(&record, &f.receipt(&record, false)).unwrap();
    let mut wrong = f.receipt(&record, true);
    wrong.execution_ref = "unrelated-execution".into();
    assert!(hooks.terminal(&record, &wrong).is_err());
    assert!(f.current(&binding).is_some());
    assert!(claim::read_execution_binding(&f.authority, &binding.resource_ref, Authorization::Authorized).unwrap().unwrap().resolved_receipt.is_none());
    f.expire(&binding);
    let mut next = f.current(&binding).unwrap();
    next.claim_id = SECOND.into();
    next.expires_at = Some("2099-01-01T00:00:00Z".into());
    assert_eq!(claim::claim(&f.authority, &binding.resource_ref, Authorization::Authorized, next).unwrap(), ClaimOutcome::Busy);
}

#[test]
fn partial_pre_spawn_lease_failure_cleans_up_without_starting_command() {
    let f = Fixture::new();
    let first = f.resource("first", FIRST, 60);
    let second = f.resource("second", SECOND, 60);
    let marker = f.root.join("command-started");
    let record = f.prepare("pre-spawn-failure", vec!["/usr/bin/touch".into(), marker.to_string_lossy().into_owned()]);
    f.delegate(&record, vec![first.clone(), second.clone()]);
    f.expire(&second);
    f.launch(&record);
    let terminal = f.terminal(&record.execution_ref);
    let receipt = terminal.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::LeaseLost);
    assert!(receipt.tree_complete);
    assert!(!marker.exists());
    assert!(terminal.started_at_unix_ms.is_none());
    assert!(f.current(&first).is_none());
    assert!(f.current(&second).is_none());
    assert!(claim::read_execution_binding(&f.authority, &first.resource_ref, Authorization::Authorized).unwrap().unwrap().resolved_receipt.is_some());
}

#[test]
fn enrollment_persists_intent_before_occupancy_failure_and_retry_recovers_it() {
    let f = Fixture::new();
    let binding = f.resource("enrollment", FIRST, 60);
    let mut record = f.prepare("enrollment", vec!["/bin/true".into()]);
    let mut hooks = f.delegate(&record, vec![]);
    let _worker_lock = f.simulate_live(&mut record);
    let occupancy_path = f.authority.root.join("resources/enrollment/execution-binding.json");
    // An unreadable occupancy object is a deterministic fault after the durable
    // enrollment write. It must not leave the execution unaware of the intent.
    fs::create_dir(&occupancy_path).unwrap();
    assert!(add_delegation(&f.store, &record.execution_ref, "alice", binding.clone()).is_err());
    let path = f.store.execution_directory(&record.execution_ref).unwrap().join("bindings.json");
    let stored: Delegation = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(stored.bindings, vec![binding.clone()]);
    assert_eq!(f.current(&binding).unwrap().claim_id, FIRST);
    fs::remove_dir(occupancy_path).unwrap();
    hooks.tick(&record).unwrap();
    let occupancy = claim::read_execution_binding(&f.authority, &binding.resource_ref, Authorization::Authorized).unwrap().unwrap();
    assert_eq!(occupancy.execution_ref, record.execution_ref);
    assert!(occupancy.resolved_receipt.is_none());
    add_delegation(&f.store, &record.execution_ref, "alice", binding).unwrap();
}

#[test]
fn terminal_publication_while_enrollment_waits_cannot_create_late_occupancy() {
    let f = Fixture::new();
    let binding = f.resource("late-enrollment", FIRST, 60);
    let mut record = f.prepare("late-enrollment", vec!["/bin/true".into()]);
    f.delegate(&record, vec![]);
    let _worker_lock = f.simulate_live(&mut record);
    let dir = f.store.execution_directory(&record.execution_ref).unwrap();
    let gate = OpenOptions::new().read(true).write(true).open(dir.join("bindings.lock")).unwrap();
    gate.lock().unwrap();
    let store = f.store.clone();
    let execution = record.execution_ref.clone();
    let pending_binding = binding.clone();
    let (ready, received) = mpsc::channel();
    let enrollment = thread::spawn(move || {
        ready.send(()).unwrap();
        add_delegation(&store, &execution, "alice", pending_binding)
    });
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    let receipt = f.receipt(&record, true);
    f.persist_terminal(&mut record, &receipt);
    drop(gate);
    assert!(enrollment.join().unwrap().is_err());
    let stored: Delegation = serde_json::from_slice(&fs::read(dir.join("bindings.json")).unwrap()).unwrap();
    assert!(stored.bindings.is_empty());
    assert!(claim::read_execution_binding(&f.authority, &binding.resource_ref, Authorization::Authorized).unwrap().is_none());
    assert_eq!(f.current(&binding).unwrap().claim_id, FIRST);
}
