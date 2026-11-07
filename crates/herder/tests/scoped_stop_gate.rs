#![cfg(target_os = "linux")]
use herder::{
    application::{
        reconcile::{DurableDispatch, ReceiptBinding, dispatch_payload_binding},
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, GateError, ScopeGenerationIssuer,
            ScopedAuthority, StopDisposition,
        },
        target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
        target_gate::acquire_pinned,
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::{
        adapter::{Admission, DispatchPlan, NativeReceipt, RequestKey, SendMode, SubmitError},
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    store::{Writer, intents::NewIntent},
};
use rusqlite::{Connection, functions::FunctionFlags};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-scoped-gate-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let db = root.join("state.db");
        let gate = root.join("gate");
        drop(Writer::create_file(&db).unwrap());
        let mut c = Connection::open(&db).unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        c.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(1),
        )
        .unwrap();
        let t = c.transaction().unwrap();
        t.execute_batch(include_str!("../src/store/migration_v1_v2.sql"))
            .unwrap();
        t.commit().unwrap();
        let t = c.transaction().unwrap();
        t.execute_batch(include_str!("../src/store/migration_v2_v3.sql"))
            .unwrap();
        t.commit().unwrap();
        drop(c);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate)
            .unwrap();
        let meta = file.metadata().unwrap();
        let guard = acquire_pinned(&gate, meta.dev(), meta.ino()).unwrap();
        let mut writer = Writer::open_file(&db).unwrap();
        assert!(
            writer
                .initialize_fresh_stop_authority(&guard, "authority-1", "now")
                .unwrap()
        );
        drop(writer);
        drop(guard);
        drop(file);
        Self { root, db, gate }
    }
    fn authority(&self) -> ScopedAuthority {
        ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into()).unwrap()
    }
    fn prepare(&self, id: &str, key: &str, plan: &DispatchPlan) {
        let mut w = Writer::open_file(&self.db).unwrap();
        w.prepare_intent(&NewIntent {
            intent_id: id,
            task_id: &format!("task-{id}"),
            principal: "alice",
            target: "issued",
            request_key: key,
            payload_hash: &dispatch_payload_binding(plan, "message"),
            now: "now",
            retain_until: "later",
        })
        .unwrap();
    }
}
fn address() -> SessionAddress {
    SessionAddress {
        instance: InstanceRef {
            node: NodeRef("node".into()),
            instance_id: "isolated".into(),
        },
        native_session_id: "native-root".into(),
    }
}
fn identity() -> ConnectionIdentity {
    ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("alice".into()),
        }),
        None,
    )
}
fn grants() -> Vec<Grant> {
    let p = PrincipalId("alice".into());
    let instance = serde_json::to_string(&address().instance).unwrap();
    vec![
        Grant {
            principal: p.clone(),
            resource: PrivateResource::Session(SessionRef("issued".into())),
            action: Action::Write,
        },
        Grant {
            principal: p.clone(),
            resource: PrivateResource::Resource("humanstop:global".into()),
            action: Action::Write,
        },
        Grant {
            principal: p,
            resource: PrivateResource::Resource(format!("instance:{instance}")),
            action: Action::Write,
        },
    ]
}
struct Issuer;
impl SessionRefIssuer for Issuer {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
        Ok(SessionRef("issued".into()))
    }
}
struct Generation;
impl ScopeGenerationIssuer for Generation {
    fn issue(&self) -> Result<String, ()> {
        Ok("scope-1".into())
    }
}
struct Creator(InstanceRef);

struct RefusesBeforeWrite(InstanceRef, AtomicUsize);
impl BoundedFreshRootCreate for RefusesBeforeWrite {
    fn instance(&self) -> &InstanceRef {
        &self.0
    }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
        self.1.fetch_add(1, Ordering::SeqCst);
        Err(SubmitError::DefinitelyNotSent {
            reason: "fixture before write".into(),
        })
    }
}

#[test]
fn create_refused_before_write_is_durable_rejected() {
    let f = Fixture::new();
    let target = address();
    let control = RefusesBeforeWrite(target.instance, AtomicUsize::new(0));
    let outcome = f
        .authority()
        .create_fresh_root(
            &identity(),
            &grants(),
            &control,
            &Issuer,
            &Generation,
            CreateRequest {
                intent_id: "rejected-create",
                task_id: "rejected-task",
                request_key: "rejected-key",
                specification: "isolated",
                now: "now",
                retain_until: "later",
            },
        )
        .unwrap();
    let db = Connection::open(&f.db).unwrap();
    let state: String = db
        .query_row(
            "SELECT state FROM intents WHERE intent_id='rejected-create'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "rejected", "create result: {outcome:?}");
    assert_eq!(outcome, CreateResult::DefinitelyNotSent);
    let diagnostic: String = db
        .query_row(
            "SELECT result_json FROM tasks WHERE task_id='rejected-task'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(diagnostic.contains("fixture before write"));
    drop(db);
    let same = f
        .authority()
        .create_fresh_root(
            &identity(),
            &grants(),
            &control,
            &Issuer,
            &Generation,
            CreateRequest {
                intent_id: "rejected-create",
                task_id: "rejected-task",
                request_key: "rejected-key",
                specification: "isolated",
                now: "now",
                retain_until: "later",
            },
        )
        .unwrap();
    assert_eq!(same, CreateResult::Existing);
    assert_eq!(control.1.load(Ordering::SeqCst), 1);
    let next = f
        .authority()
        .create_fresh_root(
            &identity(),
            &grants(),
            &control,
            &Issuer,
            &Generation,
            CreateRequest {
                intent_id: "new-create",
                task_id: "new-task",
                request_key: "new-key",
                specification: "isolated",
                now: "now",
                retain_until: "later",
            },
        )
        .unwrap();
    assert_eq!(next, CreateResult::DefinitelyNotSent);
    assert_eq!(control.1.load(Ordering::SeqCst), 2);
}
impl BoundedFreshRootCreate for Creator {
    fn instance(&self) -> &InstanceRef {
        &self.0
    }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
        Ok(address())
    }
}
fn create(f: &Fixture) {
    let a = address();
    assert_eq!(
        f.authority()
            .create_fresh_root(
                &identity(),
                &grants(),
                &Creator(a.instance),
                &Issuer,
                &Generation,
                CreateRequest {
                    intent_id: "create",
                    task_id: "create-task",
                    request_key: "create-key",
                    specification: "isolated",
                    now: "now",
                    retain_until: "later"
                }
            )
            .unwrap(),
        CreateResult::Created(SessionRef("issued".into()))
    );
}
fn plan() -> DispatchPlan {
    DispatchPlan {
        target: address(),
        mode: SendMode::Start,
        expected_turn: None,
    }
}
struct Control {
    calls: Arc<AtomicUsize>,
    db: PathBuf,
    ready: Option<mpsc::SyncSender<()>>,
    proceed: Option<std::sync::Mutex<mpsc::Receiver<()>>>,
}
impl BoundedNativeHandoff for Control {
    fn submit_bounded(
        &self,
        p: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        assert_eq!(p.target, address());
        assert_eq!(message, "message");
        assert_eq!(key.0, "k");
        self.calls.fetch_add(1, Ordering::SeqCst);
        // This would fail if a transaction remained open over the network wait.
        let c = Connection::open(&self.db).unwrap();
        c.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
        if let Some(tx) = &self.ready {
            tx.send(()).unwrap();
            self.proceed
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .recv()
                .unwrap();
        }
        Ok(Admission {
            receipt: NativeReceipt {
                target: p.target,
                native_id: "turn-1".into(),
            },
        })
    }
}
fn binding<'a>(a: &'a SessionAddress, id: &'a str, key: &'a str) -> ReceiptBinding<'a> {
    ReceiptBinding {
        intent_id: id,
        principal: "alice",
        target_ref: "issued",
        request_key: key,
        address: a,
    }
}
#[test]
fn stop_before_claim_and_between_claim_handoff_never_submits() {
    for before in [true, false] {
        let f = Fixture::new();
        create(&f);
        let a = address();
        let p = plan();
        f.prepare("i", "k", &p);
        let b = binding(&a, "i", "k");
        let control = Control {
            calls: Arc::new(AtomicUsize::new(0)),
            db: f.db.clone(),
            ready: None,
            proceed: None,
        };
        if before {
            assert_eq!(
                f.authority()
                    .stop(&identity(), &grants(), "session:issued", "manual", "t")
                    .unwrap(),
                StopDisposition::HeldBeforeHandoff
            );
        }
        let claimed = f
            .authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap();
        if before {
            assert!(!claimed);
        } else {
            assert!(claimed);
            assert_eq!(
                f.authority()
                    .stop(&identity(), &grants(), "session:issued", "manual", "t")
                    .unwrap(),
                StopDisposition::InterruptOrReconcileRequired
            );
            assert_eq!(
                f.authority()
                    .handoff(
                        &identity(),
                        &grants(),
                        &b,
                        "scope-1",
                        p,
                        "message",
                        "t",
                        &control
                    )
                    .unwrap(),
                DurableDispatch::StoppedBeforeHandoff
            );
            let db = Connection::open(&f.db).unwrap();
            let (state, result): (String, String) = db.query_row("SELECT i.state,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.intent_id='i'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(state, "rejected");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&result).unwrap()["native_submit"],
                "definitely_not_sent"
            );
        }
        assert_eq!(control.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn handoff_gate_blocks_stop_then_receipt_requires_interrupt_and_no_replay() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap()
    );
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let calls = Arc::new(AtomicUsize::new(0));
    let db = f.db.clone();
    let gate = f.gate.clone();
    let calls2 = calls.clone();
    let child = std::thread::spawn(move || {
        let a = address();
        let b = binding(&a, "i", "k");
        let control = Control {
            calls: calls2,
            db: db.clone(),
            ready: Some(ready_tx),
            proceed: Some(std::sync::Mutex::new(go_rx)),
        };
        ScopedAuthority::new(db, gate, "authority-1".into())
            .unwrap()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                plan(),
                "message",
                "t",
                &control,
            )
            .unwrap()
    });
    ready_rx.recv().unwrap();
    let stop_authority = f.authority();
    let stopper = std::thread::spawn(move || {
        stop_authority.stop(&identity(), &grants(), "session:issued", "manual", "t")
    });
    go_tx.send(()).unwrap();
    assert!(matches!(
        child.join().unwrap(),
        DurableDispatch::Admitted(_)
    ));
    assert_eq!(
        stopper.join().unwrap().unwrap(),
        StopDisposition::InterruptOrReconcileRequired
    );
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                plan(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn scoped_stop_child() {
    use std::io::Write;
    let Some(db) = std::env::var_os("HERDER_SCOPED_TEST_DB") else {
        return;
    };
    let gate = std::path::PathBuf::from(std::env::var_os("HERDER_SCOPED_TEST_GATE").unwrap());
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(&gate).unwrap();
    assert_eq!(
        acquire_pinned(&gate, meta.dev(), meta.ino())
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    let authority = ScopedAuthority::new(db.into(), gate, "authority-1".into()).unwrap();
    println!("CHILD_BUSY");
    std::io::stdout().flush().unwrap();
    assert_eq!(
        authority
            .stop(&identity(), &grants(), "session:issued", "manual", "t")
            .unwrap(),
        StopDisposition::InterruptOrReconcileRequired
    );
    println!("CHILD_STOPPED");
    std::io::stdout().flush().unwrap();
}

#[test]
fn separate_process_stop_serializes_with_actual_handoff_path() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap()
    );
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let calls = Arc::new(AtomicUsize::new(0));
    let db = f.db.clone();
    let gate = f.gate.clone();
    let calls2 = calls.clone();
    let handoff = std::thread::spawn(move || {
        let a = address();
        let b = binding(&a, "i", "k");
        let control = Control {
            calls: calls2,
            db: db.clone(),
            ready: Some(ready_tx),
            proceed: Some(std::sync::Mutex::new(go_rx)),
        };
        ScopedAuthority::new(db, gate, "authority-1".into())
            .unwrap()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                plan(),
                "message",
                "t",
                &control,
            )
            .unwrap()
    });
    ready_rx.recv().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "scoped_stop_child", "--nocapture"])
        .env("HERDER_SCOPED_TEST_DB", &f.db)
        .env("HERDER_SCOPED_TEST_GATE", &f.gate)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let signal = |stdout: &mut BufReader<std::process::ChildStdout>, expected: &str| {
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(stdout.read_line(&mut line).unwrap(), 0);
            if line.trim() == expected {
                break;
            }
        }
    };
    signal(&mut stdout, "CHILD_BUSY");
    go_tx.send(()).unwrap();
    assert!(matches!(
        handoff.join().unwrap(),
        DurableDispatch::Admitted(_)
    ));
    signal(&mut stdout, "CHILD_STOPPED");
    assert!(child.wait().unwrap().success());
    let c = Connection::open(&f.db).unwrap();
    let held: i64=c.query_row("SELECT count(*) FROM humanstop_holds WHERE scope_ref='session:issued' AND released_at IS NULL",[],|r|r.get(0)).unwrap();
    assert_eq!(held, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct Lost {
    calls: Arc<AtomicUsize>,
}
impl BoundedNativeHandoff for Lost {
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        assert_eq!(plan.target, address());
        assert_eq!(message, "message");
        assert!(key.0 == "k" || key.0 == "lost-key");
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(SubmitError::OutcomeUnknown {
            receipt: None,
            reason: "simulated disconnect after write".into(),
        })
    }
}
struct Interrupt {
    calls: AtomicUsize,
    lost: bool,
}
impl herder::application::scoped_stop::BoundedNativeInterrupt for Interrupt {
    fn interrupt_exact(
        &self,
        target: &SessionAddress,
        native_turn_id: &str,
    ) -> herder::application::scoped_stop::InterruptAttempt {
        assert_eq!(*target, address());
        assert_eq!(native_turn_id, "turn-1");
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.lost {
            herder::application::scoped_stop::InterruptAttempt::OutcomeUnknown
        } else {
            herder::application::scoped_stop::InterruptAttempt::Interrupted
        }
    }
}
#[test]
fn lost_handoff_is_unknown_and_never_replayed() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Lost {
        calls: calls.clone(),
    };
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p.clone(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::Unknown
    );
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p.clone(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    f.prepare("different-intent", "new-key", &p);
    let next = binding(&a, "different-intent", "new-key");
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &next, "scope-1", &p, "message", "t")
            .unwrap()
    );
    let interrupt = Interrupt {
        calls: AtomicUsize::new(0),
        lost: false,
    };
    assert_eq!(
        f.authority()
            .stop_session_and_interrupt(&identity(), &grants(), &b, "stop", "t", &interrupt)
            .unwrap(),
        herder::application::scoped_stop::InterruptDisposition::InterruptUnknown
    );
    assert_eq!(interrupt.calls.load(Ordering::SeqCst), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[test]
fn fresh_create_deliver_receipt_stop_interrupt_unknown_and_next_denied() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert!(matches!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p.clone(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::Admitted(_)
    ));
    let w = Writer::open_file(&f.db).unwrap();
    assert_eq!(
        w.load_native_receipt(&b).unwrap(),
        herder::application::reconcile::StoredReceipt::Found(NativeReceipt {
            target: a.clone(),
            native_id: "turn-1".into()
        })
    );
    drop(w);
    let interrupt = Interrupt {
        calls: AtomicUsize::new(0),
        lost: true,
    };
    assert_eq!(
        f.authority()
            .stop_session_and_interrupt(&identity(), &grants(), &b, "stop", "t", &interrupt)
            .unwrap(),
        herder::application::scoped_stop::InterruptDisposition::InterruptUnknown
    );
    assert_eq!(interrupt.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.authority()
            .stop_session_and_interrupt(&identity(), &grants(), &b, "stop", "t", &interrupt)
            .unwrap(),
        herder::application::scoped_stop::InterruptDisposition::InterruptUnknown
    );
    assert_eq!(interrupt.calls.load(Ordering::SeqCst), 1);
    f.prepare("next", "key-next", &p);
    let next = binding(&a, "next", "key-next");
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &next, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
#[ignore = "starts real isolated Codex and the loopback test-model fixture"]
fn real_codex_fresh_create_deliver_native_read_stop_next_denied() {
    use herder::{
        adapters::codex::{
            connection::{CodexConnection, CodexInstance},
            control::RequestReceiptLookup,
            create::CodexCreateControl,
        },
        application::target::{NativeCreateControl, NativeCreateOutcome},
        domain::adapter::NativeSessionControl,
    };
    use std::{
        future::Future,
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        task::{Context, Poll, Waker},
        time::Duration,
    };
    struct Cleanup(Child);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct Live {
        control: CodexCreateControl,
        instance: InstanceRef,
    }
    impl BoundedFreshRootCreate for Live {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(
            &self,
            key: &str,
            spec: &str,
        ) -> Result<SessionAddress, SubmitError> {
            let mut f = std::pin::pin!(self.control.create_once(key, spec));
            match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                Poll::Ready(NativeCreateOutcome::Confirmed {
                    request_key,
                    instance,
                    native_session_id,
                    parent_ref: None,
                }) if request_key == key && instance == self.instance => Ok(SessionAddress {
                    instance,
                    native_session_id,
                }),
                Poll::Ready(_) => Err(SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "fixture unknown".into(),
                }),
                Poll::Pending => {
                    panic!("Codex create no longer guarantees synchronous bounded handoff")
                }
            }
        }
    }
    impl BoundedNativeHandoff for Live {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            m: &str,
            k: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            // This test wrapper is valid only for the current CodexControl:
            // its submit body performs the bounded synchronous RPC in one poll.
            let mut f = std::pin::pin!(self.control.native_control().submit(p, m, k));
            match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                Poll::Ready(value) => value,
                Poll::Pending => {
                    panic!("Codex submit no longer guarantees synchronous bounded handoff")
                }
            }
        }
    }
    let f = Fixture::new();
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/native/test-model-server.py");
    let mut model = Command::new("/usr/bin/python3")
        .arg(fixture)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(model.stdout.take().unwrap());
    let mut port = String::new();
    stdout.read_line(&mut port).unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let _model = Cleanup(model);
    // The proxy forwards the request to the shared model, then holds its
    // response behind a channel so the real native turn stays in progress.
    // No sleeps or real provider credentials are involved.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    let (proxy_ready_tx, proxy_ready_rx) = mpsc::sync_channel(0);
    let (proxy_release_tx, proxy_release_rx) = mpsc::sync_channel(0);
    let proxy = std::thread::spawn(move || {
        use std::io::{BufRead, Read, Write};
        let (mut client, _) = listener.accept().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            head.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let length: usize = head
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse().ok())
            })
            .expect("content-length");
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let mut upstream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        upstream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut lines = head.lines();
        let request = lines.next().unwrap();
        write!(upstream, "{request}\r\n").unwrap();
        for line in lines {
            if line.is_empty() || line.to_ascii_lowercase().starts_with("connection:") {
                continue;
            }
            write!(upstream, "{line}\r\n").unwrap();
        }
        upstream.write_all(b"Connection: close\r\n\r\n").unwrap();
        upstream.write_all(&body).unwrap();
        let mut response = Vec::new();
        upstream.read_to_end(&mut response).unwrap();
        proxy_ready_tx.send(()).unwrap();
        let _ = proxy_release_rx.recv();
        let _ = client.write_all(&response);
    });
    let home = f.root.join("codex-home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("config.toml"),format!("model = \"herder-test\"\nmodel_provider = \"fixture\"\n[model_providers.fixture]\nname = \"fixture\"\nbase_url = \"http://127.0.0.1:{proxy_port}/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"fixture-only\"\n")).unwrap();
    let instance = address().instance;
    let native_instance = CodexInstance {
        instance_id: instance.instance_id.clone(),
        executable: PathBuf::from(std::env::var("HERDER_TEST_CODEX_BIN").unwrap()),
        code_home: home,
        cwd: f.root.clone(),
    };
    let control = CodexCreateControl::open(
        native_instance.clone(),
        instance.clone(),
        Duration::from_secs(15),
    )
    .unwrap();
    let live = Live { control, instance };
    assert_eq!(
        f.authority()
            .create_fresh_root(
                &identity(),
                &grants(),
                &live,
                &Issuer,
                &Generation,
                CreateRequest {
                    intent_id: "create",
                    task_id: "create-task",
                    request_key: "create-key",
                    specification: "isolated",
                    now: "now",
                    retain_until: "later"
                }
            )
            .unwrap(),
        CreateResult::Created(SessionRef("issued".into()))
    );
    use herder::application::target::SessionRegistry;
    let writer = Writer::open_file(&f.db).unwrap();
    let native = writer
        .resolve(&SessionRef("issued".into()))
        .unwrap()
        .unwrap();
    drop(writer);
    let p = DispatchPlan {
        target: native.clone(),
        mode: SendMode::Start,
        expected_turn: None,
    };
    f.prepare("live", "unique-live-key", &p);
    let b = binding(&native, "live", "unique-live-key");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let received = f
        .authority()
        .handoff(
            &identity(),
            &grants(),
            &b,
            "scope-1",
            p.clone(),
            "message",
            "now",
            &live,
        )
        .unwrap();
    let DurableDispatch::Admitted(receipt) = received else {
        panic!("native admission not confirmed: {received:?}")
    };
    proxy_ready_rx
        .recv_timeout(Duration::from_secs(15))
        .expect("model request did not reach fixture");
    let w = Writer::open_file(&f.db).unwrap();
    assert_eq!(
        w.load_native_receipt(&b).unwrap(),
        herder::application::reconcile::StoredReceipt::Found(receipt.clone())
    );
    drop(w);
    let mut matched = false;
    for _ in 0..50 {
        if let Ok(RequestReceiptLookup::Found(r)) = live
            .control
            .native_control()
            .lookup_request(&native, &RequestKey("unique-live-key".into()))
        {
            assert_eq!(r, receipt);
            matched = true;
            break;
        }
    }
    assert!(matched, "native receipt was not independently readable");
    use std::io::{Read, Write};
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut contacted = false;
    while std::time::Instant::now() < deadline {
        let mut stats = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stats
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stats
            .write_all(b"GET /_stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stats.read_to_string(&mut response).unwrap();
        let (_, body) = response.split_once("\r\n\r\n").unwrap();
        if serde_json::from_str::<serde_json::Value>(body).unwrap()["requests"]
            .as_u64()
            .unwrap()
            >= 1
        {
            contacted = true;
            break;
        }
    }
    assert!(contacted, "test model was not contacted");
    assert_eq!(
        f.authority()
            .stop_session_and_interrupt(
                &identity(),
                &grants(),
                &b,
                "manual",
                "now",
                live.control.native_control()
            )
            .unwrap(),
        herder::application::scoped_stop::InterruptDisposition::InterruptAcknowledged
    );
    let _ = proxy_release_tx.send(());
    proxy.join().unwrap();
    drop(live);
    // Read the same turn from a reopened native profile; acknowledgement alone
    // is not evidence that the native turn actually stopped.
    let mut independent = CodexConnection::open(native_instance).unwrap();
    independent.request("initialize", serde_json::json!({"clientInfo":{"name":"herder-stop-readback","version":"1"},"capabilities":{"experimentalApi":true}}), Duration::from_secs(15)).unwrap();
    independent
        .notify("initialized", serde_json::json!({}))
        .unwrap();
    let readback = independent
        .request(
            "thread/read",
            serde_json::json!({"threadId":native.native_session_id,"includeTurns":true}),
            Duration::from_secs(15),
        )
        .unwrap();
    let turns = readback["thread"]["turns"]
        .as_array()
        .expect("native turns");
    assert!(
        turns
            .iter()
            .any(|turn| turn["id"] == receipt.native_id && turn["status"] == "interrupted"),
        "native interrupt not confirmed: {readback}"
    );
    f.prepare("after", "after-key", &p);
    let next = binding(&native, "after", "after-key");
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &next,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    println!(
        "scoped-native-proof session_ref=issued scope_generation=scope-1 native_thread={} native_turn={} model=loopback-fixture readback=interrupted next_claim=denied",
        native.native_session_id, receipt.native_id
    );
}

#[test]
fn file_writer_preserves_fake_admission_receipt_across_reopen() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let result = f
        .authority()
        .handoff(
            &identity(),
            &grants(),
            &b,
            "scope-1",
            p.clone(),
            "message",
            "now",
            &control,
        )
        .unwrap();
    let DurableDispatch::Admitted(receipt) = result else {
        panic!("expected admission")
    };
    let reopened = Writer::open_file(&f.db).unwrap();
    assert_eq!(
        reopened.load_native_receipt(&b).unwrap(),
        herder::application::reconcile::StoredReceipt::Found(receipt)
    );
    drop(reopened);
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                &p,
                "message",
                "again"
            )
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p,
                "message",
                "again",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct CrashControl;
impl BoundedNativeHandoff for CrashControl {
    fn submit_bounded(
        &self,
        _: DispatchPlan,
        _: &str,
        _: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        use std::io::Write;
        println!("POSSIBLE_NATIVE_HANDOFF");
        std::io::stdout().flush().unwrap();
        std::process::exit(77)
    }
}
#[test]
fn scoped_crash_child() {
    let Some(db) = std::env::var_os("HERDER_SCOPED_CRASH_DB") else {
        return;
    };
    let gate = std::env::var_os("HERDER_SCOPED_CRASH_GATE").unwrap();
    let a = address();
    let b = binding(&a, "i", "k");
    let _ = ScopedAuthority::new(db.into(), gate.into(), "authority-1".into())
        .unwrap()
        .handoff(
            &identity(),
            &grants(),
            &b,
            "scope-1",
            plan(),
            "message",
            "now",
            &CrashControl,
        );
    panic!("crash control returned");
}
#[test]
fn fenced_file_writer_recovers_interrupted_fake_submit_without_resending() {
    use std::process::{Command, Stdio};
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "scoped_crash_child", "--nocapture"])
        .env("HERDER_SCOPED_CRASH_DB", &f.db)
        .env("HERDER_SCOPED_CRASH_GATE", &f.gate)
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(77));
    assert!(String::from_utf8_lossy(&child.stdout).contains("POSSIBLE_NATIVE_HANDOFF"));
    let before_recovery_calls = Arc::new(AtomicUsize::new(0));
    let before_recovery = Control {
        calls: before_recovery_calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p.clone(),
                "message",
                "before-recovery",
                &before_recovery
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    assert_eq!(before_recovery_calls.load(Ordering::SeqCst), 0);
    let mut reopened = Writer::open_file(&f.db).unwrap();
    assert_eq!(
        reopened.recover_missing_receipt("i", "restart").unwrap(),
        herder::application::reconcile::MissingReceiptRecovery::Unknown
    );
    assert_eq!(
        reopened.load_native_receipt(&b).unwrap(),
        herder::application::reconcile::StoredReceipt::Unknown
    );
    drop(reopened);
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                &p,
                "message",
                "retry"
            )
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p,
                "message",
                "retry",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[test]
fn durable_dispatch_fake_control_binds_request_and_never_resends_after_restart() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                &p,
                "different",
                "now"
            )
            .unwrap()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    assert!(matches!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                p.clone(),
                "message",
                "now",
                &control
            )
            .unwrap(),
        DurableDispatch::Admitted(_)
    ));
    let reopened = Writer::open_file(&f.db).unwrap();
    assert!(matches!(
        reopened.load_native_receipt(&b).unwrap(),
        herder::application::reconcile::StoredReceipt::Found(_)
    ));
    drop(reopened);
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &b,
                "scope-1",
                &p,
                "message",
                "retry"
            )
            .unwrap()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.prepare("lost", "lost-key", &p);
    let lost = binding(&a, "lost", "lost-key");
    let lost_calls = Arc::new(AtomicUsize::new(0));
    let fake = Lost {
        calls: lost_calls.clone(),
    };
    assert!(
        f.authority()
            .claim(
                &identity(),
                &grants(),
                &lost,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &lost,
                "scope-1",
                p.clone(),
                "message",
                "now",
                &fake
            )
            .unwrap(),
        DurableDispatch::Unknown
    );
    let reopened = Writer::open_file(&f.db).unwrap();
    assert_eq!(
        reopened.load_native_receipt(&lost).unwrap(),
        herder::application::reconcile::StoredReceipt::Unknown
    );
    drop(reopened);
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &lost,
                "scope-1",
                &p,
                "message",
                "retry"
            )
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &lost,
                "scope-1",
                p,
                "message",
                "retry",
                &fake
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    assert_eq!(lost_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn global_hold_stale_generation_and_imported_target_fail_closed() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let a = address();
    let b = binding(&a, "i", "k");
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &b,
                "stale-generation",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    let stranger = ConnectionIdentity::new(Caller::Unknown, None);
    assert_eq!(
        f.authority()
            .claim(&stranger, &grants(), &b, "scope-1", &p, "message", "now"),
        Err(GateError::Invalid)
    );
    let c = Connection::open(&f.db).unwrap();
    c.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8,
        |_| Ok(3),
    )
    .unwrap();
    c.execute(
        "INSERT INTO session_bindings VALUES ('imported','node','isolated','old-native')",
        [],
    )
    .unwrap();
    drop(c);
    let imported = SessionAddress {
        native_session_id: "old-native".into(),
        ..a.clone()
    };
    let ib = ReceiptBinding {
        target_ref: "imported",
        address: &imported,
        ..b
    };
    let mut allowed = grants();
    allowed.push(Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("imported".into())),
        action: Action::Write,
    });
    assert!(
        f.authority()
            .resolve_session(
                &identity(),
                &allowed,
                &SessionRef("imported".into()),
                &imported.instance
            )
            .is_err()
    );
    let imported_plan = DispatchPlan {
        target: imported.clone(),
        ..p.clone()
    };
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &allowed,
                &ib,
                "scope-1",
                &imported_plan,
                "message",
                "now"
            )
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .stop(&identity(), &grants(), "global", "manual", "now")
            .unwrap(),
        StopDisposition::HeldBeforeHandoff
    );
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
}

struct FixtureReader {
    target: SessionAddress,
    reads: AtomicUsize,
    db: PathBuf,
}
impl herder::domain::adapter::NativeSessionReader for FixtureReader {
    async fn snapshot(
        &self,
        _: &SessionAddress,
    ) -> Result<herder::domain::adapter::SessionSnapshot, herder::domain::adapter::ReadError> {
        use herder::domain::{
            adapter::{SessionActivity, SessionSnapshot},
            address::{Authorization, Availability, Capability, CapabilityVersion, Support},
        };
        self.reads.fetch_add(1, Ordering::SeqCst);
        let db = Connection::open(&self.db)
            .map_err(|e| herder::domain::adapter::ReadError(e.to_string()))?;
        let human_stop: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_scopes s JOIN humanstop_holds h ON h.scope_ref=s.scope_ref WHERE s.session_ref='issued' AND h.released_at IS NULL) OR EXISTS(SELECT 1 FROM holds WHERE released_at IS NULL AND session_ref IN ('global','issued','session:issued'))", [], |r| r.get(0)).map_err(|e| herder::domain::adapter::ReadError(e.to_string()))?;
        Ok(SessionSnapshot {
            address: self.target.clone(),
            human_stop,
            activity: SessionActivity::Idle,
            capabilities: vec![Capability {
                name: "deliver.start".into(),
                version: CapabilityVersion {
                    adapter_version: "test".into(),
                    capability_version: "test".into(),
                },
                supported: Support::Supported,
                available: Availability::Available,
                authorized: Authorization::Authorized,
            }],
        })
    }
    async fn reconcile(
        &self,
        _: &NativeReceipt,
    ) -> Result<herder::domain::adapter::Observation, herder::domain::adapter::ReadError> {
        unreachable!()
    }
}
#[tokio::test]
async fn delivery_requires_authority_exact_instance_and_snapshot_before_fake_submit() {
    use herder::application::target::{DeliverRequest, TargetError, deliver_scoped};
    use herder::domain::adapter::SendCommand;
    let f = Fixture::new();
    create(&f);
    let ref_id = SessionRef("issued".into());
    let target = address();
    let reader = FixtureReader {
        target: target.clone(),
        reads: AtomicUsize::new(0),
        db: f.db.clone(),
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    let request = || DeliverRequest {
        session: &ref_id,
        intent_id: "i",
        task_id: "task-i",
        request_key: "k",
        message: "message",
        command: SendCommand {
            mode: SendMode::Start,
        },
        now: "now",
        retain_until: "later",
    };
    assert_eq!(
        deliver_scoped(
            &f.authority(),
            &target.instance,
            &identity(),
            &[],
            &reader,
            &control,
            request()
        )
        .await,
        Err(TargetError::Unauthorized)
    );
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0);
    let wrong_instance = InstanceRef {
        node: NodeRef("other".into()),
        instance_id: "isolated".into(),
    };
    assert_eq!(
        deliver_scoped(
            &f.authority(),
            &wrong_instance,
            &identity(),
            &grants(),
            &reader,
            &control,
            request()
        )
        .await,
        Err(TargetError::RegistryUnavailable)
    );
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0);
    let wrong = FixtureReader {
        target: SessionAddress {
            instance: wrong_instance,
            native_session_id: target.native_session_id.clone(),
        },
        reads: AtomicUsize::new(0),
        db: f.db.clone(),
    };
    assert_eq!(
        deliver_scoped(
            &f.authority(),
            &target.instance,
            &identity(),
            &grants(),
            &wrong,
            &control,
            request()
        )
        .await,
        Err(TargetError::SnapshotMismatch)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let first_delivery = deliver_scoped(
        &f.authority(),
        &target.instance,
        &identity(),
        &grants(),
        &reader,
        &control,
        request(),
    )
    .await;
    assert!(
        matches!(first_delivery, Ok(DurableDispatch::Admitted(_))),
        "first delivery: {first_delivery:?}"
    );
    assert_eq!(
        deliver_scoped(
            &f.authority(),
            &target.instance,
            &identity(),
            &grants(),
            &reader,
            &control,
            request()
        )
        .await,
        Ok(DurableDispatch::NotClaimed)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn ordered_stop_child() {
    use std::io::{BufRead, Write};
    let Some(db) = std::env::var_os("HERDER_ORDERED_STOP_DB") else {
        return;
    };
    let gate = std::env::var_os("HERDER_ORDERED_STOP_GATE").unwrap();
    println!("CHILD_READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "stop");
    let authority = ScopedAuthority::new(db.into(), gate.into(), "authority-1".into()).unwrap();
    let result = authority
        .stop(&identity(), &grants(), "session:issued", "manual", "t")
        .unwrap();
    println!("CHILD_STOP:{result:?}");
    std::io::stdout().flush().unwrap();
}
#[test]
fn separate_process_stop_before_claim_and_between_claim_handoff() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    for before in [true, false] {
        let f = Fixture::new();
        create(&f);
        let p = plan();
        f.prepare("i", "k", &p);
        let a = address();
        let b = binding(&a, "i", "k");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ordered_stop_child", "--nocapture"])
            .env("HERDER_ORDERED_STOP_DB", &f.db)
            .env("HERDER_ORDERED_STOP_GATE", &f.gate)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let expect = |stdout: &mut BufReader<std::process::ChildStdout>, expected: &str| {
            let mut line = String::new();
            loop {
                line.clear();
                assert_ne!(stdout.read_line(&mut line).unwrap(), 0);
                if line.trim() == expected {
                    break;
                }
            }
        };
        expect(&mut stdout, "CHILD_READY");
        if !before {
            assert!(
                f.authority()
                    .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
                    .unwrap()
            );
        }
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "stop").unwrap();
        stdin.flush().unwrap();
        expect(
            &mut stdout,
            if before {
                "CHILD_STOP:HeldBeforeHandoff"
            } else {
                "CHILD_STOP:InterruptOrReconcileRequired"
            },
        );
        assert!(child.wait().unwrap().success());
        let calls = Arc::new(AtomicUsize::new(0));
        let control = Control {
            calls: calls.clone(),
            db: f.db.clone(),
            ready: None,
            proceed: None,
        };
        if before {
            assert!(
                !f.authority()
                    .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "t")
                    .unwrap()
            );
        } else {
            assert_eq!(
                f.authority()
                    .handoff(
                        &identity(),
                        &grants(),
                        &b,
                        "scope-1",
                        p,
                        "message",
                        "t",
                        &control
                    )
                    .unwrap(),
                DurableDispatch::StoppedBeforeHandoff
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

struct BlockedCreator {
    instance: InstanceRef,
    ready: mpsc::SyncSender<()>,
    proceed: std::sync::Mutex<mpsc::Receiver<()>>,
}
impl BoundedFreshRootCreate for BlockedCreator {
    fn instance(&self) -> &InstanceRef {
        &self.instance
    }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
        self.ready.send(()).unwrap();
        self.proceed.lock().unwrap().recv().unwrap();
        Ok(address())
    }
}
#[test]
fn fresh_root_is_gated_from_before_native_create_through_atomic_scope_commit() {
    let f = Fixture::new();
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let db = f.db.clone();
    let gate = f.gate.clone();
    let creator = std::thread::spawn(move || {
        ScopedAuthority::new(db, gate, "authority-1".into())
            .unwrap()
            .create_fresh_root(
                &identity(),
                &grants(),
                &BlockedCreator {
                    instance: address().instance,
                    ready: ready_tx,
                    proceed: std::sync::Mutex::new(go_rx),
                },
                &Issuer,
                &Generation,
                CreateRequest {
                    intent_id: "create",
                    task_id: "create-task",
                    request_key: "create-key",
                    specification: "isolated",
                    now: "now",
                    retain_until: "later",
                },
            )
            .unwrap()
    });
    ready_rx.recv().unwrap();
    let stop_authority = f.authority();
    let stopper = std::thread::spawn(move || {
        stop_authority.stop(&identity(), &grants(), "global", "stop", "now")
    });
    let db = Connection::open(&f.db).unwrap();
    let count:i64=db.query_row("SELECT (SELECT count(*) FROM session_bindings)+(SELECT count(*) FROM humanstop_sessions)+(SELECT count(*) FROM humanstop_scopes)",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 0);
    drop(db);
    go_tx.send(()).unwrap();
    assert_eq!(
        creator.join().unwrap(),
        CreateResult::Created(SessionRef("issued".into()))
    );
    let db = Connection::open(&f.db).unwrap();
    let result:(i64,i64,i64)=db.query_row("SELECT (SELECT count(*) FROM session_bindings WHERE session_ref='issued'),(SELECT count(*) FROM humanstop_sessions WHERE session_ref='issued' AND scope_generation='scope-1'),(SELECT count(*) FROM humanstop_scopes WHERE session_ref='issued')",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(result, (1, 1, 2));
    assert_eq!(
        stopper.join().unwrap().unwrap(),
        StopDisposition::HeldBeforeHandoff
    );
}

#[test]
fn only_one_unsettled_handoff_per_session_is_claimed() {
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("first", "k", &p);
    f.prepare("next", "next-key", &p);
    let a = address();
    let first = binding(&a, "first", "k");
    let next = binding(&a, "next", "next-key");
    assert!(
        f.authority()
            .claim(
                &identity(),
                &grants(),
                &first,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &next,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    let control = Control {
        calls: Arc::new(AtomicUsize::new(0)),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(matches!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &first,
                "scope-1",
                p.clone(),
                "message",
                "now",
                &control
            )
            .unwrap(),
        DurableDispatch::Admitted(_)
    ));
    assert!(
        f.authority()
            .claim(
                &identity(),
                &grants(),
                &next,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
}

#[test]
fn global_hold_before_create_blocks_native_creation_and_intent() {
    struct CountingCreator {
        instance: InstanceRef,
        calls: AtomicUsize,
    }
    impl BoundedFreshRootCreate for CountingCreator {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    let f = Fixture::new();
    assert_eq!(
        f.authority()
            .stop(&identity(), &grants(), "global", "manual", "now")
            .unwrap(),
        StopDisposition::HeldBeforeHandoff
    );
    let creator = CountingCreator {
        instance: address().instance,
        calls: AtomicUsize::new(0),
    };
    let result = f.authority().create_fresh_root(
        &identity(),
        &grants(),
        &creator,
        &Issuer,
        &Generation,
        CreateRequest {
            intent_id: "create",
            task_id: "create-task",
            request_key: "create-key",
            specification: "isolated",
            now: "now",
            retain_until: "later",
        },
    );
    assert_eq!(result, Err(GateError::Invalid));
    assert_eq!(creator.calls.load(Ordering::SeqCst), 0);
    let db = Connection::open(&f.db).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM intents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

struct NotSent {
    calls: Arc<AtomicUsize>,
}
impl BoundedNativeHandoff for NotSent {
    fn submit_bounded(
        &self,
        _: DispatchPlan,
        _: &str,
        _: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(SubmitError::DefinitelyNotSent {
            reason: "fixture refused before write".into(),
        })
    }
}
#[test]
fn definitely_not_sent_is_durable_and_allows_a_new_key() {
    let f = Fixture::new();
    create(&f);
    let a = address();
    let p = plan();
    let old = binding(&a, "not-sent", "old-key");
    f.prepare(old.intent_id, old.request_key, &p);
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &old, "scope-1", &p, "message", "t")
            .unwrap()
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let control = NotSent {
        calls: calls.clone(),
    };
    let outcome = f
        .authority()
        .handoff(
            &identity(),
            &grants(),
            &old,
            "scope-1",
            p.clone(),
            "message",
            "t",
            &control,
        )
        .unwrap();
    assert_eq!(outcome, DurableDispatch::DefinitelyNotSent);
    let db = Connection::open(&f.db).unwrap();
    let (state, diagnostic): (String, Option<String>) = db.query_row("SELECT i.state,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.intent_id=?1", [old.intent_id], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(
        state, "rejected",
        "outcome={outcome:?}, diagnostic={diagnostic:?}"
    );
    let diagnostic = diagnostic.expect("durable diagnostic");
    assert!(
        diagnostic.contains("definitely_not_sent")
            && diagnostic.contains("fixture refused before write"),
        "{diagnostic}"
    );
    drop(db);
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &old, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &old,
                "scope-1",
                p.clone(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
    );
    let new = binding(&a, "new-intent", "new-key");
    f.prepare(new.intent_id, new.request_key, &p);
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &new, "scope-1", &p, "message", "t")
            .unwrap()
    );
    assert_eq!(
        f.authority()
            .handoff(
                &identity(),
                &grants(),
                &new,
                "scope-1",
                p.clone(),
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::DefinitelyNotSent
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
