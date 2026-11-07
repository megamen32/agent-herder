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
    fn migrate_v4(&self) {
        let meta = fs::metadata(&self.gate).unwrap();
        let gate = acquire_pinned(&self.gate, meta.dev(), meta.ino()).unwrap();
        Writer::open_file(&self.db)
            .unwrap()
            .migrate_search_v4(&gate)
            .unwrap();
    }
    fn new() -> Self {
        Self::new_in(&PathBuf::from(std::env::var_os("HOME").unwrap()))
    }
    fn new_in(parent: &std::path::Path) -> Self {
        let root = parent.join(format!(
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
fn v4_migration_rejects_gate_from_another_authority() {
    let first = Fixture::new();
    let second = Fixture::new();
    let meta = fs::metadata(&second.gate).unwrap();
    let wrong_gate = acquire_pinned(&second.gate, meta.dev(), meta.ino()).unwrap();
    assert!(
        Writer::open_file(&first.db)
            .unwrap()
            .migrate_search_v4(&wrong_gate)
            .is_err()
    );
    let db = Connection::open(&first.db).unwrap();
    let version: i32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 3);
}

#[test]
fn launcher_opens_migrated_v4_without_losing_authority() {
    let f = Fixture::new();
    f.migrate_v4();
    assert!(scoped_profile::open(&f.profile).is_ok());
    let db = Connection::open(&f.db).unwrap();
    let generation: String = db
        .query_row(
            "SELECT generation FROM humanstop_authority WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(generation, "generation");
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
                &Creator(instance.clone()),
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
    drop(db);
    let session = SessionRef("fresh".into());
    let session_grants = [Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(session.clone()),
        action: Action::Write,
    }];
    scoped_profile::open(&f.profile)
        .unwrap()
        .stop(&id, &session_grants, "session:fresh", "manual", "now")
        .unwrap();
    f.migrate_v4();
    let reopened = scoped_profile::open(&f.profile).unwrap();
    let (address, scope) = reopened
        .resolve_session(&id, &session_grants, &session, &instance)
        .unwrap();
    assert_eq!(address.native_session_id, "native-fresh");
    assert_eq!(scope, "fresh-generation");
    let db = Connection::open(&f.db).unwrap();
    let hold: String = db.query_row("SELECT reason FROM humanstop_holds WHERE scope_ref='session:fresh' AND released_at IS NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(hold, "manual");
}

#[test]
fn launch_rejects_downgraded_version_and_missing_v3_fence() {
    let f = Fixture::new();
    let c = Connection::open(&f.db).unwrap();
    c.execute_batch("DROP TRIGGER v3_authority_update_immutable; PRAGMA user_version=1;")
        .unwrap();
    assert!(
        scoped_profile::open(&f.profile).is_err(),
        "v3 authority in a downgraded and damaged store must be rejected"
    );
}
#[test]
fn launch_rejects_v3_store_missing_schema_fence() {
    let f = Fixture::new();
    let c = Connection::open(&f.db).unwrap();
    c.execute_batch("DROP TRIGGER v3_authority_update_immutable;")
        .unwrap();
    assert!(scoped_profile::open(&f.profile).is_err());
}

#[test]
fn launch_rejects_writable_ancestor() {
    let base = Fixture::new();
    let unsafe_parent = base.root.join("unsafe-parent");
    fs::create_dir(&unsafe_parent).unwrap();
    fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
    let f = Fixture::new_in(&unsafe_parent);
    assert!(
        scoped_profile::open(&f.profile).is_err(),
        "a valid authority under a writable ancestor must be refused"
    );
}

#[test]
fn fifo_profile_is_rejected_without_waiting_for_a_writer() {
    let f = Fixture::new();
    fs::remove_file(&f.profile).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(&f.profile)
            .status()
            .unwrap()
            .success()
    );
    let result = Command::new("timeout")
        .args(["3", env!("CARGO_BIN_EXE_herder_native_stdio"), "--config"])
        .arg(&f.config)
        .arg("--scoped-profile")
        .arg(&f.profile)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_ne!(
        result.status.code(),
        Some(124),
        "launcher hung opening a FIFO"
    );
    assert!(!result.status.success());
}

#[test]
fn scoped_stdio_rejects_spoofed_identity_and_mutation() {
    use std::io::Write;
    let f = Fixture::new();
    let mut process = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--config")
        .arg(&f.config)
        .arg("--scoped-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"spoof","version":"1"},"principal":"alice"},"name":"deliver","arguments":{"action":"session","session_ref":"imported","message":"test","mode":"current","request_key":"never-send"}}});
    writeln!(process.stdin.take().unwrap(), "{request}").unwrap();
    let output = process.wait_with_output().unwrap();
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["result"]["isError"], true);
    assert_eq!(response["result"]["structuredContent"]["effect"], "none");
    assert!(matches!(
        response["result"]["structuredContent"]["code"].as_str(),
        Some("unauthorized" | "unsupported")
    ));
    let db = Connection::open(&f.db).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM intents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn owner_profile_requires_explicit_complete_protected_configuration() {
    let f = Fixture::new();
    assert!(scoped_profile::open_owner(&f.profile).is_err());
    let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"principal":"local-owner","node":"local","instance":"codex-test","executable":"/usr/bin/codex","code_home":f.root,"cwd":f.root}});
    fs::write(&f.profile, profile.to_string()).unwrap();
    let opened = scoped_profile::open_owner(&f.profile).unwrap();
    assert_eq!(opened.owner.principal, "local-owner");
    assert_eq!(opened.owner.instance, "codex-test");
    let mut invalid = profile;
    invalid["owner"]["code_home"] = serde_json::json!("relative");
    fs::write(&f.profile, invalid.to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err());
    fs::set_permissions(&f.profile, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err());
}

#[test]
fn trusted_owner_launcher_wires_create_and_scoped_read_over_stdio() {
    use std::io::{BufRead, BufReader, Write};
    let f = Fixture::new();
    let fake = f.root.join("fake-codex");
    fs::write(&fake,r##"#!/usr/bin/python3
import json,os,sys
home=os.environ['CODEX_HOME']
experimental=False
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r['method']; p=r.get('params',{})
 if m=='initialize':
  experimental=p.get('capabilities',{}).get('experimentalApi') is True
  v={'codexHome':os.path.realpath(home)}
 elif m=='thread/start': v={'thread':{'id':'fake-thread'}}
 elif m=='thread/read': v={'thread':{'id':'fake-thread','turns':[]}}
 elif m=='turn/start':
  open(os.path.join(home,'sent'),'w').write('1')
  v={'turn':{'id':'fake-turn'}}
 elif m=='thread/items/list' and not experimental:
  print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'experimentalApi required'}}),flush=True); continue
 elif m=='thread/items/list': v={'data':[{'turnId':'fake-turn','item':{'id':'fake-item','type':'userMessage','content':[{'type':'text','text':'unique test prompt'}]}}], 'nextCursor':None, 'backwardsCursor':None}
 else: raise Exception('unexpected '+m)
 print(json.dumps({'id':r['id'],'result':v}),flush=True)
"##).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let p = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"principal":"local-owner","node":"local","instance":"codex-test","executable":fake,"code_home":f.root,"cwd":f.root}});
    fs::write(&f.profile, p.to_string()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let call = |input: &mut std::process::ChildStdin,
                out: &mut BufReader<std::process::ChildStdout>,
                v: serde_json::Value| {
        writeln!(input, "{v}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    let meta = serde_json::json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"owner-test","version":"1"},"principal":"spoof"});
    let created = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"codex-test","prompt":"unique test prompt","request_key":"one"}}}),
    );
    assert_eq!(created["result"]["resultType"], "task", "{created}");
    assert!(
        f.root.join("sent").exists(),
        "prompt must pass through actual bounded fake port: {created}"
    );
    let db = Connection::open(&f.db).unwrap();
    let session: String = db
        .query_row("SELECT session_ref FROM session_bindings", [], |r| r.get(0))
        .unwrap();
    let response = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session}}}),
    );
    assert_eq!(
        response["result"]["structuredContent"]["page"]["messages"][0]["text"],
        "unique test prompt",
        "{response}"
    );
    drop(input);
    let _ = child.wait();
    // A fresh launcher must derive the same exact grant from the durable receipt.
    let mut reopened = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = reopened.stdin.take().unwrap();
    let mut out = BufReader::new(reopened.stdout.take().unwrap());
    let after = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session}}}),
    );
    assert_eq!(
        after["result"]["structuredContent"]["page"]["messages"][0]["text"], "unique test prompt",
        "{after}"
    );
    let imported = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":"imported"}}}),
    );
    assert_eq!(imported["result"]["isError"], true, "{imported}");
    drop(input);
    let _ = reopened.wait();
}
