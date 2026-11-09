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
        if std::env::var_os("HERDER_KEEP_OWNER_FIXTURE").is_some() {
            println!("OWNER_FIXTURE_PRESERVED {}", self.root.display());
        } else {
            let _ = fs::remove_dir_all(&self.root);
        }
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
fresh=False
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r['method']; p=r.get('params',{})
 if m=='initialize':
  experimental=p.get('capabilities',{}).get('experimentalApi') is True
  v={'codexHome':os.path.realpath(home)}
 elif m=='thread/start':
  fresh=True
  v={'thread':{'id':'fake-thread'}}
 elif m=='thread/read':
  if not fresh and not os.path.exists(os.path.join(home,'sent')):
   print(json.dumps({'id':r['id'],'error':{'code':-32000,'message':'thread not yet persisted for another process'}}),flush=True);continue
  if fresh and not os.path.exists(os.path.join(home,'sent')) and p.get('includeTurns') is True:
   print(json.dumps({'id':r['id'],'error':{'code':-32000,'message':'includeTurns unavailable before first message'}}),flush=True);continue
  turns=[{'id':'fake-turn','status':'completed','items':[{'type':'userMessage'}]}] if os.path.exists(os.path.join(home,'sent')) else []
  v={'thread':{'id':'fake-thread','status':{'type':'idle'},'turns':turns}}
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
    if let Some(probe) = std::env::var_os("HERDER_OWNER_SDK_PROBE") {
        let result = Command::new(probe)
            .arg("--preflight")
            .arg(env!("CARGO_BIN_EXE_herder_native_stdio"))
            .arg(&f.profile)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "SDK preflight: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("self=unknown no_effect=true"));
    }
    if let Some(probe) = std::env::var_os("HERDER_OWNER_SDK_FULL") {
        let result = Command::new(probe)
            .arg(env!("CARGO_BIN_EXE_herder_native_stdio"))
            .arg(&f.profile)
            .arg("codex-test")
            .arg("unique test prompt")
            .arg(f.root.join("sdk-receipt.jsonl"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "SDK owner flow: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("\"task_reopen\":\"terminal\""));
        return;
    }
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
    let task_id = created["result"]["taskId"].as_str().unwrap();
    let terminal = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":8,"method":"tasks/get","params":{"_meta":meta,"taskId":task_id}}),
    );
    assert_eq!(terminal["result"]["status"], "completed", "{terminal}");
    assert_eq!(
        terminal["result"]["result"]["structuredContent"]["prompt"]["outcome"], "confirmed",
        "{terminal}"
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
    // Selecting another trusted principal does not inherit the old owner's grant.
    let mut other_profile = p.clone();
    other_profile["owner"]["principal"] = serde_json::json!("other-owner");
    fs::write(&f.profile, other_profile.to_string()).unwrap();
    let mut other = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = other.stdin.take().unwrap();
    let mut out = BufReader::new(other.stdout.take().unwrap());
    let denied = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session}}}),
    );
    assert_eq!(denied["result"]["isError"], true, "{denied}");
    drop(input);
    let _ = other.wait();
}

#[test]
#[ignore = "run exactly once in the isolated tests/native launcher after Task reconciliation review"]
fn real_sdk_owner_stdio_create_task_and_reopened_messages() {
    use std::io::{Read, Write};
    let f = Fixture::new();
    let model =
        std::env::var("HERDER_TEST_MODEL_BASE_URL").expect("isolated loopback model required");
    assert!(model.starts_with("http://127.0.0.1:") && model.ends_with("/v1"));
    let home = f.root.join("codex-home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("config.toml"),format!("model = \"herder-test\"\nmodel_provider = \"fixture\"\n[model_providers.fixture]\nname = \"fixture\"\nbase_url = \"{model}\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"fixture-only\"\n")).unwrap();
    let codex = std::env::var("HERDER_TEST_CODEX_BIN").unwrap();
    let binary = std::env::var("HERDER_OWNER_NATIVE_BINARY").unwrap();
    let probe = std::env::var("HERDER_OWNER_SDK_PROBE").unwrap();
    let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"principal":"isolated-owner","node":"isolated-node","instance":"isolated-codex","executable":codex,"code_home":home,"cwd":f.root}});
    fs::write(&f.profile, profile.to_string()).unwrap();
    let marker = format!(
        "HERDER_OWNER_INPUT_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let receipt = f.root.join("one-shot-receipt.jsonl");
    println!("OWNER_PROOF_PREPARED marker={marker} no-replay=true");
    let status = Command::new(probe)
        .arg(binary)
        .arg(&f.profile)
        .arg("isolated-codex")
        .arg(&marker)
        .arg(&receipt)
        .status()
        .unwrap();
    let evidence = fs::read_to_string(&receipt).unwrap_or_else(|_| "NO_RECEIPT_UNKNOWN".into());
    println!("OWNER_PROOF_RECEIPT {evidence}");
    let port = model
        .trim_start_matches("http://127.0.0.1:")
        .trim_end_matches("/v1")
        .parse::<u16>()
        .unwrap();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(b"GET /_stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut result = String::new();
    stream.read_to_string(&mut result).unwrap();
    let body = result.split_once("\r\n\r\n").unwrap().1;
    println!("OWNER_MODEL_STATS {body}");
    assert!(
        status.success(),
        "one-shot result failed or unknown; never resend"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(body).unwrap()["requests"],
        1,
        "fixture must observe exactly one native model request"
    );
}

#[test]
fn trusted_opencode_profile_rejects_foreign_writable_runner() {
    let f = Fixture::new();
    let script = f.root.join("runner.js");
    fs::write(&script, "// fixture").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o666)).unwrap();
    let node = fs::canonicalize("/usr/bin/python3").unwrap();
    let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"kind":"opencode","principal":"owner","node":"node","instance":"test","executable":node,"ahap_script":script,"ahap_base_url":"http://127.0.0.1:3456","code_home":f.root,"cwd":f.root}});
    fs::write(&f.profile, profile.to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err());
}

#[test]
fn trusted_owner_profiles_bind_all_v1_types_to_legacy_runners() {
    let f = Fixture::new();
    let script = f.root.join("runner.js");
    fs::write(&script, "// trusted thin adapter runner").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    for kind in ["opencode", "codex", "zcode", "chatgpt", "zai"] {
        let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":kind,"principal":"owner","node":"node","instance":format!("{kind}-one"),
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,
            "ahap_base_url":if kind=="opencode" {Some("http://127.0.0.1:3456")}else{None},
            "ahap_env":match kind { "zcode" => serde_json::json!({"AHAP_ZCODE_TRANSPORT":"official-server"}), "codex" => serde_json::json!({"AHAP_CODEX_MODEL":"gpt-6-luna"}), "opencode" => serde_json::json!({"AHAP_OPENCODE_MODEL":"minimax-coding-plan/MiniMax-M3.1-Flash"}), _ => serde_json::json!({}) },"code_home":f.root,"cwd":f.root}});
        fs::write(&f.profile, profile.to_string()).unwrap();
        let opened = scoped_profile::open_owner(&f.profile);
        assert!(opened.is_ok(), "{kind} must accept its trusted TypeScript runner");
    }
}

#[test]
fn trusted_owner_runner_rejects_process_injection_and_cross_family_environment() {
    let f = Fixture::new();
    let script = f.root.join("runner.js");
    fs::write(&script, "// trusted thin adapter runner").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["NODE_OPTIONS", "LD_PRELOAD", "HOME", "AHAP_HARNESS", "AHAP_BROWSER_PAGE_ID"] {
        let profile=serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":"opencode","principal":"owner","node":"node","instance":"one",
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,
            "ahap_base_url":"http://127.0.0.1:3456","ahap_env":{name:"bad"},"code_home":f.root,"cwd":f.root}});
        fs::write(&f.profile, profile.to_string()).unwrap();
        assert!(scoped_profile::open_owner(&f.profile).is_err(), "must reject {name}");
    }
}

#[test]
fn trusted_owner_codex_profile_accepts_only_exact_isolation_off() {
    let f = Fixture::new();
    let script = f.root.join("runner.js");
    fs::write(&script, "// trusted thin adapter runner").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let executable = fs::canonicalize("/usr/bin/python3").unwrap();
    let write_profile = |env: serde_json::Value, kind: &str| {
        let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":kind,"principal":"owner","node":"node","instance":"codex-iso",
            "executable":executable,"ahap_script":script,"ahap_env":env,"code_home":f.root,"cwd":f.root}});
        fs::write(&f.profile, profile.to_string()).unwrap();
    };
    write_profile(serde_json::json!({"AGENT_HERDER_WORKLOAD_ISOLATION":"off"}), "codex");
    assert!(
        scoped_profile::open_owner(&f.profile).is_ok(),
        "exact workload-isolation off opt-in must be accepted for codex"
    );
    for bad in ["on", "1", "Off", "off "] {
        write_profile(serde_json::json!({"AGENT_HERDER_WORKLOAD_ISOLATION":bad}), "codex");
        assert!(
            scoped_profile::open_owner(&f.profile).is_err(),
            "must reject AGENT_HERDER_WORKLOAD_ISOLATION value {bad:?}"
        );
    }
    write_profile(serde_json::json!({"AGENT_HERDER_WORKLOAD_ISOLATION":"off"}), "zcode");
    assert!(
        scoped_profile::open_owner(&f.profile).is_err(),
        "workload-isolation switch stays codex-only"
    );
}

#[test]
fn trusted_owner_opencode_ahap_create_start_task_and_read() {
    owner_ahap_public_flow("opencode");
}

#[test]
fn trusted_owner_other_ahap_types_use_same_public_create_read_and_restart() {
    for kind in ["codex", "zcode", "chatgpt", "zai"] { owner_ahap_public_flow(kind); }
}

fn owner_ahap_public_flow(kind: &str) {
    use std::io::{BufRead, BufReader, Write};
    let binary = std::env::var_os("HERDER_V1_CANDIDATE_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_herder_native_stdio").into());
    let f = Fixture::new();
    f.migrate_v4();
    let script = f.root.join("adapter.py");
    fs::write(&script,r##"import json,os,sys,base64
harness=os.environ['AHAP_HARNESS']; home=os.environ['HOME']; events=os.path.join(home,'events.json')
def messages():
 return json.load(open(events)) if os.path.exists(events) else []
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 if m=='initialize':v={'harness':harness,'capabilities':{'methods':['init','createSession','sendMessage','getSession','getSessionMessages','getRawTranscript','listSessions','archiveSession'],'deliveryModes':['start'] if harness=='opencode' else ['queue']}}
 elif m=='init':v=None
 elif m=='createSession':v={'id':'sesABC','harness':harness}
 elif m=='getSession':v={'id':'sesABC','harness':harness,'status':'idle','cwd':home}
 elif m=='listSessions':v=[{'id':'sesABC','harness':harness,'status':'idle','cwd':home}]
 elif m=='sendMessage':
  assert p['id']=='sesABC' and p['options']['queue'] is (harness!='opencode') and p['options']['activeTurnOnly'] is False and p['options']['inputId']
  rows=messages(); mid='msg_ABC'+str(len(rows)); rows.append({'id':mid,'role':'user','text':p['options']['message']})
  with open(events,'w') as out:json.dump(rows,out)
  with open(os.path.join(home,'sent'),'a') as out:out.write('1')
  v={'ok':True,'admitted':True,'nativeInputMessageId':mid,'inputId':p['options']['inputId']}
  if p['options']['message']=='unknownmarker':v={'ok':True,'admitted':True}
 elif m=='getSessionMessages':v=messages()
 elif m=='archiveSession':
  assert p['id']=='sesABC'
  with open(os.path.join(home,'archived'),'a') as out:out.write('1')
  v={'ok':True,'sessionId':p['id']}
 elif m=='getRawTranscript':v={'bytes_base64':base64.b64encode(json.dumps(messages()).encode()).decode(),'complete':True,'source':{'kind':'native-api','location':'fixture-session','format':'json'},'timestampCoverage':'none'}
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"##).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"kind":kind,"principal":"owner","node":"node","instance":"opencode-fixture","executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,"ahap_base_url":if kind=="opencode" {Some("http://127.0.0.1:3456")} else {None},"code_home":f.root,"cwd":f.root}});
    fs::write(&f.profile, profile.to_string()).unwrap();
    let mut child = Command::new(&binary)
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let call = |w: &mut std::process::ChildStdin,
                r: &mut BufReader<std::process::ChildStdout>,
                v: serde_json::Value| {
        writeln!(w, "{v}").unwrap();
        w.flush().unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    let meta = serde_json::json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"}});
    let wrong = call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"foreign-instance","prompt":"forbidden","request_key":"foreign"}}}));
    assert_eq!(wrong["result"]["isError"],true,"{wrong}");
    assert!(!f.root.join("sent").exists());
    let create = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"create","arguments":{"action":"create","instance_ref":"opencode-fixture","prompt":"ahap prompt","request_key":"once"}}}),
    );
    assert_eq!(create["result"]["resultType"], "task", "{create}");
    let task = create["result"]["taskId"].as_str().unwrap();
    let result = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"_meta":meta,"taskId":task}}),
    );
    assert_eq!(result["result"]["status"], "completed", "{result}");
    assert_eq!(
        result["result"]["result"]["structuredContent"]["prompt"]["outcome"], "confirmed",
        "{result}"
    );
    let session = result["result"]["result"]["structuredContent"]["create"]["session_ref"]
        .as_str()
        .unwrap();
    let read = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session}}}),
    );
    assert_eq!(
        read["result"]["structuredContent"]["page"]["messages"][0]["text"], "ahap prompt",
        "{read}"
    );
    assert_eq!(
        read["result"]["structuredContent"]["page"]["complete"],
        false
    );
    let direct = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":session,"message":"must not send","mode":"current","request_key":"direct-denied"}}}),
    );
    assert!(direct.to_string().contains("unsupported"), "{direct}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(), "1");
    let mode = if kind == "opencode" { "start" } else { "queue" };
    let second_args=serde_json::json!({"action":"session","session_ref":session,"message":"secondmarker","mode":mode,"request_key":"second-once"});
    let second=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":second_args}}));
    assert_eq!(second["result"]["resultType"], "task", "{second}");
    let second_id=second["result"]["taskId"].as_str().unwrap();
    let second_result=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":32,"method":"tasks/get","params":{"_meta":meta,"taskId":second_id}}));
    assert_eq!(second_result["result"]["status"],"completed","{second_result}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"11");
    let duplicate=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":second_args}}));
    assert_eq!(duplicate["result"]["taskId"],second_id,"{duplicate}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"11");
    let mut conflicting = second_args.clone(); conflicting["message"]=serde_json::json!("different payload");
    let conflict=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":101,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":conflicting}}));
    assert_eq!(conflict["result"]["structuredContent"]["code"],"idempotency_conflict","{conflict}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"11");
    let exported=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":34,"method":"tools/call","params":{"_meta":meta,"name":"export","arguments":{"action":"export","session_ref":session,"format":"native"}}}));
    assert_eq!(exported["result"]["structuredContent"]["complete"],true,"{exported}");
    let searched=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":35,"method":"tools/call","params":{"_meta":meta,"name":"search","arguments":{"action":"search","query":"secondmarker"}}}));
    assert_eq!(searched["result"]["structuredContent"]["total_hits"],1,"{searched}");
    let projects=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":36,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"projects"}}}));
    assert_eq!(projects["result"]["isError"],false,"{projects}");
    let unknown_args=serde_json::json!({"action":"session","session_ref":session,"message":"unknownmarker","mode":mode,"request_key":"unknown-once"});
    let unknown=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":102,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":unknown_args}}));
    assert_eq!(unknown["result"]["resultType"],"task","{unknown}");
    let unknown_task=unknown["result"]["taskId"].as_str().unwrap().to_owned();
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"111");
    let task_owned = task.to_owned();
    let session_owned = session.to_owned();
    drop(input);
    let _ = child.wait();
    let mut reopened = Command::new(&binary)
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = reopened.stdin.take().unwrap();
    let mut output = BufReader::new(reopened.stdout.take().unwrap());
    let after = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tasks/get","params":{"_meta":meta,"taskId":task_owned}}),
    );
    assert_eq!(after["result"]["status"], "completed", "{after}");
    let after_read = call(
        &mut input,
        &mut output,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session_owned}}}),
    );
    assert_eq!(
        after_read["result"]["structuredContent"]["page"]["messages"][0]["text"], "ahap prompt",
        "{after_read}"
    );
    // Archived test conversations preserve messages and receipts; repeating the
    // exact archive key reads the core receipt instead of a second native call.
    for archive_id in [201,202] {
        let archived=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":archive_id,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"archive","session_ref":session_owned,"request_key":"cleanup-once"}}}));
        assert_eq!(archived["result"]["structuredContent"]["archived"],true,"{archived}");
    }
    assert_eq!(fs::read_to_string(f.root.join("archived")).unwrap(),"1");
    let unresolved=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":103,"method":"tasks/get","params":{"_meta":meta,"taskId":unknown_task}}));
    assert_eq!(unresolved["result"]["result"]["structuredContent"]["code"],"outcome_unknown","{unresolved}");
    assert_eq!(unresolved["result"]["result"]["structuredContent"]["retry"],"forbidden","{unresolved}");
    let replay=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":104,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":unknown_args}}));
    assert_eq!(replay["result"]["taskId"],unknown_task,"{replay}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"111");
    let stopped=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":105,"method":"tools/call","params":{"_meta":meta,"name":"stop","arguments":{"action":"stop","session_ref":session_owned,"request_key":"stop-once"}}}));
    assert_eq!(stopped["result"]["structuredContent"]["hold"],"active","{stopped}");
    let blocked=call(&mut input,&mut output,serde_json::json!({"jsonrpc":"2.0","id":106,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":session_owned,"message":"forbidden after stop","mode":mode,"request_key":"after-stop"}}}));
    assert_eq!(blocked["result"]["isError"],true,"{blocked}");
    assert_eq!(fs::read_to_string(f.root.join("sent")).unwrap(),"111");
    drop(input);
    let _ = reopened.wait();
}

#[test]
fn one_core_routes_two_chatgpt_accounts_and_restores_tasks_after_restart() {
    use std::io::{BufRead, BufReader, Write};
    let a = Fixture::new(); let b = Fixture::new();
    for (i, f) in [&a, &b].into_iter().enumerate() {
        f.migrate_v4();
        let script = f.root.join("adapter.py");
        fs::write(&script, r#"import json,os,sys
home=os.environ['HOME']; log=os.path.join(home,'messages.json')
def messages():
 return json.load(open(log)) if os.path.exists(log) else []
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 if m=='initialize':v={'harness':'chatgpt','capabilities':{'methods':['init','createSession','sendMessage','getSession','getSessionMessages','listSessions','archiveSession'],'deliveryModes':['queue']}}
 elif m=='init':
  open(os.path.join(home,'parent-pid'),'w').write(str(os.getppid()));v=None
 elif m=='createSession':v={'id':'same-native-id','harness':'chatgpt'}
 elif m=='getSession':v={'id':'same-native-id','harness':'chatgpt','status':'idle','cwd':home}
 elif m=='listSessions':v=[{'id':'same-native-id','harness':'chatgpt','status':'idle','cwd':home}]
 elif m=='getSessionMessages':v=messages()
 elif m=='sendMessage':
  rows=messages();mid='msg-'+str(len(rows));rows.append({'id':mid,'role':'user','text':p['options']['message']})
  json.dump(rows,open(log,'w'));v={'ok':True,'admitted':True,'nativeInputMessageId':mid,'inputId':p['options']['inputId']}
 elif m=='archiveSession':
  open(os.path.join(home,'archived'),'a').write('1');v={'ok':True,'sessionId':p['id']}
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&f.profile, serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":"chatgpt","principal":"owner","node":"node","instance":format!("chatgpt-{i}"),
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,
            "code_home":f.root,"cwd":f.root}}).to_string()).unwrap();
    }
    let binary=std::env::var_os("HERDER_V1_CANDIDATE_BINARY").unwrap_or_else(||env!("CARGO_BIN_EXE_herder_native_stdio").into());
    let meta=serde_json::json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"two-profiles","version":"1"}});
    let mut sessions=Vec::new(); let mut tasks=Vec::new();
    for restart in [false,true] {
        let mut child=Command::new(&binary).arg("--trusted-owner-profile").arg(&a.profile)
            .arg("--trusted-owner-profile").arg(&b.profile)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut input=child.stdin.take().unwrap();let mut output=BufReader::new(child.stdout.take().unwrap());
        let mut seq=0;
        let mut call=|method:&str,mut params:serde_json::Value| {
            seq+=1;params["_meta"]=meta.clone();
            writeln!(input,"{}",serde_json::json!({"jsonrpc":"2.0","id":seq,"method":method,"params":params})).unwrap();input.flush().unwrap();
            let mut line=String::new(); output.read_line(&mut line).unwrap();
            assert!(!line.is_empty(),"core exited before reply");serde_json::from_str::<serde_json::Value>(&line).unwrap()
        };
        let discover=call("tools/call",serde_json::json!({"name":"discover","arguments":{"action":"instances"}}));
        assert_eq!(discover["result"]["structuredContent"]["instances"].as_array().unwrap().len(),2,"{discover}");
        let implicit=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"context"}}));
        assert_eq!(implicit["result"]["structuredContent"]["code"],"self_binding_required","{implicit}");
        for f in [&a, &b] { assert_eq!(fs::read_to_string(f.root.join("parent-pid")).unwrap(), child.id().to_string()); }
        for i in 0..2 {
            if !restart {
                let create=call("tools/call",serde_json::json!({"name":"create","arguments":{"action":"create","instance_ref":format!("chatgpt-{i}"),"prompt":format!("account-{i}"),"request_key":"same-key"}}));
                let task=create["result"]["taskId"].as_str().expect("create task").to_owned();
                let receipt=call("tasks/get",serde_json::json!({"taskId":task}));
                assert_eq!(receipt["result"]["status"],"completed","{receipt}");
                sessions.push(receipt["result"]["result"]["structuredContent"]["create"]["session_ref"].as_str().unwrap().to_owned());tasks.push(task);
                let deliver=call("tools/call",serde_json::json!({"name":"deliver","arguments":{"action":"session","session_ref":sessions[i],"message":format!("follow-{i}"),"mode":"queue","request_key":"same-deliver-key"}}));
                assert!(deliver["result"]["taskId"].is_string(),"{deliver}");
            } else {
                let receipt=call("tasks/get",serde_json::json!({"taskId":tasks[i]}));
                assert_eq!(receipt["result"]["status"],"completed","{receipt}");
            }
            let read=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"messages","session_ref":sessions[i]}}));
            let rows=read["result"]["structuredContent"]["page"]["messages"].as_array().expect("messages");
            assert_eq!(rows.len(),2,"{read}");assert_eq!(rows[0]["text"],format!("account-{i}"));assert_eq!(rows[1]["text"],format!("follow-{i}"));
            let context=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"context","session_ref":sessions[i]}}));
            assert_eq!(context["result"]["structuredContent"]["session_ref"],sessions[i],"{context}");
            assert_eq!(context["result"]["structuredContent"]["address"]["instance"]["instance_id"],format!("chatgpt-{i}"),"{context}");
            assert_eq!(context["result"]["structuredContent"]["is_self"],false,"{context}");
        }
        let archive=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"archive","session_ref":sessions[0],"request_key":"archive-first"}}));
        assert_eq!(archive["result"]["structuredContent"]["archived"],true,"{archive}");
        assert_eq!(fs::read_to_string(a.root.join("archived")).unwrap(),"1");assert!(!b.root.join("archived").exists());
        let foreign=call("tools/call",serde_json::json!({"name":"create","arguments":{"action":"create","instance_ref":"foreign","prompt":"never","request_key":"forbidden"}}));
        assert_eq!(foreign["result"]["isError"],true);
        child.kill().unwrap();let _=child.wait();
    }
}
