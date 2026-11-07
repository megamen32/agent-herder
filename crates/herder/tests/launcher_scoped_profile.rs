#![cfg(target_os = "linux")]
#[path = "../src/bin/herder_native_stdio/scoped_profile.rs"]
mod scoped_profile;
use herder::{application::target_gate::acquire_pinned, store::Writer};
use rusqlite::{Connection, functions::FunctionFlags};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
    profile: PathBuf,
    config: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-launch-{}-{}",
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
        let profile = root.join("profile.json");
        let config = root.join("config.json");
        drop(Writer::create_file(&db).unwrap());
        let mut c = Connection::open(&db).unwrap();
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
        let m = file.metadata().unwrap();
        let guard = acquire_pinned(&gate, m.dev(), m.ino()).unwrap();
        assert!(
            Writer::open_file(&db)
                .unwrap()
                .initialize_fresh_stop_authority(&guard, "generation", "test")
                .unwrap()
        );
        drop(guard);
        let f = Self {
            root,
            db,
            gate,
            profile,
            config,
        };
        f.write_profile("generation");
        fs::write(&f.config, r#"{"local_node_id":"local","nodes":[{"id":"local","endpoint":"local","authority":{"principal":"test","secret_ref":null},"instances":[]}]}"#).unwrap();
        f
    }
    fn write_profile(&self, generation: &str) {
        let json = serde_json::json!({"database":self.db,"gate":self.gate,"generation":generation});
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        use std::io::Write;
        write!(options.open(&self.profile).unwrap(), "{json}").unwrap();
    }
    fn launch(&self) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
            .arg("--config")
            .arg(&self.config)
            .arg("--scoped-profile")
            .arg(&self.profile)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }
}
#[test]
fn launcher_opens_only_pinned_authority_and_refuses_changed_generation() {
    let f = Fixture::new();
    assert!(scoped_profile::open(&f.profile).is_ok());
    let output = f.launch();
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("ConnectionClosed(\"initialize request\")"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    f.write_profile("different-generation");
    assert!(scoped_profile::open(&f.profile).is_err());
    assert!(!f.launch().status.success());
    f.write_profile("generation");
    fs::set_permissions(&f.profile, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(scoped_profile::open(&f.profile).is_err());
    assert!(!f.launch().status.success());
    fs::set_permissions(&f.profile, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(&f.gate, f.root.join("original-gate")).unwrap();
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&f.gate)
        .unwrap();
    assert!(scoped_profile::open(&f.profile).is_err());
    assert!(!f.launch().status.success());
}

#[test]
fn launched_authority_rejects_imported_mapping_without_scope() {
    use herder::{
        auth::identity::{
            Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource,
            VerifiedPrincipal,
        },
        domain::address::{InstanceRef, NodeRef, SessionRef},
    };
    let f = Fixture::new();
    let c = Connection::open(&f.db).unwrap();
    c.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(3),
    )
    .unwrap();
    c.execute(
        "INSERT INTO session_bindings VALUES ('imported','node','profile','native')",
        [],
    )
    .unwrap();
    let principal = PrincipalId("alice".into());
    let id = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: principal.clone(),
        }),
        None,
    );
    let session = SessionRef("imported".into());
    let grants = [Grant {
        principal,
        resource: PrivateResource::Session(session.clone()),
        action: Action::Write,
    }];
    let instance = InstanceRef {
        node: NodeRef("node".into()),
        instance_id: "profile".into(),
    };
    let authority = scoped_profile::open(&f.profile).unwrap();
    assert!(
        authority
            .resolve_session(&id, &grants, &session, &instance)
            .is_err()
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM humanstop_sessions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn launched_authority_retains_fresh_create_receipt_in_the_same_store() {
    use herder::{
        application::{
            scoped_stop::{BoundedFreshRootCreate, ScopeGenerationIssuer},
            target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
        },
        auth::identity::{
            Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource,
            VerifiedPrincipal,
        },
        domain::address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    };
    struct Creator(InstanceRef);
    impl BoundedFreshRootCreate for Creator {
        fn instance(&self) -> &InstanceRef {
            &self.0
        }
        fn create_root_bounded(
            &self,
            _: &str,
            _: &str,
        ) -> Result<SessionAddress, herder::domain::adapter::SubmitError> {
            Ok(SessionAddress {
                instance: self.0.clone(),
                native_session_id: "native-fresh".into(),
            })
        }
    }
    struct Issuer;
    impl SessionRefIssuer for Issuer {
        fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
            Ok(SessionRef("fresh".into()))
        }
    }
    impl ScopeGenerationIssuer for Issuer {
        fn issue(&self) -> Result<String, ()> {
            Ok("fresh-generation".into())
        }
    }
    let f = Fixture::new();
    let authority = scoped_profile::open(&f.profile).unwrap();
    let instance = InstanceRef {
        node: NodeRef("node".into()),
        instance_id: "profile".into(),
    };
    let principal = PrincipalId("alice".into());
    let id = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: principal.clone(),
        }),
        None,
    );
    let grants = [Grant {
        principal,
        resource: PrivateResource::Resource(format!(
            "instance:{}",
            serde_json::to_string(&instance).unwrap()
        )),
        action: Action::Write,
    }];
    assert_eq!(
        authority
            .create_fresh_root(
                &id,
                &grants,
                &Creator(instance),
                &Issuer,
                &Issuer,
                CreateRequest {
                    intent_id: "create",
                    task_id: "task",
                    request_key: "unique",
                    specification: "isolated",
                    now: "now",
                    retain_until: "later"
                }
            )
            .unwrap(),
        CreateResult::Created(SessionRef("fresh".into()))
    );
    drop(authority);
    let reopened = scoped_profile::open(&f.profile);
    assert!(reopened.is_ok());
    let db = Connection::open(&f.db).unwrap();
    let receipt: String = db
        .query_row(
            "SELECT native_receipt FROM intents WHERE intent_id='create'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(receipt["native_session_id"], "native-fresh");
    assert_eq!(receipt["request_key"], "unique");
    assert_eq!(receipt["session_ref"], "fresh");
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM humanstop_sessions WHERE session_ref='fresh'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
