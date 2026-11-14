#![cfg(any(target_os = "linux", target_os = "macos"))]
use herder::{
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, ScopeGenerationIssuer, ScopedAuthority,
            automation_driver::{self, AutomationOwner, AutomationTick},
            create_prompt::FreshSessionGrantPolicy,
            mcp_deliver::ScopedDeliverApplication,
            task_reconcile::ScopedReceiptReconciler,
            wait_automation::{
                DependencyRegistry, DependencySource, NativeTurn, NativeTurnReader,
                NativeTurnStatus, WaitAutomationApplication,
            },
        },
        target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
        target_gate::acquire_pinned,
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::{
        adapter::{
            Admission, DispatchPlan, NativeReceipt, NativeSessionReader, Observation, ReadError,
            RequestKey, SendMode, SessionActivity, SessionSnapshot, SubmitError,
        },
        address::{
            Authorization, Availability, Capability, CapabilityVersion, InstanceRef, NodeRef,
            SessionAddress, SessionRef, Support,
        },
    },
    mcp::{catalog, transport::ApplicationPort},
    store::Writer,
};
use rusqlite::{Connection, functions::FunctionFlags};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    future::Future,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn identity() -> ConnectionIdentity {
    ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("alice".into()),
        }),
        None,
    )
}
struct Store {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Store {
    fn new() -> Arc<Self> {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "herder-canonical-waits-{}-{}",
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
        let c = Connection::open(&db).unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        c.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(1),
        )
        .unwrap();
        c.execute_batch(include_str!("../src/store/migration_v1_v2.sql"))
            .unwrap();
        c.execute_batch(include_str!("../src/store/migration_v2_v3.sql"))
            .unwrap();
        drop(c);
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate)
            .unwrap();
        let m = f.metadata().unwrap();
        let guard = acquire_pinned(&gate, m.dev(), m.ino()).unwrap();
        assert!(
            Writer::open_file(&db)
                .unwrap()
                .initialize_fresh_stop_authority(&guard, "authority-1", "now")
                .unwrap()
        );
        drop(guard);
        drop(f);
        Arc::new(Self { root, db, gate })
    }
    fn authority(&self) -> Arc<ScopedAuthority> {
        Arc::new(
            ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into()).unwrap(),
        )
    }
    fn change(&self, sql: &str) {
        let m = fs::metadata(&self.gate).unwrap();
        let _gate = acquire_pinned(&self.gate, m.dev(), m.ino()).unwrap();
        let c = Connection::open(&self.db).unwrap();
        let version: i64 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        c.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |_| Ok(version),
        )
        .unwrap();
        c.execute_batch(sql).unwrap();
    }
    fn wake_count(&self) -> usize {
        Connection::open(&self.db)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM intents WHERE request_key LIKE 'wait-wake:%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }
}
struct Issuer(String);
impl SessionRefIssuer for Issuer {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
        Ok(SessionRef(self.0.clone()))
    }
}
impl ScopeGenerationIssuer for Issuer {
    fn issue(&self) -> Result<String, ()> {
        Ok(format!("scope-{}", self.0))
    }
}
struct Creator(SessionAddress);
impl BoundedFreshRootCreate for Creator {
    fn instance(&self) -> &InstanceRef {
        &self.0.instance
    }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
        Ok(self.0.clone())
    }
}
struct Policy {
    instance: InstanceRef,
    session: String,
    revoked: AtomicBool,
}
impl FreshSessionGrantPolicy for Policy {
    fn session_read_grant(
        &self,
        p: &PrincipalId,
        i: &InstanceRef,
        s: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok((p.0 == "alice"
            && i == &self.instance
            && s.0 == self.session
            && !self.revoked.load(Ordering::SeqCst))
        .then(|| Grant {
            principal: p.clone(),
            resource: PrivateResource::Session(s.clone()),
            action: Action::Read,
        }))
    }
    fn session_write_grant(
        &self,
        p: &PrincipalId,
        i: &InstanceRef,
        s: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok(self.session_read_grant(p, i, s)?.map(|mut g| {
            g.action = Action::Write;
            g
        }))
    }
}
struct Native {
    address: SessionAddress,
    turn: Mutex<Option<NativeTurn>>,
    reads: AtomicUsize,
    submits: AtomicUsize,
    lost_ack: AtomicBool,
    reject_submit: AtomicBool,
    receipt_ready: AtomicBool,
    last_key: Mutex<Option<String>>,
    must_hold_gates: Mutex<Vec<PathBuf>>,
}
impl Native {
    fn set(&self, id: &str, status: NativeTurnStatus) {
        *self.turn.lock().unwrap() = Some(NativeTurn {
            turn_id: id.into(),
            status,
        });
    }
}
impl NativeTurnReader for Native {
    fn current_turn(&self, target: &SessionAddress) -> Result<Option<NativeTurn>, ReadError> {
        assert_eq!(target, &self.address);
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.turn.lock().unwrap().clone())
    }
}
impl NativeSessionReader for Native {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop: false,
            activity: SessionActivity::Idle,
            capabilities: vec![Capability {
                name: "deliver.start".into(),
                version: CapabilityVersion {
                    adapter_version: "fixture".into(),
                    capability_version: "1".into(),
                },
                supported: Support::Supported,
                available: Availability::Available,
                authorized: Authorization::Authorized,
            }],
        })
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        Ok(if self.receipt_ready.load(Ordering::SeqCst) {
            Observation::Confirmed {
                receipt: receipt.clone(),
            }
        } else {
            Observation::Pending {
                receipt: receipt.clone(),
            }
        })
    }
    async fn recover_admission(
        &self,
        target: &SessionAddress,
        key: &RequestKey,
    ) -> Result<Option<NativeReceipt>, ReadError> {
        assert_eq!(target, &self.address);
        Ok((self.receipt_ready.load(Ordering::SeqCst)
            && self.last_key.lock().unwrap().as_deref() == Some(&key.0))
        .then(|| NativeReceipt {
            target: target.clone(),
            native_id: "exact-wake-receipt".into(),
        }))
    }
}
impl BoundedNativeHandoff for Native {
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        _: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        for gate in self.must_hold_gates.lock().unwrap().iter() {
            let m = fs::metadata(gate).unwrap();
            assert!(
                matches!(acquire_pinned(gate,m.dev(),m.ino()),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock),
                "dependency gate must cover native handoff"
            );
        }
        assert_eq!(plan.target, self.address);
        self.submits.fetch_add(1, Ordering::SeqCst);
        *self.last_key.lock().unwrap() = Some(key.0.clone());
        if self.reject_submit.load(Ordering::SeqCst) {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "fixture admission refused".into(),
            });
        }
        if self.lost_ack.load(Ordering::SeqCst) {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "lost fixture ACK".into(),
            });
        }
        Ok(Admission {
            receipt: NativeReceipt {
                target: plan.target,
                native_id: "exact-wake-receipt".into(),
            },
        })
    }
}
struct Owner {
    store: Arc<Store>,
    session: String,
    instance: InstanceRef,
    policy: Arc<Policy>,
    native: Arc<Native>,
    source: Arc<DependencySource>,
}
impl Owner {
    fn new(label: &str) -> Self {
        Self::in_store(Store::new(), label, label)
    }
    fn in_store(store: Arc<Store>, label: &str, native_id: &str) -> Self {
        let instance = InstanceRef {
            node: NodeRef("node".into()),
            instance_id: format!("profile-{label}"),
        };
        let session = format!("session-{label}");
        let address = SessionAddress {
            instance: instance.clone(),
            native_session_id: native_id.into(),
        };
        let grants = Self::grants_for(&instance);
        let issuer = Issuer(session.clone());
        let result = store
            .authority()
            .create_fresh_root(
                &identity(),
                &grants,
                &Creator(address.clone()),
                &issuer,
                &issuer,
                CreateRequest {
                    intent_id: &format!("create-{label}"),
                    task_id: &format!("create-task-{label}"),
                    request_key: label,
                    specification: "fixture",
                    now: "now",
                    retain_until: "later",
                },
            )
            .unwrap();
        assert_eq!(result, CreateResult::Created(SessionRef(session.clone())));
        let policy = Arc::new(Policy {
            instance: instance.clone(),
            session: session.clone(),
            revoked: AtomicBool::new(false),
        });
        let native = Arc::new(Native {
            address,
            turn: Mutex::new(Some(NativeTurn {
                turn_id: format!("turn-{label}"),
                status: NativeTurnStatus::Running,
            })),
            reads: AtomicUsize::new(0),
            submits: AtomicUsize::new(0),
            lost_ack: AtomicBool::new(false),
            reject_submit: AtomicBool::new(false),
            receipt_ready: AtomicBool::new(true),
            last_key: Mutex::new(None),
            must_hold_gates: Mutex::new(Vec::new()),
        });
        let source = Arc::new(DependencySource::new(
            store.authority(),
            instance.clone(),
            "fixture-harness".into(),
            PrincipalId("alice".into()),
            grants,
            policy.clone(),
            native.clone(),
        ));
        Self {
            store,
            session,
            instance,
            policy,
            native,
            source,
        }
    }
    fn grants_for(i: &InstanceRef) -> Vec<Grant> {
        vec![
            Grant {
                principal: PrincipalId("alice".into()),
                resource: PrivateResource::Resource(format!(
                    "instance:{}",
                    serde_json::to_string(i).unwrap()
                )),
                action: Action::Write,
            },
            Grant {
                principal: PrincipalId("alice".into()),
                resource: PrivateResource::Resource("humanstop:global".into()),
                action: Action::Write,
            },
        ]
    }
    fn app(&self, registry: Arc<DependencyRegistry>) -> Arc<WaitAutomationApplication> {
        self.app_with_capability(registry, true)
    }
    fn app_with_capability(
        &self,
        registry: Arc<DependencyRegistry>,
        allowed: bool,
    ) -> Arc<WaitAutomationApplication> {
        let authority = self.store.authority();
        let deliver = Arc::new(
            ScopedDeliverApplication::new(
                authority.clone(),
                self.instance.clone(),
                Self::grants_for(&self.instance),
                self.native.clone(),
                self.native.clone(),
                "9999-12-31T23:59:59Z".into(),
            )
            .unwrap()
            .with_delivery_mode(SendMode::Start)
            .unwrap()
            .with_policy(self.policy.clone()),
        );
        let reconciler = Arc::new(ScopedReceiptReconciler::new(authority, self.native.clone()));
        Arc::new(
            WaitAutomationApplication::new(
                self.source.clone(),
                registry,
                deliver,
                catalog::DeliveryMode::Start,
                reconciler,
                self.policy.clone(),
            )
            .with_automatic_continuation(allowed),
        )
    }
    fn stop_and_release(&self) {
        self.store
            .authority()
            .stop(
                &identity(),
                &Self::grants_for(&self.instance),
                "global",
                "fixture stop",
                "now",
            )
            .unwrap();
        self.store
            .change("UPDATE humanstop_holds SET released_at='later' WHERE scope_ref='global'");
    }
    fn timer(&self, key: &str, trigger: catalog::TimerTrigger) -> catalog::Automation {
        catalog::Automation::Create {
            session_ref: self.session.clone(),
            request_key: key.into(),
            rule: catalog::AutomationRule::Timer {
                trigger,
                wake_message: "resume fixture".into(),
            },
        }
    }
    fn depends(&self, key: &str, refs: Vec<String>) -> catalog::Automation {
        catalog::Automation::Create {
            session_ref: self.session.clone(),
            request_key: key.into(),
            rule: catalog::AutomationRule::SessionCompletion {
                dependencies: refs,
                wake_message: "inspect completed turns".into(),
            },
        }
    }
}
fn registry(owners: &[&Owner]) -> Arc<DependencyRegistry> {
    let r = Arc::new(DependencyRegistry::new());
    r.configure(owners.iter().map(|o| o.source.clone()).collect())
        .unwrap();
    r
}
async fn call(app: &WaitAutomationApplication, action: catalog::Automation) -> Value {
    app.call(&identity(), catalog::Request::Automation(action))
        .await
        .unwrap()
        .structured_content
        .unwrap()
}
async fn get(app: &WaitAutomationApplication, reference: &str) -> Value {
    call(
        app,
        catalog::Automation::Get {
            rule_ref: reference.into(),
        },
    )
    .await
}
fn reference(v: &Value) -> String {
    v.get("rule_ref")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{v}"))
        .into()
}
fn past() -> catalog::TimerTrigger {
    catalog::TimerTrigger::At {
        at: "2020-02-29T03:04:05.006+03:00".into(),
    }
}

#[tokio::test]
async fn delay_due_is_admitted_once_and_original_request_survives_restart() {
    let owner = Owner::new("parent");
    let routes = registry(&[&owner]);
    let app = owner.app(routes.clone());
    let request = owner.timer(
        "stable-delay",
        catalog::TimerTrigger::Delay { delay_ms: 60_000 },
    );
    let first = call(&app, request.clone()).await;
    assert_eq!(first["status"], "armed");
    assert!(first["due_unix_ms"].is_u64());
    tokio::time::sleep(Duration::from_millis(5)).await;
    let retry = call(&app, request.clone()).await;
    assert_eq!(first, retry);
    drop(app);
    let reopened = owner.app(routes);
    assert_eq!(first, call(&reopened, request).await);
    assert_eq!(owner.native.reads.load(Ordering::SeqCst), 0);
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 0);
    let conflict = call(
        &reopened,
        owner.timer(
            "stable-delay",
            catalog::TimerTrigger::Delay { delay_ms: 60_001 },
        ),
    )
    .await;
    assert_eq!(conflict["code"], "idempotency_conflict");
    let utc = call(&reopened, owner.timer("absolute", past())).await;
    assert_eq!(utc["due_at"], "2020-02-29T00:04:05.006Z");
    let invalid = call(
        &reopened,
        owner.timer(
            "bad-date",
            catalog::TimerTrigger::At {
                at: "2026-02-30T00:00:00Z".into(),
            },
        ),
    )
    .await;
    assert_eq!(invalid["code"], "invalid_timer");
}

#[tokio::test]
async fn timer_recovery_uses_existing_intent_and_never_sends_a_second_wake() {
    let owner = Owner::new("parent");
    let routes = registry(&[&owner]);
    let app = owner.app(routes.clone());
    let first = call(&app, owner.timer("once", past())).await;
    let reference = reference(&first);
    drop(app);
    let restarted = owner.app(routes.clone());
    restarted.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
    restarted.reconcile_registered(&identity()).await;
    assert_eq!(get(&restarted, &reference).await["status"], "confirmed");
    drop(restarted);
    let again = owner.app(routes);
    again.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(owner.store.wake_count(), 1);
}

#[tokio::test]
async fn cross_owner_wait_captures_exact_turn_and_idle_or_another_turn_never_completes_it() {
    let parent = Owner::new("parent");
    let child = Owner::new("child");
    let routes = registry(&[&parent, &child]);
    let app = parent.app(routes);
    let request = parent.depends("exact", vec![child.session.clone()]);
    let first = call(&app, request.clone()).await;
    let id = reference(&first);
    assert_eq!(first["dependencies"][0]["native_turn_id"], "turn-child");
    *child.native.turn.lock().unwrap() = None;
    app.reconcile_registered(&identity()).await;
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
    child
        .native
        .set("another-turn", NativeTurnStatus::Completed);
    app.reconcile_registered(&identity()).await;
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
    let reads = child.native.reads.load(Ordering::SeqCst);
    let retry = call(&app, request).await;
    assert_eq!(retry["dependencies"][0]["native_turn_id"], "turn-child");
    assert_eq!(child.native.reads.load(Ordering::SeqCst), reads);
    child.native.set("turn-child", NativeTurnStatus::Failed);
    app.reconcile_registered(&identity()).await;
    app.reconcile_registered(&identity()).await;
    let completed = get(&app, &id).await;
    assert_eq!(completed["status"], "confirmed");
    assert_eq!(
        completed["dependencies"][0]["completion"]["status"],
        "failed"
    );
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dependency_humanstop_epoch_survives_release_and_blocks_the_old_wait() {
    let parent = Owner::new("parent");
    let child = Owner::new("child");
    let routes = registry(&[&parent, &child]);
    let app = parent.app(routes.clone());
    let first = call(
        &app,
        parent.depends("before-stop", vec![child.session.clone()]),
    )
    .await;
    let id = reference(&first);
    drop(app);
    child.stop_and_release();
    child.native.set("turn-child", NativeTurnStatus::Completed);
    let restored = parent.app(routes);
    restored.reconcile_registered(&identity()).await;
    assert_eq!(get(&restored, &id).await["status"], "cancelled");
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
    restored.reconcile_registered(&identity()).await;
    assert_eq!(parent.store.wake_count(), 0);
}

#[tokio::test]
async fn shared_authority_gates_are_deduplicated_and_cycles_are_rejected_atomically() {
    let store = Store::new();
    let a = Owner::in_store(store.clone(), "a", "native-a");
    let b = Owner::in_store(store, "b", "native-b");
    let routes = registry(&[&a, &b]);
    let app_a = a.app(routes.clone());
    let app_b = b.app(routes);
    let first = call(&app_a, a.depends("a-b", vec![b.session.clone()])).await;
    reference(&first);
    let cycle = call(&app_b, b.depends("b-a", vec![a.session.clone()])).await;
    assert_eq!(cycle["code"], "wait_dependency_cycle");
    let self_wait = call(&app_b, b.depends("self", vec![b.session.clone()])).await;
    assert_eq!(self_wait["code"], "wait_dependency_cycle");
    reference(
        &call(
            &app_b,
            b.timer(
                "independent-profile",
                catalog::TimerTrigger::Delay { delay_ms: 60_000 },
            ),
        )
        .await,
    );
    for app in [&app_a, &app_b] {
        let listed = call(
            app,
            catalog::Automation::List {
                session_ref: None,
                cursor: None,
            },
        )
        .await;
        assert_eq!(
            listed["rules"].as_array().unwrap().len(),
            1,
            "shared database list must stay owner scoped"
        );
    }
    b.native.set("turn-b", NativeTurnStatus::Completed);
    // Pinned gates use try_lock. Duplicate acquisition would return Busy and
    // fail the single-admission assertion below; elapsed schema-validation time
    // under parallel tests is not evidence of a gate deadlock.
    app_a.reconcile_registered(&identity()).await;
    app_a.reconcile_registered(&identity()).await;
    assert_eq!(a.native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn foreign_gate_contention_defers_before_intent_then_holds_gate_through_single_handoff() {
    let parent = Owner::new("parent");
    let child = Owner::new("child");
    let app = parent.app(registry(&[&parent, &child]));
    reference(
        &call(
            &app,
            parent.depends("contended", vec![child.session.clone()]),
        )
        .await,
    );
    child.native.set("turn-child", NativeTurnStatus::Completed);
    let m = fs::metadata(&child.store.gate).unwrap();
    let held = acquire_pinned(&child.store.gate, m.dev(), m.ino()).unwrap();
    app.reconcile_registered(&identity()).await;
    assert_eq!(parent.store.wake_count(), 0);
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
    drop(held);
    parent
        .native
        .must_hold_gates
        .lock()
        .unwrap()
        .push(child.store.gate.clone());
    app.reconcile_registered(&identity()).await;
    app.reconcile_registered(&identity()).await;
    assert_eq!(parent.store.wake_count(), 1);
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resuming_a_paused_rule_rechecks_dependency_cycle_under_all_owner_gates() {
    let a = Owner::new("a");
    let b = Owner::new("b");
    let routes = registry(&[&a, &b]);
    let app_a = a.app(routes.clone());
    let app_b = b.app(routes);
    let request = a.depends("a-b", vec![b.session.clone()]);
    let first = call(&app_a, request.clone()).await;
    let id = reference(&first);
    let paused = call(
        &app_a,
        catalog::Automation::Pause {
            rule_ref: id.clone(),
            revision: first["revision"].as_u64().unwrap(),
        },
    )
    .await;
    reference(&call(&app_b, b.depends("b-a", vec![a.session.clone()])).await);
    let catalog::Automation::Create { rule, .. } = request else {
        unreachable!()
    };
    let resumed = call(
        &app_a,
        catalog::Automation::Update {
            rule_ref: id.clone(),
            revision: paused["revision"].as_u64().unwrap(),
            rule,
        },
    )
    .await;
    assert_eq!(resumed["code"], "wait_dependency_cycle");
    assert_eq!(get(&app_a, &id).await["status"], "paused");
    assert_eq!(a.native.submits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn pause_delete_and_update_use_stable_revisions_and_delete_keeps_a_tombstone() {
    let owner = Owner::new("parent");
    let app = owner.app(registry(&[&owner]));
    let request = owner.timer("lifecycle", past());
    let first = call(&app, request.clone()).await;
    let id = reference(&first);
    let revision = first["revision"].as_u64().unwrap();
    let paused = call(
        &app,
        catalog::Automation::Pause {
            rule_ref: id.clone(),
            revision,
        },
    )
    .await;
    assert_eq!(paused["status"], "paused");
    assert_eq!(call(&app, request.clone()).await, paused);
    let conflict = call(
        &app,
        catalog::Automation::Delete {
            rule_ref: id.clone(),
            revision,
        },
    )
    .await;
    assert_eq!(conflict["code"], "revision_conflict");
    app.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 0);
    let revision = paused["revision"].as_u64().unwrap();
    let cancelled = call(
        &app,
        catalog::Automation::Delete {
            rule_ref: id.clone(),
            revision,
        },
    )
    .await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        call(
            &app,
            catalog::Automation::Delete {
                rule_ref: id,
                revision
            }
        )
        .await,
        cancelled
    );
    assert_eq!(call(&app, request).await, cancelled);
    app.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 0);
    let listed = call(
        &app,
        catalog::Automation::List {
            session_ref: Some(owner.session.clone()),
            cursor: None,
        },
    )
    .await;
    assert_eq!(listed["complete"], true);
    assert_eq!(listed["rules"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn lost_ack_reconciles_original_key_after_restart_without_resubmission() {
    let owner = Owner::new("parent");
    owner.native.lost_ack.store(true, Ordering::SeqCst);
    owner.native.receipt_ready.store(false, Ordering::SeqCst);
    let routes = registry(&[&owner]);
    let app = owner.app(routes.clone());
    let first = call(&app, owner.timer("lost-ack", past())).await;
    let id = reference(&first);
    app.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(get(&app, &id).await["status"], "delivery_unknown");
    drop(app);
    let restored = owner.app_with_capability(routes, false);
    restored.reconcile_registered(&identity()).await;
    restored.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(owner.store.wake_count(), 1);
    owner.native.receipt_ready.store(true, Ordering::SeqCst);
    restored.reconcile_registered(&identity()).await;
    assert_eq!(get(&restored, &id).await["status"], "confirmed");
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unsupported_continuation_refuses_new_rules_before_native_reads_and_blocks_existing_new_wake()
 {
    let parent = Owner::new("parent");
    let child = Owner::new("child");
    let routes = registry(&[&parent, &child]);
    let supported = parent.app(routes.clone());
    let pending = call(&supported, parent.timer("before-downgrade", past())).await;
    let id = reference(&pending);
    drop(supported);
    let blocked = parent.app_with_capability(routes, false);
    for request in [
        parent.timer("new-timer", past()),
        parent.depends("new-session-wait", vec![child.session.clone()]),
    ] {
        assert_eq!(
            call(&blocked, request).await["code"],
            "automatic_continuation_unsupported"
        );
    }
    assert_eq!(child.native.reads.load(Ordering::SeqCst), 0);
    blocked.reconcile_registered(&identity()).await;
    let saved = get(&blocked, &id).await;
    assert_eq!(saved["status"], "armed");
    assert_eq!(saved["automatic_continuation"], false);
    assert_eq!(
        saved["wait"]["detail"],
        "automatic_continuation_unsupported"
    );
    let retry = call(&blocked, parent.timer("before-downgrade", past())).await;
    assert_eq!(saved, retry);
    let listed = call(
        &blocked,
        catalog::Automation::List {
            session_ref: Some(parent.session.clone()),
            cursor: None,
        },
    )
    .await;
    assert_eq!(listed["rules"].as_array().unwrap().len(), 1);
    assert_eq!(parent.store.wake_count(), 0);
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejected_wake_blocks_autopilot_until_explicit_delete_and_never_resubmits() {
    let owner = Owner::new("parent");
    owner.native.reject_submit.store(true, Ordering::SeqCst);
    let app = owner.app(registry(&[&owner]));
    let first = call(&app, owner.timer("rejected", past())).await;
    let id = reference(&first);
    app.reconcile_registered(&identity()).await;
    let rejected = get(&app, &id).await;
    assert_eq!(rejected["status"], "rejected");
    let status = || catalog::Automation::WaitStatus {
        harness: "fixture-harness".into(),
        native_session_id: "parent".into(),
        node_ref: Some("node".into()),
    };
    assert_eq!(call(&app, status()).await["blocked"], true);
    app.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
    let deleted = call(
        &app,
        catalog::Automation::Delete {
            rule_ref: id,
            revision: rejected["revision"].as_u64().unwrap(),
        },
    )
    .await;
    assert_eq!(deleted["status"], "cancelled");
    assert_eq!(call(&app, status()).await["blocked"], false);
    app.reconcile_registered(&identity()).await;
    assert_eq!(owner.native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn mapping_is_read_only_under_stop_and_dependency_acl_is_rechecked() {
    let parent = Owner::new("parent");
    let child = Owner::new("child");
    let routes = registry(&[&parent, &child]);
    let app = parent.app(routes.clone());
    let first = call(&app, parent.depends("acl", vec![child.session.clone()])).await;
    reference(&first);
    child.policy.revoked.store(true, Ordering::SeqCst);
    child.native.set("turn-child", NativeTurnStatus::Completed);
    app.reconcile_registered(&identity()).await;
    assert_eq!(parent.native.submits.load(Ordering::SeqCst), 0);
    parent
        .store
        .authority()
        .stop(
            &identity(),
            &Owner::grants_for(&parent.instance),
            "global",
            "fixture",
            "now",
        )
        .unwrap();
    let mapped = routes
        .resolve_native(&identity(), "fixture-harness", "parent", Some("node"))
        .unwrap();
    assert_eq!(mapped["session_ref"], parent.session);
    assert_eq!(parent.native.reads.load(Ordering::SeqCst), 0);
    let status = call(
        &app,
        catalog::Automation::WaitStatus {
            harness: "fixture-harness".into(),
            native_session_id: "parent".into(),
            node_ref: Some("node".into()),
        },
    )
    .await;
    assert_eq!(status["blocked"], true);
}

#[tokio::test]
async fn native_mapping_ambiguity_and_invalid_dependency_sets_fail_closed() {
    let a = Owner::in_store(Store::new(), "a", "same-native");
    let b = Owner::in_store(Store::new(), "b", "same-native");
    let routes = registry(&[&a, &b]);
    assert_eq!(
        routes.resolve_native(&identity(), "fixture-harness", "same-native", Some("node")),
        Err("ambiguous_native_session")
    );
    let app = a.app(routes);
    let too_many = call(
        &app,
        a.depends(
            "too-many",
            (0..33).map(|i| format!("session-{i}")).collect(),
        ),
    )
    .await;
    assert_eq!(too_many["code"], "invalid_dependencies");
    let duplicate = call(
        &app,
        a.depends("duplicate", vec![b.session.clone(), b.session.clone()]),
    )
    .await;
    assert_eq!(duplicate["code"], "invalid_dependencies");
    *b.native.turn.lock().unwrap() = None;
    let idle = call(&app, a.depends("idle", vec![b.session.clone()])).await;
    assert_eq!(idle["code"], "completion_identity_unavailable");
    assert_eq!(a.store.wake_count(), 0);
}

struct SlowTick {
    delay: Duration,
    calls: AtomicUsize,
    active: AtomicUsize,
    max_active: AtomicUsize,
}
impl AutomationTick for SlowTick {
    fn tick<'a>(
        &'a self,
        _: &'a ConnectionIdentity,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            let delay = self.delay;
            tokio::task::spawn_blocking(move || std::thread::sleep(delay))
                .await
                .unwrap();
            self.active.fetch_sub(1, Ordering::SeqCst);
        })
    }
}
#[tokio::test]
async fn one_coordinator_keeps_slow_owner_ticks_separate_without_overlap() {
    let slow = Arc::new(SlowTick {
        delay: Duration::from_millis(2400),
        calls: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
    });
    let fast = Arc::new(SlowTick {
        delay: Duration::from_millis(1),
        calls: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
    });
    automation_driver::start(vec![
        AutomationOwner::new(identity(), vec![slow.clone()]),
        AutomationOwner::new(identity(), vec![fast.clone()]),
    ])
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while fast.calls.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fast.calls.load(Ordering::SeqCst) >= 2);
    assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
    assert_eq!(slow.max_active.load(Ordering::SeqCst), 1);
}
