//! Native Codex turn submission and read-only recovery lookup.
//!
//! `clientUserMessageId` carries the caller's request key as correlation only;
//! Codex does not promise to deduplicate it. A missing lookup result is UNKNOWN,
//! never permission to submit the same request again.

use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex, time::Duration};

use serde_json::{Value, json};

use crate::domain::{
    adapter::{
        Admission, DispatchPlan, NativeReceipt, NativeSessionControl, RequestKey, SendMode,
        SubmitError,
    },
    address::{InstanceRef, SessionAddress},
};

use super::connection::{CodexConnection, CodexInstance, OpenError, RpcError};

const LOOKUP_PAGE_LIMIT: u32 = 200;
const LOOKUP_MAX_PAGES: usize = 128;

#[derive(Debug)]
pub enum CodexControlOpenError {
    Open(OpenError),
    Rpc(RpcError),
    ProfilePath(std::io::Error),
    ProfileMismatch { expected: PathBuf, observed: String },
    InstanceMismatch,
    InvalidTimeout,
}

impl std::fmt::Display for CodexControlOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(error) => write!(f, "could not open Codex profile: {error}"),
            Self::Rpc(error) => write!(f, "Codex app-server initialization failed: {error}"),
            Self::ProfilePath(error) => write!(f, "could not resolve Codex profile path: {error}"),
            Self::ProfileMismatch { expected, observed } => write!(
                f,
                "Codex app-server opened a different profile: expected {}, observed {observed}",
                expected.display()
            ),
            Self::InstanceMismatch => {
                f.write_str("Codex process and configured instance identity do not match")
            }
            Self::InvalidTimeout => f.write_str("Codex request timeout must be positive"),
        }
    }
}

impl std::error::Error for CodexControlOpenError {}

impl From<OpenError> for CodexControlOpenError {
    fn from(value: OpenError) -> Self {
        Self::Open(value)
    }
}

impl From<RpcError> for CodexControlOpenError {
    fn from(value: RpcError) -> Self {
        Self::Rpc(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestReceiptLookup {
    Found(NativeReceipt),
    /// No matching `clientId` was visible. This is not evidence that no submit occurred.
    NotFound,
    /// More than one native turn used this correlation value; no turn is guessed.
    Ambiguous,
}

#[derive(Debug)]
pub enum RequestLookupError {
    Rpc(RpcError),
    InvalidTarget,
    InvalidRequestKey,
    InvalidResponse(String),
    PaginationLimit,
}

impl std::fmt::Display for RequestLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rpc(error) => write!(f, "Codex receipt lookup failed: {error}"),
            Self::InvalidTarget => f.write_str("Codex receipt lookup target is not this instance"),
            Self::InvalidRequestKey => f.write_str("Codex request key is empty or too long"),
            Self::InvalidResponse(reason) => {
                write!(f, "invalid Codex receipt lookup response: {reason}")
            }
            Self::PaginationLimit => {
                f.write_str("Codex receipt lookup did not finish within its page limit")
            }
        }
    }
}

impl std::error::Error for RequestLookupError {}

struct ControlState {
    connection: CodexConnection,
    /// A new thread can receive its first turn only through this control object.
    /// This is a local scope check, not a native concurrency fence.
    fresh_threads: HashSet<String>,
}

/// A single native Codex app-server connection bound to one configured instance.
pub struct CodexControl {
    instance: InstanceRef,
    timeout: Duration,
    state: Mutex<ControlState>,
}

impl CodexControl {
    pub fn open(
        process: CodexInstance,
        instance: InstanceRef,
        timeout: Duration,
    ) -> Result<Self, CodexControlOpenError> {
        if timeout.is_zero() {
            return Err(CodexControlOpenError::InvalidTimeout);
        }
        if process.instance_id != instance.instance_id {
            return Err(CodexControlOpenError::InstanceMismatch);
        }
        let expected_profile =
            fs::canonicalize(&process.code_home).map_err(CodexControlOpenError::ProfilePath)?;
        let mut connection = CodexConnection::open(process)?;
        let initialized = connection.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-herder-native",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {},
            }),
            timeout,
        )?;
        let observed = initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .ok_or_else(|| CodexControlOpenError::ProfileMismatch {
                expected: expected_profile.clone(),
                observed: "initialize omitted codexHome".into(),
            })?;
        if PathBuf::from(observed) != expected_profile {
            return Err(CodexControlOpenError::ProfileMismatch {
                expected: expected_profile,
                observed: observed.to_owned(),
            });
        }
        connection.notify("initialized", json!({}))?;
        Ok(Self {
            instance,
            timeout,
            state: Mutex::new(ControlState {
                connection,
                fresh_threads: HashSet::new(),
            }),
        })
    }

    pub fn instance(&self) -> &InstanceRef {
        &self.instance
    }

    /// Create one empty native thread. `thread/start` has no request-key field;
    /// any uncertain result must remain UNKNOWN and must not be replayed.
    pub fn start_thread(&self, cwd: &str) -> Result<SessionAddress, SubmitError> {
        if cwd.trim().is_empty() {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Codex thread cwd is empty".into(),
            });
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| SubmitError::DefinitelyNotSent {
                reason: "Codex control connection lock is poisoned".into(),
            })?;
        let result = state
            .connection
            .request("thread/start", json!({"cwd": cwd}), self.timeout);
        let result = match result {
            Ok(result) => result,
            Err(error) => return Err(map_rpc_error(error)),
        };
        let thread_id = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let Some(thread_id) = thread_id else {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "Codex thread/start response omitted the native thread ID".into(),
            });
        };
        let thread_id = thread_id.to_owned();
        state.fresh_threads.insert(thread_id.clone());
        Ok(SessionAddress {
            instance: self.instance.clone(),
            native_session_id: thread_id,
        })
    }

    /// Search only native `userMessage.clientId` values. A miss or ambiguity
    /// never authorizes another submit. The caller may persist a unique Found receipt.
    pub fn lookup_request(
        &self,
        target: &SessionAddress,
        key: &RequestKey,
    ) -> Result<RequestReceiptLookup, RequestLookupError> {
        if target.instance != self.instance || target.native_session_id.is_empty() {
            return Err(RequestLookupError::InvalidTarget);
        }
        if key.0.is_empty() || key.0.len() > 4096 {
            return Err(RequestLookupError::InvalidRequestKey);
        }
        let mut state = self.state.lock().map_err(|_| {
            RequestLookupError::InvalidResponse("connection lock is poisoned".into())
        })?;
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut matched_turn: Option<String> = None;
        for _ in 0..LOOKUP_MAX_PAGES {
            let response = state
                .connection
                .request(
                    "thread/items/list",
                    json!({
                        "threadId": target.native_session_id,
                        "cursor": cursor,
                        "limit": LOOKUP_PAGE_LIMIT,
                        "sortDirection": "desc",
                    }),
                    self.timeout,
                )
                .map_err(RequestLookupError::Rpc)?;
            let rows = response
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| RequestLookupError::InvalidResponse("missing data array".into()))?;
            for row in rows {
                let item = row.get("item").ok_or_else(|| {
                    RequestLookupError::InvalidResponse("item row omitted item".into())
                })?;
                if item.get("type").and_then(Value::as_str) != Some("userMessage")
                    || item.get("clientId").and_then(Value::as_str) != Some(key.0.as_str())
                {
                    continue;
                }
                let turn_id = row
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        RequestLookupError::InvalidResponse(
                            "matching user message omitted turnId".into(),
                        )
                    })?
                    .to_owned();
                if matched_turn.as_ref().is_some_and(|prior| prior != &turn_id) {
                    return Ok(RequestReceiptLookup::Ambiguous);
                }
                matched_turn = Some(turn_id);
            }
            let next = response
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            match next {
                None => {
                    return Ok(match matched_turn {
                        Some(native_id) => RequestReceiptLookup::Found(NativeReceipt {
                            target: target.clone(),
                            native_id,
                        }),
                        None => RequestReceiptLookup::NotFound,
                    });
                }
                Some(next) if !seen_cursors.insert(next.clone()) => {
                    return Err(RequestLookupError::InvalidResponse(
                        "repeated pagination cursor".into(),
                    ));
                }
                Some(next) => cursor = Some(next),
            }
        }
        Err(RequestLookupError::PaginationLimit)
    }
}

impl NativeSessionControl for CodexControl {
    async fn submit(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        if plan.target.instance != self.instance || plan.target.native_session_id.is_empty() {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Codex dispatch target does not belong to this configured instance".into(),
            });
        }
        if key.0.is_empty() || key.0.len() > 4096 {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Codex request key is empty or too long".into(),
            });
        }
        let method_and_params = match plan.mode {
            SendMode::Start if plan.expected_turn.is_none() => (
                "turn/start",
                json!({
                    "threadId": plan.target.native_session_id,
                    "input": [{"type": "text", "text": message}],
                    "clientUserMessageId": key.0,
                }),
            ),
            SendMode::Start => {
                return Err(SubmitError::DefinitelyNotSent {
                    reason: "Codex turn/start does not accept an expected-turn precondition".into(),
                });
            }
            SendMode::Current => {
                let Some(expected_turn) = plan.expected_turn.as_deref().filter(|id| !id.is_empty())
                else {
                    return Err(SubmitError::DefinitelyNotSent {
                        reason: "Codex turn/steer requires the exact expected turn ID".into(),
                    });
                };
                (
                    "turn/steer",
                    json!({
                        "threadId": plan.target.native_session_id,
                        "expectedTurnId": expected_turn,
                        "input": [{"type": "text", "text": message}],
                        "clientUserMessageId": key.0,
                    }),
                )
            }
            SendMode::Queue => {
                return Err(SubmitError::DefinitelyNotSent {
                    reason:
                        "Codex app-server has no native queued-turn operation; no submit was sent"
                            .into(),
                });
            }
        };

        let (method, params) = method_and_params;
        let result = {
            let mut state = self.state.lock().map_err(|_| SubmitError::DefinitelyNotSent {
                reason: "Codex control connection lock is poisoned".into(),
            })?;
            if method == "turn/start" && !state.fresh_threads.remove(&plan.target.native_session_id) {
                return Err(SubmitError::DefinitelyNotSent {
                    reason: "Codex turn/start is allowed only on a fresh thread created by this control instance".into(),
                });
            }
            state.connection.request(method, params, self.timeout)
        }
        .map_err(map_rpc_error)?;

        let native_id = match method {
            "turn/start" => result
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str),
            "turn/steer" => result.get("turnId").and_then(Value::as_str),
            _ => None,
        }
        .filter(|id| !id.is_empty());
        let Some(native_id) = native_id else {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: format!("Codex {method} response omitted its native turn ID"),
            });
        };
        if method == "turn/steer" && plan.expected_turn.as_deref() != Some(native_id) {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "Codex turn/steer response did not match expectedTurnId".into(),
            });
        }
        Ok(Admission {
            receipt: NativeReceipt {
                target: plan.target,
                native_id: native_id.to_owned(),
            },
        })
    }
}

fn map_rpc_error(error: RpcError) -> SubmitError {
    match error {
        RpcError::NotRunning
        | RpcError::RequestIdExhausted
        | RpcError::Process(_)
        | RpcError::Encode(_) => SubmitError::DefinitelyNotSent {
            reason: error.to_string(),
        },
        // The legacy native adapter treats Codex's invalid-state/parameter
        // response as a server-side pre-admission rejection. Other remote
        // errors remain UNKNOWN because their side-effect semantics are not
        // proven by a transport error alone.
        RpcError::Remote {
            code: Some(-32600), ..
        } => SubmitError::DefinitelyNotSent {
            reason: error.to_string(),
        },
        _ => SubmitError::OutcomeUnknown {
            receipt: None,
            reason: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::{NodeRef, SessionAddress};

    fn fake_control(server_body: &str, timeout: Duration) -> (CodexControl, PathBuf) {
        use std::{fs, os::unix::fs::PermissionsExt};

        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let root = std::env::temp_dir().join(format!(
            "herder-codex-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let executable = root.join("fake-codex");
        let script = format!("#!/usr/bin/python3\n{server_body}");
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let instance = InstanceRef {
            node: NodeRef("test-node".into()),
            instance_id: "test-instance".into(),
        };
        let control = CodexControl::open(
            CodexInstance {
                instance_id: instance.instance_id.clone(),
                executable,
                code_home: home.clone(),
                cwd: root.clone(),
            },
            instance,
            timeout,
        )
        .unwrap();
        (control, root)
    }

    fn fixture_server(extra: &str) -> String {
        format!(
            "import json, os, sys\nfor line in sys.stdin:\n r=json.loads(line)\n if 'id' not in r: continue\n m=r['method']; p=r['params']\n if m == 'turn/start': result={{'turn':{{'id':'turn-1'}}}}\n elif m == 'turn/steer': result={{'turnId':p['expectedTurnId']}}\n elif m == 'thread/start': result={{'thread':{{'id':'thread-1'}}}}\n elif m == 'thread/items/list': result={{'data':[{{'turnId':'turn-1','item':{{'type':'userMessage','clientId':'request-1'}}}}], 'nextCursor':None}}\n elif m == 'initialize': result={{'codexHome':os.environ['CODEX_HOME']}}\n else: result={{}}\n {extra}\n print(json.dumps({{'id':r['id'],'result':result}}), flush=True)\n"
        )
    }

    #[tokio::test]
    async fn starts_only_a_controller_created_thread_and_correlates_read_only_receipt() {
        let (control, _root) = fake_control(&fixture_server(""), Duration::from_secs(2));
        let target = control.start_thread("/tmp").unwrap();
        assert_eq!(target.native_session_id, "thread-1");

        let admission = control
            .submit(
                DispatchPlan {
                    target: target.clone(),
                    mode: SendMode::Start,
                    expected_turn: None,
                },
                "hello",
                &RequestKey("request-1".into()),
            )
            .await
            .unwrap();
        assert_eq!(admission.receipt.native_id, "turn-1");
        assert_eq!(
            control
                .lookup_request(&target, &RequestKey("request-1".into()))
                .unwrap(),
            RequestReceiptLookup::Found(NativeReceipt {
                target,
                native_id: "turn-1".into(),
            })
        );
    }

    #[tokio::test]
    async fn queue_is_rejected_before_native_submission() {
        let (control, _root) = fake_control(&fixture_server(""), Duration::from_secs(2));
        let error = control
            .submit(
                DispatchPlan {
                    target: SessionAddress {
                        instance: control.instance().clone(),
                        native_session_id: "thread-existing".into(),
                    },
                    mode: SendMode::Queue,
                    expected_turn: None,
                },
                "hello",
                &RequestKey("request-2".into()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, SubmitError::DefinitelyNotSent { .. }));
    }

    #[tokio::test]
    async fn timed_out_submission_is_unknown_and_is_not_retried() {
        let body = "import json, os, sys, time\nfor line in sys.stdin:\n r=json.loads(line)\n if 'id' not in r: continue\n m=r['method']\n if m == 'initialize': print(json.dumps({'id':r['id'],'result':{'codexHome':os.environ['CODEX_HOME']}}), flush=True)\n elif m == 'thread/start': print(json.dumps({'id':r['id'],'result':{'thread':{'id':'thread-1'}}}), flush=True)\n elif m == 'turn/start': time.sleep(1)\n";
        let (control, _root) = fake_control(body, Duration::from_millis(100));
        let target = control.start_thread("/tmp").unwrap();
        let result = control
            .submit(
                DispatchPlan {
                    target,
                    mode: SendMode::Start,
                    expected_turn: None,
                },
                "hello",
                &RequestKey("request-3".into()),
            )
            .await;
        assert!(matches!(result, Err(SubmitError::OutcomeUnknown { .. })));
    }
}
