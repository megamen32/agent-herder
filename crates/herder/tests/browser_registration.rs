//! Registration acceptance through the actual Rust stdio launcher and an
//! isolated AHAP subprocess. No browser, account, or real conversation is used.
#![cfg(target_os = "linux")]

use herder::{application::target_gate::acquire_pinned, store::Writer};
use rusqlite::{Connection, functions::FunctionFlags};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ADAPTER: &str = r##"import json,os,sys
harness=os.environ['AHAP_HARNESS']
profile=os.environ['AHAP_BROWSER_PAGE_ID']
home=os.environ['HOME']
trace=os.path.join(home,'native.jsonl')
def records():
 if not os.path.exists(trace): return []
 with open(trace) as stream: return [json.loads(line) for line in stream]
def messages(native):
 return [row['message'] for row in records() if row['method']=='sendMessage' and row['profile']==profile and row['harness']==harness and row['id']==native]
def session(native):
 if native=='missing': return None
 return {'id':'different-native' if native=='wrong-id' else native,
         'harness':'foreign-provider' if native=='wrong-harness' else harness,
         'status':'idle','cwd':'/native/observed-cwd','meta':{'nativeStateObserved':True}}
for line in sys.stdin:
 r=json.loads(line); method=r['method']; p=r.get('params',{})
 row={'method':method,'harness':harness,'profile':profile,'id':p.get('id')}
 if method=='initialize':
  value={'harness':harness,'capabilities':{'methods':['init','getSession','listSessions','getSessionMessages','sendMessage','createSession'],'deliveryModes':['queue']}}
 elif method=='init': value=None
 elif method=='getSession': value=session(p['id'])
 elif method=='listSessions': value=[session('existing-native')]
 elif method=='getSessionMessages': value=messages(p['id'])
 elif method=='sendMessage':
  assert p['id']=='existing-native'
  assert p['options']['queue'] is True and p['options']['activeTurnOnly'] is False
  assert p['options']['inputId']
  mid=profile+'-message-'+str(len(messages(p['id'])))
  row['message']={'id':mid,'role':'user','text':p['options']['message']}
  value={'ok':True,'admitted':True,'nativeInputMessageId':mid,
         'inputId':p['options']['inputId'],'sessionId':p['id'],'harness':harness}
 elif method=='createSession':
  raise AssertionError('Registration must not create a native conversation')
 else: raise AssertionError('Unexpected AHAP method '+method)
 with open(trace,'a') as stream: stream.write(json.dumps(row)+'\n')
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':value}),flush=True)
"##;

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    gate: PathBuf,
    script: PathBuf,
}

fn write_private(path: &Path, bytes: impl AsRef<[u8]>) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes.as_ref()).unwrap();
}

impl Fixture {
    fn new() -> Self {
        // The trusted launcher rejects /tmp and other replaceable ancestors.
        let home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
        let root = home.join(format!(
            "herder-registration-wire-{}-{}",
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
        let script = root.join("adapter.py");
        drop(Writer::create_file(&db).unwrap());
        let mut connection = Connection::open(&db).unwrap();
        connection
            .create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_| Ok(1),
            )
            .unwrap();
        for sql in [
            include_str!("../src/store/migration_v1_v2.sql"),
            include_str!("../src/store/migration_v2_v3.sql"),
        ] {
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(sql).unwrap();
            transaction.commit().unwrap();
        }
        drop(connection);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate)
            .unwrap();
        let metadata = file.metadata().unwrap();
        let guard = acquire_pinned(&gate, metadata.dev(), metadata.ino()).unwrap();
        let mut writer = Writer::open_file(&db).unwrap();
        assert!(
            writer
                .initialize_fresh_stop_authority(&guard, "registration-test", "test")
                .unwrap()
        );
        writer.migrate_search_v4(&guard).unwrap();
        drop(guard);
        write_private(&script, ADAPTER);
        Self {
            root,
            db,
            gate,
            script,
        }
    }

    fn profile(&self, provider: &str, instance: &str) -> PathBuf {
        let path = self.root.join(format!("{provider}-{instance}.json"));
        write_private(
            &path,
            json!({
                "database":self.db,"gate":self.gate,"generation":"registration-test",
                "owner":{
                    "kind":provider,"principal":"owner","node":"browser-node",
                    "instance":instance,"executable":fs::canonicalize("/usr/bin/python3").unwrap(),
                    "ahap_script":self.script,"code_home":self.root,"cwd":self.root,
                    "ahap_env":{"AHAP_BROWSER_PAGE_ID":instance}
                }
            })
            .to_string(),
        );
        path
    }

    fn native_calls(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(self.root.join("native.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|row| row["method"] == method)
            .collect()
    }

    fn binding_count(&self) -> i64 {
        Connection::open(&self.db)
            .unwrap()
            .query_row("SELECT count(*) FROM session_bindings", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Wire {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    stderr: PathBuf,
    sequence: u64,
}

impl Wire {
    fn open(profile: &Path) -> Self {
        let stderr = profile.with_extension(format!(
            "{}.stderr",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&stderr)
            .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"))
            .arg("--trusted-owner-profile")
            .arg(profile)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input: Some(input),
            output: receiver,
            stderr,
            sequence: 0,
        }
    }

    fn rpc(&mut self, method: &str, mut params: Value) -> Value {
        self.sequence += 1;
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}},
            "io.modelcontextprotocol/clientInfo":{"name":"registration-test","version":"1"},
            "principal":"spoofed-client-principal","session_ref":"spoofed-client-session"
        });
        let request = json!({"jsonrpc":"2.0","id":self.sequence,"method":method,"params":params});
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        loop {
            let response = self
                .output
                .recv_timeout(Duration::from_secs(15))
                .unwrap_or_else(|error| {
                    panic!(
                        "wire response: {error}; stderr: {}",
                        fs::read_to_string(&self.stderr).unwrap_or_default()
                    )
                });
            if response.get("id").is_none() {
                continue;
            }
            assert_eq!(response["id"], self.sequence, "{response}");
            return response;
        }
    }

    fn call(&mut self, name: &str, args: Value) -> Value {
        self.rpc("tools/call", json!({"name":name,"arguments":args}))
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        drop(self.input.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn content(response: &Value) -> &Value {
    assert!(response.get("error").is_none(), "{response}");
    assert_ne!(response["result"]["isError"], true, "{response}");
    &response["result"]["structuredContent"]
}

fn expect_error(response: &Value) {
    assert!(
        response.get("error").is_some() || response["result"]["isError"] == true,
        "{response}"
    );
}

fn registration(provider: &str) {
    let fixture = Fixture::new();
    let profile = fixture.profile(provider, "profile-a");
    let other_profile = fixture.profile(provider, "profile-b");
    let workspace = json!({"node_ref":"worker-node","path":"/work/project-a","project_ref":"project-a","purpose":"review"});
    let args = json!({"action":"register","instance_ref":"profile-a","native_session_id":"existing-native","workspace":workspace,"request_key":"register-once"});
    let mut client = Wire::open(&profile);
    let registered = client.call("session", args.clone());
    let session = content(&registered)["session_ref"]
        .as_str()
        .expect("registered session_ref")
        .to_owned();
    assert!(fixture.native_calls("createSession").is_empty());
    assert!(fixture.native_calls("sendMessage").is_empty());
    assert_eq!(fixture.binding_count(), 1);

    let duplicate = client.call("session", args.clone());
    assert_eq!(content(&duplicate)["session_ref"], session);
    let mut conflict_args = args.clone();
    conflict_args["native_session_id"] = json!("different-native");
    expect_error(&client.call("session", conflict_args));
    assert_eq!(fixture.binding_count(), 1);

    let unbound = client.call("session", json!({"action":"context"}));
    assert_eq!(
        unbound["result"]["structuredContent"]["code"], "self_binding_required",
        "{unbound}"
    );
    let context = client.call("session", json!({"action":"context","session_ref":session}));
    assert_eq!(content(&context)["session_ref"], session);
    assert_eq!(
        content(&context)["address"]["native_session_id"],
        "existing-native"
    );
    assert_eq!(
        content(&context)["address"]["instance"]["instance_id"],
        "profile-a"
    );
    assert_eq!(content(&context)["workspace"], workspace);
    assert_eq!(
        content(&context)["is_self"],
        false,
        "client metadata and registration do not prove self"
    );
    let inventory = client.call(
        "sessions",
        json!({"action":"list","instance_ref":"profile-a"}),
    );
    let row = content(&inventory)["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["session_ref"] == session)
        .expect("registered session is discoverable");
    assert_eq!(row["workspace"], workspace);

    let changed = json!({"node_ref":"worker-node","path":"/work/project-b","project_ref":"project-b","purpose":"implementation"});
    let update = json!({"action":"workspace","session_ref":session,"workspace":changed,"request_key":"workspace-once"});
    content(&client.call("session", update.clone()));
    content(&client.call("session", update.clone()));
    let mut conflicting_workspace = update;
    conflicting_workspace["workspace"]["path"] = json!("/work/not-the-original-update");
    expect_error(&client.call("session", conflicting_workspace));
    // A replay of the initial registration must not undo the newer declaration.
    assert_eq!(
        content(&client.call("session", args.clone()))["session_ref"],
        session
    );
    drop(client);

    let mut restarted = Wire::open(&profile);
    let after_restart =
        restarted.call("session", json!({"action":"context","session_ref":session}));
    assert_eq!(content(&after_restart)["workspace"], changed);
    let fresh_key = restarted.call("session", json!({"action":"register","instance_ref":"profile-a","native_session_id":"existing-native","request_key":"register-again"}));
    assert_eq!(content(&fresh_key)["session_ref"], session);
    assert_eq!(fixture.binding_count(), 1);
    let after_reregister =
        restarted.call("session", json!({"action":"context","session_ref":session}));
    assert_eq!(
        content(&after_reregister)["workspace"],
        changed,
        "omitted workspace must preserve the declaration"
    );

    let mut other = Wire::open(&other_profile);
    let other_registration = other.call("session", json!({"action":"register","instance_ref":"profile-b","native_session_id":"existing-native","request_key":"register-once"}));
    let other_session = content(&other_registration)["session_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(
        other_session, session,
        "native IDs are scoped to their browser profile"
    );
    assert_eq!(fixture.binding_count(), 2);
    expect_error(&other.call("session", json!({"action":"context","session_ref":session})));
    expect_error(&other.call("deliver", json!({"action":"session","session_ref":session,"message":"foreign-profile","mode":"queue","request_key":"foreign"})));
    assert!(fixture.native_calls("sendMessage").is_empty());
    drop(other);

    let delivery = json!({"action":"session","session_ref":session,"message":"registered recipient","mode":"queue","request_key":"message-once"});
    let sent = restarted.call("deliver", delivery.clone());
    assert_eq!(sent["result"]["resultType"], "task", "{sent}");
    let task = sent["result"]["taskId"].as_str().unwrap().to_owned();
    let receipt = restarted.rpc("tasks/get", json!({"taskId":task}));
    assert_eq!(receipt["result"]["status"], "completed", "{receipt}");
    let replay = restarted.call("deliver", delivery);
    assert_eq!(replay["result"]["taskId"], task, "{replay}");
    let sends = fixture.native_calls("sendMessage");
    assert_eq!(sends.len(), 1, "a delivered request must not be sent twice");
    assert_eq!(sends[0]["profile"], "profile-a");
    assert_eq!(sends[0]["harness"], provider);
    assert_eq!(sends[0]["id"], "existing-native");
    let messages = restarted.call(
        "session",
        json!({"action":"messages","session_ref":session}),
    );
    assert_eq!(
        content(&messages)["page"]["messages"][0]["text"],
        "registered recipient"
    );

    content(&restarted.call("session", json!({"action":"workspace","session_ref":session,"workspace":null,"request_key":"workspace-clear"})));
    let cleared = restarted.call("session", json!({"action":"context","session_ref":session}));
    assert_eq!(content(&cleared)["workspace"], Value::Null);
    assert_eq!(content(&cleared)["session_ref"], session);
    assert_eq!(fixture.binding_count(), 2);

    content(&restarted.call(
        "stop",
        json!({"action":"stop","session_ref":session,"request_key":"stop-once"}),
    ));
    let held_registration = restarted.call("session", json!({"action":"register","instance_ref":"profile-a","native_session_id":"existing-native","request_key":"register-after-stop"}));
    // Re-registration may retain the known address or reject a held session;
    // either result must preserve the hold and never enable another handoff.
    if held_registration["result"]["isError"] != true {
        assert_eq!(content(&held_registration)["session_ref"], session);
    }
    expect_error(&restarted.call("deliver", json!({"action":"session","session_ref":session,"message":"blocked after stop","mode":"queue","request_key":"after-stop"})));
    assert_eq!(fixture.native_calls("sendMessage").len(), 1);
    drop(restarted);
}

#[test]
fn chatgpt_registration_survives_restart_and_routes_exactly_once() {
    registration("chatgpt");
}

#[test]
fn zai_registration_survives_restart_and_routes_exactly_once() {
    registration("zai");
}

#[test]
fn native_identity_mismatch_and_wrong_instance_never_register_or_send() {
    for provider in ["chatgpt", "zai"] {
        let fixture = Fixture::new();
        let profile = fixture.profile(provider, "profile-a");
        let mut client = Wire::open(&profile);
        for (index, native) in ["wrong-id", "wrong-harness", "missing"]
            .into_iter()
            .enumerate()
        {
            expect_error(&client.call("session", json!({"action":"register","instance_ref":"profile-a","native_session_id":native,"request_key":format!("bad-{index}")})));
        }
        expect_error(&client.call("session", json!({"action":"register","instance_ref":"foreign-profile","native_session_id":"existing-native","request_key":"wrong-instance"})));
        expect_error(&client.call("session", json!({"action":"workspace","session_ref":"unregistered","workspace":{"node_ref":"worker","path":"/work/foreign"},"request_key":"foreign-workspace"})));
        assert_eq!(fixture.binding_count(), 0);
        assert!(fixture.native_calls("sendMessage").is_empty());
        assert!(fixture.native_calls("createSession").is_empty());
        drop(client);
    }
}
