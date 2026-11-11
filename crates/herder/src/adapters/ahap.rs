//! Instance-bound AHAP v0.1 JSON-RPC over stdio.
//! Mutations are never retried: a write, timeout or disconnect can leave an
//! unknown outcome. Transport errors are not evidence of native non-admission.
use crate::{domain::adapter::BrowserSendDiagnostic, error::browser_send_diagnostic};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Mutex,
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 4 * 1024 * 1024;
#[derive(Debug)]
pub enum AhapError {
    InvalidConfig,
    Unavailable,
    Unsupported,
    BeforeSend,
    OutcomeUnknown,
    Remote,
    BrowserSendUnconfirmed(BrowserSendDiagnostic),
    /// Exact Codex createSession quota guard receipt before native thread/start.
    /// Carries no remote diagnostic text and grants no replay authority.
    CodexCreateQuotaNotSubmitted,
    Protocol,
    Initialization {
        phase: &'static str,
        cause: Box<AhapError>,
    },
}
#[derive(Clone, Debug)]
pub struct AhapConfig {
    pub instance_id: String,
    pub harness: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}
struct State {
    child: Child,
    writer: mpsc::SyncSender<(Vec<u8>, mpsc::SyncSender<Result<(), ()>>)>,
    rx: Receiver<Result<Value, ()>>,
    next_id: u64,
    usable: bool,
    init_pending: bool,
}
pub struct AhapClient {
    instance_id: String,
    harness: String,
    methods: HashSet<String>,
    capabilities: Value,
    state: Mutex<State>,
    timeout: Duration,
}
impl State {
    /// Do not release the caller's execution guard while our runner can still
    /// issue requests. A request already handed to the native service remains
    /// UNKNOWN even after the runner exits.
    fn poison(&mut self) {
        self.usable = false;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for State {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn frames(out: impl Read, tx: mpsc::SyncSender<Result<Value, ()>>) {
    let mut r = BufReader::new(out);
    loop {
        let mut line = Vec::new();
        let n = match (&mut r).take(MAX_FRAME + 1).read_until(b'\n', &mut line) {
            Ok(n) => n,
            Err(_) => {
                let _ = tx.send(Err(()));
                return;
            }
        };
        if n == 0 {
            return;
        }
        if n as u64 > MAX_FRAME || line.last() != Some(&b'\n') {
            let _ = tx.send(Err(()));
            return;
        }
        let parsed = serde_json::from_slice::<Value>(&line).map_err(|_| ());
        if tx.send(parsed).is_err() {
            return;
        }
    }
}
fn writes(mut input: ChildStdin, rx: Receiver<(Vec<u8>, mpsc::SyncSender<Result<(), ()>>)>) {
    while let Ok((data, result)) = rx.recv() {
        let written = input
            .write_all(&data)
            .and_then(|_| input.flush())
            .map_err(|_| ());
        let failed = written.is_err();
        let _ = result.send(written);
        if failed {
            break;
        }
    }
}
fn codex_create_quota_not_submitted(harness: &str, method: &str, error: &Value) -> bool {
    // The method/harness are local call context, never selected by error.data.
    if harness != "codex" || method != "createSession" {
        return false;
    }
    let Some(error) = error.as_object() else {
        return false;
    };
    let Some(data) = error.get("data").and_then(Value::as_object) else {
        return false;
    };
    // Unknown extensions may contradict non-admission: fail closed until reviewed.
    error.len() == 3
        && error.get("code").and_then(Value::as_i64) == Some(-32000)
        && error.get("message").and_then(Value::as_str).is_some()
        && data.len() == 8
        && data.get("outcome").and_then(Value::as_str) == Some("not_submitted")
        && data.get("admitted").and_then(Value::as_bool) == Some(false)
        && data.get("notSubmitted").and_then(Value::as_bool) == Some(true)
        && data.get("retryable").and_then(Value::as_bool) == Some(false)
        && data.get("code").and_then(Value::as_str) == Some("codex_quota_guard")
        && data.get("method").and_then(Value::as_str) == Some("createSession")
        && data.get("operation").and_then(Value::as_str) == Some("thread/start")
        && matches!(
            data.get("reason").and_then(Value::as_str),
            Some(
                "provider_denied"
                    | "below_reserve"
                    | "quota_unknown"
                    | "quota_snapshot_expired"
                    | "quota_policy_unavailable"
            )
        )
}

fn browser_send_unconfirmed(harness: &str, method: &str, error: &Value) -> Option<BrowserSendDiagnostic> {
    if method != "sendMessage" || error["code"].as_i64() != Some(-32000) {
        return None;
    }
    let data = error.get("data")?;
    if data["method"] != "sendMessage" || data["outcome"] != "unknown" || data["retryable"] != false {
        return None;
    }
    browser_send_diagnostic(data).filter(|d| d.belongs_to(harness))
}

fn rpc(
    s: &mut State,
    method: &str,
    params: Value,
    timeout: Duration,
    harness: &str,
) -> Result<Value, AhapError> {
    if !s.usable {
        return Err(AhapError::Unavailable);
    }
    match s.child.try_wait() {
        Ok(None) => (),
        _ => {
            s.usable = false;
            return Err(AhapError::BeforeSend);
        }
    }
    let id = s.next_id;
    s.next_id = s.next_id.checked_add(1).ok_or(AhapError::BeforeSend)?;
    let mut data =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|_| AhapError::BeforeSend)?;
    data.push(b'\n');
    if data.len() as u64 > MAX_FRAME {
        return Err(AhapError::BeforeSend);
    }
    let deadline = Instant::now() + timeout;
    let (ack, ack_rx) = mpsc::sync_channel(1);
    if s.writer.send((data, ack)).is_err() {
        s.usable = false;
        return Err(AhapError::BeforeSend);
    }
    match ack_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok(())) => (),
        _ => {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        }
    }
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        }
        let frame = match s.rx.recv_timeout(remaining) {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                s.poison();
                return Err(AhapError::OutcomeUnknown);
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                s.poison();
                return Err(AhapError::OutcomeUnknown);
            }
        };
        if frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        }
        if frame.get("id").is_none() && frame.get("method").and_then(Value::as_str) == Some("event")
        {
            continue;
        }
        if frame.get("id").and_then(Value::as_u64) != Some(id) {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        }
        let Some(object) = frame.as_object() else {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        };
        let has_result = object.contains_key("result");
        let has_error = object.contains_key("error");
        if has_result == has_error {
            s.poison();
            return Err(AhapError::OutcomeUnknown);
        }
        if has_error {
            let valid = object
                .get("error")
                .and_then(Value::as_object)
                .is_some_and(|e| {
                    e.get("code").and_then(Value::as_i64).is_some()
                        && e.get("message").and_then(Value::as_str).is_some()
                });
            if !valid {
                s.poison();
                return Err(AhapError::OutcomeUnknown);
            }
            return Err(
                if object.len() == 3
                    && codex_create_quota_not_submitted(harness, method, &object["error"])
                {
                    AhapError::CodexCreateQuotaNotSubmitted
                } else if let Some(diagnostic) = browser_send_unconfirmed(harness, method, &object["error"]) {
                    AhapError::BrowserSendUnconfirmed(diagnostic)
                } else {
                    AhapError::Remote
                },
            );
        }
        return Ok(object["result"].clone());
    }
}
impl AhapClient {
    pub fn open(config: AhapConfig) -> Result<Self, AhapError> {
        Self::open_inner(config, false)
    }
    /// Verify AHAP metadata immediately, but defer account initialization to
    /// the first supported operation. Intended for browser owner composition.
    pub fn open_lazy_init(config: AhapConfig) -> Result<Self, AhapError> {
        Self::open_inner(config, true)
    }
    fn open_inner(config: AhapConfig, lazy_init: bool) -> Result<Self, AhapError> {
        if config.instance_id.is_empty()
            || config.harness.is_empty()
            || !config.executable.is_absolute()
            || !config.cwd.is_absolute()
            || config.timeout.is_zero()
        {
            return Err(AhapError::InvalidConfig);
        }
        let mut cmd = Command::new(&config.executable);
        cmd.args(&config.args)
            .current_dir(&config.cwd)
            .env_clear()
            .envs(config.env.iter().map(|(k, v)| (k, v)))
            .env("AHAP_VERSION", "0.1")
            .env("AHAP_HARNESS", &config.harness)
            .env("AHAP_ROLE", "adapter")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| {
            eprintln!("AHAP runner process could not start: {e}");
            AhapError::BeforeSend
        })?;
        let input = child.stdin.take().ok_or(AhapError::BeforeSend)?;
        let out = child.stdout.take().ok_or(AhapError::BeforeSend)?;
        let (tx, rx) = mpsc::sync_channel(32);
        thread::spawn(move || frames(out, tx));
        let (writer, write_rx) = mpsc::sync_channel(1);
        thread::spawn(move || writes(input, write_rx));
        let mut state = State {
            child,
            writer,
            rx,
            next_id: 1,
            usable: true,
            init_pending: false,
        };
        let init = rpc(
            &mut state,
            "initialize",
            json!({"harness":config.harness,"ahapVersion":"0.1"}),
            config.timeout,
            &config.harness,
        )
        .map_err(|cause| AhapError::Initialization {
            phase: "initialize",
            cause: Box::new(cause),
        })?;
        if init.get("harness").and_then(Value::as_str) != Some(config.harness.as_str()) {
            return Err(AhapError::Protocol);
        }
        let entries = init
            .pointer("/capabilities/methods")
            .and_then(Value::as_array)
            .ok_or(AhapError::Protocol)?;
        let mut methods = HashSet::new();
        for entry in entries {
            let name = entry
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(AhapError::Protocol)?;
            if !methods.insert(name.to_owned()) {
                return Err(AhapError::Protocol);
            }
        }
        if methods.contains("init") && !lazy_init {
            rpc(
                &mut state,
                "init",
                json!({}),
                config.timeout,
                &config.harness,
            )
            .map_err(|cause| AhapError::Initialization {
                phase: "init",
                cause: Box::new(cause),
            })?;
        }
        state.init_pending = lazy_init && methods.contains("init");
        Ok(Self {
            instance_id: config.instance_id,
            harness: config.harness,
            methods,
            capabilities: init["capabilities"].clone(),
            state: Mutex::new(state),
            timeout: config.timeout,
        })
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
    /// Harness verified against the adapter's AHAP initialize response.
    pub fn harness(&self) -> &str {
        &self.harness
    }
    /// Adapter-advertised initialize capabilities, preserved without inference.
    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }
    pub fn supports(&self, method: &str) -> bool {
        self.methods.contains(method)
    }
    pub fn call(&self, method: &str, params: Value) -> Result<Value, AhapError> {
        if !self.supports(method) {
            return Err(AhapError::Unsupported);
        }
        let mut s = self.state.lock().map_err(|_| AhapError::Unavailable)?;
        if !s.usable {
            return Err(AhapError::Unavailable);
        }
        if s.init_pending {
            let result = rpc(&mut s, "init", json!({}), self.timeout, &self.harness);
            if let Err(cause) = result {
                s.poison();
                return Err(AhapError::Initialization { phase: "init", cause: Box::new(cause) });
            }
            s.init_pending = false;
            if method == "init" {
                return result;
            }
        }
        rpc(&mut s, method, params, self.timeout, &self.harness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(body: &str, timeout: Duration) -> (Fixture, AhapClient) {
        fixture_mode(body, timeout, false)
    }
    fn fixture_mode(body: &str, timeout: Duration, lazy: bool) -> (Fixture, AhapClient) {
        let dir = std::env::temp_dir().join(format!(
            "herder-ahap-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let executable = dir.join("adapter");
        fs::write(&executable, body).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let config = AhapConfig {
            instance_id: "node-a/profile-a".into(),
            harness: "opencode".into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec![executable.to_string_lossy().into_owned()],
            cwd: dir.clone(),
            env: vec![(
                "TRACE".into(),
                dir.join("trace").to_string_lossy().into_owned(),
            )],
            timeout,
        };
        let c = if lazy { AhapClient::open_lazy_init(config) } else { AhapClient::open(config) }.unwrap();
        (Fixture(dir), c)
    }
    const SCRIPT: &str = r##"#!/usr/bin/python3
import json,os,sys,time
for line in sys.stdin:
 r=json.loads(line); m=r['method']
 with open(os.environ['TRACE'],'a') as f:f.write(m+'\n')
 if m=='initialize':
  assert r['params']['harness']=='opencode' and os.environ['AHAP_VERSION']=='0.1'
  v={'harness':'opencode','name':'fixture','capabilities':{'methods':['init','createSession','sendMessage','getSessionMessages']}}
 elif m=='init':v=None
 elif m=='sendMessage':time.sleep(1);v={'admission':'accepted','nativeInputMessageId':'msg'}
 elif m=='createSession':v={'id':'ses_fixture'}
 else:v=[]
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"##;
    #[test]
    fn capabilities_and_instance_are_explicit() {
        let (f, c) = fixture(SCRIPT, Duration::from_secs(2));
        assert_eq!(c.instance_id(), "node-a/profile-a");
        assert_eq!(c.harness(), "opencode");
        assert!(c.supports("createSession"));
        assert!(matches!(
            c.call("deleteSession", json!({})),
            Err(AhapError::Unsupported)
        ));
        assert_eq!(
            c.call("createSession", json!({"options":{}})).unwrap()["id"],
            "ses_fixture"
        );
        drop(c);
        assert_eq!(
            fs::read_to_string(f.0.join("trace"))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["initialize", "init", "createSession"]
        );
    }
    const LAZY_SCRIPT: &str = r##"import json,os,sys,time
for line in sys.stdin:
 r=json.loads(line); m=r['method']
 with open(os.environ['TRACE'],'a') as f:f.write(m+'\n')
 if m=='initialize': v={'harness':'opencode','capabilities':{'methods':['init','getSessionMessages','sendMessage']}}
 elif m=='init':
  mode=open('mode').read() if os.path.exists('mode') else 'ok'
  if mode=='timeout': time.sleep(2)
  if mode=='denied':
   print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'wrong scope'}}),flush=True);continue
  v=None
 else: v={'data':'fixture'}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"##;
    #[test]
    fn lazy_init_is_deferred_and_serialized() {
        let (f, c) = fixture_mode(LAZY_SCRIPT, Duration::from_secs(2), true);
        assert_eq!(fs::read_to_string(f.0.join("trace")).unwrap(), "initialize\n");
        assert!(c.supports("getSessionMessages"));
        let c = std::sync::Arc::new(c);
        let workers: Vec<_> = (0..4).map(|_| { let c = c.clone(); std::thread::spawn(move || c.call("getSessionMessages", json!({})).unwrap()) }).collect();
        for worker in workers { assert_eq!(worker.join().unwrap()["data"], "fixture"); }
        let trace = fs::read_to_string(f.0.join("trace")).unwrap();
        assert_eq!(trace.lines().collect::<Vec<_>>(), ["initialize","init","getSessionMessages","getSessionMessages","getSessionMessages","getSessionMessages"]);
    }
    #[test]
    fn lazy_init_wrong_scope_and_timeout_fail_closed_without_replay() {
        for mode in ["denied", "timeout"] {
            let (f, c) = fixture_mode(LAZY_SCRIPT, Duration::from_millis(300), true);
            fs::write(f.0.join("mode"), mode).unwrap();
            assert!(matches!(c.call("sendMessage", json!({})), Err(AhapError::Initialization { phase: "init", .. })));
            assert!(matches!(c.call("getSessionMessages", json!({})), Err(AhapError::Unavailable)));
            assert_eq!(fs::read_to_string(f.0.join("trace")).unwrap(), "initialize\ninit\n");
        }
    }
    #[test]
    fn initialize_harness_must_match_the_trusted_configuration() {
        let dir = std::env::temp_dir().join(format!(
            "herder-ahap-harness-mismatch-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let _f = Fixture(dir.clone());
        let script = dir.join("adapter");
        fs::write(
            &script,
            "#!/usr/bin/python3\nimport json,sys\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'harness':'opencode','capabilities':{'methods':[]}}}),flush=True)\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let result = AhapClient::open(AhapConfig {
            instance_id: "node-a/profile-a".into(),
            harness: "zcode".into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: dir,
            env: vec![],
            timeout: Duration::from_secs(2),
        });
        assert!(matches!(result, Err(AhapError::Protocol)));
    }
    #[test]
    fn startup_failure_identifies_init_phase_without_echoing_remote_secrets() {
        let dir = std::env::temp_dir().join(format!(
            "ahap-init-diagnostic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let _fixture = Fixture(dir.clone());
        let script = dir.join("adapter.py");
        fs::write(&script, r#"import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if r['method']=='initialize': v={'result':{'harness':'codex','capabilities':{'methods':['init']}}}
 else: v={'error':{'code':-32000,'message':'SECRET remote credential','data':{'outcome':'read_failed'}}}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],**v}),flush=True)
"#).unwrap();
        let error = AhapClient::open(AhapConfig {
            instance_id: "one".into(),
            harness: "codex".into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: dir,
            env: vec![],
            timeout: Duration::from_secs(2),
        })
        .err()
        .unwrap();
        let text = format!("{error:?}");
        assert!(text.contains("init") && text.contains("Remote"), "{text}");
        assert!(!text.contains("SECRET"), "{text}");
    }
    #[test]
    fn timeout_never_replays_a_possibly_sent_mutation() {
        let (f, c) = fixture(SCRIPT, Duration::from_millis(100));
        assert!(matches!(
            c.call("sendMessage", json!({"id":"ses","options":{"message":"x"}})),
            Err(AhapError::OutcomeUnknown)
        ));
        assert!(matches!(
            c.call("sendMessage", json!({})),
            Err(AhapError::Unavailable)
        ));
        drop(c);
        let trace = fs::read_to_string(f.0.join("trace")).unwrap();
        assert_eq!(trace.lines().filter(|m| *m == "sendMessage").count(), 1);
    }
    #[test]
    fn blocked_stdin_is_bounded_and_never_retried() {
        let script = r##"#!/usr/bin/python3
import json,sys,time
r=json.loads(sys.stdin.readline())
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'harness':'opencode','capabilities':{'methods':['sendMessage']}}}),flush=True)
time.sleep(5)
"##;
        let (_f, mut c) = fixture(script, Duration::from_secs(2));
        c.timeout = Duration::from_millis(150);
        let started = Instant::now();
        assert!(matches!(
            c.call("sendMessage", json!({"payload":"x".repeat(1024*1024)})),
            Err(AhapError::OutcomeUnknown)
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(matches!(
            c.call("sendMessage", json!({})),
            Err(AhapError::Unavailable)
        ));
    }
    #[test]
    fn ambiguous_result_and_null_error_poisons_connection() {
        let script = r##"#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if r['method']=='initialize':v={'harness':'opencode','capabilities':{'methods':['sendMessage']}};frame={'jsonrpc':'2.0','id':r['id'],'result':v}
 else:frame={'jsonrpc':'2.0','id':r['id'],'result':{'ok':True},'error':None}
 print(json.dumps(frame),flush=True)
"##;
        let (_f, c) = fixture(script, Duration::from_secs(2));
        assert!(matches!(
            c.call("sendMessage", json!({})),
            Err(AhapError::OutcomeUnknown)
        ));
        assert!(matches!(
            c.call("sendMessage", json!({})),
            Err(AhapError::Unavailable)
        ));
    }
}
