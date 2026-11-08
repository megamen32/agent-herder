#![cfg(target_os = "linux")]
use herder::{
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, ScopeGenerationIssuer,
            ScopedAuthority, automation::{CompletedTurnReader, ScopedAutomationApplication},
            create_prompt::FreshSessionGrantPolicy, mcp_deliver::ScopedDeliverApplication,
        },
        target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
        target_gate::acquire_pinned,
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal},
    domain::{
        adapter::{Admission, DispatchPlan, NativeReceipt, NativeSessionReader, Observation, ReadError, RequestKey, SendMode, SessionActivity, SessionSnapshot, SubmitError},
        address::{Authorization, Availability, Capability, CapabilityVersion, InstanceRef, NodeRef, SessionAddress, SessionRef, Support},
    },
    mcp::{catalog, transport::ApplicationPort},
    store::Writer,
};
use rusqlite::{Connection, functions::FunctionFlags};
use rmcp::model::CallToolResult;
use std::{
    fs::{self, OpenOptions}, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf, sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture { root: PathBuf, db: PathBuf, gate: PathBuf }
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("herder-automation-wake-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap(); fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let db = root.join("state.db"); let gate = root.join("gate"); drop(Writer::create_file(&db).unwrap());
        let c = Connection::open(&db).unwrap(); c.pragma_update(None, "foreign_keys", true).unwrap();
        c.create_scalar_function("herder_writer_version", 0, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |_| Ok(1)).unwrap();
        c.execute_batch(include_str!("../src/store/migration_v1_v2.sql")).unwrap();
        c.execute_batch(include_str!("../src/store/migration_v2_v3.sql")).unwrap(); drop(c);
        let f = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&gate).unwrap();
        let m = f.metadata().unwrap(); let guard = acquire_pinned(&gate, m.dev(), m.ino()).unwrap();
        assert!(Writer::open_file(&db).unwrap().initialize_fresh_stop_authority(&guard, "authority-1", "now").unwrap());
        drop(guard); drop(f); Self { root, db, gate }
    }
    fn authority(&self) -> ScopedAuthority { ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into()).unwrap() }
}
fn instance() -> InstanceRef { InstanceRef { node: NodeRef("node".into()), instance_id: "profile".into() } }
fn identity() -> ConnectionIdentity { ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal { id: PrincipalId("alice".into()) }), None) }
fn base_grants() -> Vec<Grant> { vec![
    Grant { principal: PrincipalId("alice".into()), resource: PrivateResource::Resource(format!("instance:{}", serde_json::to_string(&instance()).unwrap())), action: Action::Write },
    Grant { principal: PrincipalId("alice".into()), resource: PrivateResource::Resource("humanstop:global".into()), action: Action::Write },
] }
struct Id(&'static str);
impl SessionRefIssuer for Id { fn issue(&self) -> Result<SessionRef, RegistryUnavailable> { Ok(SessionRef(self.0.into())) } }
struct Generation(&'static str);
impl ScopeGenerationIssuer for Generation { fn issue(&self) -> Result<String, ()> { Ok(format!("scope-{}", self.0)) } }
struct Creator(SessionAddress);
impl BoundedFreshRootCreate for Creator {
    fn instance(&self) -> &InstanceRef { &self.0.instance }
    fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> { Ok(self.0.clone()) }
}
fn create_session(f: &Fixture, reference: &'static str, native_id: &'static str) {
    let address = SessionAddress { instance: instance(), native_session_id: native_id.into() };
    let outcome = f.authority().create_fresh_root(&identity(), &base_grants(), &Creator(address), &Id(reference), &Generation(reference),
        CreateRequest { intent_id: &format!("create-{reference}"), task_id: &format!("task-create-{reference}"), request_key: reference, specification: "fixture", now: "now", retain_until: "later" }).unwrap();
    assert_eq!(outcome, CreateResult::Created(SessionRef(reference.into())));
}
struct Policy;
impl FreshSessionGrantPolicy for Policy {
    fn session_write_grant(&self, p: &PrincipalId, _: &InstanceRef, s: &SessionRef) -> Result<Option<Grant>, ()> { Ok(Some(Grant { principal: p.clone(), resource: PrivateResource::Session(s.clone()), action: Action::Write })) }
    fn session_read_grant(&self, p: &PrincipalId, _: &InstanceRef, s: &SessionRef) -> Result<Option<Grant>, ()> { Ok(Some(Grant { principal: p.clone(), resource: PrivateResource::Session(s.clone()), action: Action::Read })) }
}
struct Native { submits: AtomicUsize, stopped: AtomicBool, parent: SessionAddress }
impl NativeSessionReader for Native {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        Ok(SessionSnapshot { address: target.clone(), human_stop: self.stopped.load(Ordering::SeqCst), activity: SessionActivity::Idle,
            capabilities: vec![Capability { name: "deliver.start".into(), version: CapabilityVersion { adapter_version: "fake-ahap".into(), capability_version: "1".into() }, supported: Support::Supported, available: Availability::Available, authorized: Authorization::Authorized }] })
    }
    async fn reconcile(&self, r: &NativeReceipt) -> Result<Observation, ReadError> { Ok(Observation::Confirmed { receipt: r.clone() }) }
}
impl BoundedNativeHandoff for Native {
    fn submit_bounded(&self, plan: DispatchPlan, _: &str, _: &RequestKey) -> Result<Admission, SubmitError> {
        assert_eq!(plan.target, self.parent); self.submits.fetch_add(1, Ordering::SeqCst);
        Ok(Admission { receipt: NativeReceipt { target: plan.target, native_id: "wake-native-receipt".into() } })
    }
}
struct Terminal { child: SessionAddress }
impl CompletedTurnReader for Terminal {
    fn confirms_completed_turn(&self, target: &SessionAddress, event_id: &str) -> Result<bool, ReadError> {
        Ok(*target == self.child && matches!(event_id, "native-turn-7" | "native-turn-8"))
    }
}
fn make_application(f: &Fixture, native: Arc<Native>) -> ScopedAutomationApplication<Terminal> {
    let authority = Arc::new(f.authority());
    let deliver: Arc<dyn ApplicationPort> = Arc::new(ScopedDeliverApplication::new(authority.clone(), instance(), base_grants(), native.clone(), native.clone(), "later".into()).unwrap().with_delivery_mode(SendMode::Start).unwrap().with_policy(Arc::new(Policy)));
    ScopedAutomationApplication::new(authority, instance(), base_grants(), Arc::new(Policy), Arc::new(Terminal { child: SessionAddress { instance: instance(), native_session_id: "native-child".into() } }), deliver, catalog::DeliveryMode::Start)
}
async fn call(app: &ScopedAutomationApplication<Terminal>, request: catalog::Automation) -> Option<CallToolResult> {
    let identity = identity();
    app.call(&identity, catalog::Request::Automation(request)).await
}

#[tokio::test]
async fn public_create_list_reconcile_replay_and_humanstop_are_durable() {
    let f = Fixture::new(); create_session(&f, "parent", "native-parent"); create_session(&f, "child", "native-child");
    let parent = SessionAddress { instance: instance(), native_session_id: "native-parent".into() };
    let native = Arc::new(Native { submits: AtomicUsize::new(0), stopped: AtomicBool::new(false), parent });
    let app = make_application(&f, native.clone());
    let create = || catalog::Automation::Create { session_ref: "parent".into(), rule: catalog::AutomationRule::ChildCompletion { child_ref: "child".into(), wake_message: "resume after child".into() }, request_key: "rule-key".into() };
    let created = call(&app, create()).await.unwrap(); assert_eq!(created.structured_content.as_ref().unwrap()["status"], "registered");
    let rule_ref = created.structured_content.as_ref().unwrap()["rule_ref"].as_str().unwrap().to_owned();
    let mut changed = create();
    if let catalog::Automation::Create { rule: catalog::AutomationRule::ChildCompletion { wake_message, .. }, .. } = &mut changed { *wake_message = "changed payload".into(); }
    assert_eq!(call(&app, changed).await.unwrap().is_error, Some(true));
    let list = call(&app, catalog::Automation::List { session_ref: Some("parent".into()), cursor: None }).await.unwrap();
    assert_eq!(list.structured_content.as_ref().unwrap()["rules"].as_array().unwrap().len(), 1);
    let reconcile = || catalog::Automation::Reconcile { rule_ref: rule_ref.clone(), child_ref: "child".into(), event_id: "native-turn-7".into() };
    let first = call(&app, reconcile()).await.unwrap(); assert_eq!(first.is_error, Some(false), "{first:?}");
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
    drop(app);
    let restarted = make_application(&f, native.clone());
    let replay = call(&restarted, reconcile()).await.unwrap(); assert_eq!(replay.is_error, Some(false), "{replay:?}");
    assert_eq!(native.submits.load(Ordering::SeqCst), 1, "restart replay must read the task receipt, not submit twice");
    native.stopped.store(true, Ordering::SeqCst);
    // New event under the same rule is confirmed natively, but owner HumanStop
    // remains authoritative and prevents a second native handoff.
    let held = call(&restarted, catalog::Automation::Reconcile { rule_ref, child_ref: "child".into(), event_id: "native-turn-8".into() }).await.unwrap();
    assert!(held.is_error == Some(true) || held.structured_content.as_ref().is_some_and(|v| v["delivery"]["isError"] == true), "{held:?}");
    assert_eq!(native.submits.load(Ordering::SeqCst), 1);
}
