use super::*;
use crate::{
    adapters::{
        ahap::{AhapClient, AhapConfig},
        ahap_opencode::{AhapOpenCode, AhapPortPolicy},
    },
    application::{
        reconcile::{ReceiptBinding, StoreReceipt, store_native_receipt},
        target_gate::acquire_pinned,
    },
    auth::identity::{PrincipalId, VerifiedPrincipal},
    domain::{
        adapter::{NativeReceipt, SendMode},
        address::NodeRef,
    },
    store::{Writer, intents::NewIntent},
};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::PathBuf,
    time::Duration,
};

// This subprocess only talks on stdio. Inspect the committed fence and hold
// from a separate SQLite reader before recording each simulated native call.
const RUNNER: &str = r#"
import json, os, sqlite3, sys
for line in sys.stdin:
    r = json.loads(line)
    m, p = r["method"], r["params"]
    if m == "initialize":
        v = {"harness": p["harness"], "capabilities": json.loads(os.environ["CAPABILITIES"])}
    elif m == "init":
        v = None
    else:
        assert m == "cancelTurn" and set(p) == {"id", "inputMessageId"}
        mid = p["inputMessageId"]
        with sqlite3.connect("file:state.db?mode=ro", uri=True) as db:
            assert db.execute("SELECT state FROM humanstop_interrupts WHERE native_turn_id=?", (mid,)).fetchall() == [("dispatching",)]
            assert db.execute("SELECT scope_ref FROM humanstop_holds WHERE released_at IS NULL").fetchall() == [("session:s",)]
        with open("calls", "a") as f:
            print(json.dumps(p), file=f)
        if mid == "lost":
            sys.exit(0)
        v = {"sessionId": p["id"], "inputMessageId": mid, "cancelled": mid != "stale-at-browser"}
        if mid == "wrong-session": v["sessionId"] = "foreign"
        if mid == "wrong-message": v["inputMessageId"] = "foreign"
        if mid == "missing-flag": del v["cancelled"]
    print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "result": v}), flush=True)
"#;

fn capabilities() -> Value {
    json!({"nativeProtocol":"direct-cdp","methods":["init","cancelTurn"],
        "controlCapabilities":{"cancelTurn":true}})
}
fn identity(name: &str) -> ConnectionIdentity {
    ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId(name.into()),
        }),
        None,
    )
}
fn message(id: &str) -> String {
    format!(
        "ahap-receipt:v1:{}",
        json!({"kind":"message","native_id":id})
    )
}
struct Fixture {
    dir: PathBuf,
    address: SessionAddress,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
impl Fixture {
    fn new(harness: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "herder-browser-interrupt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let f = Self {
            dir,
            address: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("node".into()),
                    instance_id: "profile".into(),
                },
                native_session_id: format!("{harness}::draft%3Aisolated"),
            },
        };
        let mut w = Writer::create_file(&f.dir.join("state.db")).unwrap();
        for migration in [
            include_str!("../../../store/migration_v1_v2.sql"),
            include_str!("../../../store/migration_v2_v3.sql"),
        ] {
            let tx = w.connection_mut().transaction().unwrap();
            tx.execute_batch(migration).unwrap();
            tx.commit().unwrap();
        }
        drop(w);
        let gate = f.dir.join("gate");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate)
            .unwrap();
        let meta = file.metadata().unwrap();
        let guard = acquire_pinned(&gate, meta.dev(), meta.ino()).unwrap();
        let mut w = f.writer();
        assert!(
            w.initialize_fresh_stop_authority(&guard, "authority", "now")
                .unwrap()
        );
        let tx = w.connection_mut().transaction().unwrap();
        tx.execute(
            "INSERT INTO session_bindings VALUES('s','node','profile',?1)",
            [&f.address.native_session_id],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO humanstop_scopes VALUES('s','global'),('s','session:s')",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO humanstop_sessions VALUES('s','authority','generation','now')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        f
    }
    fn writer(&self) -> Writer {
        Writer::open_file(&self.dir.join("state.db")).unwrap()
    }
    fn input(&self, key: &str, principal: &str, receipt: Option<&str>, tracked: bool) {
        let mut w = self.writer();
        let intent = format!("intent-{key}");
        w.prepare_intent(&NewIntent {
            intent_id: &intent,
            task_id: &format!("task-{key}"),
            principal,
            target: "s",
            request_key: key,
            payload_hash: "sha256-dispatch-v1:test",
            now: "same",
            retain_until: "later",
        })
        .unwrap();
        w.connection()
            .execute(
                "UPDATE intents SET state='unknown' WHERE intent_id=?1",
                [&intent],
            )
            .unwrap();
        if tracked {
            w.connection()
                .execute(
                    "INSERT INTO humanstop_dispatches VALUES(?1,'generation','finished','same')",
                    [&intent],
                )
                .unwrap();
        }
        if let Some(id) = receipt {
            let b = ReceiptBinding {
                intent_id: &intent,
                principal,
                target_ref: "s",
                request_key: key,
                address: &self.address,
            };
            let native = NativeReceipt {
                target: self.address.clone(),
                native_id: id.into(),
            };
            assert_eq!(
                store_native_receipt(w.connection_mut(), &b, &native, "same").unwrap(),
                StoreReceipt::Stored
            );
            w.connection()
                .execute(
                    "UPDATE intents SET state='confirmed' WHERE intent_id=?1",
                    [intent],
                )
                .unwrap();
        }
    }
    fn adapter(&self, harness: &str, caps: Value) -> Arc<AhapOpenCode> {
        let client = AhapClient::open_lazy_init(AhapConfig {
            instance_id: "profile".into(),
            harness: harness.into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec!["-c".into(), RUNNER.into()],
            cwd: self.dir.clone(),
            env: vec![("CAPABILITIES".into(), caps.to_string())],
            timeout: Duration::from_secs(3),
        })
        .unwrap();
        Arc::new(
            AhapOpenCode::new_with_policy(
                Arc::new(client),
                self.address.instance.clone(),
                self.dir.clone(),
                "fixture".into(),
                AhapPortPolicy {
                    harness: harness.into(),
                    initial_delivery_mode: SendMode::Queue,
                },
            )
            .unwrap(),
        )
    }
    fn app(&self, harness: &str) -> ScopedStopApplication {
        let adapter = self.adapter(harness, capabilities());
        assert!(adapter.supports_browser_interrupt());
        let authority = ScopedAuthority::new(
            self.dir.join("state.db"),
            self.dir.join("gate"),
            "authority".into(),
        )
        .unwrap();
        let grants = vec![Grant {
            principal: PrincipalId("owner".into()),
            resource: PrivateResource::Session(SessionRef("s".into())),
            action: Action::Write,
        }];
        ScopedStopApplication::new_with_browser_interrupt(
            authority,
            self.address.instance.clone(),
            grants,
            adapter,
        )
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
async fn stop(app: &ScopedStopApplication, caller: &str, key: &str) -> Value {
    let request = catalog::Request::Stop(catalog::Stop::Stop {
        session_ref: "s".into(),
        request_key: key.into(),
    });
    app.call(&identity(caller), request)
        .await
        .unwrap()
        .structured_content
        .unwrap()
}

#[tokio::test]
async fn browser_interrupt_uses_latest_input_and_replays_its_receipt_after_restart() {
    for harness in ["chatgpt", "zai"] {
        let f = Fixture::new(harness);
        f.input("older", "owner", Some("old-message"), true);
        f.input("latest", "owner", Some(&message("native/message:β")), true);
        // A late readback moves the old delivery to the top by updated_at.
        f.writer()
            .connection()
            .execute(
                "UPDATE intents SET updated_at='tomorrow' WHERE request_key='older'",
                [],
            )
            .unwrap();
        let app = f.app(harness);
        assert_eq!(
            stop(&app, "foreign", "latest").await["code"],
            "unauthorized"
        );
        assert_eq!(
            stop(&app, "owner", "older").await["native_interrupt"],
            "not_sent"
        );
        assert!(f.calls().is_empty());
        let ack = stop(&app, "owner", "arbitrary-stop-key").await;
        assert_eq!(
            ack,
            json!({"session_ref":"s","hold":"active","native_interrupt":"acknowledged"})
        );
        drop(app);
        let reopened = f.app(harness);
        assert_eq!(stop(&reopened, "owner", "latest").await, ack);
        assert_eq!(
            f.calls(),
            [json!({"id":f.address.native_session_id,"inputMessageId":"native/message:β"})]
        );
        // An explicit release and subsequent delivery cannot retarget the old stop.
        f.writer()
            .connection()
            .execute("UPDATE humanstop_holds SET released_at='later'", [])
            .unwrap();
        f.input("after-release", "owner", Some("third-message"), true);
        assert_eq!(
            stop(&reopened, "owner", "arbitrary-stop-key").await["native_interrupt"],
            "required_or_reconcile"
        );
        assert_eq!(f.calls().len(), 1);
    }
}

#[tokio::test]
async fn browser_interrupt_refuses_a_stop_from_before_delivery_or_from_an_older_create_prompt() {
    let f = Fixture::new("chatgpt");
    let app = f.app("chatgpt");
    assert_eq!(
        stop(&app, "owner", "before-any-input").await["native_interrupt"],
        "not_attempted_no_known_handoff"
    );
    f.writer()
        .connection()
        .execute("UPDATE humanstop_holds SET released_at='later'", [])
        .unwrap();
    let (key, _, _) = crate::application::scoped_stop::create_prompt::delivery_identifiers(
        &PrincipalId("owner".into()),
        &f.address.instance,
        "initial-create",
    )
    .unwrap();
    f.input(&key, "owner", Some("first-message"), true);
    f.input("latest", "owner", Some("current-message"), true);
    for old_key in ["before-any-input", "initial-create"] {
        assert_eq!(
            stop(&app, "owner", old_key).await["native_interrupt"],
            "not_sent"
        );
    }
    assert!(f.calls().is_empty());
    assert_eq!(
        stop(&app, "owner", "latest").await["native_interrupt"],
        "acknowledged"
    );
}

#[tokio::test]
async fn browser_interrupt_never_falls_back_past_missing_foreign_or_turn_receipts() {
    for (principal, receipt) in [
        ("owner", None),
        ("foreign", Some("foreign-id")),
        (
            "owner",
            Some(r#"ahap-receipt:v1:{"kind":"turn","native_id":"a-turn"}"#),
        ),
        ("owner", Some("ahap-receipt:v1:malformed")),
    ] {
        let f = Fixture::new("chatgpt");
        f.input("older", "owner", Some("old-message"), true);
        f.input("unproven", principal, receipt, true);
        let result = stop(&f.app("chatgpt"), "owner", "stop").await;
        assert_eq!(result["hold"], "active");
        assert_eq!(result["native_interrupt"], "required_or_reconcile");
        assert!(f.calls().is_empty());
    }
}

#[tokio::test]
async fn browser_interrupt_requires_both_echoes_and_never_retries_a_lost_reply() {
    for (id, expected) in [
        ("lost", "required_or_reconcile"),
        ("wrong-session", "required_or_reconcile"),
        ("wrong-message", "required_or_reconcile"),
        ("missing-flag", "required_or_reconcile"),
        ("stale-at-browser", "not_sent"),
        ("legacy", "acknowledged"),
    ] {
        let f = Fixture::new("zai");
        f.input("delivery", "owner", Some(id), false);
        assert_eq!(
            stop(&f.app("zai"), "owner", "stop").await["native_interrupt"],
            expected
        );
        assert_eq!(
            stop(&f.app("zai"), "owner", "different-key").await["native_interrupt"],
            expected
        );
        if id == "lost" {
            f.writer()
                .connection()
                .execute("UPDATE humanstop_holds SET released_at='later'", [])
                .unwrap();
            f.input("after-release", "owner", Some("next"), true);
            assert_eq!(
                stop(&f.app("zai"), "owner", "stop").await["native_interrupt"],
                "required_or_reconcile"
            );
        }
        assert_eq!(
            f.calls(),
            [json!({"id":f.address.native_session_id,"inputMessageId":id})]
        );
    }
}

#[test]
fn browser_interrupt_requires_a_configured_native_browser_and_advertised_control() {
    let f = Fixture::new("chatgpt");
    for (harness, caps) in [
        ("codex", capabilities()),
        ("opencode", capabilities()),
        ("zcode", capabilities()),
        (
            "chatgpt",
            json!({"nativeProtocol":"direct-cdp","methods":["init","cancelTurn"]}),
        ),
        (
            "zai",
            json!({"methods":["init","cancelTurn"],"controlCapabilities":{"cancelTurn":true}}),
        ),
        (
            "zai",
            json!({"nativeProtocol":"direct-cdp","methods":["init"],"controlCapabilities":{"cancelTurn":true}}),
        ),
    ] {
        assert!(!f.adapter(harness, caps).supports_browser_interrupt());
    }
    let port = f.adapter("chatgpt", capabilities());
    let mut wrong = f.address.clone();
    wrong.instance.instance_id = "other".into();
    assert_eq!(
        port.interrupt_input(&wrong, "msg"),
        InterruptAttempt::DefinitelyNotSent
    );
    wrong = f.address.clone();
    wrong.native_session_id = "zai::route%3Aother".into();
    assert_eq!(
        port.interrupt_input(&wrong, "msg"),
        InterruptAttempt::DefinitelyNotSent
    );
    assert!(f.calls().is_empty());
}
