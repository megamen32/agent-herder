#![cfg(target_os = "linux")]
use herder::process::{
    AttachRequest, CompletionReason, ExecutionObservation, ExecutionRequest, ExecutionSnapshot,
    ExecutionState, ExecutionStore, ProcessObservation, StartRequest, WorkerBackend,
    capture_process, execution_ref_for, observe_process, unix_millis,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_herder_process_worker"))
}

struct Fixture {
    root: PathBuf,
    store: ExecutionStore,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-process-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = ExecutionStore::open(&root, "test-node").unwrap();
        Self { root, store }
    }
    fn request(&self, key: &str, script: &str) -> StartRequest {
        StartRequest {
            principal_ref: "alice".into(),
            session_ref: "session-on-test-node".into(),
            request_key: key.into(),
            argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
            cwd: self.root.clone(),
            deadline_unix_ms: None,
            stop_grace_ms: 200,
        }
    }
    fn start(&self, request: StartRequest) -> ExecutionSnapshot {
        let r = self.store.prepare_start(request).unwrap();
        self.store
            .launch_prepared_with_backend(&r.execution_ref, binary(), WorkerBackend::Direct)
            .unwrap()
    }
    fn until(
        &self,
        reference: &str,
        predicate: impl Fn(&ExecutionSnapshot) -> bool,
    ) -> ExecutionSnapshot {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let s = self.store.reconcile(reference).unwrap();
            if predicate(&s) {
                return s;
            }
            if Instant::now() >= deadline {
                let logs = fs::read_to_string(
                    self.store
                        .execution_directory(reference)
                        .unwrap()
                        .join("supervisor.log"),
                )
                .unwrap_or_default();
                panic!("execution did not reach expected state: {s:?}\n{logs}");
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.root) {
            let refs: Vec<String> = entries
                .filter_map(Result::ok)
                .filter_map(|v| v.file_name().into_string().ok())
                .filter(|v| v.starts_with("exec-"))
                .collect();
            for r in &refs {
                let _ = self.store.cancel(r);
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let alive = refs
                    .iter()
                    .filter_map(|r| self.store.status(r).ok())
                    .any(|s| {
                        s.record
                            .worker
                            .as_ref()
                            .is_some_and(|p| observe_process(p) == ProcessObservation::Alive)
                    });
                if !alive || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            for r in refs {
                if let Ok(s) = self.store.status(&r) {
                    if matches!(s.record.request, ExecutionRequest::Start(_)) {
                        if let Some(p) = &s.record.process {
                            if observe_process(p) == ProcessObservation::Alive
                                && unsafe { libc::getpgid(p.pid as i32) } == p.pid as i32
                            {
                                unsafe {
                                    libc::kill(-(p.pid as i32), libc::SIGKILL);
                                }
                            }
                        }
                    }
                    if let Some(p) = &s.record.worker {
                        if observe_process(p) == ProcessObservation::Alive {
                            unsafe {
                                libc::kill(p.pid as i32, libc::SIGKILL);
                            }
                        }
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn scoped_request_identity_and_changed_payload_conflict() {
    let f = Fixture::new();
    let request = f.request("same-key", "true");
    let first = f.store.prepare_start(request.clone()).unwrap();
    let repeated = f.store.prepare_start(request.clone()).unwrap();
    assert_eq!(first.execution_ref, repeated.execution_ref);
    assert_eq!(first.payload_hash, repeated.payload_hash);
    assert_ne!(
        execution_ref_for("alice", "session-a", "same-key"),
        execution_ref_for("alice", "session-b", "same-key")
    );
    let mut changed = request;
    changed.argv = vec!["/bin/false".into()];
    assert_eq!(
        f.store.prepare_start(changed).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(f.store.execution_directory("../escape").is_err());
    let restarted = ExecutionStore::from_existing_root(&f.root).unwrap();
    assert_eq!(
        restarted.status(&first.execution_ref).unwrap().record.state,
        ExecutionState::Prepared
    );
}
#[test]
fn immediate_registration_restart_and_concurrent_retries_run_one_command() {
    let f = Fixture::new();
    let mut request = f.request(
        "one-effect",
        "printf x >> effect; while test ! -f release; do sleep 0.02; done; printf done; exit 7",
    );
    request.deadline_unix_ms = Some(unix_millis().unwrap() + 10_000);
    // A causal barrier proves registration returned independently of completion;
    // filesystem scheduling latency must not turn this into a benchmark.
    let r = f.start(request.clone());
    assert!(
        r.record.receipt.is_none(),
        "registration waited for the command"
    );
    let reference = r.record.execution_ref;
    let store = Arc::new(ExecutionStore::from_existing_root(&f.root).unwrap());
    let threads: Vec<_> = (0..6)
        .map(|_| {
            let store = store.clone();
            let request = request.clone();
            thread::spawn(move || {
                let prepared = store.prepare_start(request).unwrap();
                store
                    .launch_prepared_with_backend(
                        &prepared.execution_ref,
                        binary(),
                        WorkerBackend::Direct,
                    )
                    .unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert!(store.status(&reference).unwrap().record.receipt.is_none());
    fs::write(f.root.join("release"), b"complete").unwrap();
    let finished = f.until(&reference, |s| s.record.receipt.is_some());
    let receipt = finished.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::Exited);
    assert_eq!(receipt.exit_code, Some(7));
    assert_eq!(receipt.signal, None);
    assert!(receipt.tree_complete);
    assert!(!receipt.succeeded());
    assert_eq!(fs::read_to_string(f.root.join("effect")).unwrap(), "x");
    assert_eq!(fs::read_to_string(receipt.stdout_path).unwrap(), "done");
}
#[test]
fn parent_exit_waits_for_background_and_setsid_descendants() {
    let f = Fixture::new();
    let r = f.start(f.request(
        "descendants",
        "setsid /bin/sh -c 'sleep 0.5; printf complete > descendant' & exit 0",
    ));
    let reference = r.record.execution_ref;
    let live = f.until(&reference, |s| s.confirmed_live);
    assert!(live.record.receipt.is_none());
    let finished = f.until(&reference, |s| s.record.receipt.is_some());
    assert_eq!(
        fs::read_to_string(f.root.join("descendant")).unwrap(),
        "complete"
    );
    assert!(finished.record.receipt.unwrap().succeeded());
}
#[test]
fn absolute_deadline_survives_reopen_and_stops_owned_tree() {
    let f = Fixture::new();
    let mut request = f.request("deadline", "trap '' TERM; sleep 10");
    let deadline = unix_millis().unwrap() + 350;
    request.deadline_unix_ms = Some(deadline);
    let r = f.start(request);
    let reference = r.record.execution_ref;
    let restarted = ExecutionStore::from_existing_root(&f.root).unwrap();
    assert_eq!(
        restarted
            .status(&reference)
            .unwrap()
            .record
            .request
            .deadline(),
        Some(deadline)
    );
    let finished = f.until(&reference, |s| s.record.receipt.is_some());
    let receipt = finished.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::TimedOut);
    assert!(receipt.tree_complete);
    assert!(!receipt.process_may_be_running);
    assert!(receipt.finished_at_unix_ms < deadline + 3000);
}
#[test]
fn cancellation_before_launch_has_no_command_effect() {
    let f = Fixture::new();
    let prepared = f
        .store
        .prepare_start(f.request("cancel", "printf unexpected > effect"))
        .unwrap();
    f.store.cancel(&prepared.execution_ref).unwrap();
    f.store
        .launch_prepared_with_backend(&prepared.execution_ref, binary(), WorkerBackend::Direct)
        .unwrap();
    let r = f.until(&prepared.execution_ref, |s| s.record.receipt.is_some());
    let receipt = r.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::Cancelled);
    assert!(receipt.tree_complete);
    assert_eq!(receipt.exit_code, None);
    assert!(!f.root.join("effect").exists());
}
#[test]
fn failed_exec_is_a_known_failure_without_invented_exit_code() {
    let f = Fixture::new();
    let mut request = f.request("bad-executable", "true");
    request.argv = vec!["/nonexistent/herder-fixture-command".into()];
    let r = f.start(request);
    let r = f.until(&r.record.execution_ref, |s| s.record.receipt.is_some());
    let receipt = r.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::LaunchFailed);
    assert_eq!(receipt.exit_code, None);
    assert!(receipt.tree_complete);
    assert!(!receipt.succeeded());
}
#[test]
fn attach_observes_exact_birth_and_never_claims_success_on_disappearance() {
    let f = Fixture::new();
    let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
    let identity = capture_process(child.id(), "test-node").unwrap();
    let mut wrong_birth = identity.clone();
    wrong_birth.start_ticks += 1;
    assert_eq!(observe_process(&wrong_birth), ProcessObservation::Gone);
    let attached = f
        .store
        .prepare_attach(AttachRequest {
            principal_ref: "alice".into(),
            session_ref: "session-on-test-node".into(),
            request_key: "attach".into(),
            process: identity.clone(),
            deadline_unix_ms: Some(unix_millis().unwrap() + 7000),
        })
        .unwrap();
    f.store
        .launch_prepared_with_backend(&attached.execution_ref, binary(), WorkerBackend::Direct)
        .unwrap();
    f.until(&attached.execution_ref, |s| s.confirmed_live);
    assert_eq!(
        f.store.cancel(&attached.execution_ref).unwrap_err().kind(),
        io::ErrorKind::Unsupported
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let done = f.until(&attached.execution_ref, |s| s.record.receipt.is_some());
    let receipt = done.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::ObservationLost);
    assert_eq!(receipt.exit_code, None);
    assert!(!receipt.tree_complete);
    assert!(
        receipt.process_may_be_running,
        "descendants of an attached process remain unproven"
    );
}
#[test]
fn lost_direct_supervisor_never_replays_or_guesses_tree_empty() {
    let f = Fixture::new();
    let request = f.request("worker-crash", "printf x >> effect; sleep 2");
    let r = f.start(request.clone());
    let reference = r.record.execution_ref;
    let live = f.until(&reference, |s| s.confirmed_live);
    let worker = live.record.worker.unwrap();
    assert_eq!(observe_process(&worker), ProcessObservation::Alive);
    unsafe {
        assert_eq!(libc::kill(worker.pid as i32, libc::SIGKILL), 0);
    }
    let gone = f.until(&reference, |s| {
        s.observation == ExecutionObservation::Unknown && !s.worker_lock_held
    });
    assert_eq!(gone.record.state, ExecutionState::Unknown);
    assert!(gone.record.receipt.is_none());
    let repeated = f.store.prepare_start(request).unwrap();
    let snapshot = f
        .store
        .launch_prepared_with_backend(&repeated.execution_ref, binary(), WorkerBackend::Direct)
        .unwrap();
    assert_eq!(snapshot.record.state, ExecutionState::Unknown);
    assert_eq!(fs::read_to_string(f.root.join("effect")).unwrap(), "x");
}
#[test]
fn receipt_written_before_record_is_recovered_without_reexecution() {
    let f = Fixture::new();
    let r = f.start(f.request("receipt-boundary", "printf x >> effect"));
    let finished = f.until(&r.record.execution_ref, |s| {
        s.record.receipt.is_some() && !s.record.finalization_pending
    });
    // Simulate an older record surviving while the atomically written receipt survived.
    let mut raw = finished.record;
    raw.receipt = None;
    raw.state = ExecutionState::Running;
    raw.finalization_pending = false;
    let path = f
        .store
        .execution_directory(&raw.execution_ref)
        .unwrap()
        .join("record.json");
    fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    let read = ExecutionStore::from_existing_root(&f.root)
        .unwrap()
        .status(&raw.execution_ref)
        .unwrap();
    let receipt = read.record.receipt.unwrap();
    assert!(receipt.succeeded());
    assert!(read.record.finalization_pending);
    let mut wrong_receipt = receipt.clone();
    wrong_receipt.finished_at_unix_ms += 1;
    assert!(
        f.store
            .acknowledge_finalization(&raw.execution_ref, &wrong_receipt)
            .is_err()
    );
    assert!(
        f.store
            .status(&raw.execution_ref)
            .unwrap()
            .record
            .finalization_pending
    );
    f.store
        .acknowledge_finalization(&raw.execution_ref, &receipt)
        .unwrap();
    assert!(
        !f.store
            .status(&raw.execution_ref)
            .unwrap()
            .record
            .finalization_pending
    );
    assert_eq!(fs::read_to_string(f.root.join("effect")).unwrap(), "x");
}
#[test]
fn systemd_cgroup_proves_empty_after_worker_crash_with_unknown_exit() {
    let bus = PathBuf::from(format!("/run/user/{}/bus", unsafe { libc::geteuid() }));
    if !bus.exists() || !Path::new("/usr/bin/systemd-run").is_file() {
        eprintln!("SKIP systemd cgroup acceptance: no owned user manager on this host");
        return;
    }
    let f = Fixture::new();
    let prepared = f
        .store
        .prepare_start(f.request("cgroup-crash", "printf x >> effect; sleep 20"))
        .unwrap();
    f.store
        .launch_prepared_with_backend(
            &prepared.execution_ref,
            binary(),
            WorkerBackend::SystemdUser,
        )
        .unwrap();
    let live = f.until(&prepared.execution_ref, |s| {
        s.confirmed_live && s.record.tree_scope.is_some()
    });
    let worker = live.record.worker.unwrap();
    unsafe {
        assert_eq!(libc::kill(worker.pid as i32, libc::SIGKILL), 0);
    }
    let ended = f.until(&prepared.execution_ref, |s| s.record.receipt.is_some());
    let receipt = ended.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::ObservationLost);
    assert_eq!(receipt.exit_code, None);
    assert!(receipt.tree_complete);
    assert!(!receipt.process_may_be_running);
    assert_eq!(receipt.evidence_source, "owned_cgroup_empty");
    assert_eq!(fs::read_to_string(f.root.join("effect")).unwrap(), "x");
}

#[test]
fn adopted_descendant_failure_is_preserved_after_successful_parent_exit() {
    let f = Fixture::new();
    let r = f.start(f.request(
        "descendant-failure",
        "setsid /bin/sh -c 'sleep 0.15; exit 9' >/dev/null 2>&1 & exit 0",
    ));
    let terminal = f.until(&r.record.execution_ref, |s| s.record.receipt.is_some());
    let receipt = terminal.record.receipt.unwrap();
    assert_eq!(receipt.exit_code, Some(0));
    assert_eq!(receipt.reason, CompletionReason::Exited);
    assert!(receipt.tree_complete);
    assert!(receipt.descendant_failure);
    assert!(!receipt.succeeded());
}

#[test]
fn live_cancellation_stops_owned_setsid_descendants_before_receipt() {
    let f = Fixture::new();
    let r = f.start(f.request(
        "cancel-live",
        r#"trap '' TERM; setsid /bin/sh -c 'trap "" TERM; sleep 10' & wait"#,
    ));
    let live = f.until(&r.record.execution_ref, |s| s.confirmed_live);
    let members = live.record.observed_members.clone();
    f.store.cancel(&r.record.execution_ref).unwrap();
    let terminal = f.until(&r.record.execution_ref, |s| s.record.receipt.is_some());
    let receipt = terminal.record.receipt.unwrap();
    assert_eq!(receipt.reason, CompletionReason::Cancelled);
    assert!(receipt.tree_complete);
    assert!(!receipt.process_may_be_running);
    for member in members {
        assert_eq!(observe_process(&member), ProcessObservation::Gone);
    }
}
