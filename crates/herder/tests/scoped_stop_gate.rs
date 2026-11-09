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
    fn migrate_v4(&self) {
        let meta = std::fs::metadata(&self.gate).unwrap();
        let guard = acquire_pinned(&self.gate, meta.dev(), meta.ino()).unwrap();
        Writer::open_file(&self.db)
            .unwrap()
            .migrate_search_v4(&guard)
            .unwrap();
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
    use herder::adapters::codex::{
        connection::{CodexConnection, CodexInstance},
        control::RequestReceiptLookup,
        create::CodexCreateControl,
    };
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        time::Duration,
    };
    struct Cleanup(Child);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
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
    assert_eq!(
        f.authority()
            .create_fresh_root(
                &identity(),
                &grants(),
                &control,
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
            control.native_control(),
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
        if let Ok(RequestReceiptLookup::Found(r)) = control
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
                control.native_control()
            )
            .unwrap(),
        herder::application::scoped_stop::InterruptDisposition::InterruptAcknowledged
    );
    let _ = proxy_release_tx.send(());
    proxy.join().unwrap();
    drop(control);
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
        receipt: &NativeReceipt,
    ) -> Result<herder::domain::adapter::Observation, herder::domain::adapter::ReadError> {
        Ok(herder::domain::adapter::Observation::Confirmed {
            receipt: receipt.clone(),
        })
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

#[tokio::test]
async fn mcp_stop_wire_holds_only_authorized_scoped_session() {
    use herder::{
        application::scoped_stop::mcp_stop::ScopedStopApplication, mcp::transport::NativeServer,
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    async fn stop(
        identity: ConnectionIdentity,
        app: Arc<ScopedStopApplication>,
        session: &str,
    ) -> Value {
        let server = NativeServer::with_connection_identity(identity, app);
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"principal":"alice"});
        let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"stop","arguments":{"action":"stop","session_ref":session,"request_key":"stop-key"}}});
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        drop(write);
        drop(lines);
        task.await.unwrap();
        response
    }
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("intent", "key", &p);
    let app = Arc::new(ScopedStopApplication::new(
        f.authority(),
        address().instance,
        grants(),
    ));
    let bob = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("bob".into()),
        }),
        None,
    );
    let denied = stop(bob, app.clone(), "issued").await;
    assert_eq!(
        denied["result"]["structuredContent"]["code"],
        "unauthorized"
    );
    let db = Connection::open(&f.db).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM humanstop_holds", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(3),
    )
    .unwrap();
    db.execute(
        "INSERT INTO session_bindings VALUES ('imported','node','isolated','imported-native')",
        [],
    )
    .unwrap();
    let mut imported_grants = grants();
    imported_grants.push(Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("imported".into())),
        action: Action::Write,
    });
    let imported_app = Arc::new(ScopedStopApplication::new(
        f.authority(),
        address().instance,
        imported_grants,
    ));
    let imported = stop(identity(), imported_app, "imported").await;
    assert_eq!(
        imported["result"]["structuredContent"]["code"],
        "scope_unavailable"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM humanstop_holds", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let accepted = stop(identity(), app, "issued").await;
    assert_eq!(accepted["result"]["structuredContent"]["hold"], "active");
    assert_eq!(
        accepted["result"]["structuredContent"]["native_interrupt"],
        "not_attempted_no_known_handoff"
    );
    let target = address();
    let first_binding = binding(&target, "intent", "key");
    assert!(
        !f.authority()
            .claim(
                &identity(),
                &grants(),
                &first_binding,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    assert_eq!(db.query_row("SELECT count(*) FROM humanstop_holds WHERE scope_ref='session:issued' AND released_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);

    let f2 = Fixture::new();
    create(&f2);
    f2.prepare("after", "k", &p);
    let target = address();
    let sent = binding(&target, "after", "k");
    assert!(
        f2.authority()
            .claim(
                &identity(),
                &grants(),
                &sent,
                "scope-1",
                &p,
                "message",
                "now"
            )
            .unwrap()
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: calls.clone(),
        db: f2.db.clone(),
        ready: None,
        proceed: None,
    };
    assert!(matches!(
        f2.authority()
            .handoff(
                &identity(),
                &grants(),
                &sent,
                "scope-1",
                p.clone(),
                "message",
                "now",
                &control
            )
            .unwrap(),
        DurableDispatch::Admitted(_)
    ));
    let app = Arc::new(ScopedStopApplication::new(
        f2.authority(),
        target.instance,
        grants(),
    ));
    let stopped = stop(identity(), app, "issued").await;
    assert_eq!(
        stopped["result"]["structuredContent"]["native_interrupt"],
        "required_or_reconcile"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn mcp_read_wire_requires_read_grant_and_exact_scoped_mapping() {
    use herder::{
        application::scoped_stop::mcp_read::{ScopedMessageReader, ScopedReadApplication},
        mcp::transport::NativeServer,
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Reader(Arc<AtomicUsize>);
    impl ScopedMessageReader for Reader {
        fn read_messages(&mut self, address: &SessionAddress) -> Result<Value, ()> {
            assert_eq!(*address, super_address());
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"messages":[{"id":"fixture-message","text":"fixture-text"}],"coverage":"complete"}),
            )
        }
    }
    fn super_address() -> SessionAddress {
        address()
    }
    async fn read(
        identity: ConnectionIdentity,
        app: Arc<ScopedReadApplication<Reader>>,
        session: &str,
        cursor: Option<&str>,
    ) -> Value {
        let server = NativeServer::with_connection_identity(identity, app);
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (r, mut w) = tokio::io::split(client);
        let mut lines = BufReader::new(r).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"principal":"alice"});
        let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session,"cursor":cursor}}});
        w.write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let result = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        drop(w);
        drop(lines);
        task.await.unwrap();
        result
    }
    let f = Fixture::new();
    create(&f);
    let calls = Arc::new(AtomicUsize::new(0));
    let read_grant = Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("issued".into())),
        action: Action::Read,
    };
    let db = Connection::open(&f.db).unwrap();
    db.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(3),
    )
    .unwrap();
    db.execute(
        "INSERT INTO session_bindings VALUES ('imported','node','isolated','imported-native')",
        [],
    )
    .unwrap();
    let imported_grant = Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("imported".into())),
        action: Action::Read,
    };
    let app = Arc::new(ScopedReadApplication::new(
        f.authority(),
        address().instance,
        vec![read_grant, imported_grant],
        Reader(calls.clone()),
    ));
    let bob = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("bob".into()),
        }),
        None,
    );
    assert_eq!(
        read(bob, app.clone(), "issued", None).await["result"]["structuredContent"]["code"],
        "unauthorized"
    );
    assert_eq!(
        read(identity(), app.clone(), "issued", Some("foreign-cursor")).await["result"]["structuredContent"]
            ["code"],
        "unsupported_cursor"
    );
    assert_eq!(
        read(identity(), app.clone(), "imported", None).await["result"]["structuredContent"]["code"],
        "scope_unavailable"
    );
    let result = read(identity(), app, "issued", None).await;
    assert_eq!(
        result["result"]["structuredContent"]["page"]["messages"][0]["text"],
        "fixture-text"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn mcp_stop_wire_waits_for_inflight_handoff_then_commits_hold() {
    use herder::{
        application::scoped_stop::mcp_stop::ScopedStopApplication, mcp::transport::NativeServer,
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("intent", "k", &p);
    let target = address();
    let b = binding(&target, "intent", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let db = f.db.clone();
    let gate = f.gate.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let submit_calls = calls.clone();
    let handoff = std::thread::spawn(move || {
        let target = address();
        let binding = binding(&target, "intent", "k");
        let control = Control {
            calls: submit_calls,
            db: db.clone(),
            ready: Some(ready_tx),
            proceed: Some(std::sync::Mutex::new(go_rx)),
        };
        ScopedAuthority::new(db, gate, "authority-1".into())
            .unwrap()
            .handoff(
                &identity(),
                &grants(),
                &binding,
                "scope-1",
                plan(),
                "message",
                "now",
                &control,
            )
            .unwrap()
    });
    ready_rx.recv().unwrap();
    let app = Arc::new(ScopedStopApplication::new(
        f.authority(),
        target.instance,
        grants(),
    ));
    let (sent_tx, sent_rx) = mpsc::sync_channel(0);
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let stop = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
            let server=NativeServer::with_connection_identity(identity(),app);
            let (client,io)=tokio::io::duplex(65536);
            let task=tokio::spawn(async move {server.serve(io).await.unwrap().waiting().await.unwrap()});
            let (r,mut w)=tokio::io::split(client); let mut lines=BufReader::new(r).lines();
            let meta=json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"barrier","version":"1"}});
            let request=json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"stop","arguments":{"action":"stop","session_ref":"issued","request_key":"stop-key"}}});
            w.write_all(format!("{request}\n").as_bytes()).await.unwrap(); sent_tx.send(()).unwrap();
            let response:Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            result_tx.send(response).unwrap(); drop(w); drop(lines); task.await.unwrap();
        });
    });
    sent_rx.recv().unwrap();
    let early = result_rx.recv_timeout(Duration::from_millis(300));
    go_tx.send(()).unwrap();
    assert!(matches!(
        handoff.join().unwrap(),
        DurableDispatch::Admitted(_)
    ));
    let result = match early {
        Ok(v) => v,
        Err(mpsc::RecvTimeoutError::Timeout) => result_rx.recv().unwrap(),
        Err(e) => panic!("{e}"),
    };
    stop.join().unwrap();
    assert_eq!(
        result["result"]["structuredContent"]["hold"], "active",
        "{result}"
    );
    assert_eq!(
        result["result"]["structuredContent"]["native_interrupt"],
        "required_or_reconcile"
    );
    let c = Connection::open(&f.db).unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM humanstop_holds WHERE scope_ref='session:issued' AND released_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn recover_exact_create_after_unknown_delivery_never_recreates_or_resends() {
    use herder::application::scoped_stop::create_recovery::RecoveredCreate;
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
    let target = address();
    let control = CountingCreator {
        instance: target.instance.clone(),
        calls: AtomicUsize::new(0),
    };
    let request = || CreateRequest {
        intent_id: "create",
        task_id: "create-task",
        request_key: "create-key",
        specification: "unique prompt",
        now: "now",
        retain_until: "later",
    };
    assert_eq!(
        f.authority()
            .recover_fresh_create(
                &identity(),
                &grants(),
                &target.instance,
                "create-key",
                "unique prompt"
            )
            .unwrap(),
        RecoveredCreate::Missing
    );
    assert_eq!(
        f.authority()
            .create_fresh_root(
                &identity(),
                &grants(),
                &control,
                &Issuer,
                &Generation,
                request()
            )
            .unwrap(),
        CreateResult::Created(SessionRef("issued".into()))
    );
    let p = plan();
    f.prepare("delivery", "k", &p);
    let b = binding(&target, "delivery", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let sends = Arc::new(AtomicUsize::new(0));
    let lost = Lost {
        calls: sends.clone(),
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
                "now",
                &lost
            )
            .unwrap(),
        DurableDispatch::Unknown
    );
    assert_eq!(
        f.authority()
            .create_fresh_root(
                &identity(),
                &grants(),
                &control,
                &Issuer,
                &Generation,
                request()
            )
            .unwrap(),
        CreateResult::Existing
    );
    assert_eq!(
        f.authority()
            .recover_fresh_create(
                &identity(),
                &grants(),
                &target.instance,
                "create-key",
                "unique prompt"
            )
            .unwrap(),
        RecoveredCreate::Created {
            task_id: "create-task".into(),
            session: SessionRef("issued".into()),
            address: target.clone()
        }
    );
    assert_eq!(
        f.authority()
            .recover_fresh_create(
                &identity(),
                &grants(),
                &target.instance,
                "create-key",
                "other prompt"
            )
            .unwrap(),
        RecoveredCreate::Conflict
    );
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    assert_eq!(control.calls.load(Ordering::SeqCst), 1);
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    assert!(
        f.authority()
            .recover_fresh_create(
                &identity(),
                &[],
                &target.instance,
                "create-key",
                "unique prompt"
            )
            .is_err()
    );
}

#[tokio::test]
async fn create_prompt_composition_keeps_create_after_uncertain_delivery() {
    use herder::application::scoped_stop::create_prompt::{
        CreatePromptOutcome, create_with_prompt,
    };
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, spec: &str) -> Result<SessionAddress, SubmitError> {
            assert_eq!(spec, "unique prompt");
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    struct Submit(AtomicUsize);
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            plan: DispatchPlan,
            message: &str,
            key: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(plan.target, address());
            assert_eq!(message, "unique prompt");
            assert!(key.0.starts_with("create-prompt:"));
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "fixture lost response".into(),
            })
        }
    }
    let f = Fixture::new();
    let target = address();
    let create = Create {
        instance: target.instance.clone(),
        calls: AtomicUsize::new(0),
    };
    let submit = Submit(AtomicUsize::new(0));
    let reader = FixtureReader {
        target,
        reads: AtomicUsize::new(0),
        db: f.db.clone(),
    };
    let request = || CreateRequest {
        intent_id: "create",
        task_id: "create-task",
        request_key: "create-key",
        specification: "unique prompt",
        now: "now",
        retain_until: "later",
    };
    let authority = f.authority();
    let first = create_with_prompt(
        &authority,
        &identity(),
        &grants(),
        &create,
        &Issuer,
        &Generation,
        &reader,
        &submit,
        &herder::application::scoped_stop::create_prompt::NoAdditionalGrant,
        request(),
    )
    .await
    .unwrap();
    assert_eq!(
        first,
        CreatePromptOutcome::DeliveryUnknownOrBlocked {
            session: SessionRef("issued".into())
        }
    );
    let replay = create_with_prompt(
        &authority,
        &identity(),
        &grants(),
        &create,
        &Issuer,
        &Generation,
        &reader,
        &submit,
        &herder::application::scoped_stop::create_prompt::NoAdditionalGrant,
        request(),
    )
    .await
    .unwrap();
    assert_eq!(
        replay,
        CreatePromptOutcome::DeliveryUnknownOrBlocked {
            session: SessionRef("issued".into())
        }
    );
    let instance_only: Vec<_> = grants()
        .into_iter()
        .filter(
            |g| matches!(&g.resource,PrivateResource::Resource(r) if r.starts_with("instance:")),
        )
        .collect();
    let revoked = create_with_prompt(
        &authority,
        &identity(),
        &instance_only,
        &create,
        &Issuer,
        &Generation,
        &reader,
        &submit,
        &herder::application::scoped_stop::create_prompt::NoAdditionalGrant,
        request(),
    )
    .await
    .unwrap();
    assert!(
        matches!(
            revoked,
            CreatePromptOutcome::DeliveryUnknownOrBlocked { .. }
        ),
        "a prior UNKNOWN must not become no-effect after grant revocation"
    );
    assert_eq!(create.calls.load(Ordering::SeqCst), 1);
    assert_eq!(submit.0.load(Ordering::SeqCst), 1);
    let db = Connection::open(&f.db).unwrap();
    let result:(i64,i64)=db.query_row("SELECT (SELECT count(*) FROM session_bindings WHERE session_ref='issued'),(SELECT count(*) FROM intents WHERE state='unknown')",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(result, (1, 1));
}

#[tokio::test]
async fn create_prompt_success_and_unknown_create_are_never_replayed() {
    use herder::application::scoped_stop::create_prompt::{
        CreatePromptOutcome, create_with_prompt,
    };
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
        unknown: bool,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.unknown {
                Err(SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "create reply lost".into(),
                })
            } else {
                Ok(address())
            }
        }
    }
    struct Submit(AtomicUsize);
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            plan: DispatchPlan,
            message: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(message, "prompt");
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Admission {
                receipt: NativeReceipt {
                    target: plan.target,
                    native_id: "turn-created".into(),
                },
            })
        }
    }
    for unknown in [false, true] {
        let f = Fixture::new();
        let target = address();
        let creator = Create {
            instance: target.instance.clone(),
            calls: AtomicUsize::new(0),
            unknown,
        };
        let sender = Submit(AtomicUsize::new(0));
        let reader = FixtureReader {
            target,
            reads: AtomicUsize::new(0),
            db: f.db.clone(),
        };
        let request = || CreateRequest {
            intent_id: "create",
            task_id: "task",
            request_key: "key",
            specification: "prompt",
            now: "now",
            retain_until: "later",
        };
        let authority = f.authority();
        let first = create_with_prompt(
            &authority,
            &identity(),
            &grants(),
            &creator,
            &Issuer,
            &Generation,
            &reader,
            &sender,
            &herder::application::scoped_stop::create_prompt::NoAdditionalGrant,
            request(),
        )
        .await
        .unwrap();
        if unknown {
            assert_eq!(first, CreatePromptOutcome::CreateUnknown);
        } else {
            assert!(matches!(first, CreatePromptOutcome::Admitted { .. }));
        }
        let second = create_with_prompt(
            &authority,
            &identity(),
            &grants(),
            &creator,
            &Issuer,
            &Generation,
            &reader,
            &sender,
            &herder::application::scoped_stop::create_prompt::NoAdditionalGrant,
            request(),
        )
        .await
        .unwrap();
        if unknown {
            assert_eq!(second, CreatePromptOutcome::CreateUnknown);
        } else {
            assert!(
                matches!(second,CreatePromptOutcome::Admitted{ref session,ref receipt} if session.0=="issued" && receipt.native_id=="turn-created"),
                "exact prior receipt must be recovered: {second:?}"
            );
        }
        assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
        assert_eq!(sender.0.load(Ordering::SeqCst), if unknown { 0 } else { 1 });
    }
}

#[tokio::test]
async fn create_prompt_requires_trusted_grant_for_new_exact_session() {
    use herder::application::scoped_stop::create_prompt::{
        CreatePromptOutcome, create_with_prompt,
    };
    struct IssuerFresh;
    impl SessionRefIssuer for IssuerFresh {
        fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
            Ok(SessionRef("fresh-dynamic-ref".into()))
        }
    }
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    struct Submit(AtomicUsize);
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            plan: DispatchPlan,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Admission {
                receipt: NativeReceipt {
                    target: plan.target,
                    native_id: "turn".into(),
                },
            })
        }
    }
    let f = Fixture::new();
    let target = address();
    let creator = Create {
        instance: target.instance.clone(),
        calls: AtomicUsize::new(0),
    };
    let reader = FixtureReader {
        target,
        reads: AtomicUsize::new(0),
        db: f.db.clone(),
    };
    let submit = Submit(AtomicUsize::new(0));
    let only_instance: Vec<_> = grants()
        .into_iter()
        .filter(
            |g| matches!(&g.resource,PrivateResource::Resource(r) if r.starts_with("instance:")),
        )
        .collect();
    let request = || CreateRequest {
        intent_id: "new-create",
        task_id: "new-task",
        request_key: "new-key",
        specification: "prompt",
        now: "now",
        retain_until: "later",
    };
    struct Policy(std::sync::atomic::AtomicBool);
    impl herder::application::scoped_stop::create_prompt::FreshSessionGrantPolicy for Policy {
        fn session_write_grant(
            &self,
            principal: &PrincipalId,
            instance: &InstanceRef,
            session: &SessionRef,
        ) -> Result<Option<Grant>, ()> {
            assert_eq!(*instance, address().instance);
            assert_eq!(session.0, "fresh-dynamic-ref");
            Ok(Some(Grant {
                principal: principal.clone(),
                resource: PrivateResource::Session(if self.0.load(Ordering::SeqCst) {
                    session.clone()
                } else {
                    SessionRef("unrelated-session".into())
                }),
                action: Action::Write,
            }))
        }
    }
    let policy = Policy(std::sync::atomic::AtomicBool::new(false));
    let outcome = create_with_prompt(
        &f.authority(),
        &identity(),
        &only_instance,
        &creator,
        &IssuerFresh,
        &Generation,
        &reader,
        &submit,
        &policy,
        request(),
    )
    .await
    .unwrap();
    match outcome {
        CreatePromptOutcome::DeliveryNotSent {
            session,
            diagnostic,
        } => {
            assert_eq!(session, SessionRef("fresh-dynamic-ref".into()));
            assert_eq!(diagnostic.code, "session_write_grant_required");
            assert_eq!(diagnostic.effect, herder::error::Effect::None);
            assert_eq!(diagnostic.retry, herder::error::Retry::SafeSameKey);
            assert!(diagnostic.expected.unwrap()[0].contains("trusted policy"));
        }
        other => panic!("expected safe policy diagnostic, got {other:?}"),
    }
    assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
    assert_eq!(submit.0.load(Ordering::SeqCst), 0);
    policy.0.store(true, Ordering::SeqCst);
    let authority = f.authority();
    let after = create_with_prompt(
        &authority,
        &identity(),
        &only_instance,
        &creator,
        &IssuerFresh,
        &Generation,
        &reader,
        &submit,
        &policy,
        request(),
    )
    .await
    .unwrap();
    assert!(matches!(after, CreatePromptOutcome::Admitted { .. }));
    let repeat = create_with_prompt(
        &authority,
        &identity(),
        &only_instance,
        &creator,
        &IssuerFresh,
        &Generation,
        &reader,
        &submit,
        &policy,
        request(),
    )
    .await
    .unwrap();
    assert!(matches!(repeat, CreatePromptOutcome::Admitted { .. }));
    assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
    assert_eq!(submit.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn mcp_delivery_task_persists_terminal_result_and_requires_exact_read_grant() {
    for outcome in ["not_sent", "unknown", "confirmed"] {
        let f = Fixture::new();
        create(&f);
        let p = plan();
        f.prepare("i", "k", &p);
        let target = address();
        let b = binding(&target, "i", "k");
        assert!(
            f.authority()
                .claim(
                    &identity(),
                    &grants(),
                    &b,
                    "scope-1",
                    &p,
                    "message",
                    "2026-11-07T10:00:00Z"
                )
                .unwrap()
        );
        let calls = Arc::new(AtomicUsize::new(0));
        match outcome {
            "not_sent" => {
                let control = NotSent {
                    calls: calls.clone(),
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
                            "2026-11-07T10:00:00Z",
                            &control
                        )
                        .unwrap(),
                    DurableDispatch::DefinitelyNotSent
                );
            }
            "unknown" => {
                let control = Lost {
                    calls: calls.clone(),
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
                            "2026-11-07T10:00:00Z",
                            &control
                        )
                        .unwrap(),
                    DurableDispatch::Unknown
                );
            }
            _ => {
                let control = Control {
                    calls: calls.clone(),
                    db: f.db.clone(),
                    ready: None,
                    proceed: None,
                };
                assert!(matches!(
                    f.authority()
                        .handoff(
                            &identity(),
                            &grants(),
                            &b,
                            "scope-1",
                            p.clone(),
                            "message",
                            "2026-11-07T10:00:00Z",
                            &control
                        )
                        .unwrap(),
                    DurableDispatch::Admitted(_)
                ));
            }
        }
        assert!(
            f.authority()
                .get_delivery_task(&identity(), &grants(), "task-i")
                .is_err()
        );
        let mut read_grants = grants();
        read_grants.push(Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(SessionRef("issued".into())),
            action: Action::Read,
        });
        if outcome == "confirmed" {
            let reader = FixtureReader {
                target: address(),
                reads: AtomicUsize::new(0),
                db: f.db.clone(),
            };
            assert!(matches!(
                f.authority()
                    .reconcile_delivery_task(&identity(), &read_grants, "task-i", &reader)
                    .await
                    .unwrap(),
                herder::application::reconcile::Reconciliation::Confirmed(_)
            ));
        }
        let task = f
            .authority()
            .get_delivery_task(&identity(), &read_grants, "task-i")
            .unwrap()
            .unwrap();
        let wire = serde_json::to_value(&task).unwrap();
        assert_eq!(wire["status"], "completed");
        let result = &wire["result"]["structuredContent"];
        match outcome {
            "not_sent" => assert_eq!(result["effect"], "none"),
            "unknown" => assert_eq!(result["effect"], "unknown"),
            _ => assert_eq!(result["outcome"], "confirmed"),
        }
        let db = Connection::open(&f.db).unwrap();
        let (status, result): (String, String) = db
            .query_row(
                "SELECT status,result_json FROM tasks WHERE task_id='task-i'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert!(result.contains("structuredContent"));
        drop(db);
        assert_eq!(
            f.authority()
                .get_delivery_task(&identity(), &read_grants, "task-i")
                .unwrap()
                .unwrap(),
            task
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn scoped_task_wire_returns_durable_terminal_states_and_messages() {
    use herder::{
        application::scoped_stop::{
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_task_server::ScopedTaskServer,
        },
        mcp::{
            catalog,
            transport::{ApplicationFuture, ApplicationPort},
        },
    };
    use rmcp::{ServiceExt, model::CallToolResult};
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Reader;
    impl ScopedMessageReader for Reader {
        fn read_messages(&mut self, a: &SessionAddress) -> Result<Value, ()> {
            assert_eq!(*a, address());
            Ok(json!({"messages":[{"text":"fixture native read"}],"coverage":"complete"}))
        }
    }
    struct App {
        authority: ScopedAuthority,
        reader: ScopedReadApplication<Reader>,
        db: PathBuf,
        outcome: &'static str,
        calls: Arc<AtomicUsize>,
    }
    impl ApplicationPort for App {
        fn call<'a>(
            &'a self,
            id: &'a ConnectionIdentity,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                if matches!(request, catalog::Request::Deliver(_)) {
                    let a = address();
                    let b = binding(&a, "i", "k");
                    let p = plan();
                    assert!(
                        self.authority
                            .claim(
                                id,
                                &grants(),
                                &b,
                                "scope-1",
                                &p,
                                "message",
                                "2026-11-07T10:00:01Z"
                            )
                            .unwrap()
                    );
                    match self.outcome {
                        "stopped" => {
                            self.authority
                                .stop(
                                    id,
                                    &grants(),
                                    "session:issued",
                                    "human",
                                    "2026-11-07T10:00:01Z",
                                )
                                .unwrap();
                            let control = NotSent {
                                calls: self.calls.clone(),
                            };
                            assert_eq!(
                                self.authority
                                    .handoff(
                                        id,
                                        &grants(),
                                        &b,
                                        "scope-1",
                                        p,
                                        "message",
                                        "2026-11-07T10:00:01Z",
                                        &control
                                    )
                                    .unwrap(),
                                DurableDispatch::StoppedBeforeHandoff
                            );
                        }
                        "not_sent" => {
                            let control = NotSent {
                                calls: self.calls.clone(),
                            };
                            self.authority
                                .handoff(
                                    id,
                                    &grants(),
                                    &b,
                                    "scope-1",
                                    p,
                                    "message",
                                    "2026-11-07T10:00:01Z",
                                    &control,
                                )
                                .unwrap();
                        }
                        "unknown" => {
                            let control = Lost {
                                calls: self.calls.clone(),
                            };
                            self.authority
                                .handoff(
                                    id,
                                    &grants(),
                                    &b,
                                    "scope-1",
                                    p,
                                    "message",
                                    "2026-11-07T10:00:01Z",
                                    &control,
                                )
                                .unwrap();
                        }
                        _ => {
                            let control = Control {
                                calls: self.calls.clone(),
                                db: self.db.clone(),
                                ready: None,
                                proceed: None,
                            };
                            self.authority
                                .handoff(
                                    id,
                                    &grants(),
                                    &b,
                                    "scope-1",
                                    p,
                                    "message",
                                    "2026-11-07T10:00:01Z",
                                    &control,
                                )
                                .unwrap();
                        }
                    }
                    Some(CallToolResult::structured(
                        json!({"_herder_delivery_task":"task-i"}),
                    ))
                } else {
                    self.reader.call(id, request).await
                }
            })
        }
    }
    for outcome in ["stopped", "not_sent", "unknown", "confirmed"] {
        let f = Fixture::new();
        create(&f);
        f.prepare("i", "k", &plan());
        let db = Connection::open(&f.db).unwrap();
        db.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(3),
        )
        .unwrap();
        db.execute("UPDATE tasks SET created_at='2026-11-07T10:00:00Z',updated_at='2026-11-07T10:00:00Z' WHERE task_id='task-i'",[]).unwrap();
        drop(db);
        let mut policy = grants();
        policy.push(Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(SessionRef("issued".into())),
            action: Action::Read,
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Arc::new(App {
            authority: f.authority(),
            reader: ScopedReadApplication::new(
                f.authority(),
                address().instance,
                policy.clone(),
                Reader,
            ),
            db: f.db.clone(),
            outcome,
            calls: calls.clone(),
        });
        let authority = Arc::new(f.authority());
        let reconcile_reader = Arc::new(FixtureReader {
            target: address(),
            reads: AtomicUsize::new(0),
            db: f.db.clone(),
        });
        let reconciler = Arc::new(
            herder::application::scoped_stop::task_reconcile::ScopedReceiptReconciler::new(
                authority.clone(),
                reconcile_reader,
            ),
        );
        let server = ScopedTaskServer::new(identity(), policy.clone(), authority, app)
            .with_reconciler(reconciler);
        let (client, io) = tokio::io::duplex(65536);
        let job =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (r, mut w) = tokio::io::split(client);
        let mut lines = BufReader::new(r).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"}});
        let requests = [
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"issued","message":"message","mode":"start","request_key":"k"}}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"_meta":meta,"taskId":"task-i"}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":"issued"}}}),
        ];
        for (index, req) in requests.iter().enumerate() {
            w.write_all(format!("{req}\n").as_bytes()).await.unwrap();
            let result: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            match index {
                0 => {
                    assert_eq!(result["result"]["resultType"], "task", "{result}");
                    assert_eq!(result["result"]["taskId"], "task-i");
                }
                1 => {
                    assert_eq!(result["result"]["status"], "completed", "{result}");
                    let v = &result["result"]["result"]["structuredContent"];
                    match outcome {
                        "not_sent" => {
                            assert_eq!(v["effect"], "none");
                            assert_eq!(v["code"], "adapter_refused");
                        }
                        "stopped" => {
                            assert_eq!(v["effect"], "none");
                            assert_eq!(v["code"], "human_stop_active");
                            assert!(v["expected"][0].as_str().unwrap().contains("HumanStop"));
                        }
                        "unknown" => assert_eq!(v["effect"], "unknown"),
                        _ => assert_eq!(v["outcome"], "confirmed"),
                    }
                }
                _ => assert_eq!(
                    result["result"]["structuredContent"]["page"]["messages"][0]["text"],
                    "fixture native read"
                ),
            }
        }
        drop(w);
        drop(lines);
        job.await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if outcome == "stopped" { 0 } else { 1 }
        );
        let reopened = f
            .authority()
            .get_delivery_task(&identity(), &policy, "task-i")
            .unwrap()
            .unwrap();
        let resumed = serde_json::to_value(reopened).unwrap();
        if outcome == "stopped" {
            assert_eq!(
                resumed["result"]["structuredContent"]["code"],
                "human_stop_active"
            );
        }
        if outcome == "not_sent" {
            assert_eq!(
                resumed["result"]["structuredContent"]["code"],
                "adapter_refused"
            );
            assert!(!resumed.to_string().contains("fixture refused before write"));
        }
        let db = Connection::open(&f.db).unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM tasks WHERE task_id='task-i'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "completed"
        );
    }
}

#[tokio::test]
async fn scoped_delivery_application_wire_dedup_tasks_and_readback() {
    use herder::{
        application::scoped_stop::{
            mcp_deliver::ScopedDeliverApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_task_server::ScopedTaskServer,
        },
        mcp::{
            catalog,
            transport::{ApplicationFuture, ApplicationPort},
        },
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Reader;
    impl ScopedMessageReader for Reader {
        fn read_messages(&mut self, a: &SessionAddress) -> Result<Value, ()> {
            assert_eq!(*a, address());
            Ok(json!({"messages":[{"text":"fixture-read"}],"coverage":"complete"}))
        }
    }
    struct Submit {
        outcome: &'static str,
        calls: Arc<AtomicUsize>,
    }
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            m: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(m, "message");
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.outcome {
                "not_sent" => Err(SubmitError::DefinitelyNotSent {
                    reason: "fixture hidden".into(),
                }),
                "unknown" => Err(SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "fixture lost".into(),
                }),
                _ => Ok(Admission {
                    receipt: NativeReceipt {
                        target: p.target,
                        native_id: "turn".into(),
                    },
                }),
            }
        }
    }
    struct App {
        deliver: ScopedDeliverApplication<FixtureReader, Submit>,
        read: ScopedReadApplication<Reader>,
    }
    impl ApplicationPort for App {
        fn call<'a>(
            &'a self,
            id: &'a ConnectionIdentity,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                if matches!(request, catalog::Request::Deliver(_)) {
                    self.deliver.call(id, request).await
                } else {
                    self.read.call(id, request).await
                }
            })
        }
    }
    async fn request(
        w: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
        lines: &mut tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        v: Value,
    ) -> Value {
        w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
    }
    for outcome in ["not_sent", "unknown", "confirmed"] {
        let f = Fixture::new();
        create(&f);
        let mut policy = grants();
        policy.push(Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(SessionRef("issued".into())),
            action: Action::Read,
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let authority = Arc::new(f.authority());
        let app = Arc::new(App {
            deliver: ScopedDeliverApplication::new(
                authority.clone(),
                address().instance,
                policy.clone(),
                Arc::new(FixtureReader {
                    target: address(),
                    reads: AtomicUsize::new(0),
                    db: f.db.clone(),
                }),
                Arc::new(Submit {
                    outcome,
                    calls: calls.clone(),
                }),
                "9999-12-31T23:59:59Z".into(),
            )
            .unwrap(),
            read: ScopedReadApplication::new(
                f.authority(),
                address().instance,
                policy.clone(),
                Reader,
            ),
        });
        let reconcile_reader = Arc::new(FixtureReader {
            target: address(),
            reads: AtomicUsize::new(0),
            db: f.db.clone(),
        });
        let reconciler = Arc::new(
            herder::application::scoped_stop::task_reconcile::ScopedReceiptReconciler::new(
                authority.clone(),
                reconcile_reader,
            ),
        );
        let server =
            ScopedTaskServer::new(identity(), policy, authority, app).with_reconciler(reconciler);
        let (client, io) = tokio::io::duplex(65536);
        let job =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (r, mut w) = tokio::io::split(client);
        let mut lines = BufReader::new(r).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"principal":"spoofed"});
        let call = |id, msg: &str| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"issued","message":msg,"mode":"start","request_key":"key"}}});
        let no_tasks_meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"unsupported","version":"1"}});
        let unsupported=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"_meta":no_tasks_meta,"name":"deliver","arguments":{"action":"session","session_ref":"issued","message":"message","mode":"start","request_key":"key"}}})).await;
        assert!(unsupported.get("error").is_some(), "{unsupported}");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let first = request(&mut w, &mut lines, call(1, "message")).await;
        assert_eq!(first["result"]["resultType"], "task", "{first}");
        let task_id = first["result"]["taskId"].as_str().unwrap().to_owned();
        if outcome == "confirmed" {
            assert_eq!(first["result"]["status"], "working");
        }
        let poll=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"_meta":meta,"taskId":task_id}})).await;
        assert_eq!(poll["result"]["status"], "completed", "{poll}");
        let data = &poll["result"]["result"]["structuredContent"];
        match outcome {
            "not_sent" => assert_eq!(data["code"], "adapter_refused"),
            "unknown" => assert_eq!(data["effect"], "unknown"),
            _ => assert_eq!(data["outcome"], "confirmed"),
        };
        let conflict = request(&mut w, &mut lines, call(3, "different message")).await;
        assert_eq!(
            conflict["result"]["structuredContent"]["code"], "idempotency_conflict",
            "{conflict}"
        );
        let replay = request(&mut w, &mut lines, call(4, "message")).await;
        assert_eq!(replay["result"]["taskId"], task_id, "{replay}");
        let read=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":"issued"}}})).await;
        assert_eq!(
            read["result"]["structuredContent"]["page"]["messages"][0]["text"],
            "fixture-read"
        );
        let foreign = ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal {
                id: PrincipalId("bob".into()),
            }),
            None,
        );
        assert!(
            f.authority()
                .get_delivery_task(&foreign, &grants(), &task_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        drop(w);
        drop(lines);
        job.await.unwrap();
    }
}

#[tokio::test]
async fn scoped_create_application_wire_preserves_session_and_deduplicates_prompt() {
    use herder::{
        application::scoped_stop::{
            create_prompt::FreshSessionGrantPolicy,
            mcp_create::ScopedCreateApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_task_server::ScopedTaskServer,
        },
        mcp::{
            catalog,
            transport::{ApplicationFuture, ApplicationPort},
        },
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
        unknown: bool,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(
            &self,
            _: &str,
            prompt: &str,
        ) -> Result<SessionAddress, SubmitError> {
            assert_eq!(prompt, "prompt");
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.unknown {
                Err(SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "lost".into(),
                })
            } else {
                Ok(address())
            }
        }
    }
    struct Submit {
        outcome: &'static str,
        calls: AtomicUsize,
    }
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            m: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(m, "prompt");
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.outcome {
                "unknown" => Err(SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "lost".into(),
                }),
                "not_sent" => Err(SubmitError::DefinitelyNotSent {
                    reason: "private diagnostic".into(),
                }),
                _ => Ok(Admission {
                    receipt: NativeReceipt {
                        target: p.target,
                        native_id: "turn".into(),
                    },
                }),
            }
        }
    }
    struct Policy(std::sync::atomic::AtomicBool);
    impl FreshSessionGrantPolicy for Policy {
        fn session_write_grant(
            &self,
            p: &PrincipalId,
            _: &InstanceRef,
            s: &SessionRef,
        ) -> Result<Option<Grant>, ()> {
            Ok(self.0.load(Ordering::SeqCst).then(|| Grant {
                principal: p.clone(),
                resource: PrivateResource::Session(s.clone()),
                action: Action::Write,
            }))
        }
        fn session_read_grant(
            &self,
            p: &PrincipalId,
            _: &InstanceRef,
            s: &SessionRef,
        ) -> Result<Option<Grant>, ()> {
            Ok(self.0.load(Ordering::SeqCst).then(|| Grant {
                principal: p.clone(),
                resource: PrivateResource::Session(s.clone()),
                action: Action::Read,
            }))
        }
    }
    struct Reader;
    impl ScopedMessageReader for Reader {
        fn read_messages(&mut self, a: &SessionAddress) -> Result<Value, ()> {
            assert_eq!(*a, address());
            Ok(json!({"messages":[{"text":"fixture-read"}],"coverage":"complete"}))
        }
    }
    struct App {
        create: ScopedCreateApplication<Create, Issuer, Generation, FixtureReader, Submit, Policy>,
        db: PathBuf,
        gate: PathBuf,
        instance: InstanceRef,
        base: Vec<Grant>,
        policy: Arc<Policy>,
    }
    impl ApplicationPort for App {
        fn call<'a>(
            &'a self,
            id: &'a ConnectionIdentity,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                if matches!(request, catalog::Request::Create(_)) {
                    return self.create.call(id, request).await;
                }
                let catalog::Request::Session(catalog::Session::Messages {
                    ref session_ref, ..
                }) = request
                else {
                    return None;
                };
                let Caller::Principal(p) = id.caller() else {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        json!({"code":"unauthorized","effect":"none"}),
                    ));
                };
                let s = SessionRef(session_ref.clone());
                let mut grants = self.base.clone();
                if let Some(g) = self
                    .policy
                    .session_read_grant(&p.id, &self.instance, &s)
                    .unwrap()
                {
                    grants.push(g)
                }
                ScopedReadApplication::new(
                    ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into())
                        .unwrap(),
                    self.instance.clone(),
                    grants,
                    Reader,
                )
                .call(id, request)
                .await
            })
        }
    }
    async fn request(
        w: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
        lines: &mut tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        v: Value,
    ) -> Value {
        w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
    }
    for version in [3, 4] {
        for scenario in [
            "no_grant",
            "unknown_create",
            "unknown_delivery",
            "not_sent",
            "confirmed",
        ] {
            let f = Fixture::new();
            if version == 4 {
                f.migrate_v4();
            }
            let target = address();
            let authority = Arc::new(f.authority());
            let base:Vec<_>=grants().into_iter().filter(|g|matches!(&g.resource,PrivateResource::Resource(r) if r.starts_with("instance:"))).collect();
            let creator = Arc::new(Create {
                instance: target.instance.clone(),
                calls: AtomicUsize::new(0),
                unknown: scenario == "unknown_create",
            });
            let sender = Arc::new(Submit {
                outcome: if scenario == "unknown_delivery" {
                    "unknown"
                } else {
                    scenario
                },
                calls: AtomicUsize::new(0),
            });
            let policy = Arc::new(Policy(std::sync::atomic::AtomicBool::new(
                scenario != "no_grant",
            )));
            let app = Arc::new(App {
                create: ScopedCreateApplication::new(
                    authority.clone(),
                    "profile-ref".into(),
                    base.clone(),
                    creator.clone(),
                    Arc::new(Issuer),
                    Arc::new(Generation),
                    Arc::new(FixtureReader {
                        target: target.clone(),
                        reads: AtomicUsize::new(0),
                        db: f.db.clone(),
                    }),
                    sender.clone(),
                    policy.clone(),
                    "9999-12-31T23:59:59Z".into(),
                )
                .unwrap(),
                db: f.db.clone(),
                gate: f.gate.clone(),
                instance: target.instance,
                base: base.clone(),
                policy: policy.clone(),
            });
            let reconcile_reader = Arc::new(FixtureReader {
                target: address(),
                reads: AtomicUsize::new(0),
                db: f.db.clone(),
            });
            let reconciler = Arc::new(
                herder::application::scoped_stop::task_reconcile::ScopedReceiptReconciler::new(
                    authority.clone(),
                    reconcile_reader,
                ),
            );
            let server = ScopedTaskServer::new(identity(), base.clone(), authority, app)
                .with_create_policy(policy.clone())
                .with_reconciler(reconciler);
            let (client, io) = tokio::io::duplex(65536);
            let job =
                tokio::spawn(
                    async move { server.serve(io).await.unwrap().waiting().await.unwrap() },
                );
            let (r, mut w) = tokio::io::split(client);
            let mut lines = BufReader::new(r).lines();
            let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"principal":"spoofed"});
            let create = |id| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"profile-ref","prompt":"prompt","request_key":"key"}}});
            let no_tasks_meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"unsupported","version":"1"}});
            let no_tasks=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":90,"method":"tools/call","params":{"_meta":no_tasks_meta,"name":"create","arguments":{"action":"create","instance_ref":"profile-ref","prompt":"prompt","request_key":"key"}}})).await;
            assert!(no_tasks.get("error").is_some());
            assert_eq!(creator.calls.load(Ordering::SeqCst), 0);
            let first = request(&mut w, &mut lines, create(1)).await;
            assert_eq!(first["result"]["resultType"], "task", "{first}");
            let task = first["result"]["taskId"].as_str().unwrap().to_owned();
            if scenario == "confirmed" {
                assert_eq!(first["result"]["status"], "working");
            }
            let poll=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"_meta":meta,"taskId":task}})).await;
            assert_eq!(poll["result"]["status"], "completed", "{poll}");
            let data = &poll["result"]["result"]["structuredContent"];
            match scenario {
                "unknown_create" => assert_eq!(data["create"]["effect"], "unknown"),
                "no_grant" => {
                    assert_eq!(data["create"]["effect"], "confirmed");
                    assert_eq!(data["create"]["session_ref"], "issued");
                    assert_eq!(data["prompt"]["effect"], "none");
                    assert_ne!(data["effect"], "none");
                }
                "unknown_delivery" => assert_eq!(data["prompt"]["effect"], "unknown"),
                "not_sent" => {
                    assert_eq!(data["prompt"]["code"], "adapter_refused");
                    assert!(!data.to_string().contains("private diagnostic"));
                }
                _ => assert_eq!(data["prompt"]["outcome"], "confirmed"),
            };
            if scenario == "confirmed" {
                policy.0.store(false, Ordering::SeqCst);
                let revoked=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":80,"method":"tasks/get","params":{"_meta":meta,"taskId":task}})).await;
                assert!(
                    revoked.get("error").is_some(),
                    "revoked session read must deny cached aggregate: {revoked}"
                );
                assert!(
                    f.authority()
                        .get_create_task_with_policy(
                            &identity(),
                            &base,
                            &task,
                            Some(policy.as_ref())
                        )
                        .is_err()
                );
                assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
                assert_eq!(sender.calls.load(Ordering::SeqCst), 1);
                policy.0.store(true, Ordering::SeqCst);
            }
            if scenario == "no_grant" {
                policy.0.store(true, Ordering::SeqCst);
            }
            let again = request(&mut w, &mut lines, create(3)).await;
            assert_eq!(again["result"]["resultType"], "task", "{again}");
            if scenario == "not_sent" {
                let id = again["result"]["taskId"].as_str().unwrap();
                let replay=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":81,"method":"tasks/get","params":{"_meta":meta,"taskId":id}})).await;
                assert_eq!(
                    replay["result"]["result"]["structuredContent"]["prompt"]["code"],
                    "adapter_refused",
                    "{replay}"
                );
                assert_eq!(
                    replay["result"]["result"]["structuredContent"]["create"]["session_ref"],
                    "issued"
                );
                let db = Connection::open(&f.db).unwrap();
                let child: String = db
                    .query_row(
                        "SELECT task_id FROM intents WHERE state='rejected' AND target='issued'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                drop(db);
                let mut read_grants = grants();
                read_grants.push(Grant {
                    principal: PrincipalId("alice".into()),
                    resource: PrivateResource::Session(SessionRef("issued".into())),
                    action: Action::Read,
                });
                assert!(
                    f.authority()
                        .get_delivery_task(&identity(), &read_grants, &child)
                        .unwrap()
                        .is_some()
                );
            }

            let third = request(&mut w, &mut lines, create(5)).await;
            assert_eq!(third["result"]["resultType"], "task", "{third}");
            if scenario == "not_sent" {
                let id = third["result"]["taskId"].as_str().unwrap();
                let projected=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":82,"method":"tasks/get","params":{"_meta":meta,"taskId":id}})).await;
                assert_eq!(
                    projected["result"]["result"]["structuredContent"]["prompt"]["code"],
                    "adapter_refused",
                    "{projected}"
                );
            }

            if scenario == "confirmed" {
                assert_eq!(third["result"]["status"], "completed");
                let repeated_task = third["result"]["taskId"].as_str().unwrap();
                let recovered=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":7,"method":"tasks/get","params":{"_meta":meta,"taskId":repeated_task}})).await;
                assert_eq!(
                    recovered["result"]["result"]["structuredContent"]["prompt"]["outcome"],
                    "confirmed"
                );
            }
            let conflict=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"profile-ref","prompt":"changed prompt","request_key":"key"}}})).await;
            assert_eq!(conflict["result"]["resultType"], "task", "{conflict}");
            let conflict_id = conflict["result"]["taskId"].as_str().unwrap();
            let conflict_status=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":9,"method":"tasks/get","params":{"_meta":meta,"taskId":conflict_id}})).await;
            assert_eq!(
                conflict_status["result"]["result"]["structuredContent"]["code"],
                "idempotency_conflict",
                "{conflict_status}"
            );

            let original=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":6,"method":"tasks/get","params":{"_meta":meta,"taskId":task}})).await;
            assert_eq!(original["result"]["status"], "completed");
            if scenario == "no_grant" {
                assert_eq!(
                    original["result"]["result"]["structuredContent"]["prompt"]["code"],
                    "session_write_grant_required"
                );
            }
            assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                sender.calls.load(Ordering::SeqCst),
                if scenario == "unknown_create" { 0 } else { 1 }
            );
            if scenario != "unknown_create" {
                let read=request(&mut w,&mut lines,json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":"issued"}}})).await;
                assert_eq!(
                    read["result"]["structuredContent"]["page"]["messages"][0]["text"],
                    "fixture-read",
                    "{read}"
                );
            }
            drop(w);
            drop(lines);
            job.await.unwrap();
        }
    }
}

#[tokio::test]
async fn create_prompt_recovers_stopped_before_handoff_before_and_after_projection() {
    use herder::application::scoped_stop::create_prompt::{
        CreatePromptOutcome, NoAdditionalGrant, create_with_prompt,
    };
    use sha2::{Digest, Sha256};
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    for scope in ["session:issued", "global"] {
        let f = Fixture::new();
        let target = address();
        let creator = Create {
            instance: target.instance.clone(),
            calls: AtomicUsize::new(0),
        };
        let req = || CreateRequest {
            intent_id: "create",
            task_id: "create-task",
            request_key: "create-key",
            specification: "isolated",
            now: "now",
            retain_until: "later",
        };
        assert_eq!(
            f.authority()
                .create_fresh_root(
                    &identity(),
                    &grants(),
                    &creator,
                    &Issuer,
                    &Generation,
                    req()
                )
                .unwrap(),
            CreateResult::Created(SessionRef("issued".into()))
        );
        let hash = Sha256::digest(
            serde_json::to_vec(&("create-prompt-v1", "alice", &target.instance, "create-key"))
                .unwrap(),
        )
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
        let key = format!("create-prompt:{hash}");
        let b = binding(&target, "delivery-stopped", &key);
        let p = plan();
        let mut writer = Writer::open_file(&f.db).unwrap();
        writer
            .prepare_intent(&NewIntent {
                intent_id: b.intent_id,
                task_id: "delivery-task",
                principal: "alice",
                target: "issued",
                request_key: &key,
                payload_hash: &dispatch_payload_binding(&p, "isolated"),
                now: "now",
                retain_until: "later",
            })
            .unwrap();
        drop(writer);
        assert!(
            f.authority()
                .claim(&identity(), &grants(), &b, "scope-1", &p, "isolated", "now")
                .unwrap()
        );
        f.authority()
            .stop(&identity(), &grants(), scope, "human", "now")
            .unwrap();
        let sends = Arc::new(AtomicUsize::new(0));
        let control = NotSent {
            calls: sends.clone(),
        };
        assert_eq!(
            f.authority()
                .handoff(
                    &identity(),
                    &grants(),
                    &b,
                    "scope-1",
                    p,
                    "isolated",
                    "now",
                    &control
                )
                .unwrap(),
            DurableDispatch::StoppedBeforeHandoff
        );
        let reader = FixtureReader {
            target,
            reads: AtomicUsize::new(0),
            db: f.db.clone(),
        };
        let authority = f.authority();
        let first = create_with_prompt(
            &authority,
            &identity(),
            &grants(),
            &creator,
            &Issuer,
            &Generation,
            &reader,
            &control,
            &NoAdditionalGrant,
            req(),
        )
        .await
        .unwrap();
        assert_eq!(
            first,
            CreatePromptOutcome::StoppedBeforeHandoff {
                session: SessionRef("issued".into())
            }
        );
        let mut read_grants = grants();
        read_grants.push(Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(SessionRef("issued".into())),
            action: Action::Read,
        });
        assert!(
            authority
                .get_delivery_task(&identity(), &read_grants, "delivery-task")
                .unwrap()
                .is_some()
        );
        let after = create_with_prompt(
            &authority,
            &identity(),
            &grants(),
            &creator,
            &Issuer,
            &Generation,
            &reader,
            &control,
            &NoAdditionalGrant,
            req(),
        )
        .await
        .unwrap();
        assert_eq!(
            after,
            CreatePromptOutcome::StoppedBeforeHandoff {
                session: SessionRef("issued".into())
            }
        );
        assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
        assert_eq!(sends.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn task_reconciliation_checks_exact_receipt_without_holding_gate_or_transaction() {
    use herder::application::reconcile::Reconciliation;
    use herder::domain::adapter::{NativeSessionReader, Observation, ReadError, SessionSnapshot};
    struct Reader {
        db: PathBuf,
        gate: PathBuf,
        mismatch: bool,
        reads: AtomicUsize,
    }
    impl NativeSessionReader for Reader {
        async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            unreachable!()
        }
        async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let meta = std::fs::metadata(&self.gate).unwrap();
            let guard = acquire_pinned(&self.gate, meta.dev(), meta.ino()).unwrap();
            let db = Connection::open(&self.db).unwrap();
            db.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
            drop(guard);
            let mut observed = receipt.clone();
            if self.mismatch {
                observed.native_id = "different-turn".into();
            }
            Ok(Observation::Confirmed { receipt: observed })
        }
    }
    let f = Fixture::new();
    create(&f);
    let p = plan();
    f.prepare("i", "k", &p);
    let target = address();
    let b = binding(&target, "i", "k");
    assert!(
        f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    let sends = Arc::new(AtomicUsize::new(0));
    let control = Control {
        calls: sends.clone(),
        db: f.db.clone(),
        ready: None,
        proceed: None,
    };
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
    let mut read_grants = grants();
    read_grants.push(Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("issued".into())),
        action: Action::Read,
    });
    let mismatch = Reader {
        db: f.db.clone(),
        gate: f.gate.clone(),
        mismatch: true,
        reads: AtomicUsize::new(0),
    };
    assert_eq!(
        f.authority()
            .reconcile_delivery_task(&identity(), &read_grants, "task-i", &mismatch)
            .await
            .unwrap(),
        Reconciliation::Unknown
    );
    assert_eq!(
        serde_json::to_value(
            f.authority()
                .get_delivery_task(&identity(), &read_grants, "task-i")
                .unwrap()
                .unwrap()
        )
        .unwrap()["status"],
        "working"
    );
    let matched = Reader {
        db: f.db.clone(),
        gate: f.gate.clone(),
        mismatch: false,
        reads: AtomicUsize::new(0),
    };
    assert!(matches!(
        f.authority()
            .reconcile_delivery_task(&identity(), &read_grants, "task-i", &matched)
            .await
            .unwrap(),
        Reconciliation::Confirmed(_)
    ));
    let task = f
        .authority()
        .get_delivery_task(&identity(), &read_grants, "task-i")
        .unwrap()
        .unwrap();
    let wire = serde_json::to_value(&task).unwrap();
    assert_eq!(wire["status"], "completed");
    assert_eq!(wire["result"]["structuredContent"]["outcome"], "confirmed");
    assert_eq!(
        f.authority()
            .get_delivery_task(&identity(), &read_grants, "task-i")
            .unwrap()
            .unwrap(),
        task
    );
    assert!(
        !f.authority()
            .claim(&identity(), &grants(), &b, "scope-1", &p, "message", "now")
            .unwrap()
    );
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    assert_eq!(mismatch.reads.load(Ordering::SeqCst), 1);
    assert_eq!(matched.reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn direct_delivery_task_uses_current_exact_policy_after_reopen() {
    use herder::{
        application::scoped_stop::{
            create_prompt::FreshSessionGrantPolicy, mcp_deliver::ScopedDeliverApplication,
            mcp_task_server::ScopedTaskServer, task_reconcile::ScopedReceiptReconciler,
        },
        domain::adapter::{NativeSessionReader, Observation, ReadError, SessionSnapshot},
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Policy {
        allow: std::sync::atomic::AtomicBool,
        gate: PathBuf,
    }
    impl FreshSessionGrantPolicy for Policy {
        fn session_write_grant(
            &self,
            p: &PrincipalId,
            _: &InstanceRef,
            s: &SessionRef,
        ) -> Result<Option<Grant>, ()> {
            Ok(self.allow.load(Ordering::SeqCst).then(|| Grant {
                principal: p.clone(),
                resource: PrivateResource::Session(s.clone()),
                action: Action::Write,
            }))
        }
        fn session_read_grant(
            &self,
            p: &PrincipalId,
            _: &InstanceRef,
            s: &SessionRef,
        ) -> Result<Option<Grant>, ()> {
            let m = std::fs::metadata(&self.gate).unwrap();
            let guard = acquire_pinned(&self.gate, m.dev(), m.ino())
                .expect("policy must be called outside gate");
            drop(guard);
            Ok(self.allow.load(Ordering::SeqCst).then(|| Grant {
                principal: p.clone(),
                resource: PrivateResource::Session(s.clone()),
                action: Action::Read,
            }))
        }
    }
    struct Reader {
        db: PathBuf,
        reads: AtomicUsize,
    }
    impl NativeSessionReader for Reader {
        async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            FixtureReader {
                target: target.clone(),
                reads: AtomicUsize::new(0),
                db: self.db.clone(),
            }
            .snapshot(target)
            .await
        }
        async fn reconcile(&self, r: &NativeReceipt) -> Result<Observation, ReadError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(Observation::Confirmed { receipt: r.clone() })
        }
    }
    struct Submit(AtomicUsize);
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Admission {
                receipt: NativeReceipt {
                    target: p.target,
                    native_id: "turn-policy".into(),
                },
            })
        }
    }
    async fn exchange(server: ScopedTaskServer, requests: Vec<Value>) -> Vec<Value> {
        let (client, io) = tokio::io::duplex(65536);
        let job =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (r, mut w) = tokio::io::split(client);
        let mut lines = BufReader::new(r).lines();
        let mut out = Vec::new();
        for req in requests {
            w.write_all(format!("{req}\n").as_bytes()).await.unwrap();
            out.push(serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap())
        }
        drop(w);
        drop(lines);
        job.await.unwrap();
        out
    }
    let f = Fixture::new();
    create(&f);
    let authority = Arc::new(f.authority());
    let base: Vec<_> = grants()
        .into_iter()
        .filter(
            |g| matches!(&g.resource,PrivateResource::Resource(r) if r.starts_with("instance:")),
        )
        .collect();
    let policy = Arc::new(Policy {
        allow: std::sync::atomic::AtomicBool::new(true),
        gate: f.gate.clone(),
    });
    let reader = Arc::new(Reader {
        db: f.db.clone(),
        reads: AtomicUsize::new(0),
    });
    let sender = Arc::new(Submit(AtomicUsize::new(0)));
    let app = Arc::new(
        ScopedDeliverApplication::new(
            authority.clone(),
            address().instance,
            base.clone(),
            reader.clone(),
            sender.clone(),
            "9999-12-31T23:59:59Z".into(),
        )
        .unwrap()
        .with_policy(policy.clone()),
    );
    let server = || {
        ScopedTaskServer::new(identity(), base.clone(), authority.clone(), app.clone())
            .with_create_policy(policy.clone())
            .with_reconciler(Arc::new(ScopedReceiptReconciler::new(
                authority.clone(),
                reader.clone(),
            )))
    };
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"principal":"spoofed"});
    let first=exchange(server(),vec![json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"issued","message":"message","mode":"start","request_key":"direct-key"}}})]).await;
    assert_eq!(first[0]["result"]["resultType"], "task", "{:?}", first);
    let task = first[0]["result"]["taskId"].as_str().unwrap().to_owned();
    let get = || json!({"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"_meta":meta,"taskId":task}});
    let completed = exchange(server(), vec![get()]).await;
    assert_eq!(
        completed[0]["result"]["status"], "completed",
        "{:?}",
        completed
    );
    assert_eq!(
        completed[0]["result"]["result"]["structuredContent"]["outcome"],
        "confirmed"
    );
    let reopen = exchange(server(), vec![get()]).await;
    assert_eq!(reopen[0]["result"]["status"], "completed");
    policy.allow.store(false, Ordering::SeqCst);
    let denied = exchange(server(), vec![get()]).await;
    assert!(denied[0].get("error").is_some(), "{:?}", denied);
    let denied_after_reopen = exchange(server(), vec![get()]).await;
    assert!(denied_after_reopen[0].get("error").is_some());
    assert_eq!(sender.0.load(Ordering::SeqCst), 1);
    assert_eq!(reader.reads.load(Ordering::SeqCst), 1);
    let db = Connection::open(&f.db).unwrap();
    assert_eq!(
        db.query_row("SELECT status FROM tasks WHERE task_id=?1", [&task], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "completed"
    );
}

#[tokio::test]
async fn create_wire_reports_actionable_input_errors_without_effect_or_echo() {
    use herder::{
        application::scoped_stop::{
            create_prompt::NoAdditionalGrant, mcp_create::ScopedCreateApplication,
            mcp_task_server::ScopedTaskServer,
        },
        domain::adapter::{NativeSessionReader, Observation, ReadError, SessionSnapshot},
    };
    use rmcp::ServiceExt;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct Create(InstanceRef, AtomicUsize);
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.0
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    struct Reader;
    impl NativeSessionReader for Reader {
        async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            panic!("no snapshot for invalid create")
        }
        async fn reconcile(&self, _: &NativeReceipt) -> Result<Observation, ReadError> {
            panic!("no reconciliation for invalid create")
        }
    }
    struct Submit(AtomicUsize);
    impl BoundedNativeHandoff for Submit {
        fn submit_bounded(
            &self,
            _: DispatchPlan,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            panic!("no submit for invalid create")
        }
    }
    let f = Fixture::new();
    let authority = Arc::new(f.authority());
    let creator = Arc::new(Create(address().instance, AtomicUsize::new(0)));
    let sender = Arc::new(Submit(AtomicUsize::new(0)));
    let app = Arc::new(
        ScopedCreateApplication::new(
            authority.clone(),
            "profile-ref".into(),
            grants(),
            creator.clone(),
            Arc::new(Issuer),
            Arc::new(Generation),
            Arc::new(Reader),
            sender.clone(),
            Arc::new(NoAdditionalGrant),
            "9999-12-31T23:59:59Z".into(),
        )
        .unwrap(),
    );
    let server = ScopedTaskServer::new(identity(), grants(), authority.clone(), app.clone());
    let (client, io) = tokio::io::duplex(65536);
    let job = tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
    let (r, mut w) = tokio::io::split(client);
    let mut lines = BufReader::new(r).lines();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"}});
    for (id, args, field, code) in [
        (
            1,
            json!({"action":"create","instance_ref":"wrong","prompt":"secret-marker","request_key":"key"}),
            "instance_ref",
            "instance_mismatch",
        ),
        (
            2,
            json!({"action":"create","instance_ref":"profile-ref","project_ref":"private-project","prompt":"secret-marker","request_key":"key"}),
            "project_ref",
            "project_unsupported",
        ),
        (
            3,
            json!({"action":"create","instance_ref":"profile-ref","prompt":"","request_key":"key"}),
            "prompt",
            "prompt_required",
        ),
        (
            4,
            json!({"action":"create","instance_ref":"profile-ref","prompt":"secret-marker","request_key":""}),
            "request_key",
            "request_key_invalid",
        ),
        (
            5,
            json!({"action":"create","instance_ref":"profile-ref","prompt":"secret-marker","request_key":"bad\nkey"}),
            "request_key",
            "request_key_invalid",
        ),
    ] {
        let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":args}});
        w.write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let d = &response["result"]["structuredContent"];
        assert_eq!(d["code"], code, "{response}");
        assert_eq!(d["field"], field);
        assert_eq!(d["effect"], "none");
        assert!(d["expected"].as_array().is_some_and(|x| !x.is_empty()));
        assert!(d["correction"].as_str().is_some_and(|x| !x.is_empty()));
        assert!(!response.to_string().contains("secret-marker"));
        assert!(!response.to_string().contains("private-project"));
    }
    assert_eq!(creator.1.load(Ordering::SeqCst), 0);
    assert_eq!(sender.0.load(Ordering::SeqCst), 0);
    let db = Connection::open(&f.db).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM intents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(w);
    drop(lines);
    job.await.unwrap();
    let bob = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("bob".into()),
        }),
        None,
    );
    let server = ScopedTaskServer::new(bob, grants(), authority, app);
    let (client, io) = tokio::io::duplex(65536);
    let job = tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
    let (r, mut w) = tokio::io::split(client);
    let mut lines = BufReader::new(r).lines();
    let request = json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"wrong","project_ref":"private-project","prompt":"secret-marker","request_key":""}}});
    w.write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let response: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    let diagnostic = &response["result"]["structuredContent"];
    assert_eq!(diagnostic["code"], "unauthorized", "{response}");
    assert_eq!(diagnostic["effect"], "none");
    assert!(diagnostic.get("field").is_none(), "{response}");
    let rendered = response.to_string();
    for secret in [
        "secret-marker",
        "private-project",
        "profile-ref",
        "instance_mismatch",
    ] {
        assert!(!rendered.contains(secret), "{response}");
    }
    assert_eq!(creator.1.load(Ordering::SeqCst), 0);
    assert_eq!(sender.0.load(Ordering::SeqCst), 0);
    let db = Connection::open(&f.db).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM intents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(w);
    drop(lines);
    job.await.unwrap();
}

#[tokio::test]
async fn fresh_create_uses_explicit_trusted_queue_mode_and_never_replays() {
    use herder::application::scoped_stop::create_prompt::{
        CreatePromptOutcome, NoAdditionalGrant, create_with_prompt,
    };
    use herder::domain::adapter::{
        NativeReceipt, NativeSessionReader, Observation, ReadError, SendMode, SessionSnapshot,
    };
    struct Create {
        instance: InstanceRef,
        calls: AtomicUsize,
    }
    impl BoundedFreshRootCreate for Create {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn initial_delivery_mode(&self) -> SendMode {
            SendMode::Queue
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(address())
        }
    }
    struct QueueReader(FixtureReader);
    impl NativeSessionReader for QueueReader {
        async fn snapshot(&self, a: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            let mut s = self.0.snapshot(a).await?;
            s.capabilities[0].name = "deliver.queue".into();
            Ok(s)
        }
        async fn reconcile(&self, r: &NativeReceipt) -> Result<Observation, ReadError> {
            self.0.reconcile(r).await
        }
    }
    struct Sender(AtomicUsize);
    impl BoundedNativeHandoff for Sender {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(p.mode, SendMode::Queue);
            assert_eq!(p.expected_turn, None);
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Admission {
                receipt: NativeReceipt {
                    target: p.target,
                    native_id: "queue-receipt".into(),
                },
            })
        }
    }
    let f = Fixture::new();
    let a = address();
    let creator = Create {
        instance: a.instance.clone(),
        calls: AtomicUsize::new(0),
    };
    let sender = Sender(AtomicUsize::new(0));
    let reader = QueueReader(FixtureReader {
        target: a,
        reads: AtomicUsize::new(0),
        db: f.db.clone(),
    });
    let req = || CreateRequest {
        intent_id: "queue-create",
        task_id: "queue-task",
        request_key: "queue-key",
        specification: "prompt",
        now: "now",
        retain_until: "later",
    };
    let auth = f.authority();
    for _ in 0..2 {
        let result = create_with_prompt(
            &auth,
            &identity(),
            &grants(),
            &creator,
            &Issuer,
            &Generation,
            &reader,
            &sender,
            &NoAdditionalGrant,
            req(),
        )
        .await
        .unwrap();
        assert!(
            matches!(result, CreatePromptOutcome::Admitted { .. }),
            "{result:?}"
        );
    }
    assert_eq!(creator.calls.load(Ordering::SeqCst), 1);
    assert_eq!(sender.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn direct_queue_delivery_requires_trusted_composition_and_deduplicates() {
    use herder::{
        application::scoped_stop::mcp_deliver::ScopedDeliverApplication,
        domain::adapter::{
            NativeReceipt, NativeSessionReader, Observation, ReadError, SendMode, SessionSnapshot,
        },
        mcp::{catalog, transport::ApplicationPort},
    };
    struct QueueReader {
        inner: FixtureReader,
        busy: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }
    impl NativeSessionReader for QueueReader {
        async fn snapshot(&self, a: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            let mut s = self.inner.snapshot(a).await?;
            if self.busy.load(Ordering::SeqCst) {
                s.activity = herder::domain::adapter::SessionActivity::Busy {
                    turn_id: "other-turn".into(),
                };
            }
            s.capabilities[0].name = "deliver.queue".into();
            Ok(s)
        }
        async fn reconcile(&self, r: &NativeReceipt) -> Result<Observation, ReadError> {
            self.inner.reconcile(r).await
        }
    }
    struct Sender(AtomicUsize);
    impl BoundedNativeHandoff for Sender {
        fn submit_bounded(
            &self,
            p: DispatchPlan,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert_eq!(p.mode, SendMode::Queue);
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Admission {
                receipt: NativeReceipt {
                    target: p.target,
                    native_id: "msg_ABC".into(),
                },
            })
        }
    }
    let f = Fixture::new();
    create(&f);
    let mut allowed = grants();
    allowed.push(Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(SessionRef("issued".into())),
        action: Action::Read,
    });
    let a = address();
    let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let reader = std::sync::Arc::new(QueueReader {
        inner: FixtureReader {
            target: a.clone(),
            reads: AtomicUsize::new(0),
            db: f.db.clone(),
        },
        busy: busy.clone(),
    });
    let sender = std::sync::Arc::new(Sender(AtomicUsize::new(0)));
    let app = ScopedDeliverApplication::new(
        std::sync::Arc::new(f.authority()),
        a.instance.clone(),
        allowed.clone(),
        reader.clone(),
        sender.clone(),
        "later".into(),
    )
    .unwrap();
    let req = || {
        catalog::Request::Deliver(catalog::Deliver::Session {
            session_ref: "issued".into(),
            message: "hi".into(),
            mode: catalog::DeliveryMode::Queue,
            request_key: "queue-key".into(),
        })
    };
    let denied = app.call(&identity(), req()).await.unwrap();
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(sender.0.load(Ordering::SeqCst), 0);
    let queue = app.with_delivery_mode(SendMode::Queue).unwrap();
    let busy_result = queue.call(&identity(), req()).await.unwrap();
    assert_eq!(busy_result.is_error, Some(true));
    assert_eq!(sender.0.load(Ordering::SeqCst), 0);
    busy.store(false, Ordering::SeqCst);
    let first = queue.call(&identity(), req()).await.unwrap();
    let second = queue.call(&identity(), req()).await.unwrap();
    assert_eq!(first.structured_content, second.structured_content);
    assert_eq!(sender.0.load(Ordering::SeqCst), 1);
}

#[test]
fn archive_is_scoped_durable_and_does_not_repeat_after_restart() {
    use serde_json::json;
    let f = Fixture::new(); create(&f);
    let calls = AtomicUsize::new(0);
    let archive = |id: &str| { calls.fetch_add(1, Ordering::SeqCst); Ok(json!({"ok":true,"sessionId":id})) };
    let result = f.authority().archive_session(&identity(),&grants(),&SessionRef("issued".into()),&address().instance,"cleanup-1",archive).unwrap();
    assert_eq!(result["archived"],true);
    let again = f.authority().archive_session(&identity(),&grants(),&SessionRef("issued".into()),&address().instance,"cleanup-1",archive).unwrap();
    assert_eq!(result,again); assert_eq!(calls.load(Ordering::SeqCst),1);
    assert!(f.authority().archive_session(&identity(),&[],&SessionRef("issued".into()),&address().instance,"cleanup-2",archive).is_err());
    let mut wrong = address().instance; wrong.instance_id = "other".into();
    assert!(f.authority().archive_session(&identity(),&grants(),&SessionRef("issued".into()),&wrong,"cleanup-2",archive).is_err());
    assert_eq!(calls.load(Ordering::SeqCst),1);
}

#[test]
fn archive_preserves_unknown_and_respects_stop() {
    use serde_json::json;
    let f=Fixture::new();create(&f);
    let s=SessionRef("issued".into());let i=address().instance;
    let unknown=f.authority().archive_session(&identity(),&grants(),&s,&i,"unknown",|_|Err(())).unwrap();
    assert_eq!(unknown["effect"],"unknown");
    assert_eq!(f.authority().archive_session(&identity(),&grants(),&s,&i,"unknown",|_|panic!("replay")).unwrap(),unknown);
    let stopped=Fixture::new();create(&stopped);
    stopped.authority().stop(&identity(),&grants(),"global","test","t").unwrap();
    assert_eq!(stopped.authority().archive_session(&identity(),&grants(),&s,&i,"held",|_|Ok(json!({"ok":true,"sessionId":"native-root"}))).unwrap()["code"],"human_stop");
    let parsed=herder::mcp::catalog::dispatch("session",json!({"action":"archive","session_ref":"issued","request_key":"cleanup"})).unwrap();
    assert_eq!(parsed.access,herder::mcp::catalog::Access::Mutate);
}
