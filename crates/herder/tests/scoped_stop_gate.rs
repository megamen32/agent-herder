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
impl BoundedFreshRootCreate for Creator {
    fn instance(&self) -> &InstanceRef {
        &self.0
    }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, ()> {
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
    assert_eq!(
        f.authority()
            .stop(&identity(), &grants(), "session:issued", "manual", "t"),
        Err(GateError::Busy)
    );
    go_tx.send(()).unwrap();
    assert!(matches!(
        child.join().unwrap(),
        DurableDispatch::Admitted(_)
    ));
    assert_eq!(
        f.authority()
            .stop(&identity(), &grants(), "session:issued", "manual", "t")
            .unwrap(),
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
    use std::io::{BufRead, Write};
    let Some(db) = std::env::var_os("HERDER_SCOPED_TEST_DB") else {
        return;
    };
    let gate = std::env::var_os("HERDER_SCOPED_TEST_GATE").unwrap();
    let authority = ScopedAuthority::new(db.into(), gate.into(), "authority-1".into()).unwrap();
    assert_eq!(
        authority.stop(&identity(), &grants(), "session:issued", "manual", "t"),
        Err(GateError::Busy)
    );
    println!("CHILD_BUSY");
    std::io::stdout().flush().unwrap();
    let mut signal = String::new();
    std::io::stdin().lock().read_line(&mut signal).unwrap();
    assert_eq!(signal.trim(), "continue");
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
        io::{BufRead, BufReader, Write},
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
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "continue").unwrap();
    stdin.flush().unwrap();
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
    fn interrupt_exact(&self, target: &SessionAddress, native_turn_id: &str) -> Result<(), ()> {
        assert_eq!(*target, address());
        assert_eq!(native_turn_id, "turn-1");
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.lost { Err(()) } else { Ok(()) }
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
                p,
                "message",
                "t",
                &control
            )
            .unwrap(),
        DurableDispatch::NotClaimed
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
            connection::CodexInstance,
            control::{CodexControl, RequestReceiptLookup},
        },
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
        control: CodexControl,
        instance: InstanceRef,
        cwd: String,
    }
    impl BoundedFreshRootCreate for Live {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, ()> {
            self.control.start_thread(&self.cwd).map_err(|_| ())
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
            let mut f = std::pin::pin!(self.control.submit(p, m, k));
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
    let home = f.root.join("codex-home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("config.toml"),format!("model = \"herder-test\"\nmodel_provider = \"fixture\"\n[model_providers.fixture]\nname = \"fixture\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"fixture-only\"\n")).unwrap();
    let instance = address().instance;
    let control = CodexControl::open(
        CodexInstance {
            instance_id: instance.instance_id.clone(),
            executable: PathBuf::from(std::env::var("HERDER_TEST_CODEX_BIN").unwrap()),
            code_home: home,
            cwd: f.root.clone(),
        },
        instance.clone(),
        Duration::from_secs(15),
    )
    .unwrap();
    let live = Live {
        control,
        instance,
        cwd: f.root.to_string_lossy().into_owned(),
    };
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
            .stop(&identity(), &grants(), "session:issued", "manual", "now")
            .unwrap(),
        StopDisposition::InterruptOrReconcileRequired
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
        Ok(SessionSnapshot {
            address: self.target.clone(),
            human_stop: false,
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
    assert!(matches!(
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
        Ok(DurableDispatch::Admitted(_))
    ));
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
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, ()> {
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
    assert_eq!(
        f.authority()
            .stop(&identity(), &grants(), "global", "stop", "now"),
        Err(GateError::Busy)
    );
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
        f.authority()
            .stop(&identity(), &grants(), "global", "stop", "now")
            .unwrap(),
        StopDisposition::HeldBeforeHandoff
    );
}
