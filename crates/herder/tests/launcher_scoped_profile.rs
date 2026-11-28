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
fn native_opencode_owner_profile_accepts_endpoint_without_ahap_runner() {
    let f = Fixture::new();
    let profile = serde_json::json!({
        "database": f.db,
        "gate": f.gate,
        "generation": "generation",
        "owner": {
            "kind": "opencode",
            "principal": "local-owner",
            "node": "local",
            "instance": "opencode-test",
            "executable": fs::canonicalize("/usr/bin/python3").unwrap(),
            "ahap_base_url": "http://127.0.0.1:4095",
            "ahap_env": {"AHAP_OPENCODE_PASSWORD": "fixture-only"},
            "code_home": f.root,
            "cwd": f.root
        }
    });
    fs::write(&f.profile, profile.to_string()).unwrap();
    let opened = scoped_profile::open_owner(&f.profile).unwrap();
    assert_eq!(opened.owner.kind, "opencode");
    assert!(opened.owner.ahap_script.is_none());
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
 with open(os.path.join(home,'native-trace'),'a') as trace:trace.write(m+'\n')
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
    let p = serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{"principal":"local-owner","node":"local","instance":"codex-test","executable":fake,"ahap_script":fake,"ahap_env":{"AHAP_CODEX_BIN":fake,"CODEX_HOME":f.root,"AHAP_CODEX_CWD":f.root,"AGENT_HERDER_WORKLOAD_ISOLATION":"off"},"code_home":f.root,"cwd":f.root}});
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
    assert_eq!(created["result"]["resultType"], "task", "{created}; native trace: {}", fs::read_to_string(f.root.join("native-trace")).unwrap_or_default());
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
    let metadata_inventory = serde_json::json!({"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"_meta":meta,"name":"sessions","arguments":{"action":"inventory","node_ref":"local","instance_ref":"codex-test","limit":1}}});
    let off = call(&mut input, &mut out, metadata_inventory.clone());
    assert_eq!(off["result"]["structuredContent"]["code"], "metadata_inventory_not_enabled", "{off}");
    let registered = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":92,"method":"tools/call","params":{"_meta":meta,"name":"sessions","arguments":{"action":"list","node_ref":"local","instance_ref":"codex-test"}}}));
    assert_eq!(registered["result"]["structuredContent"]["sessions"][0]["session_ref"], session, "{registered}");
    assert_eq!(registered["result"]["structuredContent"]["scope"], "authorized_registered_sessions");
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
    let resolved = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"resolve","harness":"codex","native_session_id":"fake-thread","node_ref":"local"}}}));
    assert_eq!(resolved["result"]["structuredContent"]["session_ref"], session, "{resolved}");
    let instances = call(&mut input, &mut out, serde_json::json!({
        "jsonrpc":"2.0","id":20,"method":"tools/call","params":{"_meta":meta,
            "name":"discover","arguments":{"action":"instances","node_ref":"local"}}
    }));
    let instance = &instances["result"]["structuredContent"]["instances"][0];
    assert_eq!(instance["instance_ref"], "codex-test", "{instances}");
    assert_eq!(instance["harness"], "codex");
    let mut ordinary = meta.clone();
    ordinary["io.modelcontextprotocol/clientCapabilities"] = serde_json::json!({});
    let sender = serde_json::json!({"hostId":"remote","harness":"opencode","nativeSessionId":"sender"});
    let delivery = serde_json::json!({"_meta":ordinary,"name":"deliver","arguments":{
        "target":{"hostId":"local","harness":"codex","nativeSessionId":"fake-thread"},
        "sender":sender,"inputId":"cross-host-followup","message":"Follow-up from OpenCode"
    }});
    for id in [21, 22] {
        let delivered = call(&mut input, &mut out, serde_json::json!({
            "jsonrpc":"2.0","id":id,"method":"tools/call","params":delivery
        }));
        assert_eq!(delivered["result"]["structuredContent"]["outcome"], "confirmed", "{delivered}");
    }
    let receipt = call(&mut input, &mut out, serde_json::json!({
        "jsonrpc":"2.0","id":23,"method":"tools/call","params":{"_meta":ordinary,
            "name":"deliver","arguments":{"action":"receipt","session_ref":session,"request_key":"cross-host-followup"}}
    }));
    assert_eq!(receipt["result"]["structuredContent"]["native_receipt"]["sender"], sender, "{receipt}");
    let trace = fs::read_to_string(f.root.join("native-trace")).unwrap();
    assert_eq!(trace.lines().filter(|method| *method == "turn/start").count(), 2, "{trace}");
    let timer_request = serde_json::json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"_meta":meta,"name":"automation","arguments":{"action":"create","session_ref":session,"request_key":"owner-stdio-timer","rule":{"kind":"timer","trigger":{"kind":"delay","delay_ms":3600000},"wake_message":"resume after timer"}}}});
    let timer = call(&mut input, &mut out, timer_request.clone());
    let timer = timer["result"]["structuredContent"].clone();
    assert_eq!(timer["status"], "armed", "{timer}");
    let rule_ref = timer["rule_ref"].as_str().unwrap().to_owned();
    let pending = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"_meta":meta,"name":"automation","arguments":{"action":"wait_status","harness":"codex","native_session_id":"fake-thread","node_ref":"local"}}}));
    assert_eq!(pending["result"]["structuredContent"]["blocked"], true, "{pending}");
    drop(input);
    let _ = child.wait();
    // A fresh launcher must derive the same exact grant from the durable receipt.
    let mut inventory_profile = p.clone();
    inventory_profile["owner"]["codex_metadata_inventory"] = serde_json::json!(true);
    fs::write(&f.profile, inventory_profile.to_string()).unwrap();
    let state = Connection::open(f.root.join("state_5.sqlite")).unwrap();
    state.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER, cwd TEXT, updated_at INTEGER);
        INSERT INTO threads VALUES ('unregistered', 0, '/project', 10);").unwrap();
    drop(state);
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
    let inventory = call(&mut input, &mut out, metadata_inventory.clone());
    let data = &inventory["result"]["structuredContent"];
    assert_eq!(data["sessions"][0]["native_session_id"], "unregistered", "{inventory}");
    assert!(data["sessions"][0].get("session_ref").is_none());
    assert_eq!(data["runtime"]["complete"], false, "a private stdio child cannot assert shared controller coverage");
    let mut wrong_node = metadata_inventory;
    wrong_node["params"]["arguments"]["node_ref"] = serde_json::json!("other");
    let denied_inventory = call(&mut input, &mut out, wrong_node);
    assert_eq!(denied_inventory["result"]["structuredContent"]["code"], "owner_profile_mismatch");
    let bound: i64 = db.query_row("SELECT COUNT(*) FROM session_bindings", [], |r| r.get(0)).unwrap();
    assert_eq!(bound, 1, "listing metadata must not bind unregistered IDs");
    let after = call(
        &mut input,
        &mut out,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"messages","session_ref":session}}}),
    );
    assert_eq!(
        after["result"]["structuredContent"]["page"]["messages"][0]["text"], "unique test prompt",
        "{after}"
    );
    let restored = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"_meta":meta,"name":"automation","arguments":{"action":"get","rule_ref":rule_ref}}}));
    assert_eq!(restored["result"]["structuredContent"], timer, "{restored}");
    let retry = call(&mut input, &mut out, timer_request);
    assert_eq!(retry["result"]["structuredContent"], timer, "{retry}");
    let cancelled = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"_meta":meta,"name":"automation","arguments":{"action":"delete","rule_ref":rule_ref,"revision":timer["revision"]}}}));
    assert_eq!(cancelled["result"]["structuredContent"]["status"], "cancelled", "{cancelled}");
    let settled = call(&mut input, &mut out, serde_json::json!({"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"_meta":meta,"name":"automation","arguments":{"action":"wait_status","harness":"codex","native_session_id":"fake-thread","node_ref":"local"}}}));
    assert_eq!(settled["result"]["structuredContent"]["blocked"], false, "{settled}");
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
fn native_codex_owner_recovers_the_same_thread_once_after_restart() {
    exercise_codex_owner_recovery(CodexHandoff::Cohort);
}

#[test]
fn native_codex_owner_discovers_new_chats_after_restart() {
    exercise_codex_owner_recovery(CodexHandoff::Instance);
}

#[test]
fn native_codex_workspace_handoff_matches_legacy_wait_status_and_recovery() {
    exercise_codex_owner_recovery(CodexHandoff::Workspaces);
}

#[test]
fn native_codex_workspace_handoff_discovers_chats_without_an_exact_cohort() {
    exercise_codex_owner_recovery(CodexHandoff::WorkspacesOnly);
}

#[test]
fn trusted_profile_accepts_workspace_handoff_only_for_codex() {
    use serde_json::json;
    let f = Fixture::new();
    let mut profile = json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "principal":"owner","node":"local","instance":"local-opencode","kind":"opencode",
        "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"code_home":f.root,"cwd":f.root,
        "ahap_base_url":"http://127.0.0.1:1",
        "opencode_recovery":{"autopilot_state_dir":f.root,"legacy_handoff":{
            "native_sessions":["existing"], "activation_file":f.root.join("activation"),
            "human_stops":f.root.join("stops"),"unfinished_sessions":f.root.join("unfinished"),
            "human_requests":f.root.join("requests"),"choices":f.root.join("choices")}}
    }});
    fs::write(&f.profile, profile.to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_ok());
    profile["owner"]["opencode_recovery"]["legacy_handoff"]["workspaces"] =
        json!([{"cwd":"/work/one","provider":"opencodex"}]);
    fs::write(&f.profile, profile.to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err());
}

fn recovery_client_meta() -> serde_json::Value {
    serde_json::json!({
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{"name":"owner-recovery-fixture","version":"1"}
    })
}

fn launch_recovery_owner(f: &Fixture) -> std::process::Child {
    use std::io::{BufRead, BufReader, Write};
    let mut child = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--trusted-owner-profile")
        .arg(&f.profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.as_mut().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        input,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":0,"method":"tools/list","params":{
            "_meta":recovery_client_meta()
        }})
    )
    .unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let initialized: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert!(initialized["result"]["tools"].is_array(), "{initialized}");
    child.stdout = Some(output.into_inner());
    child
}

fn recovery_wait_status(child: &mut std::process::Child, harness: &str, target: &str) -> serde_json::Value {
    use std::io::{BufRead, BufReader, Write};
    let input = child.stdin.as_mut().unwrap();
    writeln!(input, "{}", serde_json::json!({"jsonrpc":"2.0","id":target,"method":"tools/call",
        "params":{"_meta":recovery_client_meta(),"name":"automation","arguments":{"action":"wait_status",
                  "harness":harness,"native_session_id":target,"node_ref":"local"}}})).unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
    serde_json::from_str::<serde_json::Value>(&line).unwrap()["result"]["structuredContent"].clone()
}

fn check_unmapped_recovery_fences(child: &mut std::process::Child, harness: &str) {
    let missing = recovery_wait_status(child, harness, "ses_Missing");
    assert_eq!(missing["blocked"], false, "{missing}");
    for id in ["ses_Offline", "ses_WrongMiss"] {
        let status = recovery_wait_status(child, harness, id);
        assert_eq!(status["blocked"], true, "{status}");
        assert_eq!(status["complete"], false, "{status}");
        assert_eq!(status["reason"], "native_recovery_ownership_unavailable", "{status}");
        assert!(status["recoveryOwner"].is_null());
    }
}

#[test]
fn native_opencode_owner_discovers_and_recovers_an_unregistered_session_once() {
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader},
        process::Child,
        thread,
        time::{Duration, Instant},
    };

    struct Server(Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let f = Fixture::new();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/opencode_recovery_listing.py");
    let mut server = Server(
        Command::new("/usr/bin/python3")
            .arg(script)
            .current_dir(&f.root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut port = String::new();
    BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut port)
        .unwrap();
    let activation = f.root.join("activation");
    let stops = f.root.join("stops");
    let requests = f.root.join("requests");
    fs::write(&stops, r#"{"version":1,"sessions":[]}"#).unwrap();
    fs::write(&requests, r#"{"version":1,"requests":[]}"#).unwrap();
    fs::write(
        f.root.join("session-autostart.json"),
        r#"{"version":8,"enabled":true,"sessions":[]}"#,
    )
    .unwrap();
    fs::write(&f.profile, json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "principal":"owner","node":"local","instance":"native-opencode","kind":"opencode",
        "executable":fs::canonicalize("/usr/bin/python3").unwrap(), "code_home":f.root, "cwd":f.root,
        "ahap_base_url":format!("http://127.0.0.1:{}", port.trim()),
        "opencode_recovery":{"autopilot_state_dir":f.root, "legacy_handoff":{
            "instance_wide":true,"activation_file":activation,"human_stops":stops,
            "unfinished_sessions":stops,"human_requests":requests,"choices":requests}}
    }}).to_string()).unwrap();
    let db = Connection::open(&f.db).unwrap();
    for restart in [false, true] {
        if restart {
            fs::write(f.root.join("restarted"), "").unwrap();
        }
        let mut owner = launch_recovery_owner(&f);
        if !restart {
            check_unmapped_recovery_fences(&mut owner, "opencode");
            fs::write(&activation, "true").unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let admitted: u32 = db.query_row(
                "SELECT COUNT(*) FROM intents i JOIN session_bindings b ON b.session_ref=i.target
                 WHERE b.native_session_id='ses_Interrupted' AND i.request_key GLOB 'opencode-recovery:*'
                 AND i.state IN ('admitted','confirmed') AND i.native_receipt IS NOT NULL", [], |r| r.get(0)
            ).unwrap();
            if admitted == 1 && (!restart || f.root.join("rechecked").exists()) {
                break;
            }
            assert!(
                owner.try_wait().unwrap().is_none() && Instant::now() < deadline,
                "owner did not recover the listed OpenCode session (restart={restart}, admitted={admitted})"
            );
            thread::sleep(Duration::from_millis(30));
        }
        drop(owner.stdin.take());
        assert!(owner.wait().unwrap().success());
    }
    let sends = fs::read_to_string(f.root.join("native-sends")).unwrap();
    assert_eq!(sends.lines().count(), 1);
    assert!(sends.starts_with("opencode-recovery:"));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodexHandoff {
    Cohort,
    Instance,
    Workspaces,
    WorkspacesOnly,
}

fn exercise_codex_owner_recovery(scope: CodexHandoff) {
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Write},
        process::Child,
        thread,
        time::{Duration, Instant},
    };

    let f = Fixture::new();
    let fake = f.root.join("fake-codex");
    let instance_wide = scope == CodexHandoff::Instance;
    let workspaces = matches!(scope, CodexHandoff::Workspaces | CodexHandoff::WorkspacesOnly);
    if workspaces {
        fs::write(f.root.join("workspace-mode"), "").unwrap();
    }
    fs::write(&fake, r#"#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path
home=Path(os.environ['CODEX_HOME'])
styles={'preserve':'openai','quota-reset':'openai','uncertain':'openai','disabled':'openai',
        'held':'openai','old-interrupt':'openai','manual-release':'openai','explicit-legacy':'openai',
        'unknown-quota':'retired','pending-question':'openai',
        'legacy-uncertain':'openai','outside-cohort':'openai','foreign-project':'openai'}
if (home/'new-native-chats').exists():
 styles.update(dict.fromkeys(('first','later-page','old','changed','completed','held-new'),'openai'))
workspace_mode=(home/'workspace-mode').exists()
if workspace_mode:
 styles.update(dict.fromkeys(('fresh','healthy','legacy-fallback','late-fallback','rerouted','sibling','outside-cohort','held-new'),'opencodex'))
 styles.update(dict.fromkeys(('reviewed-'+str(i) for i in range(10)), 'openai'))
 styles['other-provider']='openai'
 styles['missing-provider']=None
loaded={}
started=int((home/'fake-codex').stat().st_mtime)-10
def cwd(target):
 if workspace_mode:
  if target in ('fresh','healthy','legacy-fallback','late-fallback','rerouted','other-provider','held-new'): return str(home/'transferred')
  if target in ('sibling','outside-cohort'): return str(home/'transferred-old')
 if target=='later-page': return str(home/'deep-workspace')
 if target=='foreign-project': return str(home/'other-project')
 return str(home/'unverified-route') if target=='unknown-quota' else str(home)
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m,p=r['method'],r.get('params',{})
 target=p.get('threadId')
 if target=='foreign-project': (home/'touched-foreign-project').touch()
 sent=home/('sent-'+target) if target else None
 starts=sent.read_text().splitlines() if sent and sent.exists() else []
 previous='prior-'+target if target else None
 provider=loaded.get(target,styles.get(target))
 model='old-model' if provider=='retired' else 'gpt-fixture'
 item={'id':'user-'+target,'type':'userMessage','content':[{'type':'text','text':'fixture work'}]} if target else None
 kind='failed' if target in ('quota-reset','unknown-quota') else 'interrupted'
 if target in ('completed','healthy') or (target=='changed' and (home/'changed-observed').exists()): kind='completed'
 old={'id':previous,'status':kind,'startedAt':started,
      'completedAt':started+1 if kind=='failed' else None,'itemsView':'full','items':[item]}
 if kind=='failed':
  old['error']={'message':'quota','codexErrorInfo':'usageLimitExceeded'}
 if target in ('old-interrupt','manual-release','explicit-legacy','held'):
  # A later native userMessage has a caller-supplied clientId, including on automated input.
  item['clientId']='input-'+target
  old.update(status='failed',completedAt=started+1,
             error={'codexErrorInfo':{'responseTooManyFailedAttempts':{'httpStatusCode':429}}})
 turns=[old]
 if starts and target!='uncertain':
  added={'id':'recovered-'+target,'status':'inProgress','startedAt':int(time.time()),
         'itemsView':'summary','items':[{'id':'user-resumed','type':'userMessage','clientId':starts[0]}]}
  turns.append(added)
 active=len(turns)==2
 thread={'id':target,'cwd':cwd(target),'source':'cli','modelProvider':provider,'model':model,
         'status':{'type':'active','activeFlags':[]} if active else {'type':'idle' if target in loaded else 'notLoaded'},
         'turns':turns}
 if m=='initialize': v={'codexHome':str(home)}
 elif m=='thread/read':
  v={'thread':thread} if target in styles else {}
  if target=='preserve': (home/'probed-preserve').touch()
  if target=='old': (home/'probed-old').touch()
 elif m=='thread/list' and p.get('cwd') is None:
  (home/'listed').touch()
  assert p['sortKey']=='updated_at' and p['sortDirection']=='desc' and p['archived'] is False
  assert p['modelProviders']==[] and 'subAgentThreadSpawn' in p['sourceKinds']
  cursor=p.get('cursor')
  rows=[('held-new',started-2),('first',started),('completed',started-1)] if cursor is None else [
        ('later-page',started-4),('changed',started-3),('old',started-3*86400)]
  if workspace_mode:
   rows=[('sibling',started),('outside-cohort',started),('legacy-fallback',started)] if cursor is None else [
         ('healthy',started),('late-fallback',started),('rerouted',started),('fresh',started),('other-provider',started),('held-new',started)]
  assert cursor in (None,'next-page')
  v={'data':[{'id':x,'updatedAt':updated} for x,updated in rows],'nextCursor':'next-page' if cursor is None else None}
 elif m=='thread/list':
  page=int(p.get('cursor') or 0)
  if p['cwd']==cwd('later-page') and page<16:
   assert p['sortKey']=='updated_at' and p['sortDirection']=='desc'
   v={'data':[{'id':f'recent-{page}-{i}','cwd':p['cwd'],'source':'cli','status':{'type':'idle'}}
              for i in range(p['limit'])], 'nextCursor':str(page+1)}
  else:
   v={'data':[{'id':x,'cwd':cwd(x),'source':'cli','status':{'type':'idle' if x in loaded else 'notLoaded'}}
              for x in styles if cwd(x)==p.get('cwd')], 'nextCursor':None}
 elif m=='thread/turns/list' and target in styles:
  v={'data':[dict(turns[-1],itemsView=p.get('itemsView','summary'))],'nextCursor':None}
  if target=='changed': (home/'changed-observed').touch()
 elif m=='thread/goal/get':
  if target in styles: v={'goal':None}
  else:
   code=-32603 if target=='ses_Offline' else -32600
   message='reader unavailable' if target=='ses_Offline' else 'thread not found: '+('other' if target=='ses_WrongMiss' else target)
   print(json.dumps({'id':r['id'],'error':{'code':code,'message':message}}),flush=True)
   continue
 elif m=='thread/queue/list' and target in styles: v={'data':[],'nextCursor':None}
 elif m=='thread/loaded/list': v={'data':list(loaded),'nextCursor':None}
 elif m=='thread/items/list' and target in styles:
  v={'data':[{'turnId':t['id'],'item':i} for t in turns for i in t['items']],'nextCursor':None}
 elif m=='account/rateLimits/read':
  v={'rateLimits':{'limitId':'codex','primary':{'usedPercent':25,'resetsAt':int(time.time())+1200},
                   'secondary':{'usedPercent':30,'resetsAt':int(time.time())+1200}}}
 elif m=='account/read':
  v={'account':{'type':'chatgpt'},'requiresOpenaiAuth':True}
 elif m=='config/read':
  v={'config':{'model_provider':'openai','model_providers':{},
               'openai_base_url':'http://127.0.0.1:1' if p.get('cwd')==cwd('unknown-quota') else None}}
 elif m=='thread/resume' and target in styles:
  if target=='late-fallback':
   registry=home/'unfinished-sessions.json'
   saved=json.loads(registry.read_text())
   saved['sessions'].append({'harness':'codex','sessionId':target,'state':'active','quotaRecovery':{'state':'waiting'}})
   registry.write_text(json.dumps(saved))
  with (home/('attach-'+target)).open('a') as out: out.write(json.dumps(p)+'\n')
  loaded[target]=p.get('modelProvider',provider)
  if target=='rerouted': loaded[target]='openai'
  effective_model=p.get('model',model)
  v={'thread':dict(thread,modelProvider=loaded[target],model=effective_model,status={'type':'idle'}),
     'model':effective_model,'modelProvider':loaded[target],'cwd':cwd(target)}
 elif m=='turn/start' and target in styles:
  with (home/'send-order').open('a') as order: order.write(target+'\n')
  with sent.open('a') as out: out.write(p['clientUserMessageId']+'\n')
  assert target in loaded
  v={'turn':{'id':'recovered-'+target,'status':'inProgress'}} if target!='uncertain' else {}
 else: raise RuntimeError('unexpected '+m)
 print(json.dumps({'id':r['id'],'result':v}),flush=True)
"#).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let mut profile = json!({"database":f.db,"gate":f.gate,"generation":"generation",
        "owner":{"principal":"local-owner","node":"local","instance":"codex-test",
        "executable":fake,"code_home":f.root,"cwd":f.root}});
    fs::write(&f.profile, profile.to_string()).unwrap();

    let meta = recovery_client_meta();
    let launch = || launch_recovery_owner(&f);
    let close = |mut child: Child| {
        drop(child.stdin.take());
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    };
    let mut provisioning = launch();
    let mut reader = BufReader::new(provisioning.stdout.take().unwrap());
    let cohort = ["preserve", "quota-reset", "uncertain", "disabled", "unknown-quota", "held",
        "old-interrupt", "manual-release", "explicit-legacy", "pending-question", "legacy-uncertain"];
    for (id, target) in cohort.iter().chain([&"outside-cohort"])
        .filter(|&&target| !instance_wide && target != "preserve" && (!workspaces || target == "outside-cohort")).enumerate() {
        let input = provisioning.stdin.as_mut().unwrap();
        writeln!(input, "{}", json!({"jsonrpc":"2.0","id":id+1,"method":"tools/call",
            "params":{"_meta":meta,"name":"session","arguments":{"action":"register","instance_ref":"codex-test",
                        "native_session_id":target,"request_key":format!("register-{target}")}}})).unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let result: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["result"]["structuredContent"]["address"]["native_session_id"], *target, "{result}");
        if *target == "held" {
            let session = &result["result"]["structuredContent"]["session_ref"];
            writeln!(input, "{}", json!({"jsonrpc":"2.0","id":50,"method":"tools/call",
                "params":{"_meta":meta,"name":"stop","arguments":{"action":"stop",
                            "session_ref":session,"request_key":"stop-before-recovery"}}})).unwrap();
            input.flush().unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            let result: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(result["result"]["structuredContent"]["hold"], "active", "{result}");
        }
    }
    close(provisioning);
    if instance_wide {
        fs::write(f.root.join("new-native-chats"), "").unwrap();
    }
    fs::write(f.root.join("session-autostart.json"), json!({
        "version":8,"enabled":true,"recoverOnDisconnect":true,"recoverOnFailure":true,
        "waitForQuota":true,"fallbackForQuota":true,
        "sessions":[{"harness":"codex","sessionId":"disabled","cwd":f.root,
                     "enabled":false,"updatedAt":"2026-01-01T00:00:00Z"}]
    }).to_string()).unwrap();
    let activation = f.root.join("recovery-enabled.json");
    let stops = f.root.join("human-stops.json");
    let questions = f.root.join("human-requests.json");
    let choices = f.root.join("choices.json");
    let unfinished = f.root.join("unfinished-sessions.json");
    let write_stops = |interrupt_active: bool| {
        let mut rows = vec![
            json!({"harness":"codex","id":"held-new","active":true,
                "stop":{"id":"explicit-stop:held-new","reason":"explicit-stop"}}),
            json!({"harness":"codex","id":"explicit-legacy","active":true,"ignoredStopIds":[],
                "stop":{"id":"explicit-stop:fixture","reason":"explicit-stop","turnId":"stopped-explicit-legacy",
                        "at":"2000-01-01T00:00:00Z"}}),
        ];
        for (target, cleared_by) in [
            ("old-interrupt", "new-user-prompt"),
            ("manual-release", "explicit-resume"),
            ("held", "explicit-resume"),
        ] {
            let turn = format!("stopped-{target}");
            let mut row = json!({"harness":"codex","id":target,"active":interrupt_active || target == "old-interrupt","ignoredStopIds":[],
                "stop":{"id":turn,"reason":"interrupted","turnId":turn,"at":"2000-01-01T00:00:00Z"}});
            if target == "manual-release" {
                row["stop"]["id"] = json!("explicit-stop:manual");
                row["stop"]["reason"] = json!("explicit-stop");
            }
            if !interrupt_active && target != "old-interrupt" {
                // Model the release as persisted by the legacy writer.
                row["clearedBy"] = json!(cleared_by);
                row["clearedAt"] = json!(chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339());
                row["ignoredStopIds"] = json!([row["stop"]["id"]]);
            }
            rows.push(row);
        }
        fs::write(&stops, json!({"version":1,"sessions":rows}).to_string()).unwrap();
    };
    write_stops(true);
    fs::write(&choices, r#"{"version":1,"requests":[]}"#).unwrap();
    fs::write(&questions, json!({"version":1,"requests":[
        {"target":{"agent":"codex","sessionId":"pending-question"},"status":"pending"}
    ]}).to_string()).unwrap();
    fs::write(&unfinished, json!({"version":1,"sessions":[
        {"harness":"codex","sessionId":"legacy-uncertain","deliveryPending":true},
        {"harness":"codex","sessionId":"legacy-fallback","state":"active","quotaRecovery":{"state":"waiting"}}
    ]}).to_string()).unwrap();
    profile["owner"]["codex_recovery"] = json!({"autopilot_state_dir":f.root,
        "legacy_handoff":{"native_sessions":cohort,"activation_file":activation,
            "human_stops":stops,"human_requests":questions,"choices":choices,"unfinished_sessions":unfinished},
        "fallback_routes":[
        {"workspace":f.root,"provider":"openai","model":"gpt-fixture"},
        {"workspace":f.root.join("unverified-route"),"provider":"openai","model":"gpt-fixture"}
    ]});
    if instance_wide {
        let handoff = profile["owner"]["codex_recovery"]["legacy_handoff"]
            .as_object_mut()
            .unwrap();
        handoff.remove("native_sessions");
        handoff.insert("instance_wide".into(), true.into());
    }
    if workspaces {
        let handoff = &mut profile["owner"]["codex_recovery"]["legacy_handoff"];
        if scope == CodexHandoff::Workspaces {
            let mut exact = vec![String::from("preserve")];
            exact.extend((0..10).map(|i| format!("reviewed-{i}")));
            handoff["native_sessions"] = json!(exact);
        } else {
            handoff.as_object_mut().unwrap().remove("native_sessions");
        }
        handoff["workspaces"] = json!([{"cwd": f.root.join("transferred"), "provider": "opencodex"}]);
    }
    fs::write(&f.profile, profile.to_string()).unwrap();

    let mut staged = launch();
    if workspaces {
        for id in ["fresh", "healthy", "late-fallback", "rerouted"] {
            let status = recovery_wait_status(&mut staged, "codex", id);
            assert_eq!(status["reason"], "rust_recovery_handoff", "{id}: {status}");
            assert_eq!(status["recoveryOwner"], "rust", "{id}: {status}");
        }
        let mixed = scope == CodexHandoff::Workspaces;
        let explicit = recovery_wait_status(&mut staged, "codex", "preserve");
        assert_eq!(explicit["blocked"], mixed, "{explicit}");
        assert_eq!(explicit["recoveryOwner"].as_str(), mixed.then_some("rust"), "{explicit}");
        for id in ["sibling", "outside-cohort", "other-provider", "legacy-fallback"] {
            let status = recovery_wait_status(&mut staged, "codex", id);
            assert_eq!(status["blocked"], false, "{id}: {status}");
            assert!(status["recoveryOwner"].is_null(), "{id}: {status}");
            assert_eq!(status["mapped"], id == "outside-cohort", "{id}: {status}");
        }
        check_unmapped_recovery_fences(&mut staged, "codex");
        let unknown = recovery_wait_status(&mut staged, "codex", "missing-provider");
        assert_eq!(unknown["reason"], "native_recovery_ownership_unavailable", "{unknown}");
        assert_eq!(unknown["complete"], false, "{unknown}");
        assert!(unknown["recoveryOwner"].is_null(), "{unknown}");
        let saved_registry = unfinished.with_extension("staged");
        fs::rename(&unfinished, &saved_registry).unwrap();
        let unknown = recovery_wait_status(&mut staged, "codex", "fresh");
        assert_eq!(unknown["blocked"], true, "{unknown}");
        assert_eq!(unknown["complete"], false, "{unknown}");
        assert!(unknown["recoveryOwner"].is_null(), "{unknown}");
        assert_eq!(recovery_wait_status(&mut staged, "codex", "sibling")["blocked"], false);
        fs::rename(saved_registry, &unfinished).unwrap();
        close(staged);
        assert!(!f.root.join("send-order").exists());
        fs::write(&activation, "true").unwrap();
        let mut child = launch();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !f.root.join("sent-fresh").exists() || mixed && !f.root.join("sent-preserve").exists() {
            assert!(Instant::now() < deadline, "expected both the new workspace chat and the unlisted explicit ID");
            thread::sleep(Duration::from_millis(40));
        }
        // A read during the bounded dispatch can find the authority gate busy.
        // Read from this same owner once it releases the gate.
        for id in ["late-fallback", "rerouted"] {
            loop {
                let legacy = recovery_wait_status(&mut child, "codex", id);
                if legacy["code"] != "legacy_migration_unavailable" {
                    assert_eq!(legacy["blocked"], false, "{id}: {legacy}");
                    assert!(legacy["recoveryOwner"].is_null(), "{id}: {legacy}");
                    break;
                }
                assert!(Instant::now() < deadline, "{legacy}");
                thread::sleep(Duration::from_millis(40));
            }
            assert!(f.root.join(format!("attach-{id}")).exists());
            assert!(!f.root.join(format!("sent-{id}")).exists());
        }
        close(child);
        let db = Connection::open(&f.db).unwrap();
        let mut stmt = db.prepare("SELECT native_session_id FROM session_bindings ORDER BY native_session_id").unwrap();
        let bound = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        let sends = fs::read_to_string(f.root.join("send-order")).unwrap();
        let mut ids = sends.lines().collect::<Vec<_>>();
        let reviewed = ids.iter().filter(|id| id.starts_with("reviewed-")).count();
        // Both sources must advance on the first tick, even with more explicit
        // eligible IDs than the complete start budget. No ID starts twice.
        assert!(reviewed <= 3);
        assert_eq!(ids.iter().filter(|id| **id == "fresh").count(), 1);
        assert_eq!(ids.iter().filter(|id| **id == "preserve").count(), usize::from(mixed));
        assert_eq!(ids.len(), 1 + usize::from(mixed) + reviewed);
        ids.extend(["late-fallback", "outside-cohort", "rerouted"]);
        ids.sort_unstable();
        assert_eq!(bound, ids);
        return;
    }
    let fence = recovery_wait_status(
        &mut staged, "codex",
        if instance_wide { "first" } else { "preserve" },
    );
    assert_eq!(fence["recoveryOwner"], "rust", "{fence}");
    assert_eq!(fence["reason"], "rust_recovery_handoff", "{fence}");
    assert_eq!(fence["blocked"], true, "{fence}");
    assert_eq!(fence["mapped"], false, "{fence}");
    if scope == CodexHandoff::Cohort {
        for (id, reason) in [
            ("old-interrupt", "rust_recovery_handoff"),
            ("explicit-legacy", "human_stop_active"),
            ("held", "human_stop_active"),
        ] {
            let status = recovery_wait_status(&mut staged, "codex", id);
            assert_eq!(status["blocked"], true, "{id}: {status}");
            assert_eq!(status["reason"], reason, "{id}: {status}");
            assert_eq!(status["recoveryOwner"], "rust", "{id}: {status}");
        }
    }
    if instance_wide {
        check_unmapped_recovery_fences(&mut staged, "codex");
    } else {
        assert!(f.root.join("probed-preserve").exists());
        assert_eq!(recovery_wait_status(&mut staged, "codex", "outside-cohort")["blocked"], false);
        let foreign = recovery_wait_status(&mut staged, "codex", "foreign-project");
        assert_eq!(foreign["blocked"], false, "{foreign}");
        assert_eq!(foreign["mapped"], false, "{foreign}");
        assert!(foreign["recoveryOwner"].is_null(), "{foreign}");
    }
    close(staged);
    let db = Connection::open(&f.db).unwrap();
    let bindings = |id: &str| db.query_row(
        "SELECT COUNT(*) FROM session_bindings WHERE native_session_id=?1", [id], |r| r.get::<_, usize>(0)
    ).unwrap();
    assert_eq!(bindings("preserve"), 0);
    assert!(!f.root.join("touched-foreign-project").exists());
    assert!(!f.root.join("attach-preserve").exists());
    assert!(!f.root.join("listed").exists());
    fs::write(&activation, "true").unwrap();

    let wait_for = |expected: usize| {
        let db = Connection::open(&f.db).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let count: usize = db.query_row(
                "SELECT COUNT(*) FROM intents WHERE request_key LIKE 'codex-recovery:%'
                 AND state IN ('admitted','confirmed','unknown')", [], |row| row.get(0),
            ).unwrap();
            if count == expected { return }
            assert!(Instant::now() < deadline, "expected {expected} durable admissions, saw {count}");
            thread::sleep(Duration::from_millis(40));
        }
    };
    let recovered = launch();
    wait_for(if instance_wide { 2 } else { 4 });
    close(recovered);
    if scope == CodexHandoff::Cohort {
        for target in ["manual-release", "explicit-legacy", "held"] {
            assert!(!f.root.join(format!("attach-{target}")).exists(), "{target} resumed while held");
            assert!(!f.root.join(format!("sent-{target}")).exists(), "{target} started while held");
        }
        write_stops(false);
    }
    let rerun = launch();
    if scope == CodexHandoff::Cohort {
        wait_for(5);
    }
    // Wait for at least one normal owner tick against the same durable state.
    thread::sleep(Duration::from_secs(3));
    close(rerun);
    if instance_wide {
        assert_eq!(
            fs::read_to_string(f.root.join("send-order")).unwrap(),
            "first\nlater-page\n"
        );
        assert!(!f.root.join("probed-old").exists());
        assert!(f.root.join("changed-observed").exists());
        let db = Connection::open(&f.db).unwrap();
        let registered: Vec<String> = db.prepare(
            "SELECT b.native_session_id FROM session_bindings b JOIN intents i
             ON i.payload_hash LIKE 'register-v1:%' AND json_extract(i.native_receipt,'$.session_ref')=b.session_ref
             ORDER BY b.native_session_id"
        ).unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(registered, ["changed", "first", "later-page"]);
        return;
    }
    for target in ["preserve", "quota-reset", "uncertain", "old-interrupt", "manual-release"] {
        let sends = fs::read_to_string(f.root.join(format!("sent-{target}"))).unwrap();
        assert_eq!(sends.lines().count(), 1, "{target}");
        assert!(sends.starts_with("codex-recovery:"));
        let attach = fs::read_to_string(f.root.join(format!("attach-{target}"))).unwrap();
        assert_eq!(attach.lines().count(), 1, "{target}");
        let params: Value = serde_json::from_str(attach.trim()).unwrap();
        assert_eq!(params["threadId"], target);
        assert!(params.get("modelProvider").is_none(), "{params}");
        assert_eq!(params["model"], "gpt-fixture", "{params}");
    }
    for target in ["disabled", "held", "explicit-legacy", "unknown-quota", "pending-question", "legacy-uncertain",
        "outside-cohort"] {
        assert!(!f.root.join(format!("sent-{target}")).exists(), "{target}");
        assert!(!f.root.join(format!("attach-{target}")).exists(), "{target}");
    }
    assert!(!f.root.join("listed").exists());
    assert!(!f.root.join("touched-foreign-project").exists());
    assert_eq!(bindings("foreign-project"), 0);
    assert_eq!(bindings("preserve"), 1);
    let registrations: usize = db.query_row(
        "SELECT COUNT(*) FROM intents WHERE request_key='codex-recovery-register:preserve'
         AND native_receipt IS NOT NULL", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(registrations, 1);
    let ids: Vec<String> = db.prepare(
        "SELECT b.native_session_id FROM intents i JOIN session_bindings b ON b.session_ref=i.target
         WHERE i.request_key LIKE 'codex-recovery:%' AND i.native_receipt IS NOT NULL ORDER BY b.native_session_id",
    ).unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(ids, ["manual-release", "old-interrupt", "preserve", "quota-reset"]);
    let held: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM humanstop_holds h JOIN session_bindings b
         ON h.scope_ref='session:'||b.session_ref WHERE b.native_session_id='held'
         AND h.reason='mcp_stop' AND h.released_at IS NULL)", [], |row| row.get(0),
    ).unwrap();
    assert!(held, "legacy release must preserve the explicit Rust session stop");
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
            "ahap_env":match kind { "zcode" => serde_json::json!({"AHAP_ZCODE_TRANSPORT":"official-server","AHAP_ZCODE_CREATE_MODEL":"4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash$enabled"}), "codex" => serde_json::json!({"AHAP_CODEX_MODEL":"gpt-6-luna"}), "opencode" => serde_json::json!({"AHAP_OPENCODE_MODEL":"minimax-coding-plan/MiniMax-M3.1-Flash"}), _ => serde_json::json!({}) },"code_home":f.root,"cwd":f.root}});
        fs::write(&f.profile, profile.to_string()).unwrap();
        let opened = scoped_profile::open_owner(&f.profile);
        assert!(opened.is_ok(), "{kind} must accept its trusted TypeScript runner");
    }
}

#[test]
fn scriptless_browser_requires_trusted_executable_exact_binding_and_current_authority() {
    use serde_json::json;
    let f = Fixture::new();
    let executable = f.root.join("herder-browser");
    fs::copy(env!("CARGO_BIN_EXE_herder-browser"), &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let env = json!({
        "AHAP_BROWSER_TRANSPORT":"direct-cdp",
        "AHAP_BROWSER_CDP_WS_URL":"ws://127.0.0.1:9222/devtools/browser/owner-fixture",
        "AHAP_BROWSER_CDP_CONTEXT_ID":"fixture-context",
        "AHAP_BROWSER_CDP_TARGET_ID":"fixture-target",
        "AHAP_BROWSER_ACCOUNT_SCOPE":"a".repeat(64),
    });
    let mut profile = json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "kind":"chatgpt","principal":"owner","node":"node","instance":"browser",
        "executable":executable,"code_home":f.root,"cwd":f.root,"ahap_env":env
    }});
    let accepted = |p: &serde_json::Value| {
        fs::write(&f.profile, p.to_string()).unwrap();
        scoped_profile::open_owner(&f.profile).is_ok()
    };
    for kind in ["chatgpt", "zai"] {
        profile["owner"]["kind"] = json!(kind);
        assert!(accepted(&profile));
        let mut origin_port = profile.clone();
        origin_port["owner"]["ahap_env"]["AHAP_BROWSER_CDP_ORIGIN_PORT"] = json!("9222");
        assert!(accepted(&origin_port));
        for key in env.as_object().unwrap().keys() {
            let mut missing = profile.clone();
            missing["owner"]["ahap_env"].as_object_mut().unwrap().remove(key);
            assert!(!accepted(&missing), "{kind} accepted missing {key}");
        }
    }
    for (key, value) in [
        ("AHAP_BROWSER_TRANSPORT", "userio"),
        ("AHAP_BROWSER_CDP_WS_URL", "ws://192.0.2.1:9222/devtools/browser/foreign"),
        ("AHAP_BROWSER_CDP_WS_URL", "ws://localhost:9222/devtools/page/wrong-endpoint"),
        ("AHAP_BROWSER_CDP_ORIGIN_PORT", "65536"),
        ("AHAP_BROWSER_ACCOUNT_SCOPE", "wrong-scope"),
        ("AHAP_BROWSER_PAGE_ID", "1"),
        ("AHAP_BROWSER_VIBE_TARGET", "mac-mini"),
        ("AHAP_USERIO_ENDPOINT", "https://example.invalid"),
        ("HOME", "/"),
        ("AHAP_HARNESS", "chatgpt"),
    ] {
        let mut mixed = profile.clone();
        mixed["owner"]["ahap_env"][key] = json!(value);
        assert!(!accepted(&mixed), "accepted {key}");
    }
    for (field, value) in [
        ("args", json!(["--instance","foreign"])),
        ("ahap_base_url", json!("http://localhost")),
        ("executable", json!(fs::canonicalize("/usr/bin/true").unwrap())),
    ] {
        let mut mixed = profile.clone();
        mixed["owner"][field] = value;
        assert!(!accepted(&mixed), "accepted {field}");
    }
    let mut stale = profile.clone();
    stale["generation"] = json!("stale-generation");
    assert!(!accepted(&stale));
    for mode in [0o600, 0o777] {
        fs::set_permissions(&executable, fs::Permissions::from_mode(mode)).unwrap();
        assert!(!accepted(&profile), "accepted executable with mode {mode:o}");
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
  if p['options']['message']=='unknownmarker' and harness in ('chatgpt','zai'):
   with open(os.path.join(home,'sent'),'a') as out:out.write('1')
   stage,reason=('wait_route','wrong_native') if harness=='chatgpt' else ('userio_preclick','route_timeout')
   data={'method':'sendMessage','outcome':'unknown','retryable':False,'stage':stage,'reason':reason}
   print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'fixture-do-not-forward','data':data}}),flush=True)
   continue
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
    let diagnostic = &unresolved["result"]["result"]["structuredContent"]["browser_diagnostic"];
    match kind {
        "chatgpt" => assert_eq!(diagnostic, &serde_json::json!({"stage":"wait_route","reason":"wrong_native"})),
        "zai" => assert_eq!(diagnostic, &serde_json::json!({"stage":"userio_preclick","reason":"route_timeout"})),
        _ => assert!(diagnostic.is_null()),
    }
    assert!(!unresolved.to_string().contains("fixture-do-not-forward"));
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
fn browser_unavailable_does_not_block_mcp_initialize_or_discovery() {
    let f = Fixture::new();
    f.migrate_v4();
    let adapter = f.root.join("lazy-adapter.py");
    fs::write(&adapter, r#"import json,os,sys,time
for line in sys.stdin:
 r=json.loads(line);m=r['method']
 with open(os.path.join(os.environ['HOME'],'trace'),'a') as out:out.write(m+'\n')
 if m=='initialize':v={'harness':'chatgpt','capabilities':{'methods':['init','listSessions','getSession','getSessionMessages','sendMessage'],'deliveryModes':['queue']}}
 else:time.sleep(30);v=None
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&f.profile, serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "kind":"chatgpt","principal":"owner","node":"node","instance":"browser-fixture",
        "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":adapter,"code_home":f.root,"cwd":f.root}}).to_string()).unwrap();
    let driver = f.root.join("probe.py");
    fs::write(&driver, r#"import json,os,select,subprocess,sys
compat=os.environ.get('HERDER_V1_COMPAT_BINARY')
env=os.environ.copy();env['HERDER_NATIVE_COMMAND']=sys.argv[1]
p=subprocess.Popen([compat or sys.argv[1],'--trusted-owner-profile',sys.argv[2]],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=sys.stderr,text=True,bufsize=1)
def call(i,method,params):
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n');p.stdin.flush()
 assert select.select([p.stdout],[],[],5)[0], 'timeout '+method
 reply=json.loads(p.stdout.readline());assert 'result' in reply,reply
 return reply['result']
try:
 meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{'name':'lazy-fixture','version':'1'}}
 if compat:
  call(1,'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'lazy-fixture','version':'1'}})
  p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');p.stdin.flush()
  result=call(2,'tools/call',{'name':'discover','arguments':{'action':'instances'}})
 else:
  call(1,'server/discover',{'_meta':meta})
  result=call(2,'tools/call',{'_meta':meta,'name':'discover','arguments':{'action':'instances'}})
 assert len(result['structuredContent']['instances'])==1,result
finally:
 p.stdin.close();p.wait(timeout=5)
"#).unwrap();
    let binary = std::env::var_os("HERDER_V1_CANDIDATE_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_herder_native_stdio").into());
    let result = Command::new("/usr/bin/python3").arg(driver).arg(binary).arg(&f.profile).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(fs::read_to_string(f.root.join("trace")).unwrap(), "initialize\n");
}


#[test]
fn hung_ahap_read_does_not_block_discovery_or_other_instances() {
    ahap_isolation_probe("hang");
}

#[test]
fn unsupported_ahap_inventory_returns_error_without_hanging() {
    ahap_isolation_probe("inventory");
}

fn ahap_isolation_probe(mode: &str) {
    let hung = Fixture::new();
    let healthy = Fixture::new();
    for (i, f) in [&hung, &healthy].into_iter().enumerate() {
        f.migrate_v4();
        let adapter = f.root.join("isolated-adapter.py");
        fs::write(&adapter, r#"import json,os,sys,time
home=os.environ['HOME']
for line in sys.stdin:
 r=json.loads(line);m=r['method']
 if m=='initialize':v={'harness':'chatgpt','capabilities':{'methods':['init','listSessions','getSession','getSessionMessages','sendMessage'],'deliveryModes':['queue']}}
 elif m=='init':v=None
 elif m=='getSession':v={'id':r['params']['id'],'harness':'chatgpt','status':'idle','cwd':home}
 elif m=='listSessions':
  if os.path.exists(os.path.join(home,'hang')):
   open(os.path.join(home,'entered'),'w').close()
   while not os.path.exists(os.path.join(home,'release')):time.sleep(.01)
   open(os.path.join(home,'released'),'w').close()
  v=[{'id':'fixture-session','harness':'chatgpt','status':'idle','cwd':home}]
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&f.profile, serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":"chatgpt","principal":"owner","node":"node","instance":format!("isolation-{i}"),
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":adapter,
            "code_home":f.root,"cwd":f.root}}).to_string()).unwrap();
    }
    fs::write(hung.root.join("hang"), "").unwrap();
    let driver = hung.root.join("probe-isolation.py");
    fs::write(&driver, r#"import json,os,select,signal,subprocess,sys,time
compat=os.environ.get('HERDER_V1_COMPAT_BINARY')
env=os.environ.copy();env['HERDER_NATIVE_COMMAND']=sys.argv[1]
p=subprocess.Popen([compat or sys.argv[1],'--trusted-owner-profile',sys.argv[2],'--trusted-owner-profile',sys.argv[3]],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=sys.stderr,start_new_session=True)
meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{'name':'isolation-fixture','version':'1'}}
pending=b''
def send(i,method,params):
 if not compat:params['_meta']=meta
 p.stdin.write((json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n').encode());p.stdin.flush()
def receive(deadline):
 global pending
 while b'\n' not in pending:
  assert select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0], 'hung adapter blocked unrelated MCP request'
  chunk=os.read(p.stdout.fileno(),65536);assert chunk,'core exited before reply'
  pending+=chunk
 line,pending=pending.split(b'\n',1)
 return json.loads(line)
try:
 if compat:
  send(0,'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'isolation-fixture','version':'1'}})
  assert 'result' in receive(time.monotonic()+5)
  p.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n');p.stdin.flush()
 if sys.argv[4]=='inventory':
  send(1,'tools/call',{'name':'sessions','arguments':{'action':'inventory','node_ref':'node','instance_ref':'isolation-0','limit':1}})
  reply=receive(time.monotonic()+3)
  assert reply['result']['isError'] and reply['result']['structuredContent']['code']=='unsupported',reply
  send(2,'tools/call',{'name':'discover','arguments':{'action':'instances'}})
  reply=receive(time.monotonic()+3);assert len(reply['result']['structuredContent']['instances'])==2,reply
  sys.exit(0)
 for i in range(2):
  send(10+i,'tools/call',{'name':'session','arguments':{'action':'register','instance_ref':'isolation-'+str(i),'native_session_id':'fixture-session','request_key':'fixture-register'}})
  reply=receive(time.monotonic()+5);assert 'result' in reply and not reply['result'].get('isError'),reply
 send(1,'tools/call',{'name':'sessions','arguments':{'action':'list','node_ref':'node','instance_ref':'isolation-0'}})
 entered=os.path.join(os.path.dirname(sys.argv[2]),'entered')
 deadline=time.monotonic()+5
 while not os.path.exists(entered):
  assert time.monotonic()<deadline,'inventory did not reach adapter'
  time.sleep(.01)
 send(2,'tools/call',{'name':'discover','arguments':{'action':'instances'}})
 send(3,'tools/call',{'name':'sessions','arguments':{'action':'list','node_ref':'node','instance_ref':'isolation-1'}})
 deadline=time.monotonic()+2
 responses={}
 while len(responses)<2:
  reply=receive(deadline);assert reply['id'] in (2,3),reply
  assert 'result' in reply and not reply['result'].get('isError'),reply
  responses[reply['id']]=reply['result']['structuredContent']
 assert len(responses[2]['instances'])==2,responses
 assert len(responses[3]['sessions'])==1,responses
 reply=receive(time.monotonic()+22)
 assert reply['id']==1 and reply['result']['isError'] and reply['result']['structuredContent']['code']=='owner_read_timeout',reply
 open(os.path.join(os.path.dirname(sys.argv[2]),'release'),'w').close()
 deadline=time.monotonic()+2
 while not os.path.exists(os.path.join(os.path.dirname(sys.argv[2]),'released')):
  assert time.monotonic()<deadline,'fixture adapter did not leave blocked RPC'
  time.sleep(.01)
 send(4,'tools/call',{'name':'discover','arguments':{'action':'instances'}})
 reply=receive(time.monotonic()+2);assert reply['id']==4 and len(reply['result']['structuredContent']['instances'])==2,reply
finally:
 os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
"#).unwrap();
    let binary = std::env::var_os("HERDER_V1_CANDIDATE_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_herder_native_stdio").into());
    let result = Command::new("/usr/bin/python3").arg(driver).arg(binary)
        .arg(&hung.profile).arg(&healthy.profile).arg(mode).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}


#[test]
fn unavailable_ahap_startup_does_not_block_compat_or_other_instances() {
    ahap_startup_isolation_probe(None);
}

#[test]
fn mismatched_ahap_startup_is_not_treated_as_transport_unavailability() {
    ahap_startup_isolation_probe(Some("mismatch"));
}

#[test]
fn invalid_ahap_startup_frame_is_not_treated_as_transport_unavailability() {
    ahap_startup_isolation_probe(Some("protocol"));
}

fn ahap_startup_isolation_probe(failure: Option<&str>) {
    let fixtures = [Fixture::new(), Fixture::new(), Fixture::new()];
    for (i, f) in fixtures.iter().enumerate() {
        f.migrate_v4();
        fs::write(f.root.join("startup-mode"), if let Some(mode) = failure.filter(|_| i == 0) {
            mode
        } else if i < 2 {
            "hang"
        } else {
            "ready"
        }).unwrap();
        let adapter = f.root.join("startup-adapter.py");
        fs::write(&adapter, r#"import json,os,subprocess,sys,time
home=os.environ['HOME'];mode=open(os.path.join(home,'startup-mode')).read()
for line in sys.stdin:
 r=json.loads(line);m=r['method']
 with open(os.path.join(home,'trace'),'a') as out:out.write(m+'\n')
 if m=='initialize':
  if mode=='hang':
   child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)'])
   open(os.path.join(home,'child-pid'),'w').write(str(child.pid))
   while True:time.sleep(1)
  if mode=='ready':time.sleep(13.5)
  v={'harness':'opencode' if mode=='mismatch' else 'codex','capabilities':{'methods':['init','listSessions','getSession','getSessionMessages','sendMessage','createSession'],'deliveryModes':['queue']}}
 elif m=='init':v=None
 elif m=='getSession':v={'id':r['params']['id'],'harness':'codex','status':'idle','cwd':home}
 elif m=='listSessions':v=[]
 elif m=='getSessionMessages':v=[]
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'1.0' if mode=='protocol' else '2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
        fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&f.profile, serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
            "kind":"codex","principal":"owner","node":"node","instance":format!("startup-{i}"),
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":adapter,
            "code_home":f.root,"cwd":f.root}}).to_string()).unwrap();
    }
    let driver = fixtures[0].root.join("probe-startup.py");
    fs::write(&driver, r#"import json,os,select,signal,sqlite3,subprocess,sys,time
compat=os.environ.get('HERDER_V1_COMPAT_BINARY')
env=os.environ.copy();env['HERDER_NATIVE_COMMAND']=sys.argv[1]
args=[compat or sys.argv[1]]
for profile in sys.argv[3:]:args+=['--trusted-owner-profile',profile]
p=subprocess.Popen(args,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
pending=b'';seq=0
meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{'name':'startup-fixture','version':'1'}}
def call(method,params,timeout=2):
 global seq,pending
 seq+=1
 if not compat:params['_meta']=meta
 p.stdin.write((json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n').encode());p.stdin.flush()
 deadline=time.monotonic()+timeout
 while b'\n' not in pending:
  assert select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0], 'unavailable owner blocked MCP startup'
  chunk=os.read(p.stdout.fileno(),65536);assert chunk,'core exited before reply: '+p.stderr.read().decode()
  pending+=chunk
 line,pending=pending.split(b'\n',1)
 reply=json.loads(line);assert reply['id']==seq and 'result' in reply,reply
 return reply['result']
try:
 if sys.argv[2]!='hang':
  assert p.wait(timeout=17)!=0,'mismatched harness was accepted'
  assert p.stdout.read()==b'','unverified owner reached MCP service'
  sys.exit(0)
 started=time.monotonic()
 if compat:
  call('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'startup-fixture','version':'1'}},timeout=17)
  p.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n');p.stdin.flush()
 else:call('server/discover',{},timeout=17)
 assert time.monotonic()-started<17,'startup budgets accumulated across owners'
 for profile in sys.argv[3:5]:
  pid=int(open(os.path.join(os.path.dirname(profile),'child-pid')).read())
  deadline=time.monotonic()+1
  while os.path.exists('/proc/'+str(pid)+'/stat'):
   state=open('/proc/'+str(pid)+'/stat').read().split()[2]
   if state=='Z':break
   assert time.monotonic()<deadline,'timed out adapter left its spawned child alive'
   time.sleep(.01)
 result=call('tools/call',{'name':'discover','arguments':{'action':'nodes'}})
 assert result['structuredContent']['nodes']==[{'node_ref':'node'}],result
 result=call('tools/call',{'name':'discover','arguments':{'action':'instances'}})
 rows=result['structuredContent']['instances'];assert len(rows)==3,rows
 for i in range(2):
  row=next(row for row in rows if row['instance_ref']=='startup-'+str(i))
  assert row['availability']=='unavailable' and 'capabilities' not in row,row
 result=call('tools/call',{'name':'session','arguments':{'action':'register','instance_ref':'startup-2','native_session_id':'fixture-session','request_key':'healthy-register'}})
 assert not result.get('isError'),result
 result=call('tools/call',{'name':'sessions','arguments':{'action':'list','instance_ref':'startup-2','node_ref':'node'}})
 assert not result.get('isError') and len(result['structuredContent']['sessions'])==1,result
 result=call('tools/call',{'name':'sessions','arguments':{'action':'list'}})
 data=result['structuredContent']
 assert not result.get('isError') and len(data['sessions'])==1 and data['complete']==False,data
 assert sum('error' in source for source in data['sources'])==2,data
 result=call('tools/call',{'name':'session','arguments':{'action':'resolve','harness':'codex','native_session_id':'fixture-session','node_ref':'node'}})
 assert not result.get('isError') and result['structuredContent']['owner']['instance_ref']=='startup-2',result
 result=call('tools/call',{'name':'create','arguments':{'action':'create','instance_ref':'startup-0','prompt':'must not be sent','request_key':'offline-once'}})
 assert result['isError'] and result['structuredContent']['code']=='owner_adapter_unavailable' and result['structuredContent']['effect']=='none',result
 with sqlite3.connect(json.load(open(sys.argv[3]))['database']) as db:
  assert db.execute('SELECT count(*) FROM intents').fetchone()[0]==0,'offline owner admitted an intent'
 result=call('tools/call',{'name':'discover','arguments':{'action':'instances'}})
 assert len(result['structuredContent']['instances'])==3,result
finally:
 try:os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 p.wait(timeout=5)
"#).unwrap();
    let binary = std::env::var_os("HERDER_V1_CANDIDATE_BINARY").unwrap_or_else(|| env!("CARGO_BIN_EXE_herder_native_stdio").into());
    let result = Command::new("/usr/bin/python3").arg(driver).arg(binary)
        .arg(failure.unwrap_or("hang"))
        .args(fixtures.iter().map(|f| &f.profile)).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    if failure.is_none() {
        for f in &fixtures[..2] {
            assert_eq!(fs::read_to_string(f.root.join("trace")).unwrap(), "initialize\n");
        }
    }
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
 elif m=='getSession':v={'id':p['id'],'harness':'chatgpt','status':'idle','cwd':home}
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
        for f in [&a, &b] { let _ = fs::remove_file(f.root.join("parent-pid")); }
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
        for f in [&a, &b] { assert!(!f.root.join("parent-pid").exists()); }
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
            assert_eq!(fs::read_to_string([&a, &b][i].root.join("parent-pid")).unwrap(), child.id().to_string());
            let rows=read["result"]["structuredContent"]["page"]["messages"].as_array().expect("messages");
            assert_eq!(rows.len(),2,"{read}");assert_eq!(rows[0]["text"],format!("account-{i}"));assert_eq!(rows[1]["text"],format!("follow-{i}"));
            let context=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"context","session_ref":sessions[i]}}));
            assert_eq!(context["result"]["structuredContent"]["session_ref"],sessions[i],"{context}");
            assert_eq!(context["result"]["structuredContent"]["address"]["instance"]["instance_id"],format!("chatgpt-{i}"),"{context}");
            assert_eq!(context["result"]["structuredContent"]["is_self"],false,"{context}");
        }
        // A session known only to B resolves through the shared registry, including
        // when the first server consulted belongs to A and after an owner restart.
        let register=call("tools/call",serde_json::json!({"name":"session","arguments":{
            "action":"register","instance_ref":"chatgpt-1","native_session_id":"only-in-b","request_key":"register-b"
        }}));
        let registered=&register["result"]["structuredContent"]["session_ref"];
        assert!(registered.is_string(),"{register}");
        let resolve=call("tools/call",serde_json::json!({"name":"session","arguments":{
            "action":"resolve","harness":"chatgpt","node_ref":"node","native_session_id":"only-in-b"
        }}));
        assert_eq!(&resolve["result"]["structuredContent"]["session_ref"],registered,"{resolve}");
        assert_eq!(resolve["result"]["structuredContent"]["owner"]["instance_ref"],"chatgpt-1");
        let ambiguous=call("tools/call",serde_json::json!({"name":"session","arguments":{
            "action":"resolve","harness":"chatgpt","node_ref":"node","native_session_id":"same-native-id"
        }}));
        assert_eq!(ambiguous["result"]["structuredContent"]["code"],"ambiguous_native_session","{ambiguous}");
        let archive=call("tools/call",serde_json::json!({"name":"session","arguments":{"action":"archive","session_ref":sessions[0],"request_key":"archive-first"}}));
        assert_eq!(archive["result"]["structuredContent"]["archived"],true,"{archive}");
        assert_eq!(fs::read_to_string(a.root.join("archived")).unwrap(),"1");assert!(!b.root.join("archived").exists());
        let foreign=call("tools/call",serde_json::json!({"name":"create","arguments":{"action":"create","instance_ref":"foreign","prompt":"never","request_key":"forbidden"}}));
        assert_eq!(foreign["result"]["isError"],true);
        child.kill().unwrap();let _=child.wait();
    }
}

fn vibe_owner_profile(f: &Fixture, kind: &str, env: serde_json::Value) -> serde_json::Value {
    let script = f.root.join("vibe-runner.js");
    fs::write(&script, "// profile validation must never launch this runner").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).unwrap();
    serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "kind":kind,"principal":"owner","node":"node","instance":format!("{kind}-vibe"),
        "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,
        "ahap_env":env,"code_home":f.root,"cwd":f.root}})
}

fn safe_vibe_env() -> serde_json::Value {
    serde_json::json!({
        "AHAP_BROWSER_TRANSPORT":"vibe",
        "AHAP_BROWSER_ACCOUNT_SCOPE":"a".repeat(64),
        "AHAP_BROWSER_VIBE_TARGET":"mac-mini",
        "AHAP_BROWSER_VIBE_SESSION_ID":"session_1",
        "AGENT_HERDER_VIBE_MAC_SSH_TARGET":"fixture-user@fixture-host",
        "AGENT_HERDER_VIBE_MAC_NODE_PATH":"/tmp/fixture-node",
        "AGENT_HERDER_VIBE_MAC_CLI_PATH":"/tmp/fixture-vibe-cli"
    })
}

#[test]
fn new_browser_authority_does_not_require_a_legacy_migration_snapshot() {
    use herder::application::scoped_stop::migration_quarantine::digest;
    use serde_json::{Value, json};
    use std::io::{BufRead, BufReader, Write};

    let legacy = Fixture::new();
    let added = Fixture::new();
    let binary = std::env::var_os("HERDER_V1_CANDIDATE_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_herder_native_stdio")));
    let source = legacy.root.join("sealed-legacy-records.json");
    let source_hash = "a".repeat(64);
    let inventory = digest(format!("{}\0{}\n", source.display(), source_hash).as_bytes());
    let snapshot = json!({
        "version":1, "kind":"herder-legacy-quarantine", "epoch":"migration-fixture",
        "authority_generation":"generation", "node_ref":"node", "instance_ref":"zai-existing",
        "writer_drain_sha256":"b".repeat(64), "inventory_sha256":inventory,
        "sources":[{"path":source,"sha256":source_hash}],
        "records":[{
            "record_ref":"legacy-job", "source_path":source, "source_sha256":source_hash,
            "record_sha256":"c".repeat(64), "request_keys":["old-delivery"], "outcome":"unknown",
            "holds":[{"node_ref":"node","instance_ref":"zai-existing","native_session_id":"old-chat"}]
        }]
    });
    legacy.migrate_v4();
    added.migrate_v4();
    Writer::open_file(&legacy.db).unwrap()
        .put_setting_once("migration:legacy", "quarantine:v1", &snapshot.to_string(), "fixture")
        .unwrap();
    for (fixture, instance) in [(&legacy, "zai-existing"), (&added, "zai-added")] {
        let profile = json!({"database":fixture.db,"gate":fixture.gate,"generation":"generation","owner":{
            "kind":"zai","node":"node","instance":instance,"principal":"owner",
            "executable":binary,"cwd":fixture.root,"code_home":fixture.root,
            "ahap_env":{"AHAP_BROWSER_TRANSPORT":"direct-cdp",
                "AHAP_BROWSER_CDP_WS_URL":"ws://127.0.0.1:9222/devtools/browser/migration-fixture",
                "AHAP_BROWSER_CDP_CONTEXT_ID":"fixture-context",
                "AHAP_BROWSER_CDP_TARGET_ID":instance,
                "AHAP_BROWSER_ACCOUNT_SCOPE":"a".repeat(64)}
        }});
        fs::write(&fixture.profile, profile.to_string()).unwrap();
    }
    let mut child = Command::new(&binary)
        .arg("--trusted-owner-profile").arg(&legacy.profile)
        .arg("--trusted-owner-profile").arg(&added.profile)
        .env("AGENT_HERDER_MIGRATION_EPOCH","migration-fixture")
        .env("AGENT_HERDER_MIGRATION_NEW_AUTHORITIES",r#"[["node","zai-added","generation"]]"#)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut wait = |id, native| {
        writeln!(input, "{}", json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{
            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientCapabilities":{},
                "io.modelcontextprotocol/clientInfo":{"name":"browser-migration-fixture","version":"1"}},
            "name":"automation","arguments":{"action":"wait_status","harness":"zai","node_ref":"node","native_session_id":native}
        }})).unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert!(reply["result"]["structuredContent"].is_object(), "{reply}");
        reply["result"]["structuredContent"].clone()
    };
    let current = wait(1, "herder-migration-readiness:migration-fixture");
    let hold = wait(2, "old-chat");
    drop(input);
    child.wait().unwrap();
    assert_eq!(current["complete"], true, "{current}");
    let proofs = current["migration_authorities"].as_array().unwrap();
    assert_eq!(proofs.len(), 1);
    assert_eq!(proofs[0]["instance_ref"], "zai-existing");
    assert_eq!(proofs[0]["required_epoch"], "migration-fixture");
    assert_eq!(hold["reason"], "legacy_target_quarantined", "{hold}");
}

#[test]
fn trusted_vibe_profile_accepts_exact_browser_binding_and_isolated_relay() {
    let f = Fixture::new();
    for kind in ["chatgpt", "zai"] {
        for isolated in [false, true] {
            let mut env = safe_vibe_env();
            if isolated {
                env["AHAP_BROWSER_VIBE_TARGET"] = "server-100".into();
                env.as_object_mut().unwrap().remove("AGENT_HERDER_VIBE_MAC_SSH_TARGET");
                env.as_object_mut().unwrap().remove("AGENT_HERDER_VIBE_MAC_NODE_PATH");
                env.as_object_mut().unwrap().remove("AGENT_HERDER_VIBE_MAC_CLI_PATH");
                env["AGENT_HERDER_VIBE_SERVER_CLI_PATH"] = "/tmp/fixture-server-vibe-cli".into();
                env["AHAP_BROWSER_VIBE_RELAY_PORT"] = "19898".into();
                env["AHAP_BROWSER_VIBE_STATE_DIR"] = "/tmp/agent-herder-fixture/herder-ci-vibe".into();
            }
            fs::write(&f.profile, vibe_owner_profile(&f, kind, env.clone()).to_string()).unwrap();
            let opened = scoped_profile::open_owner(&f.profile).unwrap();
            assert_eq!(opened.owner.kind, kind);
            assert_eq!(opened.owner.ahap_env.get("AHAP_BROWSER_VIBE_SESSION_ID").unwrap(), "session_1");
            assert_eq!(opened.owner.ahap_env.len(), env.as_object().unwrap().len());
        }
    }
}

#[test]
fn trusted_vibe_profile_rejects_missing_binding_before_runner_launch() {
    let f = Fixture::new();
    for missing in ["AHAP_BROWSER_VIBE_TARGET", "AHAP_BROWSER_VIBE_SESSION_ID", "AHAP_BROWSER_ACCOUNT_SCOPE"] {
        let mut env = safe_vibe_env();
        env.as_object_mut().unwrap().remove(missing);
        fs::write(&f.profile, vibe_owner_profile(&f, "chatgpt", env).to_string()).unwrap();
        assert!(scoped_profile::open_owner(&f.profile).is_err(), "missing {missing}");
    }
    let mut env = safe_vibe_env();
    env["AHAP_BROWSER_VIBE_RELAY_PORT"] = "19898".into();
    fs::write(&f.profile, vibe_owner_profile(&f, "zai", env).to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err(), "a custom relay needs isolated state");
}

#[test]
fn trusted_vibe_profile_rejects_unsafe_binding_and_ambiguous_transport() {
    let f = Fixture::new();
    for (name, value) in [
        ("AHAP_BROWSER_VIBE_TARGET", "foreign"),
        ("AHAP_BROWSER_VIBE_SESSION_ID", "session_1;touch injected"),
        ("AHAP_BROWSER_VIBE_SESSION_ID", ""),
        ("AHAP_BROWSER_VIBE_RELAY_PORT", "1023"),
        ("AHAP_BROWSER_VIBE_RELAY_PORT", "65535"),
        ("AHAP_BROWSER_VIBE_RELAY_PORT", "19888;true"),
        ("AHAP_BROWSER_VIBE_STATE_DIR", "relative/state"),
        ("AHAP_BROWSER_VIBE_STATE_DIR", "/tmp/agent-herder-fixture/../other"),
        ("AHAP_BROWSER_VIBE_STATE_DIR", "/tmp/agent-herder-fixture/state;true"),
        ("AHAP_BROWSER_ACCOUNT_SCOPE", "not-an-account-hash"),
        ("AHAP_BROWSER_TRANSPORT", "mac-mini"),
    ] {
        let mut env = safe_vibe_env();
        env[name] = value.into();
        fs::write(&f.profile, vibe_owner_profile(&f, "chatgpt", env).to_string()).unwrap();
        assert!(scoped_profile::open_owner(&f.profile).is_err(), "invalid {name}");
    }
}

#[test]
fn trusted_vibe_profile_keeps_unknown_and_process_environment_rejected() {
    let f = Fixture::new();
    for name in ["AHAP_BROWSER_VIBE_COMMAND", "AHAP_BROWSER_VIBE_ARGS", "AHAP_BROWSER_VIBE_TOKEN", "NODE_OPTIONS", "HOME", "AHAP_HARNESS"] {
        let mut env = safe_vibe_env();
        env[name] = "invalid".into();
        fs::write(&f.profile, vibe_owner_profile(&f, "zai", env).to_string()).unwrap();
        assert!(scoped_profile::open_owner(&f.profile).is_err(), "must reject {name}");
    }
    fs::write(&f.profile, vibe_owner_profile(&f, "codex", safe_vibe_env()).to_string()).unwrap();
    assert!(scoped_profile::open_owner(&f.profile).is_err(), "Vibe keys cannot cross into Codex");
}

#[test]
fn owner_enrolls_exact_existing_chat_and_revokes_profile_membership_without_native_writes() {
    use std::io::{BufRead, BufReader, Write};
    let f=Fixture::new();f.migrate_v4();
    let script=f.root.join("existing-adapter.py");
    fs::write(&script,r#"import json,os,sys
home=os.environ['HOME']; native='chatgpt::native~conversation'
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 with open(os.path.join(home,'native-methods'),'a') as out:out.write(m+'\n')
 if m=='initialize':v={'harness':'chatgpt','capabilities':{'methods':['init','createSession','sendMessage','getSession','getSessionMessages','listSessions'],'deliveryModes':['queue']}}
 elif m=='init':v=None
 elif m=='listSessions':v=[{'id':native,'harness':'chatgpt','status':'idle','cwd':home,'needsPermission':False}]
 elif m=='getSession':
  assert p['id']==native
  v={'id':native,'harness':'chatgpt','status':'idle','cwd':home,'needsPermission':False}
 elif m=='getSessionMessages':
  assert p['id']==native
  v=[{'id':'human','role':'user','text':'existing request'},{'id':'answer','role':'assistant','text':'existing answer'}]
 else:raise Exception('native writes forbidden in enrollment acceptance: '+m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
    fs::set_permissions(&script,fs::Permissions::from_mode(0o600)).unwrap();
    let mut profile=serde_json::json!({"database":f.db,"gate":f.gate,"generation":"generation","owner":{
        "kind":"chatgpt","principal":"owner","node":"node","instance":"chatgpt-existing",
        "executable":fs::canonicalize("/usr/bin/python3").unwrap(),"ahap_script":script,
        "code_home":f.root,"cwd":f.root,"ahap_env":{"AHAP_BROWSER_ACCOUNT_SCOPE":"b".repeat(64)},
        "existing_sessions":[{"request_key":"approve-existing","native_session_id":"chatgpt::native~conversation","account_scope":"b".repeat(64)}]
    }});
    fs::write(&f.profile,profile.to_string()).unwrap();
    let binary=env!("CARGO_BIN_EXE_herder_native_stdio");
    let enroll=||Command::new(binary).args(["--enroll-existing-owner-profile"]).arg(&f.profile)
        .args(["--request-key","approve-existing"]).output().unwrap();
    let first=enroll();
    assert!(first.status.success(),"{}",String::from_utf8_lossy(&first.stderr));
    let receipt:serde_json::Value=serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(receipt["provenance"],"owner-explicit-existing-session");
    let second=enroll();assert!(second.status.success(),"{}",String::from_utf8_lossy(&second.stderr));
    assert_eq!(receipt,serde_json::from_slice::<serde_json::Value>(&second.stdout).unwrap());
    let session=receipt["session_ref"].as_str().unwrap();
    let read=|expected_visible:bool| {
        let mut child=Command::new(binary).arg("--trusted-owner-profile").arg(&f.profile)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let mut input=child.stdin.take().unwrap();let mut output=BufReader::new(child.stdout.take().unwrap());
        let meta=serde_json::json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},"io.modelcontextprotocol/clientInfo":{"name":"enrollment-fixture","version":"1"}});
        let mut call=|id:u64,name:&str,args:serde_json::Value|{
            writeln!(input,"{}",serde_json::json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":name,"arguments":args}})).unwrap();input.flush().unwrap();
            let mut line=String::new();assert!(output.read_line(&mut line).unwrap()>0,"owner core exited before reply");
            serde_json::from_str::<serde_json::Value>(&line).unwrap()
        };
        let adoption=call(0,"session",serde_json::json!({"action":"register","instance_ref":"chatgpt-existing",
            "native_session_id":"chatgpt::native~conversation","request_key":"public-adopt-enrolled"}));
        assert_eq!(adoption["result"]["isError"],true,"{adoption}");
        assert_eq!(adoption["result"]["structuredContent"]["code"],"session_provenance_unavailable","{adoption}");
        let list=call(1,"sessions",serde_json::json!({"action":"list","instance_ref":"chatgpt-existing"}));
        assert_eq!(list["result"]["structuredContent"]["sessions"].as_array().unwrap().len(),usize::from(expected_visible),"{list}");
        let messages=call(2,"session",serde_json::json!({"action":"messages","session_ref":session}));
        if expected_visible {
            assert_eq!(messages["result"]["structuredContent"]["page"]["messages"][0]["text"],"existing request","{messages}");
        } else {assert_eq!(messages["result"]["isError"],true,"{messages}");}
        drop(call);drop(input);assert!(child.wait().unwrap().success());
    };
    read(true);
    profile["owner"]["existing_sessions"]=serde_json::json!([]);
    fs::write(&f.profile,profile.to_string()).unwrap();
    read(false);
    let log=fs::read_to_string(f.root.join("native-methods")).unwrap();
    assert!(!log.lines().any(|method|matches!(method,"createSession"|"sendMessage")),"{log}");
    assert_eq!(Connection::open(&f.db).unwrap().query_row("SELECT count(*) FROM session_bindings",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

fn all_approved_enrollment_fixture() -> Fixture {
    let f = Fixture::new();
    f.migrate_v4();
    let script = f.root.join("batch-existing-adapter.py");
    fs::write(&script, r#"import json,os,sys,time
home=os.environ['HOME']
natives=['chatgpt::batch-one','chatgpt::batch-two','chatgpt::batch-three']
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 with open(os.path.join(home,'native-methods'),'a') as out:out.write(m+':'+p.get('id','')+'\n')
 if m=='initialize':v={'harness':'chatgpt','capabilities':{'methods':['init','createSession','sendMessage','getSession','getSessionMessages','listSessions'],'deliveryModes':['queue']}}
 elif m=='init':v=None
 elif m=='listSessions':v=[{'id':n,'harness':'chatgpt','status':'idle','cwd':home,'needsPermission':False} for n in natives]
 elif m=='getSession':
  assert p['id'] in natives
  if p['id']==natives[1] and os.path.exists(os.path.join(home,'pause-second')):
   started=time.monotonic()
   while not os.path.exists(os.path.join(home,'continue-second')):
    if time.monotonic()-started>20:raise Exception('fixture continuation timeout')
    time.sleep(0.01)
  v={'id':p['id'],'harness':'chatgpt','status':'idle','cwd':home,'needsPermission':False}
  if p['id']==natives[1] and os.path.exists(os.path.join(home,'refuse-second')):v['id']='chatgpt::different'
 else:raise Exception('native writes forbidden in batch enrollment: '+m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).unwrap();
    let approvals = ["one", "two", "three"].map(|name| serde_json::json!({
        "request_key":format!("approve-{name}"),
        "native_session_id":format!("chatgpt::batch-{name}"),
        "account_scope":"b".repeat(64),
    }));
    let profile = serde_json::json!({
        "database":f.db, "gate":f.gate, "generation":"generation",
        "owner":{
            "kind":"chatgpt", "principal":"owner", "node":"node", "instance":"chatgpt-existing",
            "executable":fs::canonicalize("/usr/bin/python3").unwrap(), "ahap_script":script,
            "code_home":f.root, "cwd":f.root,
            "ahap_env":{"AHAP_BROWSER_ACCOUNT_SCOPE":"b".repeat(64)},
            "existing_sessions":approvals,
        },
    });
    fs::write(&f.profile, profile.to_string()).unwrap();
    f
}

fn all_approved_receipts(bytes: &[u8]) -> Vec<serde_json::Value> {
    std::str::from_utf8(bytes).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn run_all_approved(f: &Fixture) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--enroll-existing-owner-profile").arg(&f.profile)
        .arg("--all-approved").output().unwrap()
}

#[test]
fn owner_enroll_all_reuses_one_adapter_keeps_per_entry_reads_and_exact_replay() {
    let f = all_approved_enrollment_fixture();
    let first = run_all_approved(&f);
    assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
    let receipts = all_approved_receipts(&first.stdout);
    assert_eq!(receipts.len(), 3);
    for (receipt, name) in receipts.iter().zip(["one", "two", "three"]) {
        assert_eq!(receipt["request_key"], format!("approve-{name}"));
        assert_eq!(receipt["native_session_id"], format!("chatgpt::batch-{name}"));
        assert_eq!(receipt["provenance"], "owner-explicit-existing-session");
    }
    let first_calls = fs::read_to_string(f.root.join("native-methods")).unwrap();
    let expected = [
        "initialize:", "init:",
        "listSessions:", "getSession:chatgpt::batch-one",
        "listSessions:", "getSession:chatgpt::batch-two",
        "listSessions:", "getSession:chatgpt::batch-three",
    ];
    assert_eq!(first_calls.lines().collect::<Vec<_>>(), expected);
    let second = run_all_approved(&f);
    assert!(second.status.success(), "{}", String::from_utf8_lossy(&second.stderr));
    assert_eq!(all_approved_receipts(&second.stdout), receipts);
    let calls = fs::read_to_string(f.root.join("native-methods")).unwrap();
    assert_eq!(calls.lines().collect::<Vec<_>>(), expected.repeat(2));
    assert_eq!(Connection::open(&f.db).unwrap().query_row(
        "SELECT count(*) FROM session_bindings", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn owner_enroll_all_stops_on_first_error_and_resumes_without_duplicate_binding() {
    let f = all_approved_enrollment_fixture();
    fs::write(f.root.join("refuse-second"), b"fixture").unwrap();
    let failed = run_all_approved(&f);
    assert!(!failed.status.success());
    let prior = all_approved_receipts(&failed.stdout);
    assert_eq!(prior.len(), 1);
    assert_eq!(prior[0]["request_key"], "approve-one");
    let calls = fs::read_to_string(f.root.join("native-methods")).unwrap();
    assert_eq!(calls.lines().collect::<Vec<_>>(), [
        "initialize:", "init:", "listSessions:", "getSession:chatgpt::batch-one",
        "listSessions:", "getSession:chatgpt::batch-two",
    ]);
    assert_eq!(Connection::open(&f.db).unwrap().query_row(
        "SELECT count(*) FROM session_bindings", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    fs::remove_file(f.root.join("refuse-second")).unwrap();
    let resumed = run_all_approved(&f);
    assert!(resumed.status.success(), "{}", String::from_utf8_lossy(&resumed.stderr));
    let after = all_approved_receipts(&resumed.stdout);
    assert_eq!(after.len(), 3);
    assert_eq!(after[0], prior[0]);
    assert_eq!(Connection::open(&f.db).unwrap().query_row(
        "SELECT count(*) FROM session_bindings", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn owner_enroll_all_rejects_mixed_selectors_and_empty_approval_before_adapter_open() {
    let f = all_approved_enrollment_fixture();
    for args in [
        vec!["--all-approved", "--request-key", "approve-one"],
        vec!["--request-key", "approve-one", "--all-approved"],
        vec!["--all-approved", "--all-approved"],
        vec!["--request-key", "not-approved"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
            .arg("--enroll-existing-owner-profile").arg(&f.profile)
            .args(args).output().unwrap();
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert!(!f.root.join("native-methods").exists());
    }
    let mut profile: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&f.profile).unwrap()).unwrap();
    profile["owner"]["existing_sessions"] = serde_json::json!([]);
    fs::write(&f.profile, profile.to_string()).unwrap();
    let result = run_all_approved(&f);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!f.root.join("native-methods").exists());
    assert_eq!(Connection::open(&f.db).unwrap().query_row(
        "SELECT count(*) FROM session_bindings", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn owner_enroll_all_flushes_receipt_before_later_native_verification_completes() {
    use std::io::{BufRead, BufReader, Read};
    use std::sync::mpsc;
    use std::time::Duration;
    let f = all_approved_enrollment_fixture();
    fs::write(f.root.join("pause-second"), b"fixture").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
        .arg("--enroll-existing-owner-profile").arg(&f.profile).arg("--all-approved")
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut output = BufReader::new(stdout);
        let mut line = String::new();
        let result = output.read_line(&mut line);
        send.send((result, line, output)).unwrap();
    });
    // The second getSession cannot finish until this test observes the first
    // receipt. Bound failure and release the fixture before any assertion.
    let first = receive.recv_timeout(Duration::from_secs(10));
    fs::write(f.root.join("continue-second"), b"fixture").unwrap();
    let completion = child.wait_with_output().unwrap();
    let (read, line, mut output) = first.expect("first confirmed receipt was not flushed");
    assert!(read.unwrap() > 0);
    assert!(completion.status.success(), "{}", String::from_utf8_lossy(&completion.stderr));
    let receipt: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(receipt["request_key"], "approve-one");
    let mut remaining = Vec::new();
    output.read_to_end(&mut remaining).unwrap();
    assert_eq!(all_approved_receipts(&remaining).len(), 2);
    reader.join().unwrap();
}
