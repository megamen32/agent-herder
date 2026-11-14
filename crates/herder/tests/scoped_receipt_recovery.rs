#![cfg(target_os = "linux")]

use herder::{
    application::{
        reconcile::{DurableDispatch, ReceiptBinding, Reconciliation},
        scoped_stop::{BoundedNativeHandoff, ScopedAuthority}, target_gate::acquire_pinned,
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal},
    domain::{
        adapter::{Admission, DispatchPlan, NativeReceipt, NativeSessionReader, Observation, ReadError,
            RequestKey, SendMode, SessionSnapshot, SubmitError},
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    store::Writer,
};
use rusqlite::{Connection, functions::FunctionFlags, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    fs::{self, OpenOptions},
    os::unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, io::AsRawFd},
    path::PathBuf,
    sync::{Arc, atomic::{AtomicUsize, Ordering}},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}
impl Fixture {
    fn new(state: &str, completed: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-receipt-recovery-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let db = root.join("state.db");
        let gate = root.join("gate");
        drop(Writer::create_file(&db).unwrap());
        let mut connection = Connection::open(&db).unwrap();
        connection.pragma_update(None, "foreign_keys", true).unwrap();
        connection.create_scalar_function(
            "herder_writer_version", 0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(1),
        ).unwrap();
        for migration in [
            include_str!("../src/store/migration_v1_v2.sql"),
            include_str!("../src/store/migration_v2_v3.sql"),
        ] {
            let tx = connection.transaction().unwrap();
            tx.execute_batch(migration).unwrap();
            tx.commit().unwrap();
        }
        drop(connection);
        let file = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&gate).unwrap();
        let metadata = file.metadata().unwrap();
        let pinned = acquire_pinned(&gate, metadata.dev(), metadata.ino()).unwrap();
        let mut writer = Writer::open_file(&db).unwrap();
        assert!(writer.initialize_fresh_stop_authority(&pinned, "authority-1", "initial").unwrap());
        drop(writer);
        let mut connection = mutation_connection(&db);
        let tx = connection.transaction().unwrap();
        tx.execute("INSERT INTO session_bindings VALUES ('issued','node','instance','native-session')", []).unwrap();
        tx.execute("INSERT INTO humanstop_scopes VALUES ('issued','global'),('issued','session:issued')", []).unwrap();
        tx.execute("INSERT INTO humanstop_sessions VALUES ('issued','authority-1','scope-1','initial')", []).unwrap();
        let prior = prior_error();
        tx.execute(
            "INSERT INTO tasks(task_id,principal,status,created_at,updated_at,result_json) VALUES ('task','alice',?1,'created','updated',?2)",
            params![if completed { "completed" } else { "working" }, prior],
        ).unwrap();
        tx.execute(
            "INSERT INTO intents VALUES ('intent','task','alice','issued','original-key','exact-payload',?1,NULL,'created','updated','retain')",
            [state],
        ).unwrap();
        tx.commit().unwrap();
        drop(connection);
        drop(pinned);
        drop(file);
        Self { root, db, gate }
    }
    fn authority(&self) -> ScopedAuthority {
        ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority-1".into()).unwrap()
    }
    fn reader(&self, mutation: Option<&'static str>) -> Reader {
        Reader { db: self.db.clone(), gate: self.gate.clone(), mutation,
            recover_calls: Cell::new(0), read_calls: Cell::new(0), wrong_target: false }
    }
    fn execute(&self, sql: &str) {
        mutation_connection(&self.db).execute_batch(sql).unwrap();
    }
    fn rows(&self) -> (String, Option<String>, String, String) {
        Connection::open(&self.db).unwrap().query_row(
            "SELECT i.state,i.native_receipt,t.result_json,t.updated_at FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.intent_id='intent'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap()
    }
    fn dispatch(&self, generation: &str, phase: &str) {
        mutation_connection(&self.db).execute(
            "INSERT INTO humanstop_dispatches VALUES ('intent',?1,?2,'handoff-time')",
            params![generation, phase],
        ).unwrap();
    }
    fn dispatch_phase(&self) -> (String, String, String) {
        Connection::open(&self.db).unwrap().query_row(
            "SELECT scope_generation,phase,updated_at FROM humanstop_dispatches WHERE intent_id='intent'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap()
    }
    fn other_scope(&self) {
        let mut connection = mutation_connection(&self.db);
        let tx = connection.transaction().unwrap();
        tx.execute("INSERT INTO session_bindings VALUES ('other-issued','node','instance','other-native')", []).unwrap();
        tx.execute("INSERT INTO humanstop_scopes VALUES ('other-issued','global'),('other-issued','session:other-issued')", []).unwrap();
        tx.execute("INSERT INTO humanstop_sessions VALUES ('other-issued','authority-1','another-scope','initial')", []).unwrap();
        tx.commit().unwrap();
    }
    fn next_delivery(&self, control: &NextControl) -> bool {
        let authority = self.authority();
        let target = address();
        let binding = ReceiptBinding { intent_id: "next-intent", principal: "alice", target_ref: "issued",
            request_key: "next-key", address: &target };
        let plan = DispatchPlan { target: target.clone(), mode: SendMode::Start, expected_turn: None };
        let mut allowed = grants("alice");
        allowed.push(Grant { principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(SessionRef("issued".into())), action: Action::Write });
        if authority.prepare(&identity("alice"), &allowed, &binding, "scope-1", &plan,
            "next payload", "next-task", "later", "retain").unwrap().is_none()
        { return false }
        if !authority.claim(&identity("alice"), &allowed, &binding, "scope-1", &plan, "next payload", "later").unwrap()
        { return false }
        matches!(authority.handoff(&identity("alice"), &allowed, &binding, "scope-1", plan,
            "next payload", "later", control).unwrap(), DurableDispatch::Admitted(_))
    }

    fn legacy_combined(&self, ambiguous: bool) -> (String, String, String) {
        let create_key = "original-create-key";
        let suffix = Sha256::digest(serde_json::to_vec(&(
            "create-prompt-v1", "alice", &address().instance, create_key,
        )).unwrap()).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let child_key = format!("create-prompt:{suffix}");
        let child_intent = format!("create-prompt-intent:{suffix}");
        let child_task = format!("create-prompt-task:{suffix}");
        let mut connection = mutation_connection(&self.db);
        connection.pragma_update(None, "defer_foreign_keys", true).unwrap();
        let tx = connection.transaction().unwrap();
        tx.execute("UPDATE tasks SET task_id=?1 WHERE task_id='task'", [&child_task]).unwrap();
        tx.execute("UPDATE intents SET intent_id=?1,task_id=?2,request_key=?3 WHERE intent_id='intent'", params![child_intent, child_task, child_key]).unwrap();
        tx.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,created_at) VALUES ('issued','alice',NULL,'created')", []).unwrap();
        let receipt = json!({"version":1,"request_key":create_key,"instance":address().instance,
            "native_session_id":"native-session","session_ref":"issued","parent_ref":null});
        let target = serde_json::to_string(&address().instance).unwrap();
        tx.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('root-task','alice','working','created','updated')", []).unwrap();
        tx.execute("INSERT INTO intents VALUES ('root-intent','root-task','alice',?1,?2,'create-v1:fixture','admitted',?3,'created','updated','retain')",
            params![target, create_key, receipt.to_string()]).unwrap();
        if ambiguous {
            let mut second = receipt.clone();
            second["request_key"] = json!("other-create-key");
            tx.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('other-root-task','alice','working','created','updated')", []).unwrap();
            tx.execute("INSERT INTO intents VALUES ('other-root-intent','other-root-task','alice',?1,'other-create-key','create-v1:fixture','admitted',?2,'created','updated','retain')",
                params![target, second.to_string()]).unwrap();
        }
        let parent = json!({"kind":"fresh_create_prompt_v1","instance":address().instance,
            "session_ref":"issued","delivery_task":null,
            "result":{"content":[],"isError":true,"structuredContent":{
                "create":{"effect":"confirmed","session_ref":"issued"},"prompt":{"effect":"unknown","retry":"forbidden"}}}}).to_string();
        tx.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at,result_json) VALUES ('combined','alice','completed','created','updated',?1)", [&parent]).unwrap();
        tx.commit().unwrap();
        (child_task, child_key, parent)
    }
}
// Controlled fixture construction and fault injection only. Production writes
// use the scoped authority's fenced Writer and compare-and-swap transaction.
fn mutation_connection(path: &PathBuf) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection.pragma_update(None, "foreign_keys", true).unwrap();
    connection.create_scalar_function(
        "herder_writer_version", 0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(3),
    ).unwrap();
    connection
}
// Adversarial corruption in this private fixture only. Restore the exact schema
// before returning so the read/commit CAS, rather than schema rejection, is tested.
fn inject_fixture_mutation(path: &PathBuf, sql: &str) {
    let mut connection = mutation_connection(path);
    connection.pragma_update(None, "defer_foreign_keys", true).unwrap();
    let tx = connection.transaction().unwrap();
    let mut restore = Vec::new();
    for (table, trigger) in [
        ("humanstop_dispatches", "v3_dispatch_monotonic"),
        ("humanstop_sessions", "v3_session_update_immutable"),
        ("humanstop_authority", "v3_authority_update_immutable"),
    ] {
        if sql.contains(&format!("UPDATE {table}")) {
            let definition: String = tx.query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
                [trigger], |row| row.get(0)).unwrap();
            tx.execute_batch(&format!("DROP TRIGGER {trigger}")).unwrap();
            restore.push(definition);
        }
    }
    tx.execute_batch(sql).unwrap();
    for definition in restore { tx.execute_batch(&definition).unwrap(); }
    tx.commit().unwrap();
}
fn prior_error() -> String {
    "{ \"content\": [], \"isError\": true, \"structuredContent\": {\"code\":\"outcome_unknown\",\"effect\":\"unknown\",\"retry\":\"forbidden\",\"original_error\":\"lost acknowledgement\"} }".into()
}
fn address() -> SessionAddress {
    SessionAddress { instance: InstanceRef { node: NodeRef("node".into()), instance_id: "instance".into() },
        native_session_id: "native-session".into() }
}
fn identity(name: &str) -> ConnectionIdentity {
    ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal { id: PrincipalId(name.into()) }), None)
}
fn grants(name: &str) -> Vec<Grant> {
    vec![Grant { principal: PrincipalId(name.into()),
        resource: PrivateResource::Session(SessionRef("issued".into())), action: Action::Read }]
}
#[derive(Default)]
struct NextControl(Cell<usize>);
impl BoundedNativeHandoff for NextControl {
    fn submit_bounded(&self, plan: DispatchPlan, message: &str, key: &RequestKey) -> Result<Admission, SubmitError> {
        assert_eq!(plan.target, address());
        assert_eq!(message, "next payload");
        assert_eq!(key.0, "next-key");
        self.0.set(self.0.get() + 1);
        Ok(Admission { receipt: NativeReceipt { target: plan.target, native_id: "next-native-message".into() } })
    }
}
struct Reader {
    db: PathBuf,
    gate: PathBuf,
    mutation: Option<&'static str>,
    recover_calls: Cell<usize>,
    read_calls: Cell<usize>,
    wrong_target: bool,
}
impl Reader {
    fn probe_unlocked(&self) {
        let gate = OpenOptions::new().read(true).write(true).open(&self.gate).unwrap();
        assert_eq!(unsafe { libc::flock(gate.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0,
            "native read must not hold the authority gate");
        let db = Connection::open(&self.db).unwrap();
        db.busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        db.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
    }
}
impl NativeSessionReader for Reader {
    async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> { unreachable!() }
    async fn recover_admission(&self, target: &SessionAddress, key: &RequestKey) -> Result<Option<NativeReceipt>, ReadError> {
        self.recover_calls.set(self.recover_calls.get() + 1);
        self.probe_unlocked();
        assert_eq!(target, &address());
        assert_eq!(key.0, "original-key");
        if let Some(sql) = self.mutation {
            inject_fixture_mutation(&self.db, sql);
        }
        let mut target = target.clone();
        if self.wrong_target { target.native_session_id = "foreign-session".into(); }
        Ok(Some(NativeReceipt { target, native_id: "native-message-7".into() }))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        self.read_calls.set(self.read_calls.get() + 1);
        self.probe_unlocked();
        Ok(Observation::Confirmed { receipt: receipt.clone() })
    }
}

#[tokio::test]
async fn lost_ack_recovers_once_for_unknown_dispatching_and_admitted_without_resend() {
    for state in ["unknown", "dispatching", "admitted"] {
        let fixture = Fixture::new(state, false);
        let reader = fixture.reader(None);
        let authority = fixture.authority();
        let result = authority.reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap();
        assert!(matches!(result, Reconciliation::Confirmed(_)));
        let first = fixture.rows();
        assert_eq!(first.0, "confirmed");
        let result: Value = serde_json::from_str(&first.2).unwrap();
        assert_eq!(result["structuredContent"]["reconciliation"]["original_result_json"], prior_error());
        assert_eq!(result["structuredContent"]["reconciliation"]["kind"], "native_admission");
        assert_eq!(result["structuredContent"]["reconciliation"]["ack_recovered"], true);
        assert!(!result.to_string().contains("turn_completed"));
        authority.reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap();
        assert_eq!(fixture.rows(), first);
        assert_eq!(reader.recover_calls.get(), 1);
        assert_eq!(reader.read_calls.get(), 1);
    }
}

#[tokio::test]
async fn completed_unknown_task_gains_admission_evidence_and_preserves_original_error_bytes() {
    let fixture = Fixture::new("unknown", true);
    let reader = fixture.reader(None);
    assert!(matches!(fixture.authority()
        .reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap(),
        Reconciliation::Confirmed(_)));
    let task = fixture.authority().get_delivery_task(&identity("alice"), &grants("alice"), "task").unwrap().unwrap();
    let wire = serde_json::to_value(task).unwrap();
    assert_eq!(wire["status"], "completed");
    assert_eq!(wire["result"]["structuredContent"]["outcome"], "confirmed");
    assert_eq!(wire["result"]["structuredContent"]["reconciliation"]["original_result_json"], prior_error());
}

#[tokio::test]
async fn foreign_principal_missing_grant_and_wrong_native_session_cannot_recover() {
    let fixture = Fixture::new("unknown", true);
    let mut reader = fixture.reader(None);
    assert_eq!(fixture.authority().reconcile_delivery_task(&identity("bob"), &grants("bob"), "task", &reader).await.unwrap(), Reconciliation::Unknown);
    assert!(fixture.authority().reconcile_delivery_task(&identity("alice"), &[], "task", &reader).await.is_err());
    assert_eq!(reader.recover_calls.get(), 0);
    reader.wrong_target = true;
    let before = fixture.rows();
    assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap(), Reconciliation::Unknown);
    assert_eq!(reader.read_calls.get(), 0);
    assert_eq!(fixture.rows(), before);
}

#[tokio::test]
async fn intent_or_terminal_evidence_changed_during_native_read_fails_the_full_snapshot_cas() {
    for mutation in [
        "UPDATE intents SET payload_hash='changed' WHERE intent_id='intent'",
        "UPDATE intents SET request_key='changed' WHERE intent_id='intent'",
        "UPDATE intents SET principal='bob' WHERE intent_id='intent'",
        "UPDATE intents SET updated_at='changed' WHERE intent_id='intent'",
        "UPDATE intents SET retain_until='changed' WHERE intent_id='intent'",
        "UPDATE intents SET native_receipt='untrusted-concurrent-evidence' WHERE intent_id='intent'",
        "UPDATE tasks SET updated_at='changed' WHERE task_id='task'",
        "UPDATE tasks SET result_json='{\"effect\":\"another-result\"}' WHERE task_id='task'",
    ] {
        let fixture = Fixture::new("unknown", true);
        let reader = fixture.reader(Some(mutation));
        assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap(), Reconciliation::Unknown);
        let row = fixture.rows();
        assert_eq!(row.0, "unknown");
        assert!(!row.2.contains("native_admission"));
    }
}

#[tokio::test]
async fn human_stop_keeps_its_hold_and_no_new_dispatch_or_wake_is_created() {
    let fixture = Fixture::new("unknown", true);
    fixture.execute("INSERT INTO humanstop_holds VALUES ('global','human instruction','held',NULL)");
    let reader = fixture.reader(None);
    assert!(matches!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap(), Reconciliation::Confirmed(_)));
    let db = Connection::open(&fixture.db).unwrap();
    let held: Option<String> = db.query_row("SELECT released_at FROM humanstop_holds WHERE scope_ref='global'", [], |row| row.get(0)).unwrap();
    assert_eq!(held, None);
    let counts: (u64, u64, u64, u64) = db.query_row(
        "SELECT (SELECT COUNT(*) FROM tasks),(SELECT COUNT(*) FROM intents),(SELECT COUNT(*) FROM humanstop_dispatches),(SELECT COUNT(*) FROM humanstop_interrupts)",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    assert_eq!(counts, (1, 1, 0, 0));
}

#[tokio::test]
async fn lost_ack_finalizes_exact_handoff_and_allows_a_distinct_next_delivery_once() {
    let fixture = Fixture::new("dispatching", false);
    fixture.dispatch("scope-1", "handing_off");
    let control = NextControl::default();
    assert!(!fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 0);
    let reader = fixture.reader(None);
    assert!(matches!(fixture.authority().reconcile_delivery_task(
        &identity("alice"), &grants("alice"), "task", &reader).await.unwrap(), Reconciliation::Confirmed(_)));
    assert_eq!(fixture.dispatch_phase().1, "finished");
    let result: Value = serde_json::from_str(&fixture.rows().2).unwrap();
    assert_eq!(result["structuredContent"]["reconciliation"]["original_dispatch_phase"], "handing_off");
    assert_eq!(result["structuredContent"]["reconciliation"]["dispatch_scope_generation"], "scope-1");
    assert!(fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 1);
    assert!(!fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 1);
}

#[tokio::test]
async fn already_confirmed_receipt_repairs_only_its_orphaned_dispatch_without_rewriting_result() {
    let fixture = Fixture::new("unknown", true);
    let reader = fixture.reader(None);
    fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap();
    // Reconstruct the earlier buggy persisted outcome without a backwards
    // transition through the production dispatch state machine.
    fixture.dispatch("scope-1", "handing_off");
    let before = fixture.rows();
    let verifier = fixture.reader(None);
    assert!(matches!(fixture.authority().reconcile_delivery_task(
        &identity("alice"), &grants("alice"), "task", &verifier).await.unwrap(), Reconciliation::Confirmed(_)));
    assert_eq!(verifier.recover_calls.get(), 0);
    assert_eq!(verifier.read_calls.get(), 1);
    assert_eq!(fixture.rows(), before);
    assert_eq!(fixture.dispatch_phase().1, "finished");
    let control = NextControl::default();
    assert!(fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 1);
}

#[tokio::test]
async fn changed_dispatch_or_scope_during_native_read_is_not_finalized() {
    for mutation in [
        "UPDATE humanstop_dispatches SET scope_generation='another-scope' WHERE intent_id='intent'",
        "UPDATE humanstop_dispatches SET updated_at='another-dispatch' WHERE intent_id='intent'",
        "UPDATE humanstop_dispatches SET phase='finished' WHERE intent_id='intent'",
        "UPDATE humanstop_sessions SET scope_generation='scope-2' WHERE session_ref='issued'; UPDATE humanstop_dispatches SET scope_generation='scope-2' WHERE intent_id='intent'",
    ] {
        let fixture = Fixture::new("unknown", true);
        fixture.other_scope();
        fixture.dispatch("scope-1", "handing_off");
        let before = fixture.rows();
        assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"),
            "task", &fixture.reader(Some(mutation))).await.unwrap(), Reconciliation::Unknown);
        assert_eq!(fixture.rows(), before);
        let dispatch = fixture.dispatch_phase();
        assert_eq!(dispatch.2, if mutation.contains("updated_at='another-dispatch'") { "another-dispatch" } else { "handoff-time" });
        assert_eq!(dispatch.1, if mutation.contains("phase='finished'") { "finished" } else { "handing_off" });
        let control = NextControl::default();
        assert!(!fixture.next_delivery(&control));
        assert_eq!(control.0.get(), 0);
    }
    for (generation, phase) in [("another-scope", "handing_off"), ("scope-1", "claimed")] {
        let fixture = Fixture::new("unknown", true);
        fixture.other_scope();
        fixture.dispatch(generation, phase);
        let before = fixture.dispatch_phase();
        let reader = fixture.reader(None);
        assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"),
            "task", &reader).await.unwrap(), Reconciliation::Unknown);
        assert_eq!(reader.recover_calls.get(), 0);
        assert_eq!(fixture.dispatch_phase(), before);
    }
}

#[tokio::test]
async fn changed_authority_generation_during_read_cannot_finish_the_original_dispatch() {
    let fixture = Fixture::new("unknown", true);
    fixture.dispatch("scope-1", "handing_off");
    let before = fixture.rows();
    let dispatch = fixture.dispatch_phase();
    let reader = fixture.reader(Some("UPDATE humanstop_authority SET generation='authority-2';
        UPDATE humanstop_sessions SET authority_generation='authority-2'"));
    assert!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"),
        "task", &reader).await.is_err());
    assert_eq!(reader.read_calls.get(), 1);
    assert_eq!(fixture.rows(), before);
    assert_eq!(fixture.dispatch_phase(), dispatch);
    assert!(fixture.authority().resolve_session_read(&identity("alice"), &grants("alice"),
        &SessionRef("issued".into()), &address().instance).is_err());
}

#[tokio::test]
async fn concurrent_human_stop_survives_admission_recovery_and_blocks_new_delivery() {
    let fixture = Fixture::new("unknown", true);
    fixture.dispatch("scope-1", "handing_off");
    let reader = fixture.reader(Some("INSERT INTO humanstop_holds VALUES ('global','human instruction','held',NULL)"));
    assert!(matches!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"),
        "task", &reader).await.unwrap(), Reconciliation::Confirmed(_)));
    assert_eq!(fixture.dispatch_phase().1, "finished");
    let control = NextControl::default();
    assert!(!fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 0);
    let held: bool = Connection::open(&fixture.db).unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL)",
        [], |row| row.get(0)).unwrap();
    assert!(held);
}

#[tokio::test]
async fn another_intents_handoff_remains_unsettled_after_exact_receipt_recovery() {
    let fixture = Fixture::new("unknown", true);
    fixture.dispatch("scope-1", "handing_off");
    fixture.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('other-task','bob','working','created','updated');
        INSERT INTO intents VALUES ('other-intent','other-task','bob','issued','other-key','other-payload','unknown',NULL,'created','updated','retain');
        INSERT INTO humanstop_dispatches VALUES ('other-intent','scope-1','handing_off','other-handoff')");
    assert!(matches!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"),
        "task", &fixture.reader(None)).await.unwrap(), Reconciliation::Confirmed(_)));
    let other: (String, String) = Connection::open(&fixture.db).unwrap().query_row(
        "SELECT phase,updated_at FROM humanstop_dispatches WHERE intent_id='other-intent'",
        [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(other, ("handing_off".into(), "other-handoff".into()));
    let control = NextControl::default();
    assert!(!fixture.next_delivery(&control));
    assert_eq!(control.0.get(), 0);
}

#[tokio::test]
async fn prepared_rejected_and_corrupt_receipt_are_not_recovered_or_rewritten() {
    for state in ["prepared", "rejected", "unknown"] {
        let fixture = Fixture::new(state, false);
        if state == "unknown" { fixture.execute("UPDATE intents SET native_receipt='{bad' WHERE intent_id='intent'"); }
        let before = fixture.rows();
        let reader = fixture.reader(None);
        assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &reader).await.unwrap(), Reconciliation::Unknown);
        assert_eq!(reader.recover_calls.get(), 0);
        assert_eq!(fixture.rows(), before);
    }
}

#[tokio::test]
async fn reader_without_exact_key_capability_leaves_lost_ack_unknown() {
    struct LegacyReader;
    impl NativeSessionReader for LegacyReader {
        async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> { unreachable!() }
        async fn reconcile(&self, _: &NativeReceipt) -> Result<Observation, ReadError> { panic!("missing receipt cannot be reconciled") }
    }
    let fixture = Fixture::new("unknown", true);
    let before = fixture.rows();
    assert_eq!(fixture.authority().reconcile_delivery_task(&identity("alice"), &grants("alice"), "task", &LegacyReader).await.unwrap(), Reconciliation::Unknown);
    assert_eq!(fixture.rows(), before);
}

struct CombinedReader {
    key: String,
    reads: AtomicUsize,
}
impl NativeSessionReader for CombinedReader {
    async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> { unreachable!() }
    async fn recover_admission(&self, target: &SessionAddress, key: &RequestKey) -> Result<Option<NativeReceipt>, ReadError> {
        assert_eq!(target, &address());
        assert_eq!(key.0, self.key);
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(Some(NativeReceipt { target: target.clone(), native_id: "native-message-7".into() }))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        Ok(Observation::Confirmed { receipt: receipt.clone() })
    }
}
fn combined_grants() -> Vec<Grant> {
    let mut allowed = grants("alice");
    allowed.push(Grant { principal: PrincipalId("alice".into()), action: Action::Write,
        resource: PrivateResource::Resource(format!("instance:{}", serde_json::to_string(&address().instance).unwrap())) });
    allowed
}

#[test]
fn legacy_combined_unknown_recovers_exact_derived_child_without_rewriting_the_parent_error() {
    use herder::application::scoped_stop::task_reconcile::{ScopedReceiptReconciler, TaskReconciler};
    let fixture = Fixture::new("unknown", true);
    let (_child_task, child_key, original) = fixture.legacy_combined(false);
    let authority = Arc::new(fixture.authority());
    let reader = Arc::new(CombinedReader { key: child_key, reads: AtomicUsize::new(0) });
    let reconciler = ScopedReceiptReconciler::new(authority.clone(), reader.clone());
    reconciler.reconcile(identity("alice"), combined_grants(), "combined".into(), None);
    let task = authority.get_create_task(&identity("alice"), &combined_grants(), "combined").unwrap().unwrap();
    let wire = serde_json::to_value(task).unwrap();
    assert_eq!(wire["result"]["structuredContent"]["prompt"]["outcome"], "confirmed");
    assert_eq!(wire["result"]["structuredContent"]["reconciliation"]["original_result_json"], original);
    let stored: String = Connection::open(&fixture.db).unwrap().query_row("SELECT result_json FROM tasks WHERE task_id='combined'", [], |row| row.get(0)).unwrap();
    assert_eq!(stored, original);
    reconciler.reconcile(identity("alice"), combined_grants(), "combined".into(), None);
    assert_eq!(reader.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn ambiguous_create_receipts_never_choose_a_recent_child_or_trigger_native_recovery() {
    use herder::application::scoped_stop::task_reconcile::{ScopedReceiptReconciler, TaskReconciler};
    let fixture = Fixture::new("unknown", true);
    let (_child_task, child_key, original) = fixture.legacy_combined(true);
    let authority = Arc::new(fixture.authority());
    let reader = Arc::new(CombinedReader { key: child_key, reads: AtomicUsize::new(0) });
    ScopedReceiptReconciler::new(authority.clone(), reader.clone())
        .reconcile(identity("alice"), combined_grants(), "combined".into(), None);
    let wire = serde_json::to_value(authority.get_create_task(&identity("alice"), &combined_grants(), "combined").unwrap().unwrap()).unwrap();
    assert_eq!(wire["result"]["structuredContent"]["prompt"]["effect"], "unknown");
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0);
    let stored: String = Connection::open(&fixture.db).unwrap().query_row("SELECT result_json FROM tasks WHERE task_id='combined'", [], |row| row.get(0)).unwrap();
    assert_eq!(stored, original);
}

struct ReceiptReadOnlyNative;
impl NativeSessionReader for ReceiptReadOnlyNative {
    async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        panic!("receipt lookup must not call the native reader")
    }
    async fn reconcile(&self, _: &NativeReceipt) -> Result<Observation, ReadError> {
        panic!("receipt lookup must not reconcile native state")
    }
}
impl BoundedNativeHandoff for ReceiptReadOnlyNative {
    fn submit_bounded(&self, _: DispatchPlan, _: &str, _: &RequestKey) -> Result<Admission, SubmitError> {
        panic!("receipt lookup must not submit")
    }
}
fn canonical_receipt_fixture(confirmed: bool) -> (Fixture, String, String) {
    let fixture = Fixture::new("unknown", true);
    let suffix = Sha256::digest(serde_json::to_vec(&("mcp-deliver-v1","alice","issued","original-key")).unwrap())
        .iter().map(|byte|format!("{byte:02x}")).collect::<String>();
    let task = format!("mcp-delivery-task:{suffix}");
    let intent = format!("mcp-delivery-intent:{suffix}");
    let mut connection = mutation_connection(&fixture.db);
    connection.pragma_update(None,"defer_foreign_keys",true).unwrap();
    let tx = connection.transaction().unwrap();
    tx.execute("UPDATE tasks SET task_id=?1 WHERE task_id='task'",[&task]).unwrap();
    tx.execute("UPDATE intents SET intent_id=?1,task_id=?2 WHERE intent_id='intent'",params![intent,task]).unwrap();
    if confirmed {
        let address=address();
        let binding=ReceiptBinding{intent_id:&intent,principal:"alice",target_ref:"issued",
            request_key:"original-key",address:&address};
        let receipt=NativeReceipt{target:address.clone(),native_id:"native-message-exact".into()};
        let encoded=json!({"version":1,"intent_id":binding.intent_id,"principal":binding.principal,
            "target_ref":binding.target_ref,"request_key":binding.request_key,
            "address":binding.address,"native_id":receipt.native_id}).to_string();
        tx.execute("UPDATE intents SET state='confirmed',native_receipt=?1 WHERE intent_id=?2",params![encoded,intent]).unwrap();
        tx.execute("UPDATE tasks SET result_json=?1 WHERE task_id=?2",
            params![json!({"content":[],"structuredContent":{"outcome":"confirmed","native_receipt_id":"native-message-exact"}}).to_string(),task]).unwrap();
    }
    tx.commit().unwrap();
    (fixture,task,intent)
}
fn receipt_read_app(fixture:&Fixture, allowed:Vec<Grant>)
    -> herder::application::scoped_stop::mcp_deliver::ScopedDeliverApplication<ReceiptReadOnlyNative,ReceiptReadOnlyNative> {
    herder::application::scoped_stop::mcp_deliver::ScopedDeliverApplication::new(
        Arc::new(fixture.authority()),address().instance,allowed,
        Arc::new(ReceiptReadOnlyNative),Arc::new(ReceiptReadOnlyNative),"retain".into()).unwrap()
}
fn receipt_read_request(key:&str) -> herder::mcp::catalog::Request {
    herder::mcp::catalog::Request::Deliver(herder::mcp::catalog::Deliver::Receipt{
        session_ref:"issued".into(),request_key:key.into()})
}
#[tokio::test]
async fn canonical_delivery_receipt_read_preserves_unknown_under_human_stop_without_native_io() {
    use herder::mcp::transport::ApplicationPort;
    let (fixture,task,_) = canonical_receipt_fixture(false);
    fixture.execute("INSERT INTO humanstop_holds VALUES ('global','human instruction','held',NULL)");
    let before: (String,Option<String>,String) = Connection::open(&fixture.db).unwrap().query_row(
        "SELECT i.state,i.native_receipt,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE t.task_id=?1",
        [&task],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    let app=receipt_read_app(&fixture,grants("alice"));
    let result=app.call(&identity("alice"),receipt_read_request("original-key")).await.unwrap();
    assert_ne!(result.is_error,Some(true));
    let value=result.structured_content.unwrap();
    assert_eq!(value["found"],true);
    assert_eq!(value["state"],"unknown");
    assert_eq!(value["task_ref"],task);
    assert!(value["native_receipt"].is_null());
    let after: (String,Option<String>,String) = Connection::open(&fixture.db).unwrap().query_row(
        "SELECT i.state,i.native_receipt,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE t.task_id=?1",
        [&task],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(before,after);
    let held:bool=Connection::open(&fixture.db).unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL)",[],|row|row.get(0)).unwrap();
    assert!(held);
}
#[tokio::test]
async fn canonical_delivery_receipt_read_is_scoped_and_rejects_unbound_confirmation() {
    use herder::mcp::transport::ApplicationPort;
    let (fixture,_,intent) = canonical_receipt_fixture(true);
    let app=receipt_read_app(&fixture,grants("alice"));
    let result=app.call(&identity("alice"),receipt_read_request("original-key")).await.unwrap();
    let value=result.structured_content.unwrap();
    assert_eq!(value["state"],"confirmed");
    assert_eq!(value["native_receipt"]["native_id"],"native-message-exact");
    assert_eq!(value["target"]["native_session_id"],"native-session");
    assert_eq!(value["delivery_mode"],"start");
    let missing=app.call(&identity("alice"),receipt_read_request("different-key")).await.unwrap();
    assert_eq!(missing.structured_content.unwrap()["found"],false);
    let denied=app.call(&identity("bob"),receipt_read_request("original-key")).await.unwrap();
    assert_eq!(denied.is_error,Some(true));
    let other=receipt_read_app(&fixture,grants("bob"));
    let unrelated=other.call(&identity("bob"),receipt_read_request("original-key")).await.unwrap();
    assert_eq!(unrelated.structured_content.unwrap()["found"],false);
    mutation_connection(&fixture.db).execute("UPDATE intents SET native_receipt='{}' WHERE intent_id=?1",[&intent]).unwrap();
    let corrupt=app.call(&identity("alice"),receipt_read_request("original-key")).await.unwrap();
    assert_eq!(corrupt.is_error,Some(true));
    assert_eq!(corrupt.structured_content.unwrap()["code"],"delivery_receipt_unavailable");
}


#[test]
fn canonical_resume_payload_matches_typescript_golden_vector() {
    let plan = herder::domain::adapter::DispatchPlan {
        target: SessionAddress { instance: InstanceRef { node: NodeRef("qa-node".into()),
            instance_id: "qa-instance".into() }, native_session_id: "thread-qa".into() },
        mode: herder::domain::adapter::SendMode::Start,
        expected_turn: None,
    };
    assert_eq!(herder::application::reconcile::dispatch_payload_binding(&plan, "Привет \"QA\"\nline\\path"),
        "sha256-dispatch-v1:e894ba7ab624401b386b68164016c11265b68e7493ccfc4c9e60096bcc364589");
}


#[derive(Default)]
struct CanonicalKeyNative {
    submissions: AtomicUsize,
    corrupt_registry: Option<PathBuf>,
}
impl NativeSessionReader for CanonicalKeyNative {
    async fn snapshot(&self,target:&SessionAddress)->Result<SessionSnapshot,ReadError> {
        use herder::domain::{adapter::SessionActivity,address::{Capability,CapabilityVersion,Support,Availability,Authorization}};
        if let Some(directory)=&self.corrupt_registry {
            let record=fs::read_dir(directory).unwrap().filter_map(Result::ok)
                .find(|entry|entry.path().extension().is_some_and(|v|v=="json")).unwrap().path();
            let mut value:Value=serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
            value["payload_hash"]=json!(format!("sha256-dispatch-v1:{}","c".repeat(64)));
            fs::write(&record,serde_json::to_vec(&value).unwrap()).unwrap();
        }
        Ok(SessionSnapshot{address:target.clone(),human_stop:false,activity:SessionActivity::Idle,
            capabilities:vec![Capability{name:"deliver.start".into(),version:CapabilityVersion{adapter_version:"fixture".into(),capability_version:"1".into()},
                supported:Support::Supported,available:Availability::Available,authorized:Authorization::Authorized}]})
    }
    async fn reconcile(&self,receipt:&NativeReceipt)->Result<Observation,ReadError>{
        Ok(Observation::Confirmed{receipt:receipt.clone()})
    }
}
impl BoundedNativeHandoff for CanonicalKeyNative {
    fn submit_bounded(&self,plan:DispatchPlan,_:&str,_:&RequestKey)->Result<Admission,SubmitError>{
        self.submissions.fetch_add(1,Ordering::SeqCst);
        Ok(Admission{receipt:NativeReceipt{target:plan.target,native_id:"native-global-key".into()}})
    }
}
fn global_keys(fixture:&Fixture)->Arc<herder::application::delivery_keys::DeliveryKeyRegistry>{
    use herder::ownership::manifest::{StorageAuthority,StorageId,AuthorityRoute};
    let root=fixture.root.join("resources-authority");fs::create_dir(&root).unwrap();
    fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
    let marker=root.join("storage.json");fs::write(&marker,r#"{"schema":"v1","storage_id":"qa-native-keys"}"#).unwrap();
    fs::set_permissions(marker,fs::Permissions::from_mode(0o600)).unwrap();
    Arc::new(herder::application::delivery_keys::DeliveryKeyRegistry::new(StorageAuthority{
        storage_id:StorageId("qa-native-keys".into()),authority_node:NodeRef("node".into()),root,
        schema:"v1".into(),route:AuthorityRoute::Local}).unwrap())
}
fn key_send(session:&str,key:&str)->herder::mcp::catalog::Request{
    use herder::mcp::catalog::{Request,Deliver,DeliveryMode};
    Request::Deliver(Deliver::Session{session_ref:session.into(),request_key:key.into(),message:"one selected payload".into(),mode:DeliveryMode::Start})
}
#[tokio::test]
async fn compatibility_key_target_switch_is_rejected_before_a_second_native_submission() {
    use herder::mcp::{transport::ApplicationPort,catalog};
    let fixture=Fixture::new("rejected",true);fixture.other_scope();
    let keys=global_keys(&fixture);let native=Arc::new(CanonicalKeyNative::default());
    let mut allowed=grants("alice");
    for session in ["issued","other-issued"] {
        allowed.push(Grant{principal:PrincipalId("alice".into()),resource:PrivateResource::Session(SessionRef(session.into())),action:Action::Write});
        allowed.push(Grant{principal:PrincipalId("alice".into()),resource:PrivateResource::Session(SessionRef(session.into())),action:Action::Read});
    }
    let app=herder::application::scoped_stop::mcp_deliver::ScopedDeliverApplication::new(
        Arc::new(fixture.authority()),address().instance,allowed,native.clone(),native.clone(),"retain".into()).unwrap().with_delivery_keys(keys);
    let key=format!("compat-resume:v1:{}","a".repeat(64));
    let first=app.call(&identity("alice"),key_send("issued",&key)).await.unwrap();
    assert_ne!(first.is_error,Some(true),"{first:?}");assert_eq!(native.submissions.load(Ordering::SeqCst),1);
    let second=app.call(&identity("alice"),key_send("other-issued",&key)).await.unwrap();
    assert_eq!(second.structured_content.unwrap()["code"],"idempotency_conflict");
    let read=app.call(&identity("alice"),catalog::Request::Deliver(catalog::Deliver::Receipt{session_ref:"other-issued".into(),request_key:key.clone()})).await.unwrap();
    assert_eq!(read.structured_content.unwrap()["code"],"idempotency_conflict");
    let replay=app.call(&identity("alice"),key_send("issued",&key)).await.unwrap();
    assert_ne!(replay.is_error,Some(true));assert_eq!(native.submissions.load(Ordering::SeqCst),1);
}
#[tokio::test]
async fn compatibility_key_is_revalidated_inside_the_actual_native_handoff() {
    use herder::mcp::transport::ApplicationPort;
    let fixture=Fixture::new("rejected",true);
    let keys=global_keys(&fixture);let native=Arc::new(CanonicalKeyNative{submissions:AtomicUsize::new(0),
        corrupt_registry:Some(fixture.root.join("resources-authority/delivery-bindings"))});
    let mut allowed=grants("alice");allowed.push(Grant{principal:PrincipalId("alice".into()),resource:PrivateResource::Session(SessionRef("issued".into())),action:Action::Write});
    let app=herder::application::scoped_stop::mcp_deliver::ScopedDeliverApplication::new(
        Arc::new(fixture.authority()),address().instance,allowed,native.clone(),native.clone(),"retain".into()).unwrap().with_delivery_keys(keys);
    let key=format!("compat-resume:v1:{}","b".repeat(64));
    let _=app.call(&identity("alice"),key_send("issued",&key)).await.unwrap();
    assert_eq!(native.submissions.load(Ordering::SeqCst),0);
    let state:String=Connection::open(&fixture.db).unwrap().query_row("SELECT state FROM intents WHERE request_key=?1",[key],|r|r.get(0)).unwrap();
    assert_eq!(state,"rejected");
}
