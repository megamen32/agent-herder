//! Fake native create control; only isolated temporary SQLite files are used.
use herder::{
    application::target::{
        self, CreateRequest, CreateResult, NativeCreateControl, NativeCreateOutcome,
        RegistryUnavailable, SessionRefIssuer, SessionRegistry, TargetError,
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::address::{InstanceRef, NodeRef, SessionRef},
    store::Writer,
};
use rusqlite::Connection;
use std::{cell::Cell, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let f = Self(std::env::temp_dir().join(format!(
                "herder-create-map-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
        drop(Writer::create_file(&f.0).unwrap());
        let mut c = Connection::open(&f.0).unwrap();
        let tx = c.transaction().unwrap();
        tx.execute_batch(include_str!("../src/store/migration_v1_v2.sql"))
            .unwrap();
        tx.commit().unwrap();
        drop(c);
        f
    }
    fn writer(&self) -> Writer {
        Writer::open_file(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
struct Fake {
    instance: InstanceRef,
    calls: Cell<usize>,
    outcome: NativeCreateOutcome,
}
impl NativeCreateControl for Fake {
    fn instance(&self) -> &InstanceRef {
        &self.instance
    }
    async fn create_once(&self, key: &str, specification: &str) -> NativeCreateOutcome {
        assert_eq!(key, "key");
        assert_eq!(specification, "isolated fixture");
        self.calls.set(self.calls.get() + 1);
        self.outcome.clone()
    }
}
struct Issuer(&'static str);
impl SessionRefIssuer for Issuer {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
        Ok(SessionRef(self.0.into()))
    }
}
fn instance() -> InstanceRef {
    InstanceRef {
        node: NodeRef("node".into()),
        instance_id: "profile".into(),
    }
}
fn auth(i: &InstanceRef) -> (ConnectionIdentity, Vec<Grant>) {
    let id = PrincipalId("creator".into());
    let target = serde_json::to_string(i).unwrap();
    (
        ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal { id: id.clone() }),
            None,
        ),
        vec![Grant {
            principal: id,
            resource: PrivateResource::Resource(format!("instance:{target}")),
            action: Action::Write,
        }],
    )
}
fn request() -> CreateRequest<'static> {
    CreateRequest {
        intent_id: "intent",
        task_id: "task",
        request_key: "key",
        specification: "isolated fixture",
        now: "now",
        retain_until: "later",
    }
}

#[tokio::test]
async fn fake_create_confirmed_persists_mapping_lineage_and_exact_receipt_atomically() {
    let f = Fixture::new();
    let mut w = f.writer();
    let i = instance();
    let (identity, grants) = auth(&i);
    let native = Fake {
        instance: i.clone(),
        calls: Cell::new(0),
        outcome: NativeCreateOutcome::Confirmed {
            request_key: "key".into(),
            instance: i.clone(),
            native_session_id: "native".into(),
            parent_ref: Some("parent".into()),
        },
    };
    assert_eq!(
        target::create_once(
            &identity,
            &grants,
            &mut w,
            &native,
            &Issuer("issued"),
            request()
        )
        .await
        .unwrap(),
        CreateResult::Created(SessionRef("issued".into()))
    );
    assert_eq!(
        target::create_once(
            &identity,
            &grants,
            &mut w,
            &native,
            &Issuer("different"),
            request()
        )
        .await
        .unwrap(),
        CreateResult::Existing
    );
    assert_eq!(native.calls.get(), 1);
    drop(w);
    let w = f.writer();
    let address = w.resolve(&SessionRef("issued".into())).unwrap().unwrap();
    assert_eq!(address.instance, i);
    assert_eq!(address.native_session_id, "native");
    drop(w);
    let c = Connection::open(&f.0).unwrap();
    let (creator,parent,state,receipt):(String,String,String,String)=c.query_row("SELECT l.creator_ref,l.parent_ref,i.state,i.native_receipt FROM lineage l JOIN intents i ON i.intent_id='intent' WHERE l.session_ref='issued'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(
        (creator.as_str(), parent.as_str(), state.as_str()),
        ("creator", "parent", "admitted")
    );
    let json: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(json["request_key"], "key");
    assert_eq!(json["native_session_id"], "native");
    assert_eq!(json["session_ref"], "issued");
}

#[tokio::test]
async fn no_fake_native_create_without_permission_or_v2_store() {
    let i = instance();
    let (identity, grants) = auth(&i);
    let native = Fake {
        instance: i.clone(),
        calls: Cell::new(0),
        outcome: NativeCreateOutcome::Unknown,
    };
    let f = Fixture::new();
    let mut v2 = f.writer();
    assert_eq!(
        target::create_once(
            &identity,
            &[],
            &mut v2,
            &native,
            &Issuer("issued"),
            request()
        )
        .await,
        Err(TargetError::Unauthorized)
    );
    let mut v1 = Writer::temporary().unwrap();
    assert_eq!(
        target::create_once(
            &identity,
            &grants,
            &mut v1,
            &native,
            &Issuer("issued"),
            request()
        )
        .await,
        Err(TargetError::Store)
    );
    assert_eq!(native.calls.get(), 0);
}

#[tokio::test]
async fn fake_unknown_spoof_and_persist_failure_never_create_mapping_or_retry() {
    for case in [
        "unknown",
        "foreign-key",
        "foreign-instance",
        "failed-lineage",
        "ignored-lineage",
    ] {
        let f = Fixture::new();
        let mut w = f.writer();
        if case == "failed-lineage" {
            let c = Connection::open(&f.0).unwrap();
            c.execute_batch("CREATE TRIGGER fixture_failure BEFORE INSERT ON lineage BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        }
        if case == "ignored-lineage" {
            let c = Connection::open(&f.0).unwrap();
            c.execute_batch("CREATE TRIGGER fixture_ignore BEFORE INSERT ON lineage BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        }
        let i = instance();
        let (identity, grants) = auth(&i);
        let outcome = match case {
            "unknown" => NativeCreateOutcome::Unknown,
            "foreign-key" => NativeCreateOutcome::Confirmed {
                request_key: "wrong".into(),
                instance: i.clone(),
                native_session_id: "native".into(),
                parent_ref: None,
            },
            "foreign-instance" => NativeCreateOutcome::Confirmed {
                request_key: "key".into(),
                instance: InstanceRef {
                    node: NodeRef("other".into()),
                    instance_id: "profile".into(),
                },
                native_session_id: "native".into(),
                parent_ref: None,
            },
            _ => NativeCreateOutcome::Confirmed {
                request_key: "key".into(),
                instance: i.clone(),
                native_session_id: "native".into(),
                parent_ref: None,
            },
        };
        let native = Fake {
            instance: i,
            calls: Cell::new(0),
            outcome,
        };
        let result = target::create_once(
            &identity,
            &grants,
            &mut w,
            &native,
            &Issuer("issued"),
            request(),
        )
        .await;
        if case == "failed-lineage" || case == "ignored-lineage" {
            assert_eq!(result, Err(TargetError::Store));
        } else {
            assert_eq!(result, Ok(CreateResult::Unknown));
        }
        assert_eq!(
            target::create_once(
                &identity,
                &grants,
                &mut w,
                &native,
                &Issuer("different"),
                request()
            )
            .await
            .unwrap(),
            CreateResult::Existing
        );
        assert_eq!(native.calls.get(), 1);
        drop(w);
        let c = Connection::open(&f.0).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT state FROM intents WHERE intent_id='intent'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "unknown"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM session_bindings", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM lineage", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn interrupted_fake_create_recovers_unknown_without_another_create() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    struct Pending {
        instance: InstanceRef,
        calls: Cell<usize>,
    }
    impl NativeCreateControl for Pending {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        async fn create_once(&self, _: &str, _: &str) -> NativeCreateOutcome {
            self.calls.set(self.calls.get() + 1);
            std::future::pending().await
        }
    }
    let f = Fixture::new();
    let mut w = f.writer();
    let i = instance();
    let (identity, grants) = auth(&i);
    let native = Pending {
        instance: i,
        calls: Cell::new(0),
    };
    {
        let mut future = std::pin::pin!(target::create_once(
            &identity,
            &grants,
            &mut w,
            &native,
            &Issuer("issued"),
            request()
        ));
        assert!(matches!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
    }
    assert_eq!(native.calls.get(), 1);
    drop(w);
    let mut w = f.writer();
    assert_eq!(
        w.recover_missing_receipt("intent", "restart").unwrap(),
        herder::application::reconcile::MissingReceiptRecovery::Unknown
    );
    let mut future = std::pin::pin!(target::create_once(
        &identity,
        &grants,
        &mut w,
        &native,
        &Issuer("different"),
        request()
    ));
    assert!(matches!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Ready(Ok(CreateResult::Existing))
    ));
    assert_eq!(native.calls.get(), 1);
}
