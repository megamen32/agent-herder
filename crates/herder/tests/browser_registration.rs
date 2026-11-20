//! Owner registration through the Rust stdio launcher and isolated adapter profiles.
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

const ADAPTER: &str = r##"import base64,hashlib,json,os,sys
harness=os.environ['AHAP_HARNESS']
profile=os.environ.get('AHAP_BROWSER_PAGE_ID', harness)
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
  if profile in ('uploads','direct-only'): value['capabilities']['nativeProtocol']='direct-cdp'
  if profile in ('uploads','flag-only'): value['capabilities']['browserFeatures']={'attachments':True}
 elif method=='init': value=None
 elif method=='getSession': value=session(p['id'])
 elif method=='listSessions': value=[session('existing-native')]
 elif method=='getSessionMessages': value=messages(p['id'])
 elif method=='sendMessage':
  assert p['id']=='existing-native' or (profile=='uploads' and p['id']=='created-native')
  assert p['options']['queue'] is True and p['options']['activeTurnOnly'] is False
  assert p['options']['inputId']
  mid=profile+'-message-'+str(len(messages(p['id'])))
  row['message']={'id':mid,'role':'user','text':p['options']['message']}
  if 'attachments' in p['options']:
   assert profile=='uploads'
   row['files']=[[f['name'],f['mime_type'],hashlib.sha256(base64.b64decode(f['data_base64'],validate=True)).hexdigest()] for f in p['options']['attachments']]
  value={'ok':True,'admitted':True,'nativeInputMessageId':mid,
         'inputId':p['options']['inputId'],'sessionId':p['id'],'harness':harness}
 elif method=='createSession':
  assert profile=='uploads' and 'attachments' not in p['options']
  value={'id':'created-native','harness':harness}
 else: raise AssertionError('Unexpected AHAP method '+method)
 with open(trace,'a') as stream: stream.write(json.dumps(row)+'\n')
 if method=='sendMessage' and p['options']['message']=='lose receipt': sys.exit(0)
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
        self.write_profile(
            provider, instance, &fs::canonicalize("/usr/bin/python3").unwrap(), Some(&self.script),
            json!({"AHAP_BROWSER_PAGE_ID":instance}),
        )
    }

    fn native_profile(&self, provider: &str, instance: &str, binary: &Path, env: Value) -> PathBuf {
        // Cargo's target directory can be under /tmp; provision the actual
        // compiled artifact inside this owner's protected directory.
        let executable = self.root.join(binary.file_name().unwrap());
        if !executable.exists() {
            fs::copy(binary, &executable).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        self.write_profile(provider, instance, &executable, None, env)
    }

    fn write_profile(
        &self, provider: &str, instance: &str, executable: &Path, script: Option<&Path>, env: Value,
    ) -> PathBuf {
        let path = self.root.join(format!("{provider}-{instance}.json"));
        let mut owner = json!({
            "kind":provider,"principal":"owner","node":"browser-node","instance":instance,
            "executable":executable,"code_home":self.root,"cwd":self.root,"ahap_env":env,
        });
        if let Some(script) = script {
            owner["ahap_script"] = json!(script);
        }
        write_private(
            &path,
            json!({
                "database":self.db,"gate":self.gate,"generation":"registration-test",
                "owner":owner
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
    task_capable: bool,
}

impl Wire {
    fn open(profile: &Path) -> Self {
        Self::open_many(&[profile])
    }

    fn ordinary(profile: &Path) -> Self {
        Self::ordinary_many(&[profile])
    }

    fn ordinary_many(profiles: &[&Path]) -> Self {
        let mut wire = Self::open_many(profiles);
        wire.task_capable = false;
        wire
    }

    fn open_many(profiles: &[&Path]) -> Self {
        let stderr = profiles[0].with_extension(format!(
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_herder_native_stdio"));
        for profile in profiles {
            command.arg("--trusted-owner-profile").arg(profile);
        }
        let mut child = command
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
            task_capable: true,
        }
    }

    fn rpc(&mut self, method: &str, mut params: Value) -> Value {
        self.sequence += 1;
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientCapabilities":if self.task_capable {
                json!({"extensions":{"io.modelcontextprotocol/tasks":{}}})
            } else { json!({}) },
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

fn files() -> Value {
    json!([
        {"name":"note.txt","mime_type":"text/plain","data_base64":"cHJpdmF0ZS10ZXN0LWF0dGFjaG1lbnQ="},
        {"name":"raw.bin","mime_type":"application/octet-stream","data_base64":"AP8="}
    ])
}

fn task_id(response: &Value) -> &str {
    response["result"]["taskId"].as_str().unwrap_or_else(|| panic!("expected a task: {response}"))
}

fn task_body(client: &mut Wire, task: &str) -> Value {
    let response = client.rpc("tasks/get", json!({"taskId":task}));
    assert_eq!(response["result"]["status"], "completed", "{response}");
    response["result"]["result"]["structuredContent"].clone()
}

// A loopback OpenCode v2 consumer. Its history records only actual prompt POSTs.
const OPENCODE_HTTP: &str = r#"
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

native = 'ses_mesh_fixture'
path = '/api/session/' + native
messages = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == '/openapi.json':
            self.reply({'openapi':'3.1.0','paths':{'/api/session':{'get':{},'post':{}},'/api/event':{'get':{}}}})
        elif self.path == path:
            self.reply({'id':native,'projectID':'fixture','time':{'created':1,'updated':2,'idle':2},
                        'location':{'directory':'/fixture'}})
        elif self.path == path + '/message':
            self.reply({'data':messages})
        else:
            self.send_error(404)
    def do_POST(self):
        if self.path != path + '/prompt':
            return self.send_error(404)
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert data['delivery'] == 'queue' and data['metadata']['agentHerderInputId']
        mid = 'msg_fixture' + str(len(messages))
        messages.append({'id':mid,'type':'user','text':data['text'],'time':{'created':2}})
        self.reply({'data':{'id':mid,'sessionID':native,'delivery':'queue'}})
server = HTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"#;

struct HttpFixture(Child);
impl Drop for HttpFixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn ordinary_browser_and_scriptless_opencode_envelopes_reach_registered_sessions() {
    let fixture = Fixture::new();
    let python = fs::canonicalize("/usr/bin/python3").unwrap();
    let mut http = HttpFixture(Command::new(&python).args(["-I", "-B", "-c", OPENCODE_HTTP])
        .stdout(Stdio::piped()).spawn().unwrap());
    let port: u16 = BufReader::new(http.0.stdout.take().unwrap()).lines().next().unwrap().unwrap().parse().unwrap();
    let endpoint = format!("http://127.0.0.1:{port}");
    let profile = |name: &str, script: Option<&Path>| {
        let path = fixture.root.join(name);
        let mut owner = json!({"kind":"opencode","principal":"owner","node":"opencode-node","instance":"oc",
            "executable":python,"code_home":fixture.root,"cwd":fixture.root,"ahap_base_url":endpoint});
        if let Some(script) = script { owner["ahap_script"] = json!(script); }
        write_private(&path, json!({"owner":owner,"database":fixture.db,"gate":fixture.gate,
            "generation":"registration-test"}).to_string());
        path
    };
    let oc = json!({"hostId":"opencode-node","harness":"opencode","nativeSessionId":"ses_mesh_fixture"});
    // Register the pre-existing OpenCode session with the same owner before opening its scriptless binding.
    let register = |wire: &mut Wire, instance: &str, address: &Value| {
        let reply = wire.call("session", json!({"action":"register","instance_ref":instance,
            "native_session_id":address["nativeSessionId"],"request_key":"register"}));
        content(&reply)["session_ref"].as_str().unwrap().to_owned()
    };
    let oc_ref = register(&mut Wire::open(&profile("register.json", Some(&fixture.script))), "oc", &oc);
    let native_profile = profile("native.json", None);
    let other_native_profile = fixture.profile("zai", "secondary-browser");
    {
        let mut client = Wire::ordinary_many(&[&native_profile, &other_native_profile]);
        let listing = client.call("discover", json!({"action":"instances"}));
        let rows = content(&listing)["instances"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row["harness"] == "opencode" && row["instance_ref"] == "oc"));
        assert!(rows.iter().any(|row| row["harness"] == "zai" && row["instance_ref"] == "secondary-browser"));
        let nodes = client.call("discover", json!({"action":"nodes"}));
        assert_eq!(content(&nodes)["nodes"].as_array().unwrap().len(), 2);
        let scoped = client.call("discover", json!({"action":"instances","node_ref":"opencode-node"}));
        assert_eq!(content(&scoped)["instances"].as_array().unwrap().len(), 1);
        assert_eq!(content(&scoped)["instances"][0]["instance_ref"], "oc");
    }
    for kind in ["chatgpt", "zai"] {
        let browser_fixture = Fixture::new();
        let address = json!({"hostId":"browser-node","harness":kind,"nativeSessionId":"existing-native"});
        let browser_profile = browser_fixture.profile(kind, kind);
        let other_browser_profile = browser_fixture.profile(kind, "secondary-browser");
        let browser_ref = register(&mut Wire::ordinary(&browser_profile), kind, &address);
        for (path, other, session_ref, target, sender) in [
            (&native_profile, &other_native_profile, &oc_ref, &oc, &address),
            (&browser_profile, &other_browser_profile, &browser_ref, &address, &oc),
        ] {
            let marker = format!("{kind}-to-{}", target["harness"].as_str().unwrap());
            let envelope = json!({"target":target,"sender":sender,"inputId":marker,"message":marker});
            let first = Wire::ordinary(path).call("deliver", envelope.clone());
            assert_eq!(content(&first)["outcome"], "confirmed");

            // A separate owner connection reads durable evidence and independent native history.
            let mut reader = Wire::ordinary_many(&[other, path]);
            let native_id = &content(&first)["native_receipt_id"];
            assert_eq!(&content(&reader.call("deliver", envelope.clone()))["native_receipt_id"], native_id);
            let mut changed = envelope.clone();
            changed["sender"]["nativeSessionId"] = json!("other-source");
            assert_eq!(&content(&reader.call("deliver", changed.clone()))["native_receipt_id"], native_id);
            changed["message"] = json!("different payload");
            let conflict = reader.call("deliver", changed);
            assert_eq!(conflict["result"]["structuredContent"]["code"], "idempotency_conflict", "{conflict}");
            let mut unknown = envelope;
            unknown["target"]["nativeSessionId"] = json!("unregistered");
            expect_error(&reader.call("deliver", unknown));
            let resolved = reader.call("session", json!({"action":"resolve","node_ref":target["hostId"],
                "harness":target["harness"],"native_session_id":target["nativeSessionId"]}));
            assert_eq!(content(&resolved)["session_ref"], *session_ref);
            let receipt = reader.call("deliver", json!({"action":"receipt","session_ref":session_ref,"request_key":marker}));
            let proof = &content(&receipt)["native_receipt"];
            assert_eq!(&proof["native_id"], native_id);
            assert_eq!(&proof["sender"], sender);
            assert_eq!(proof["target"]["native_session_id"], target["nativeSessionId"]);
            let history = reader.call("session", json!({"action":"messages","session_ref":session_ref}));
            let messages = content(&history)["page"]["messages"].as_array().unwrap();
            let received: Vec<_> = messages.iter().filter(|row| row["text"] == marker).collect();
            assert_eq!(received.len(), 1);
            if target["harness"] == "opencode" {
                assert_eq!(received[0]["id"], proof["native_id"]);
            } else {
                let reference = native_id.as_str().unwrap().strip_prefix("ahap-receipt:v1:").unwrap();
                assert_eq!(serde_json::from_str::<Value>(reference).unwrap(),
                    json!({"kind":"message","native_id":received[0]["id"]}));
            }
        }
        register(&mut Wire::ordinary(&other_browser_profile), "secondary-browser", &address);
        let mut multi = Wire::ordinary_many(&[&other_browser_profile, &browser_profile]);
        let ambiguous = multi.call("deliver", json!({"sender":oc,"target":address,
            "inputId":"ambiguous","message":"must not be submitted"}));
        expect_error(&ambiguous);
        assert_eq!(browser_fixture.native_calls("sendMessage").len(), 1);
    }
}

#[test]
fn attachments_reach_first_prompt_action_and_envelope_with_exact_replay() {
    let fixture = Fixture::new();
    let profile = fixture.profile("chatgpt", "uploads");
    let mut wire = Wire::open(&profile);
    let create = json!({"action":"create","instance_ref":"uploads","prompt":"","attachments":files(),"request_key":"first"});
    let parent = task_id(&wire.call("create", create.clone())).to_owned();
    let created = task_body(&mut wire, &parent);
    assert_eq!(created["prompt"]["outcome"], "confirmed", "{created}");
    let session = &created["create"]["session_ref"];
    let action = json!({"action":"session","session_ref":session,"mode":"queue","request_key":"next","message":"caption","attachments":files()});
    let child = task_id(&wire.call("deliver", action.clone())).to_owned();
    assert_eq!(task_body(&mut wire, &child)["outcome"], "confirmed");
    let sender = json!({"hostId":"peer","harness":"codex","nativeSessionId":"caller"});
    let envelope = json!({"target":{"hostId":"browser-node","harness":"chatgpt","nativeSessionId":"created-native"},
        "sender":sender,"inputId":"envelope","message":"","attachments":files()});
    let envelope_task = task_id(&wire.call("deliver", envelope.clone())).to_owned();
    assert_eq!(task_body(&mut wire, &envelope_task)["outcome"], "confirmed");
    drop(wire);

    let mut wire = Wire::open(&profile);
    assert_eq!(task_id(&wire.call("create", create.clone())), parent);
    assert_eq!(task_id(&wire.call("deliver", action.clone())), child);
    assert_eq!(task_id(&wire.call("deliver", envelope)), envelope_task);
    let receipt = wire.call("deliver", json!({"action":"receipt","session_ref":session,"request_key":"envelope"}));
    assert_eq!(content(&receipt)["native_receipt"]["sender"], sender);
    for (field, change) in [("name", "renamed.txt"), ("data_base64", "UQ=="), ("mime_type", "text/csv")] {
        let mut different = create.clone();
        different["attachments"][0][field] = json!(change);
        let conflict = wire.call("create", different);
        assert_eq!(task_body(&mut wire, task_id(&conflict))["code"], "idempotency_conflict");
        let mut different = action.clone();
        different["attachments"][0][field] = json!(change);
        assert_eq!(wire.call("deliver", different)["result"]["structuredContent"]["code"], "idempotency_conflict");
    }
    let mut reversed = action.clone();
    reversed["attachments"].as_array_mut().unwrap().reverse();
    assert_eq!(wire.call("deliver", reversed)["result"]["structuredContent"]["code"], "idempotency_conflict");
    let mut text_only = action;
    text_only.as_object_mut().unwrap().remove("attachments");
    assert_eq!(wire.call("deliver", text_only)["result"]["structuredContent"]["code"], "idempotency_conflict");

    let sends = fixture.native_calls("sendMessage");
    assert_eq!(fixture.native_calls("createSession").len(), 1);
    assert_eq!(sends.len(), 3);
    for (send, caption) in sends.iter().zip(["", "caption", ""]) {
        assert_eq!(send["id"], "created-native");
        assert_eq!(send["message"]["text"], caption);
        assert_eq!(send["files"], json!([
            ["note.txt","text/plain","3d6124c0105928e47dd1a8dcdacb48e9a0b229a4ad56e7b97b3bebd2b0340c28"],
            ["raw.bin","application/octet-stream","06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8"]
        ]));
    }
    let db = Connection::open(&fixture.db).unwrap();
    for marker in ["data_base64", "note.txt", files()[0]["data_base64"].as_str().unwrap()] {
        let persisted: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE instr(result_json, ?1)>0) OR EXISTS(SELECT 1 FROM intents WHERE instr(payload_hash, ?1)>0 OR instr(native_receipt, ?1)>0)",
            [marker], |r| r.get(0),
        ).unwrap();
        assert!(!persisted, "attachment material in the generic ledger");
    }
}

#[test]
fn attachments_lost_receipt_is_never_resubmitted_on_restart() {
    let fixture = Fixture::new();
    let profile = fixture.profile("zai", "uploads");
    let create = json!({"action":"create","instance_ref":"uploads","prompt":"lose receipt","attachments":files(),"request_key":"lost-first"});
    let mut wire = Wire::open(&profile);
    let parent = task_id(&wire.call("create", create.clone())).to_owned();
    drop(wire);
    let mut wire = Wire::open(&profile);
    assert_eq!(task_id(&wire.call("create", create)), parent);
    let body = task_body(&mut wire, &parent);
    assert_eq!(body["prompt"]["effect"], "unknown", "{body}");
    let mut action = json!({"action":"session","session_ref":body["create"]["session_ref"],"mode":"queue","request_key":"lost-next","message":"lose receipt","attachments":files()});
    let held = wire.call("deliver", action.clone());
    assert_eq!(held["result"]["structuredContent"]["code"], "delivery_blocked", "{held}");
    // The unresolved first prompt fences that session. Exercise a lost
    // ordinary delivery on an independently authorized native session.
    let registered = wire.call("session", json!({"action":"register","instance_ref":"uploads","native_session_id":"existing-native","request_key":"register"}));
    action["session_ref"] = content(&registered)["session_ref"].clone();
    let child = task_id(&wire.call("deliver", action.clone())).to_owned();
    drop(wire);
    let mut wire = Wire::open(&profile);
    assert_eq!(task_id(&wire.call("deliver", action.clone())), child);
    assert_eq!(task_body(&mut wire, &child)["effect"], "unknown");
    let mut changed = action;
    changed["attachments"][0]["data_base64"] = json!("UQ==");
    assert_eq!(wire.call("deliver", changed)["result"]["structuredContent"]["code"], "idempotency_conflict");
    assert_eq!(fixture.native_calls("createSession").len(), 1);
    let sends = fixture.native_calls("sendMessage");
    assert_eq!(sends.iter().map(|send| send["id"].as_str().unwrap()).collect::<Vec<_>>(),
        ["created-native", "existing-native"]);
}

#[test]
fn attachments_aggregate_limit_survives_the_stdio_and_ahap_frames() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use herder::domain::attachment::MAX_ATTACHMENT_BYTES;

    let fixture = Fixture::new();
    let mut wire = Wire::open(&fixture.profile("chatgpt", "uploads"));
    let registered = wire.call("session", json!({"action":"register","instance_ref":"uploads","native_session_id":"existing-native","request_key":"register"}));
    let mut send = json!({
        "action":"session","session_ref":content(&registered)["session_ref"],"mode":"queue","message":"","request_key":"size",
        "attachments":[
            {"name":"limit.bin","mime_type":"application/octet-stream","data_base64":STANDARD.encode(vec![0xff; MAX_ATTACHMENT_BYTES])},
            {"name":"extra.bin","mime_type":"application/octet-stream","data_base64":"eA=="}
        ]
    });
    let refused = wire.call("deliver", send.clone());
    assert_eq!(refused["result"]["structuredContent"]["code"], "invalid_attachments", "{refused}");
    assert!(fixture.native_calls("sendMessage").is_empty());
    send["attachments"].as_array_mut().unwrap().pop();
    let admitted = wire.call("deliver", send);
    assert_eq!(task_body(&mut wire, task_id(&admitted))["outcome"], "confirmed");
    assert_eq!(fixture.native_calls("sendMessage").len(), 1);
}

#[test]
fn attachments_need_valid_bytes_both_capability_markers_and_session_grants() {
    for instance in ["uploads", "flag-only", "direct-only"] {
        let fixture = Fixture::new();
        let mut wire = Wire::open(&fixture.profile("chatgpt", instance));
        let mut input = files();
        let code = if instance == "uploads" {
            input[0]["data_base64"] = json!("invalid!");
            "invalid_attachments"
        } else {
            "attachments_unsupported"
        };
        let create = wire.call("create", json!({"action":"create","instance_ref":instance,"prompt":"caption","attachments":input,"request_key":"refused"}));
        assert_eq!(create["result"]["structuredContent"]["code"], code, "{create}");
        let registered = wire.call("session", json!({"action":"register","instance_ref":instance,"native_session_id":"existing-native","request_key":"registration"}));
        let mut send = json!({"action":"session","session_ref":content(&registered)["session_ref"],"mode":"queue","message":"caption","attachments":input,"request_key":"refused"});
        let refused = wire.call("deliver", send.clone());
        assert_eq!(refused["result"]["structuredContent"]["code"], code, "{refused}");
        send["attachments"] = files();
        send["session_ref"] = json!("foreign-session");
        let denied = wire.call("deliver", send);
        assert_eq!(denied["result"]["structuredContent"]["code"], "session_grant_required", "{denied}");
        assert!(fixture.native_calls("createSession").is_empty());
        assert!(fixture.native_calls("sendMessage").is_empty());
        let intents: i64 = Connection::open(&fixture.db).unwrap().query_row(
            "SELECT count(*) FROM intents WHERE request_key='refused'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(intents, 0);
    }
}

#[test]
fn native_owner_single_and_mixed_multi_route_to_the_profile_selected_runner() {
    let fixture = Fixture::new();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    socket.set_nonblocking(true).unwrap();
    let address = socket.local_addr().unwrap();
    let binding = |kind: &str| json!({
        "AHAP_BROWSER_TRANSPORT":"direct-cdp",
        "AHAP_BROWSER_CDP_WS_URL":format!("ws://{address}/devtools/browser/fixture"),
        "AHAP_BROWSER_CDP_CONTEXT_ID":format!("{kind}-context"),
        "AHAP_BROWSER_CDP_TARGET_ID":format!("{kind}-target"),
        "AHAP_BROWSER_ACCOUNT_SCOPE":"a".repeat(64),
    });
    let mut native = Vec::new();
    for (kind, binary) in [
        ("chatgpt", env!("CARGO_BIN_EXE_herder_native_stdio")),
        ("zai", env!("CARGO_BIN_EXE_herder-browser")),
    ] {
        let instance = format!("{kind}-rust");
        let path = fixture.native_profile(kind, &instance, Path::new(binary), binding(kind));
        let mut client = Wire::open(&path);
        let instances = client.call("discover", json!({"action":"instances"}));
        let rows = content(&instances)["instances"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["instance_ref"], instance);
        assert_eq!(rows[0]["node_ref"], "browser-node");
        assert_eq!(rows[0]["harness"], kind);
        assert_eq!(rows[0]["capabilities"]["nativeProtocol"], "direct-cdp");
        expect_error(&client.call("session", json!({"action":"messages","session_ref":"unregistered"})));
        native.push(path);
    }
    let mut legacy_env = binding("legacy");
    legacy_env["AHAP_BROWSER_PAGE_ID"] = json!("1");
    let legacy = fixture.write_profile("chatgpt", "legacy", &fs::canonicalize("/usr/bin/python3").unwrap(),
        Some(&fixture.script), legacy_env);
    let mut multi = Wire::open_many(&[&native[0], &legacy, &native[1]]);
    let instances = multi.call("discover", json!({"action":"instances","node_ref":"browser-node"}));
    let rows = content(&instances)["instances"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for row in rows {
        match row["instance_ref"].as_str().unwrap() {
            "chatgpt-rust" | "zai-rust" => assert_eq!(row["capabilities"]["nativeProtocol"], "direct-cdp"),
            "legacy" => assert!(row["capabilities"].get("nativeProtocol").is_none()),
            other => panic!("unexpected instance {other}"),
        }
    }
    let registered = multi.call("session", json!({"action":"register","instance_ref":"legacy",
        "native_session_id":"existing-native","request_key":"legacy-owner-proof"}));
    let session = &content(&registered)["session_ref"];
    let messages = multi.call("session", json!({"action":"messages","session_ref":session}));
    assert_eq!(content(&messages)["page"]["messages"], json!([]));
    assert_eq!(fixture.native_calls("getSessionMessages")[0]["profile"], "1");
    assert_eq!(fixture.binding_count(), 1);
    // Discovery and refused reads must not even open a CDP connection.
    assert_eq!(socket.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
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
