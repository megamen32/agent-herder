#![cfg(any(target_os = "linux", target_os = "macos"))]
use herder::{
    application::{
        process_bindings::ProcessRuntimeConfig,
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, ScopeGenerationIssuer, ScopedAuthority,
            create_prompt::FreshSessionGrantPolicy, mcp_deliver::ScopedDeliverApplication,
            process_automation::ProcessAutomationApplication,
            task_reconcile::ScopedReceiptReconciler,
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
        resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope},
    },
    mcp::{catalog, transport::ApplicationPort},
    ownership::{
        claim,
        manifest::{AuthorityRoute, StorageAuthority, StorageId, StorageMarker},
        resource,
    },
    process::{ExecutionSnapshot, ExecutionStore, StartRequest, WorkerBackend},
    store::Writer,
};
use rmcp::model::CallToolResult;
use rusqlite::{Connection, functions::FunctionFlags};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CLAIM: &str = "01234567-89ab-4cde-8fab-0123456789ab";

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
    config: ProcessRuntimeConfig,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "herder-process-automation-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
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
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate)
            .unwrap();
        let metadata = file.metadata().unwrap();
        let guard = acquire_pinned(&gate, metadata.dev(), metadata.ino()).unwrap();
        assert!(
            Writer::open_file(&db)
                .unwrap()
                .initialize_fresh_stop_authority(&guard, "authority-1", "now")
                .unwrap()
        );
        drop(guard);
        drop(file);
        let resources = root.join("resource-authority");
        fs::create_dir(&resources).unwrap();
        fs::set_permissions(&resources, fs::Permissions::from_mode(0o700)).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("fixture-resource-authority".into()),
            authority_node: NodeRef("node".into()),
            root: resources,
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        fs::write(
            authority.root.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(
            authority.root.join("storage.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let config = ProcessRuntimeConfig {remote_executors: Vec::new(),
            version: 1,
            node_ref: "node".into(),
            worker: PathBuf::from(env!("CARGO_BIN_EXE_herder_process_worker")),
            execution_root: root.join("executions"),
            resources: authority,
            administrators: vec!["alice".into()],
        };
        let fixture = Self {
            root,
            db,
            gate,
            config,
        };
        fixture.create_session();
        fixture
    }

    fn authority(&self) -> ScopedAuthority {
        ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into()).unwrap()
    }

    fn create_session(&self) {
        let address = SessionAddress {
            instance: instance(),
            native_session_id: "native-parent".into(),
        };
        let outcome = self
            .authority()
            .create_fresh_root(
                &identity("alice"),
                &base_grants(),
                &Creator(address),
                &Id,
                &Generation,
                CreateRequest {
                    intent_id: "create-parent",
                    task_id: "task-create-parent",
                    request_key: "parent",
                    specification: "fixture",
                    now: "now",
                    retain_until: "later",
                },
            )
            .unwrap();
        assert_eq!(outcome, CreateResult::Created(SessionRef("parent".into())));
    }

    fn store(&self) -> ExecutionStore {
        ExecutionStore::open(&self.config.execution_root, &self.config.node_ref).unwrap()
    }

    fn key(&self, name: &str) -> String {
        // systemd transient units are global to the user, while these stores are private.
        format!(
            "{}:{name}",
            self.root.file_name().unwrap().to_str().unwrap()
        )
    }

    fn held_execution(&self) -> catalog::ProcessExecution {
        catalog::ProcessExecution::Start {
            argv: vec![
                "/bin/sh".into(), "-c".into(),
                "printf 'run\\n' >> \"$1\"; i=0; while [ ! -e \"$2\" ] && [ \"$i\" -lt 120 ]; do sleep 0.05; i=$((i+1)); done".into(),
                "herder-fixture".into(), self.root.join("runs").display().to_string(),
                self.root.join("finish").display().to_string(),
            ],
            cwd: self.root.display().to_string(), deadline_unix_ms: None, stop_grace_ms: Some(100),
        }
    }

    fn create(
        &self,
        key: &str,
        bindings: Vec<catalog::ProcessLeaseBinding>,
    ) -> catalog::Automation {
        catalog::Automation::Create {
            session_ref: "parent".into(),
            request_key: self.key(key),
            rule: catalog::AutomationRule::ProcessCompletion {
                execution: self.held_execution(),
                bindings,
                wake_message: "Read the completed fixture receipt.".into(),
            },
        }
    }

    fn finish(&self) {
        fs::write(self.root.join("finish"), b"exit").unwrap();
    }

    fn lease(&self) -> catalog::ProcessLeaseBinding {
        let reference = ResourceRef("fixture-build-slot".into());
        let descriptor = resource::register_or_update(
            &self.config.resources,
            ResourceDescriptor::new(
                reference.clone(),
                ResourceScope::Global,
                ResourceKind::Other("build".into()),
                "fixture-only-build".into(),
                self.config.resources.storage_id.0.clone(),
                None,
                0,
            ),
            Authorization::Authorized,
            None,
        )
        .unwrap();
        let now = claim::now_seconds().unwrap();
        let outcome = claim::claim(
            &self.config.resources,
            &reference,
            Authorization::Authorized,
            ResourceClaim {
                resource_ref: reference.clone(),
                principal_ref: "alice".into(),
                session_ref: Some(SessionRef("parent".into())),
                claim_id: CLAIM.into(),
                purpose: "process automation integration".into(),
                acquired_at: format!("unix-seconds:{now}"),
                expires_at: Some(format!("unix-seconds:{}", now + 30)),
            },
        )
        .unwrap();
        assert_eq!(outcome, claim::ClaimOutcome::Acquired);
        catalog::ProcessLeaseBinding {
            resource_ref: reference,
            claim_id: CLAIM.into(),
            revision: descriptor.revision,
            ttl_seconds: 30,
            on_exit: catalog::ProcessLeaseExit::Release,
            handback_seconds: None,
        }
    }

    fn wake_intents(&self) -> usize {
        Connection::open(&self.db)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM intents WHERE request_key LIKE 'process-wake:%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    async fn execution_until(
        &self,
        reference: &str,
        predicate: impl Fn(&ExecutionSnapshot) -> bool,
    ) -> ExecutionSnapshot {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = self.store().reconcile(reference).unwrap();
            if predicate(&snapshot) {
                return snapshot;
            }
            if Instant::now() >= deadline {
                let dir = self.store().execution_directory(reference).unwrap();
                panic!(
                    "execution predicate timed out: {snapshot:?}; worker: {}",
                    fs::read_to_string(dir.join("supervisor.log")).unwrap_or_default()
                );
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(store) = ExecutionStore::open(&self.config.execution_root, &self.config.node_ref)
        {
            if let Ok(entries) = fs::read_dir(&self.config.execution_root) {
                let references: Vec<_> = entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| name.starts_with("exec-"))
                    .collect();
                for reference in &references {
                    let _ = store.cancel(reference);
                }
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline
                    && references
                        .iter()
                        .any(|r| store.status(r).is_ok_and(|s| s.record.receipt.is_none()))
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn instance() -> InstanceRef {
    InstanceRef {
        node: NodeRef("node".into()),
        instance_id: "profile".into(),
    }
}
fn identity(principal: &str) -> ConnectionIdentity {
    ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId(principal.into()),
        }),
        None,
    )
}
fn base_grants() -> Vec<Grant> {
    vec![
        Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Resource(format!(
                "instance:{}",
                serde_json::to_string(&instance()).unwrap()
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
struct Id;
impl SessionRefIssuer for Id {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
        Ok(SessionRef("parent".into()))
    }
}
struct Generation;
impl ScopeGenerationIssuer for Generation {
    fn issue(&self) -> Result<String, ()> {
        Ok("scope-parent".into())
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
    allow: bool,
}
impl FreshSessionGrantPolicy for Policy {
    fn session_write_grant(
        &self,
        principal: &PrincipalId,
        _: &InstanceRef,
        session: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok(self.allow.then(|| Grant {
            principal: principal.clone(),
            resource: PrivateResource::Session(session.clone()),
            action: Action::Write,
        }))
    }
    fn session_read_grant(
        &self,
        principal: &PrincipalId,
        _: &InstanceRef,
        session: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok(self.allow.then(|| Grant {
            principal: principal.clone(),
            resource: PrivateResource::Session(session.clone()),
            action: Action::Read,
        }))
    }
}
struct Native {
    submits: AtomicUsize,
    snapshots: AtomicUsize,
    reconciliations: AtomicUsize,
    busy: AtomicBool,
    lose_ack: AtomicBool,
    recovery_enabled: AtomicBool,
    recoveries: AtomicUsize,
    accepted: std::sync::Mutex<Option<(SessionAddress, String)>>,
}
impl Native {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            submits: AtomicUsize::new(0),
            snapshots: AtomicUsize::new(0),
            reconciliations: AtomicUsize::new(0),
            busy: AtomicBool::new(false),
            lose_ack: AtomicBool::new(false),
            recovery_enabled: AtomicBool::new(false),
            recoveries: AtomicUsize::new(0),
            accepted: std::sync::Mutex::new(None),
        })
    }
}
impl NativeSessionReader for Native {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        self.snapshots.fetch_add(1, Ordering::SeqCst);
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop: false,
            activity: if self.busy.load(Ordering::SeqCst) {
                SessionActivity::Busy {
                    turn_id: "parent-turn".into(),
                }
            } else {
                SessionActivity::Idle
            },
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
        self.reconciliations.fetch_add(1, Ordering::SeqCst);
        Ok(Observation::Confirmed {
            receipt: receipt.clone(),
        })
    }
    async fn recover_admission(&self,target:&SessionAddress,key:&RequestKey)->Result<Option<NativeReceipt>,ReadError>{
        self.recoveries.fetch_add(1,Ordering::SeqCst);
        if !self.recovery_enabled.load(Ordering::SeqCst){return Ok(None)}
        let accepted=self.accepted.lock().unwrap();
        Ok(accepted.as_ref().filter(|(address,original)|address==target && original==&key.0)
            .map(|(address,_)|NativeReceipt{target:address.clone(),native_id:"fixture-wake".into()}))
    }
}
impl BoundedNativeHandoff for Native {
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        _: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        assert_eq!(plan.target.native_session_id, "native-parent");
        self.submits.fetch_add(1, Ordering::SeqCst);
        *self.accepted.lock().unwrap()=Some((plan.target.clone(),key.0.clone()));
        if self.lose_ack.load(Ordering::SeqCst) {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "injected ACK loss after native effect".into(),
            });
        }
        Ok(Admission {
            receipt: NativeReceipt {
                target: plan.target,
                native_id: "fixture-wake".into(),
            },
        })
    }
}
fn application(
    fixture: &Fixture,
    native: Arc<Native>,
    allow_session: bool,
) -> Arc<ProcessAutomationApplication> {
    let authority = Arc::new(fixture.authority());
    let policy = Arc::new(Policy {
        allow: allow_session,
    });
    let deliver: Arc<dyn ApplicationPort> = Arc::new(
        ScopedDeliverApplication::new(
            authority.clone(),
            instance(),
            base_grants(),
            native.clone(),
            native.clone(),
            "later".into(),
        )
        .unwrap()
        .with_delivery_mode(SendMode::Start)
        .unwrap()
        .with_policy(policy.clone()),
    );
    let reconciler = Arc::new(ScopedReceiptReconciler::new(authority.clone(), native));
    Arc::new(
        ProcessAutomationApplication::new(
            authority,
            instance(),
            base_grants(),
            policy,
            deliver,
            catalog::DeliveryMode::Start,
            reconciler,
            fixture.config.clone(),
        )
        .unwrap(),
    )
}
async fn raw_call(
    app: &ProcessAutomationApplication,
    principal: &str,
    request: catalog::Automation,
) -> CallToolResult {
    app.call(&identity(principal), catalog::Request::Automation(request))
        .await
        .unwrap()
}
async fn call(app: &ProcessAutomationApplication, request: catalog::Automation) -> Value {
    let result = raw_call(app, "alice", request).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    result.structured_content.unwrap()
}
fn reference(value: &Value, name: &str) -> String {
    value[name]
        .as_str()
        .unwrap_or_else(|| panic!("missing {name}: {value}"))
        .to_owned()
}
fn reconcile(rule: &str) -> catalog::Automation {
    catalog::Automation::ReconcileProcess {
        rule_ref: rule.into(),
    }
}
async fn until_phase(app: &ProcessAutomationApplication, rule: &str, phase: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let result = raw_call(app, "alice", reconcile(rule)).await;
        if result.is_error == Some(true) {
            let error = result.structured_content.unwrap();
            assert_eq!(
                error["code"], "scope_unavailable",
                "unexpected reconciliation failure: {error}"
            );
            assert!(
                Instant::now() < deadline,
                "authority remained busy: {error}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
            continue;
        }
        let value = result.structured_content.unwrap();
        if value["wait"]["phase"] == phase {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "expected {phase}, observed {value}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
async fn wait_counter(counter: &AtomicUsize, minimum: usize) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while counter.load(Ordering::SeqCst) < minimum {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn duplicate_registration_restart_and_reconcile_start_and_wake_once() {
    let fixture = Fixture::new();
    let native = Native::new();
    let app = application(&fixture, native.clone(), true);
    let first = call(&app, fixture.create("restart", vec![])).await;
    let rule = reference(&first, "rule_ref");
    let execution = reference(&first, "execution_ref");
    assert_eq!(first["wait"]["phase"], "armed");
    drop(app);
    let restarted = application(&fixture, native.clone(), true);
    let duplicate = call(&restarted, fixture.create("restart", vec![])).await;
    assert_eq!(duplicate["rule_ref"], first["rule_ref"]);
    assert_eq!(duplicate["execution_ref"], first["execution_ref"]);
    fixture.finish();
    fixture
        .execution_until(&execution, |s| s.record.receipt.is_some())
        .await;
    until_phase(&restarted, &rule, "confirmed").await;
    for _ in 0..3 {
        call(&restarted, reconcile(&rule)).await;
    }
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.wake_intents(), 1);
    assert_eq!(
        fs::read_to_string(fixture.root.join("runs")).unwrap(),
        "run\n"
    );
}

#[tokio::test]
async fn completion_available_during_registration_returns_ready_without_wake() {
    let fixture = Fixture::new();
    let native = Native::new();
    let app = application(&fixture, native.clone(), true);
    let key = fixture.key("instant");
    let argv = vec!["/bin/true".to_owned()];
    let record = fixture
        .store()
        .prepare_start(StartRequest {
            principal_ref: "alice".into(),
            session_ref: "parent".into(),
            request_key: key.clone(),
            argv: argv.clone(),
            cwd: fixture.root.clone(),
            deadline_unix_ms: None,
            stop_grace_ms: 100,
        })
        .unwrap();
    fixture
        .store()
        .launch_prepared_with_backend(
            &record.execution_ref,
            Path::new(env!("CARGO_BIN_EXE_herder_process_worker")),
            if cfg!(target_os = "macos") { WorkerBackend::LaunchdUser } else { WorkerBackend::Direct },
        )
        .unwrap();
    fixture
        .execution_until(&record.execution_ref, |s| s.record.receipt.is_some())
        .await;
    let value = call(
        &app,
        catalog::Automation::Create {
            session_ref: "parent".into(),
            request_key: key,
            rule: catalog::AutomationRule::ProcessCompletion {
                execution: catalog::ProcessExecution::Start {
                    argv,
                    cwd: fixture.root.display().to_string(),
                    deadline_unix_ms: None,
                    stop_grace_ms: Some(100),
                },
                bindings: vec![],
                wake_message: "Already complete.".into(),
            },
        },
    )
    .await;
    assert_eq!(value["wait"]["phase"], "ready");
    let rule = reference(&value, "rule_ref");
    drop(app);
    let restarted = application(&fixture, native.clone(), true);
    assert_eq!(
        call(&restarted, reconcile(&rule)).await["wait"]["phase"],
        "ready"
    );
    assert_eq!(native.submits.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.wake_intents(), 0);
}

#[tokio::test]
async fn concurrent_reconciliation_admits_one_wake_intent() {
    let fixture = Fixture::new();
    let native = Native::new();
    let app = application(&fixture, native.clone(), true);
    let first = call(&app, fixture.create("concurrent", vec![])).await;
    let rule = reference(&first, "rule_ref");
    fixture.finish();
    fixture
        .execution_until(&reference(&first, "execution_ref"), |s| {
            s.record.receipt.is_some()
        })
        .await;
    let (a, b, c, d) = tokio::join!(
        raw_call(&app, "alice", reconcile(&rule)),
        raw_call(&app, "alice", reconcile(&rule)),
        raw_call(&app, "alice", reconcile(&rule)),
        raw_call(&app, "alice", reconcile(&rule)),
    );
    for result in [a, b, c, d] {
        let value = result.structured_content.unwrap();
        if result.is_error == Some(true) {
            // The existing authority gate is deliberately nonblocking. Contending
            // readers may defer, but every admitted wake must share one intent.
            assert_eq!(value["code"], "scope_unavailable", "{value}");
        } else {
            assert_eq!(value["rule_ref"], rule);
        }
    }
    until_phase(&app, &rule, "confirmed").await;
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.wake_intents(), 1);
}

#[tokio::test]
async fn busy_parent_defers_background_wake_and_background_releases_its_owner() {
    let fixture = Fixture::new();
    let native = Native::new();
    native.busy.store(true, Ordering::SeqCst);
    let app = application(&fixture, native.clone(), true);
    let first = call(&app, fixture.create("busy", vec![])).await;
    app.start_background(identity("alice"));
    fixture.finish();
    fixture
        .execution_until(&reference(&first, "execution_ref"), |s| {
            s.record.receipt.is_some()
        })
        .await;
    wait_counter(&native.snapshots, 1).await;
    assert_eq!(native.submits.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.wake_intents(), 0);
    native.busy.store(false, Ordering::SeqCst);
    wait_counter(&native.submits, 1).await;
    until_phase(&app, &reference(&first, "rule_ref"), "confirmed").await;
    let weak = Arc::downgrade(&app);
    drop(app);
    tokio::time::timeout(Duration::from_secs(4), async {
        while weak.strong_count() != 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("background task retained its application after owner drop");
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn paused_and_deleted_wakes_still_recover_failed_lease_finalization() {
    for delete in [false, true] {
        let fixture = Fixture::new();
        let native = Native::new();
        let app = application(&fixture, native.clone(), true);
        let binding = fixture.lease();
        let first = call(&app, fixture.create("cancel-wake", vec![binding.clone()])).await;
        let rule = reference(&first, "rule_ref");
        let execution = reference(&first, "execution_ref");
        fixture
            .execution_until(&execution, |s| s.confirmed_live)
            .await;
        let value = call(
            &app,
            catalog::Automation::Get {
                rule_ref: rule.clone(),
            },
        )
        .await;
        let revision = value["revision"].as_u64().unwrap();
        let action = if delete {
            catalog::Automation::Delete {
                rule_ref: rule.clone(),
                revision,
            }
        } else {
            catalog::Automation::Pause {
                rule_ref: rule.clone(),
                revision,
            }
        };
        let cancelled = call(&app, action).await;
        assert_eq!(cancelled["wait"]["wake_cancelled"], true);
        let cancelled_phase = reference(&cancelled["wait"], "phase");
        assert!(matches!(cancelled_phase.as_str(), "cancelled" | "paused"));
        let marker = fixture.config.resources.root.join("storage.json");
        let original_marker = fs::read(&marker).unwrap();
        fs::write(&marker, b"{temporarily unavailable").unwrap();
        fixture.finish();
        fixture
            .execution_until(&execution, |s| {
                s.record.receipt.is_some() && s.record.finalization_pending
            })
            .await;
        fs::write(&marker, original_marker).unwrap();
        let reconciled = call(&app, reconcile(&rule)).await;
        assert_eq!(reconciled["wait"]["phase"], cancelled_phase);
        assert!(
            claim::read_by_claim_id(
                &fixture.config.resources,
                &binding.resource_ref,
                Authorization::Authorized,
                CLAIM
            )
            .unwrap()
            .is_none(),
            "{reconciled}"
        );
        assert_eq!(native.submits.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.wake_intents(), 0);
    }
}

#[tokio::test]
async fn lost_native_ack_never_resubmits_after_restart() {
    let fixture = Fixture::new();
    let native = Native::new();
    native.lose_ack.store(true, Ordering::SeqCst);
    let app = application(&fixture, native.clone(), true);
    let first = call(&app, fixture.create("lost-ack", vec![])).await;
    let rule = reference(&first, "rule_ref");
    fixture.finish();
    fixture
        .execution_until(&reference(&first, "execution_ref"), |s| {
            s.record.receipt.is_some()
        })
        .await;
    until_phase(&app, &rule, "delivery_unknown").await;
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
    drop(app);
    let restarted = application(&fixture, native.clone(), true);
    call(&restarted, fixture.create("lost-ack", vec![])).await;
    for _ in 0..4 {
        assert_eq!(
            call(&restarted, reconcile(&rule)).await["wait"]["phase"],
            "delivery_unknown"
        );
    }
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.wake_intents(), 1);
}

#[tokio::test]
async fn wait_status_cancelled_unknown_wake_stays_blocked_after_stop_release_without_resubmit() {
    for cancellation in ["delete", "human_stop"] {
        let fixture = Fixture::new();
        let native = Native::new();
        native.lose_ack.store(true, Ordering::SeqCst);
        let app = application(&fixture, native.clone(), true);
        let first = call(&app, fixture.create(cancellation, vec![])).await;
        let rule = reference(&first, "rule_ref");
        fixture.finish();
        fixture.execution_until(&reference(&first, "execution_ref"), |s| {
            s.record.receipt.is_some() && !s.record.finalization_pending
        }).await;
        let unknown = until_phase(&app, &rule, "delivery_unknown").await;
        assert_eq!(native.submits.load(Ordering::SeqCst), 1);
        assert_eq!(call(&app, native_wait_query("native-parent")).await["blocked"], true);
        if cancellation == "delete" {
            let deleted = call(&app, catalog::Automation::Delete {
                rule_ref: rule.clone(), revision: unknown["revision"].as_u64().unwrap(),
            }).await;
            assert_eq!(deleted["wait"]["phase"], "cancelled");
        } else {
            fixture.authority().stop(&identity("alice"), &base_grants(), "global", "fixture stop after uncertain wake", "now").unwrap();
            assert_eq!(call(&app, native_wait_query("native-parent")).await["reason"], "human_stop_active");
            let metadata = fs::metadata(&fixture.gate).unwrap();
            let _gate = acquire_pinned(&fixture.gate, metadata.dev(), metadata.ino()).unwrap();
            let connection = Connection::open(&fixture.db).unwrap();
            let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
            connection.create_scalar_function("herder_writer_version", 0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                move |_| Ok(version)).unwrap();
            // An independently authorized later hold release cannot erase the
            // old native handoff's still uncertain receipt.
            connection.execute("UPDATE humanstop_holds SET released_at='later' WHERE scope_ref='global'", []).unwrap();
        }
        drop(app);
        let restarted = application(&fixture, native.clone(), true);
        let before_reads = (native.snapshots.load(Ordering::SeqCst), native.recoveries.load(Ordering::SeqCst), native.reconciliations.load(Ordering::SeqCst));
        let status = call(&restarted, native_wait_query("native-parent")).await;
        assert_eq!(status["blocked"], true, "{cancellation}: {status}");
        assert_eq!(status["ruleRefs"], serde_json::json!([rule]));
        assert_eq!((native.snapshots.load(Ordering::SeqCst), native.recoveries.load(Ordering::SeqCst), native.reconciliations.load(Ordering::SeqCst)), before_reads);
        let result = call(&restarted, reconcile(&rule)).await;
        assert_eq!(result["wait"]["phase"], "cancelled");
        assert_eq!(call(&restarted, native_wait_query("native-parent")).await["blocked"], true);
        assert_eq!(native.submits.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.wake_intents(), 1);
        {
            let metadata=fs::metadata(&fixture.gate).unwrap();
            let _gate=acquire_pinned(&fixture.gate,metadata.dev(),metadata.ino()).unwrap();
            let connection=Connection::open(&fixture.db).unwrap();
            let version:i64=connection.pragma_query_value(None,"user_version",|row|row.get(0)).unwrap();
            connection.create_scalar_function("herder_writer_version",0,
                FunctionFlags::SQLITE_UTF8|FunctionFlags::SQLITE_DETERMINISTIC,move |_|Ok(version)).unwrap();
            // A row under the original computed task with a foreign binding is
            // inconsistent evidence, never proof that this wake had no intent.
            assert_eq!(connection.execute("UPDATE intents SET target='foreign-session' WHERE task_id=?1",
                [unknown["wait"]["delivery_task"].as_str().unwrap()]).unwrap(),1);
        }
        assert_eq!(call(&restarted,native_wait_query("native-parent")).await["blocked"],true);
        assert_eq!(native.submits.load(Ordering::SeqCst),1);
    }
}

#[tokio::test]
async fn installed_process_grant_and_session_grant_are_both_required() {
    let fixture = Fixture::new();
    let native = Native::new();
    let app = application(&fixture, native.clone(), true);
    let denied = raw_call(&app, "mallory", fixture.create("denied-principal", vec![])).await;
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.unwrap()["code"],
        "process_grant_required"
    );
    let no_session = application(&fixture, native.clone(), false);
    let denied = raw_call(
        &no_session,
        "alice",
        fixture.create("denied-session", vec![]),
    )
    .await;
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.unwrap()["code"],
        "session_grant_required"
    );
    assert_eq!(
        fs::read_dir(&fixture.config.execution_root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("exec-"))
            .count(),
        0
    );
    assert_eq!(native.submits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn human_stop_then_release_does_not_reauthorize_an_old_wake() {
    let fixture = Fixture::new();
    let native = Native::new();
    native.busy.store(true, Ordering::SeqCst);
    let app = application(&fixture, native.clone(), true);
    let request = fixture.create("human-stop", vec![]);
    let first = call(&app, request.clone()).await;
    let rule = reference(&first, "rule_ref");
    fixture
        .authority()
        .stop(
            &identity("alice"),
            &base_grants(),
            "global",
            "test HumanStop",
            "now",
        )
        .unwrap();
    {
        let metadata = fs::metadata(&fixture.gate).unwrap();
        let _gate = acquire_pinned(&fixture.gate, metadata.dev(), metadata.ino()).unwrap();
        let writer = Connection::open(&fixture.db).unwrap();
        let version: i64 = writer
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        writer
            .create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                move |_| Ok(version),
            )
            .unwrap();
        // Simulate an independently authorized later release of the global hold.
        writer
            .execute(
                "UPDATE humanstop_holds SET released_at='later' WHERE scope_ref='global'",
                [],
            )
            .unwrap();
    }
    native.busy.store(false, Ordering::SeqCst);
    fixture.finish();
    fixture
        .execution_until(&reference(&first, "execution_ref"), |s| {
            s.record.receipt.is_some()
        })
        .await;
    drop(app);
    let restarted = application(&fixture, native.clone(), true);
    let replay = call(&restarted, request).await;
    assert_eq!(replay["wait"]["wake_cancelled"], true);
    for _ in 0..3 {
        assert_eq!(
            call(&restarted, reconcile(&rule)).await["wait"]["wake_cancelled"],
            true
        );
    }
    assert_eq!(native.submits.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.wake_intents(), 0);
}


fn native_wait_query(native: &str) -> catalog::Automation {
    catalog::Automation::WaitStatus {
        harness: "fixture".into(), native_session_id: native.into(), node_ref: Some("node".into()),
    }
}

mod remote_wait_status {
    use super::*;
    use herder::process::{
        CompletionReason, CompletionReceipt, ExecutionRecord, ExecutionState, ProcessIdentity,
        remote::{RemoteDeadlineCapability, RemoteExecutorConfig, RemoteStartRequest, RemoteTransportConfig},
    };
    use sha2::{Digest, Sha256};

    struct RemoteWait {
        fixture: Fixture,
        native: Arc<Native>,
        record: ExecutionRecord,
        control: Value,
        rule: Value,
        state: Value,
        directory: PathBuf,
        transport: PathBuf,
    }
    fn private_json(path: &Path, value: &impl serde::Serialize) {
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    impl RemoteWait {
        fn new() -> Self {
            let mut fixture = Fixture::new();
            let native = Native::new();
            let remote = ExecutionStore::open(fixture.root.join("executor"), "executor-node").unwrap();
            // Pinned fixture artifacts are never executed. Any transport attempt
            // leaves a marker and fails, without contacting a remote host.
            let transport = fixture.root.join("fixture-transport");
            fs::write(&transport, b"#!/bin/sh\nprintf unexpected > \"$0.executed\"\nexit 91\n").unwrap();
            fs::set_permissions(&transport, fs::Permissions::from_mode(0o700)).unwrap();
            let digest: String = Sha256::digest(fs::read(&transport).unwrap()).iter().map(|v|format!("{v:02x}")).collect();
            let mesh = fixture.root.join("fixture-mesh.json");
            private_json(&mesh, &serde_json::json!({}));
            let metadata = fs::metadata(remote.root()).unwrap();
            let executor = RemoteExecutorConfig {
                executor_ref: "fixture-executor".into(), node_ref: remote.node_ref().into(),
                transport: RemoteTransportConfig {
                    node_binary: transport.clone(), node_sha256: digest.clone(),
                    bridge: transport.clone(), bridge_sha256: digest.clone(), fleet_mesh_config: mesh,
                    credential_pin: "a".repeat(64), target: "shell:fixture-executor".into(),
                },
                worker: transport.clone(), worker_sha256: digest,
                endpoint_config: fixture.root.join("fixture-endpoint.json"), endpoint_config_sha256: "b".repeat(64),
                execution_root: remote.root().into(), root_device: metadata.dev(), root_inode: metadata.ino(),
                max_runtime_ms: 60_000, deadline_capability: RemoteDeadlineCapability::LinuxBootWatchdogV1,
            };
            fixture.config.remote_executors.push(executor.clone());
            let now = herder::process::unix_millis().unwrap();
            let spec = RemoteStartRequest {
                principal_ref: "alice".into(), session_ref: "parent".into(),
                request_key: fixture.key("terminal-remote"), argv: vec!["/bin/true".into()],
                cwd: fixture.root.clone(), deadline_unix_ms: now + 50_000, stop_grace_ms: 2000,
                executor: executor.clone(),
            };
            let mut record = fixture.store().prepare_remote_start(spec.clone()).unwrap();
            let mut observed = remote.prepare_start(spec.command()).unwrap();
            let receipt = CompletionReceipt {
                execution_ref: record.execution_ref.clone(), node_ref: executor.node_ref.clone(),
                reason: CompletionReason::Exited, started_at_unix_ms: Some(now), finished_at_unix_ms: now + 1,
                exit_code: Some(0), signal: None, descendant_failure: false,
                tree_complete: true, process_may_be_running: false,
                evidence_source: "fixture_exact_executor_receipt".into(),
                stdout_path: remote.root().join("stdout.log"), stderr_path: remote.root().join("stderr.log"), detail: None,
            };
            for value in [&mut record, &mut observed] {
                value.state = ExecutionState::Finished;
                value.started_at_unix_ms = receipt.started_at_unix_ms;
                value.receipt = Some(receipt.clone());
                value.finalization_pending = false;
            }
            let handle = serde_json::json!({
                "version":1,"controller_node_ref":fixture.config.node_ref,"executor_node_ref":executor.node_ref,
                "executor_ref":executor.executor_ref,"execution_ref":record.execution_ref,
                "controller_payload_hash":record.payload_hash,"command_hash":observed.payload_hash,
                "worker_sha256":executor.worker_sha256,"endpoint_config_sha256":executor.endpoint_config_sha256,
                "nonce":"c".repeat(64),"root_device":executor.root_device,"root_inode":executor.root_inode,
                "boot_id":"fixture-executor-boot","deadline_boot_ms":100_000,"deadline_unix_ms":spec.deadline_unix_ms,
            });
            let request = serde_json::json!({"version":1,"request_id":"d".repeat(64),
                "controller_node_ref":fixture.config.node_ref,"executor_node_ref":executor.node_ref,
                "executor_ref":executor.executor_ref,"operation":{"action":"status","handle":handle}});
            let response = serde_json::json!({"version":1,"request_id":request["request_id"],
                "controller_node_ref":fixture.config.node_ref,"executor_node_ref":executor.node_ref,
                "executor_ref":executor.executor_ref,"observation":{"handle":handle,
                    "observed_boot_id":"fixture-executor-boot","observed_boot_ms":2000,
                    "snapshot":{"record":observed,"observation":"terminal","confirmed_live":false,"worker_lock_held":false},
                    "source":{"execution_ref":record.execution_ref,"executor_node":executor.node_ref,"request_digest":observed.payload_hash}}});
            let control = serde_json::json!({"version":1,"controller_node_ref":fixture.config.node_ref,
                "execution_ref":record.execution_ref,"controller_payload_hash":record.payload_hash,
                "handle":handle,"start_dispatched":true,
                "start_permit":{"boot_id":"fixture-executor-boot","observed_boot_ms":1000,"expires_boot_ms":2000},
                "observation":{"request":request,"response":response,"received_at_unix_ms":now+1,
                    "request_started_at_unix_ms":now,"round_trip_ms":1},"terminal_observed_at_unix_ms":now+1});
            let rule_ref = format!("process-rule:{}", record.execution_ref.trim_start_matches("exec-"));
            let execution = catalog::ProcessExecution::RemoteStart {
                executor_ref: executor.executor_ref, argv: spec.argv.clone(), cwd: spec.cwd.display().to_string(),
                deadline_unix_ms: spec.deadline_unix_ms, stop_grace_ms: None,
            };
            let rule = serde_json::json!({"version":1,"rule_ref":rule_ref,"principal":"alice","session_ref":"parent",
                "request_key":record.request_key,"execution_ref":record.execution_ref,
                "execution":execution,"bindings":[],"wake_message":"Read the original completion."});
            let state = serde_json::json!({"phase":"ready","detail":null,"delivery_task":null,
                "wake_cancelled":false,"cancel_generation":0,"wake_message":null});
            let directory = fixture.store().execution_directory(&record.execution_ref).unwrap();
            let value = Self {fixture,native,record,control,rule,state,directory,transport};
            value.persist();
            assert!(herder::process::remote_terminal_observed_at(&value.record,&value.directory).unwrap().is_some());
            assert_eq!(value.fixture.store().status(&value.record.execution_ref).unwrap().record.receipt,value.record.receipt);
            value
        }
        fn persist(&self) {
            let metadata = fs::metadata(&self.fixture.gate).unwrap();
            let _gate = acquire_pinned(&self.fixture.gate,metadata.dev(),metadata.ino()).unwrap();
            private_json(&self.directory.join("record.json"),&self.record);
            private_json(&self.directory.join("receipt.json"),self.record.receipt.as_ref().unwrap());
            private_json(&self.directory.join("remote-control.json"),&self.control);
            let mut writer = Writer::open_file(&self.fixture.db).unwrap();
            let scope = "automation:process-completion:alice";
            for (prefix,value) in [("rule",&self.rule),("state",&self.state)] {
                let key = format!("{prefix}:{}",self.rule["rule_ref"].as_str().unwrap());
                match writer.get_setting_versioned(scope,&key).unwrap() {
                    Some((revision,_)) => assert!(writer.compare_and_set_setting(scope,&key,revision,&value.to_string(),"now").unwrap()),
                    None => {writer.put_setting_once(scope,&key,&value.to_string(),"now").unwrap();},
                }
            }
        }
        async fn query(&self) -> Value {
            let app = application(&self.fixture,self.native.clone(),true);
            let before = ["record.json","receipt.json","remote-control.json"].map(|name|
                fs::read(self.directory.join(name)).ok());
            let result = call(&app,native_wait_query("native-parent")).await;
            assert_eq!(result["version"],1);assert_eq!(result["complete"],true);assert_eq!(result["mapped"],true);
            assert_eq!(result["sessionRefs"],serde_json::json!(["parent"]));
            assert_eq!(before,["record.json","receipt.json","remote-control.json"].map(|name|
                fs::read(self.directory.join(name)).ok()),"wait_status mutated durable execution evidence");
            assert_eq!(self.native.submits.load(Ordering::SeqCst),0);
            assert_eq!(self.native.snapshots.load(Ordering::SeqCst),0);
            assert_eq!(self.native.reconciliations.load(Ordering::SeqCst),0);
            assert_eq!(self.native.recoveries.load(Ordering::SeqCst),0);
            assert_eq!(self.fixture.wake_intents(),0);
            assert!(!self.transport.with_extension("executed").exists(),"wait_status executed transport");
            assert!(!self.directory.join("launch.json").exists(),"wait_status launched a worker");
            result
        }
    }

    #[tokio::test]
    async fn ready_remote_completion_clears_only_from_persisted_executor_proof() {
        let fixture = RemoteWait::new();
        assert_ne!(fixture.record.node_ref,fixture.record.receipt.as_ref().unwrap().node_ref);
        // A stale live observation cannot renew a lease, but an exact immutable
        // terminal receipt remains valid without an RPC or a live executor PID.
        let value = fixture.query().await;
        assert_eq!(value["blocked"],false,"verified finalized remote completion must clear the gate: {value}");
        assert_eq!(value["ruleRefs"],serde_json::json!([]));
        assert_eq!(value["reason"],"no_process_wait");
    }

    #[tokio::test]
    async fn diagnostics_get_and_list_join_claim_and_wait_without_effects_or_false_history() {
        let mut fixture=RemoteWait::new();
        let binding=fixture.fixture.lease();
        herder::application::process_bindings::write_delegation(&fixture.fixture.store(),
            &fixture.record.execution_ref,"alice",&fixture.fixture.config.resources,vec![binding.clone()]).unwrap();
        fixture.rule["bindings"]=serde_json::to_value(vec![binding.clone()]).unwrap();
        fixture.persist();
        let before_claim=claim::read_current(&fixture.fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap();
        let before_files=["record.json","receipt.json","remote-control.json"].map(|name|fs::read(fixture.directory.join(name)).unwrap());
        let app=application(&fixture.fixture,fixture.native.clone(),true);
        let rule=fixture.rule["rule_ref"].as_str().unwrap().to_owned();
        let get=call(&app,catalog::Automation::Get{rule_ref:rule.clone()}).await;
        assert_eq!(get["wait_target"],serde_json::json!({"session_ref":"parent","complete":true,
            "address":{"instance":{"node":"node","instance_id":instance().instance_id},"native_session_id":"native-parent"}}));
        assert_eq!(get["bindings"],serde_json::to_value(vec![binding.clone()]).unwrap());
        assert_eq!(get["controller_node"],"node");assert_eq!(get["executor_node"],"executor-node");
        assert!(get["delivery_status"].is_null());
        let diagnostics=&get["diagnostics"];
        assert_eq!(diagnostics["non_authoritative"],true);
        assert_eq!(diagnostics["intent_readable"],true);
        assert_eq!(diagnostics["hold_active"],false);
        assert!(diagnostics["native_idle_blocked"].is_null());
        assert_eq!(diagnostics["next_action"],"inspect_receipt");
        assert_eq!(diagnostics["renewal"]["availability"],"no_evidence");
        assert_eq!(diagnostics["renewal"]["history_complete"],false);
        assert!(diagnostics["renewal"]["recorded"].is_null());
        assert_eq!(diagnostics["retention"]["deduplication"],"indefinite");
        assert_eq!(diagnostics["resources_complete"],true);
        let resource=&diagnostics["resources"][0];
        assert_eq!(resource["availability"],"available");
        assert_eq!(resource["claim"]["claim_id"],CLAIM);
        assert_eq!(resource["claim"]["principal_ref"],"alice");
        assert_eq!(resource["claim_live"],true);
        assert_eq!(resource["claim_generation_matches"],true);
        assert_eq!(resource["execution_binding_matches"],false);
        assert!(resource["remaining_ttl_ms"].as_u64().unwrap()>0);
        let list=call(&app,catalog::Automation::List{session_ref:Some("parent".into()),cursor:None}).await;
        assert_eq!(list["rules"].as_array().unwrap().len(),1);
        assert_eq!(list["rules"][0]["rule_ref"],rule);
        assert_eq!(list["gauges"]["sampled"],1);
        assert_eq!(list["gauges"]["terminal"],1);
        assert!(list["gauges"]["recorded_renewal_attempts"].is_null());
        assert!(list["gauges"]["lifetime_renewal_attempts"].is_null());

        // Diagnostic corruption cannot turn missing renewal history into zero
        // or make the canonical rule/status unavailable.
        let telemetry=fixture.directory.join("renewal-observations.json");
        fs::write(&telemetry,b"{corrupt observation").unwrap();
        fs::set_permissions(&telemetry,fs::Permissions::from_mode(0o600)).unwrap();
        let get=call(&app,catalog::Automation::Get{rule_ref:rule}).await;
        assert_eq!(get["wait"]["phase"],"ready");
        assert_eq!(get["diagnostics"]["renewal"]["availability"],"unavailable");
        assert!(get["diagnostics"]["renewal"]["recorded"].is_null());
        assert_eq!(fs::read(&telemetry).unwrap(),b"{corrupt observation");
        assert_eq!(claim::read_current(&fixture.fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap(),before_claim);
        assert_eq!(["record.json","receipt.json","remote-control.json"].map(|name|fs::read(fixture.directory.join(name)).unwrap()),before_files);
        assert_eq!(fixture.query().await["blocked"],false);
    }

    #[tokio::test]
    async fn missing_or_changed_remote_proof_binding_and_unsettled_wait_remain_blocked() {
        let mut fixture = RemoteWait::new();
        let original_record = fixture.record.clone();let original_control = fixture.control.clone();
        let original_rule = fixture.rule.clone();let original_state = fixture.state.clone();
        let original_config = fixture.fixture.config.clone();
        for scenario in ["missing_proof","altered_receipt","wrong_receipt_node","changed_handle",
            "missing_terminal_time","current_config_drift","removed_executor","rule_executor",
            "rule_argv","rule_cwd","rule_deadline","rule_stop_grace","rule_request_key",
            "local_process","local_members","pending_finalization","unknown_wake",
            "foreign_task_pointer","cancelled_without_cancellation","confirmed_missing_intent"] {
            fixture.record = original_record.clone();fixture.control = original_control.clone();
            fixture.rule = original_rule.clone();fixture.state = original_state.clone();
            fixture.fixture.config = original_config.clone();
            match scenario {
                "altered_receipt" => fixture.record.receipt.as_mut().unwrap().exit_code=Some(42),
                "wrong_receipt_node" => fixture.record.receipt.as_mut().unwrap().node_ref="node".into(),
                "changed_handle" => fixture.control["handle"]["nonce"]=serde_json::json!("e".repeat(64)),
                "missing_terminal_time" => fixture.control["terminal_observed_at_unix_ms"]=Value::Null,
                "current_config_drift" => fixture.fixture.config.remote_executors[0].transport.credential_pin="f".repeat(64),
                "removed_executor" => fixture.fixture.config.remote_executors.clear(),
                "rule_executor" => fixture.rule["execution"]["executor_ref"]=serde_json::json!("other-executor"),
                "rule_argv" => fixture.rule["execution"]["argv"]=serde_json::json!(["/bin/false"]),
                "rule_cwd" => fixture.rule["execution"]["cwd"]=serde_json::json!("/other-worktree"),
                "rule_deadline" => fixture.rule["execution"]["deadline_unix_ms"]=serde_json::json!(1),
                "rule_stop_grace" => fixture.rule["execution"]["stop_grace_ms"]=serde_json::json!(100),
                "rule_request_key" => fixture.rule["request_key"]=serde_json::json!("another-operation"),
                "local_process" | "local_members" => {
                    let identity = ProcessIdentity {node_ref:"node".into(),boot_id:"local-fixture".into(),pid:1,start_ticks:1};
                    if scenario=="local_process" {fixture.record.process=Some(identity)}
                    else {fixture.record.observed_members.push(identity)}
                },
                "pending_finalization" => fixture.record.finalization_pending=true,
                "unknown_wake" => fixture.state["phase"]=serde_json::json!("delivery_unknown"),
                "foreign_task_pointer" => fixture.state["delivery_task"]=serde_json::json!("foreign-task"),
                "cancelled_without_cancellation" => fixture.state["phase"]=serde_json::json!("cancelled"),
                "confirmed_missing_intent" => fixture.state["phase"]=serde_json::json!("confirmed"),
                "missing_proof" => (),
                _ => unreachable!(),
            }
            fixture.persist();
            if scenario=="missing_proof" {fs::remove_file(fixture.directory.join("remote-control.json")).unwrap();}
            let value = fixture.query().await;
            assert_eq!(value["blocked"],true,"{scenario}: {value}");
            assert_eq!(value["ruleRefs"],serde_json::json!([fixture.rule["rule_ref"]]),"{scenario}: {value}");
        }
    }
}

#[tokio::test]
async fn wait_status_is_read_only_and_cancelled_wait_stays_blocked_until_finalization() {
    let fixture=Fixture::new();
    let native=Native::new();
    let app=application(&fixture,native.clone(),true);
    let missing=call(&app,native_wait_query("not-registered")).await;
    assert_eq!(missing["complete"],true);
    assert_eq!(missing["mapped"],false);
    assert_eq!(missing["blocked"],false);
    assert_eq!(call(&app,native_wait_query("native-parent")).await["blocked"],false);
    let first=call(&app,fixture.create("readonly-wait",vec![])).await;
    let rule=reference(&first,"rule_ref");
    let status=call(&app,native_wait_query("native-parent")).await;
    assert_eq!(status["blocked"],true);
    assert_eq!(status["sessionRefs"],serde_json::json!(["parent"]));
    assert_eq!(status["ruleRefs"],serde_json::json!([rule]));
    call(&app,catalog::Automation::Delete{rule_ref:rule.clone(),revision:first["revision"].as_u64().unwrap()}).await;
    assert_eq!(call(&app,native_wait_query("native-parent")).await["blocked"],true);
    fixture.finish();
    fixture.execution_until(&reference(&first,"execution_ref"),|s|s.record.receipt.is_some() && !s.record.finalization_pending).await;
    assert_eq!(call(&app,native_wait_query("native-parent")).await["blocked"],false);
    fixture.authority().stop(&identity("alice"),&base_grants(),"global","completed fixture stop","now").unwrap();
    assert_eq!(call(&app,native_wait_query("native-parent")).await["reason"],"human_stop_active");
    let unregistered=call(&app,native_wait_query("unregistered-after-stop")).await;
    assert_eq!(unregistered["mapped"],false);
    assert_eq!(unregistered["blocked"],true);
    assert_eq!(unregistered["reason"],"human_stop_active");
    assert_eq!(native.submits.load(Ordering::SeqCst),0);
    assert_eq!(native.snapshots.load(Ordering::SeqCst),0);
    assert_eq!(fixture.wake_intents(),0);
}

#[tokio::test]
async fn wait_status_fences_registration_crash_unknown_delivery_and_human_stop() {
    let fixture=Fixture::new();
    let native=Native::new();
    let app=application(&fixture,native.clone(),true);
    let first=call(&app,fixture.create("readonly-crash",vec![])).await;
    let rule=reference(&first,"rule_ref");
    let scope="automation:process-completion:alice";
    let key=format!("state:{rule}");
    {
        let metadata=fs::metadata(&fixture.gate).unwrap();
        let _gate=acquire_pinned(&fixture.gate,metadata.dev(),metadata.ino()).unwrap();
        let writer=Connection::open(&fixture.db).unwrap();
        let version:i64=writer.pragma_query_value(None,"user_version",|r|r.get(0)).unwrap();
        writer.create_scalar_function("herder_writer_version",0,
            FunctionFlags::SQLITE_UTF8|FunctionFlags::SQLITE_DETERMINISTIC,move |_|Ok(version)).unwrap();
        // Crash after immutable rule admission but before its state write.
        writer.execute("DELETE FROM settings WHERE scope=?1 AND setting_key=?2",[scope,key.as_str()]).unwrap();
    }
    assert_eq!(call(&app,native_wait_query("native-parent")).await["blocked"],true);
    {
        let metadata=fs::metadata(&fixture.gate).unwrap();
        let _gate=acquire_pinned(&fixture.gate,metadata.dev(),metadata.ino()).unwrap();
        let mut writer=Writer::open_file(&fixture.db).unwrap();
        let mut state=first["wait"].clone();state["phase"]=serde_json::json!("delivery_unknown");
        writer.put_setting_once(scope,&key,&serde_json::to_string(&state).unwrap(),"now").unwrap();
    }
    fixture.finish();
    fixture.execution_until(&reference(&first,"execution_ref"),|s|s.record.receipt.is_some() && !s.record.finalization_pending).await;
    assert_eq!(call(&app,native_wait_query("native-parent")).await["blocked"],true);
    let wrong_owner=raw_call(&app,"mallory",native_wait_query("native-parent")).await;
    assert_eq!(wrong_owner.is_error,Some(true));
    fixture.authority().stop(&identity("alice"),&base_grants(),"global","fixture stop","now").unwrap();
    assert_eq!(call(&app,native_wait_query("native-parent")).await["reason"],"human_stop_active");
    assert_eq!(native.submits.load(Ordering::SeqCst),0);
    assert_eq!(native.snapshots.load(Ordering::SeqCst),0);
    assert_eq!(fixture.wake_intents(),0);
}


#[tokio::test]
async fn lost_wake_ack_is_recovered_after_restart_without_another_native_turn() {
    let fixture=Fixture::new();
    let native=Native::new();
    native.lose_ack.store(true,Ordering::SeqCst);
    let app=application(&fixture,native.clone(),true);
    let first=call(&app,fixture.create("recover-wake-ack",vec![])).await;
    let rule=reference(&first,"rule_ref");
    fixture.finish();
    fixture.execution_until(&reference(&first,"execution_ref"),|s|s.record.receipt.is_some()).await;
    until_phase(&app,&rule,"delivery_unknown").await;
    assert_eq!(native.submits.load(Ordering::SeqCst),1);
    drop(app);
    // The native session exposes the original admission after reconnect.
    native.recovery_enabled.store(true,Ordering::SeqCst);
    let restarted=application(&fixture,native.clone(),true);
    let recovered=until_phase(&restarted,&rule,"confirmed").await;
    assert_eq!(recovered["wait"]["wake_cancelled"],false);
    assert_eq!(native.submits.load(Ordering::SeqCst),1);
    assert_eq!(fixture.wake_intents(),1);
    let reads=native.recoveries.load(Ordering::SeqCst);
    assert!(reads>0);
    for _ in 0..3 {
        assert_eq!(call(&restarted,reconcile(&rule)).await["wait"]["phase"],"confirmed");
    }
    assert_eq!(native.submits.load(Ordering::SeqCst),1);
    assert_eq!(native.recoveries.load(Ordering::SeqCst),reads);
}


#[tokio::test]
async fn stop_after_durable_registration_before_launch_prevents_a_new_build_after_restart() {
    let fixture=Fixture::new();
    let native=Native::new();
    let binding=fixture.lease();
    let resource_ref=binding.resource_ref.clone();
    let request=fixture.create("crash-before-launch",vec![binding]);
    let catalog::Automation::Create{session_ref,request_key,
        rule:catalog::AutomationRule::ProcessCompletion{execution,bindings,wake_message}}=request
        else{panic!("expected process fixture")};
    let catalog::ProcessExecution::Start{argv,cwd,deadline_unix_ms,stop_grace_ms}=&execution
        else{panic!("expected supervised start")};
    let record=fixture.store().prepare_start(StartRequest{
        principal_ref:"alice".into(),session_ref:session_ref.clone(),request_key:request_key.clone(),
        argv:argv.clone(),cwd:cwd.into(),deadline_unix_ms:*deadline_unix_ms,
        stop_grace_ms:stop_grace_ms.unwrap_or(2000),
    }).unwrap();
    herder::application::process_bindings::write_delegation(
        &fixture.store(),&record.execution_ref,"alice",&fixture.config.resources,bindings.clone()).unwrap();
    for binding in &bindings {
        claim::bind_execution(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized,
            &binding.claim_id,"alice",binding.revision,&record.execution_ref).unwrap();
    }
    let rule=format!("process-rule:{}",record.execution_ref.trim_start_matches("exec-"));
    let immutable=serde_json::json!({"version":1,"rule_ref":rule,"principal":"alice",
        "session_ref":session_ref,"request_key":request_key,"execution_ref":record.execution_ref,
        "execution":execution,"bindings":bindings,"wake_message":wake_message});
    {
        let metadata=fs::metadata(&fixture.gate).unwrap();
        let _gate=acquire_pinned(&fixture.gate,metadata.dev(),metadata.ino()).unwrap();
        let mut writer=Writer::open_file(&fixture.db).unwrap();
        writer.put_setting_once("automation:process-completion:alice",&format!("rule:{rule}"),
            &immutable.to_string(),"now").unwrap();
        // Simulate a crash before the initial WaitState and supervisor launch.
    }
    fixture.authority().stop(&identity("alice"),&base_grants(),"global","stop before launch","now").unwrap();
    let restarted=application(&fixture,native.clone(),true);
    let held=call(&restarted,reconcile(&rule)).await;
    assert_eq!(held["wait"]["phase"],"cancelled");
    assert!(held["execution"]["record"]["process"].is_null());
    assert!(held["execution"]["record"]["started_at_unix_ms"].is_null());
    assert_eq!(held["execution"]["record"]["receipt"]["tree_complete"],true);
    assert_eq!(held["execution"]["record"]["receipt"]["process_may_be_running"],false);
    assert_eq!(held["execution"]["record"]["finalization_pending"],false);
    assert!(claim::read_current(&fixture.config.resources,&resource_ref,Authorization::Authorized).unwrap().is_none());
    assert_eq!(call(&restarted,native_wait_query("native-parent")).await["blocked"],true);
    {
        let metadata=fs::metadata(&fixture.gate).unwrap();
        let _gate=acquire_pinned(&fixture.gate,metadata.dev(),metadata.ino()).unwrap();
        let connection=Connection::open(&fixture.db).unwrap();
        let version:i64=connection.pragma_query_value(None,"user_version",|r|r.get(0)).unwrap();
        connection.create_scalar_function("herder_writer_version",0,
            FunctionFlags::SQLITE_UTF8|FunctionFlags::SQLITE_DETERMINISTIC,move |_|Ok(version)).unwrap();
        connection.execute("UPDATE humanstop_holds SET released_at='later' WHERE scope_ref='global'",[]).unwrap();
    }
    for _ in 0..3 {
        let value=call(&restarted,reconcile(&rule)).await;
        assert_eq!(value["wait"]["phase"],"cancelled");
        assert!(value["execution"]["record"]["process"].is_null());
        assert!(value["execution"]["record"]["started_at_unix_ms"].is_null());
    }
    assert!(!fixture.root.join("runs").exists());
    assert_eq!(call(&restarted,native_wait_query("native-parent")).await["blocked"],false);
    assert_eq!(native.submits.load(Ordering::SeqCst),0);
    assert_eq!(fixture.wake_intents(),0);
}

fn continuation_disabled(fixture:&Fixture,native:Arc<Native>)->ProcessAutomationApplication{
    Arc::try_unwrap(application(fixture,native,true)).ok().unwrap().with_automatic_continuation(false)
}

#[tokio::test]
async fn disabled_continuation_rejects_create_before_execution_or_lease_binding(){
    let fixture=Fixture::new();let native=Native::new();let binding=fixture.lease();
    let before=claim::read_current(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap();
    let app=continuation_disabled(&fixture,native.clone());
    let result=raw_call(&app,"alice",fixture.create("disabled-create",vec![binding.clone()])).await;
    assert_eq!(result.is_error,Some(true));
    assert_eq!(result.structured_content.unwrap()["code"],"automatic_continuation_unsupported");
    let reference=herder::process::execution_ref_for("alice","parent",&fixture.key("disabled-create"));
    assert!(!fixture.store().execution_directory(&reference).unwrap().exists());
    assert_eq!(claim::read_current(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap(),before);
    assert!(claim::read_execution_binding(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap().is_none());
    assert_eq!(native.submits.load(Ordering::SeqCst),0);assert_eq!(fixture.wake_intents(),0);
}

#[tokio::test]
async fn disabled_continuation_blocks_prepared_recovery_but_keeps_cancel_cleanup(){
    let fixture=Fixture::new();let native=Native::new();let binding=fixture.lease();
    let catalog::Automation::Create{session_ref,request_key,
        rule:catalog::AutomationRule::ProcessCompletion{execution,bindings,wake_message}}=
        fixture.create("disabled-prepared",vec![binding.clone()]) else{panic!()};
    let catalog::ProcessExecution::Start{argv,cwd,deadline_unix_ms,stop_grace_ms}=&execution else{panic!()};
    let record=fixture.store().prepare_start(StartRequest{principal_ref:"alice".into(),session_ref:session_ref.clone(),
        request_key:request_key.clone(),argv:argv.clone(),cwd:cwd.into(),deadline_unix_ms:*deadline_unix_ms,
        stop_grace_ms:stop_grace_ms.unwrap_or(2000)}).unwrap();
    herder::application::process_bindings::write_delegation(&fixture.store(),&record.execution_ref,"alice",
        &fixture.config.resources,bindings.clone()).unwrap();
    claim::bind_execution(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized,
        &binding.claim_id,"alice",binding.revision,&record.execution_ref).unwrap();
    let rule=format!("process-rule:{}",record.execution_ref.trim_start_matches("exec-"));
    let immutable=serde_json::json!({"version":1,"rule_ref":rule,"principal":"alice","session_ref":session_ref,
        "request_key":request_key,"execution_ref":record.execution_ref,"execution":execution,"bindings":bindings,
        "wake_message":wake_message});
    {
        let m=fs::metadata(&fixture.gate).unwrap();let _gate=acquire_pinned(&fixture.gate,m.dev(),m.ino()).unwrap();
        Writer::open_file(&fixture.db).unwrap().put_setting_once("automation:process-completion:alice",
            &format!("rule:{rule}"),&immutable.to_string(),"now").unwrap();
    }
    let app=continuation_disabled(&fixture,native.clone());
    let held=call(&app,reconcile(&rule)).await;
    assert_eq!(held["execution"]["record"]["state"],"prepared");
    assert!(held["wait"]["detail"].as_str().unwrap().contains("automatic_continuation_unsupported"));
    assert!(!fixture.root.join("runs").exists());
    assert!(!fixture.store().execution_directory(&record.execution_ref).unwrap().join("launch.json").exists());
    call(&app,catalog::Automation::Delete{rule_ref:rule.clone(),revision:held["revision"].as_u64().unwrap()}).await;
    let cancelled=call(&app,reconcile(&rule)).await;
    assert_eq!(cancelled["execution"]["record"]["receipt"]["tree_complete"],true);
    assert_eq!(cancelled["execution"]["record"]["finalization_pending"],false);
    assert!(claim::read_current(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap().is_none());
    assert_eq!(native.submits.load(Ordering::SeqCst),0);assert_eq!(fixture.wake_intents(),0);
}

#[tokio::test]
async fn disabled_continuation_finalizes_existing_terminal_lease_without_new_wake(){
    let fixture=Fixture::new();let native=Native::new();let binding=fixture.lease();
    let app=application(&fixture,native.clone(),true);
    let first=call(&app,fixture.create("disabled-terminal",vec![binding.clone()])).await;
    let rule=reference(&first,"rule_ref");let execution=reference(&first,"execution_ref");
    fixture.execution_until(&execution,|s|s.confirmed_live).await;
    drop(app);
    let marker=fixture.config.resources.root.join("storage.json");let original=fs::read(&marker).unwrap();
    fs::write(&marker,b"{injected unavailable authority").unwrap();fixture.finish();
    fixture.execution_until(&execution,|s|s.record.receipt.is_some() && s.record.finalization_pending).await;
    fs::write(&marker,original).unwrap();
    let app=continuation_disabled(&fixture,native.clone());
    let completed=call(&app,reconcile(&rule)).await;
    assert_eq!(completed["execution"]["record"]["finalization_pending"],false);
    assert!(completed["wait"]["detail"].as_str().unwrap().contains("automatic_continuation_unsupported"));
    assert!(claim::read_current(&fixture.config.resources,&binding.resource_ref,Authorization::Authorized).unwrap().is_none());
    assert_eq!(native.submits.load(Ordering::SeqCst),0);assert_eq!(fixture.wake_intents(),0);
}
