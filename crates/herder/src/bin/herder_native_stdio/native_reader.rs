//! Read-only, instance-bound Codex snapshot and exact receipt observation.
use herder::{
    adapters::codex::connection::{CodexConnection, CodexInstance},
    application::scoped_stop::wait_automation::{
        NativeTurn, NativeTurnReader, NativeTurnStatus, native_turn,
    },
    domain::{
        adapter::{
            NativeReceipt, NativeSessionReader, Observation, ReadError, SessionActivity,
            SessionSnapshot,
        },
        address::{
            Authorization, Availability, Capability, CapabilityVersion, InstanceRef,
            SessionAddress, Support,
        },
    },
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex, time::Duration};

pub struct NativeReader {
    instance: InstanceRef,
    connection: Mutex<CodexConnection>,
    timeout: Duration,
}
impl NativeReader {
    pub fn open(
        process: CodexInstance,
        instance: InstanceRef,
        timeout: Duration,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if process.instance_id != instance.instance_id || timeout.is_zero() {
            return Err("invalid reader instance or timeout".into());
        }
        let home = std::fs::canonicalize(&process.code_home)?;
        let mut connection = CodexConnection::open(process)?;
        let result = connection.request("initialize",json!({"clientInfo":{"name":"agent-herder-native-reader","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),timeout)?;
        if result
            .get("codexHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .as_ref()
            != Some(&home)
        {
            return Err("reader profile mismatch".into());
        }
        connection.notify("initialized", json!({}))?;
        Ok(Self {
            instance,
            connection: Mutex::new(connection),
            timeout,
        })
    }
    fn read(&self, target: &SessionAddress) -> Result<Value, ReadError> {
        if target.instance != self.instance || target.native_session_id.is_empty() {
            return Err(ReadError("wrong instance or empty target".into()));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ReadError("reader lock poisoned".into()))?;
        let response = connection
            .request(
                "thread/read",
                json!({"threadId":target.native_session_id,"includeTurns":true}),
                self.timeout,
            )
            .map_err(|e| ReadError(e.to_string()))?;
        let thread = response
            .get("thread")
            .filter(|t| {
                t.get("id").and_then(Value::as_str) == Some(target.native_session_id.as_str())
            })
            .ok_or_else(|| ReadError("thread identity mismatch".into()))?;
        if !thread.get("turns").is_some_and(Value::is_array) {
            return Err(ReadError("thread turns unavailable".into()));
        }
        Ok(thread.clone())
    }
}
fn exact_wait_turn(
    thread: &Value,
    captured: Option<&str>,
) -> Result<Option<NativeTurn>, ReadError> {
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| ReadError("thread turns unavailable".into()))?;
    let mut seen = std::collections::HashSet::new();
    let mut parsed = Vec::new();
    for turn in turns {
        let id = turn
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| ReadError("turn identity unavailable".into()))?;
        if !seen.insert(id) {
            return Err(ReadError("ambiguous turn identity".into()));
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| ReadError("turn state unavailable".into()))?;
        if !matches!(
            status,
            "inProgress" | "completed" | "failed" | "interrupted"
        ) {
            return Err(ReadError("turn state unavailable".into()));
        }
        parsed.push(native_turn(id, status).ok_or_else(|| ReadError("invalid turn proof".into()))?);
    }
    if let Some(captured) = captured {
        return Ok(parsed.into_iter().find(|t| t.turn_id == captured));
    }
    let mut running = parsed
        .iter()
        .filter(|t| t.status == NativeTurnStatus::Running);
    let active = running.next();
    if running.next().is_some() {
        return Err(ReadError("ambiguous current turn".into()));
    }
    // thread/read exposes the ordered native turn history. Explicit turn status
    // is required even when the enclosing thread advertises idle.
    Ok(active.or_else(|| parsed.last()).cloned())
}
impl NativeTurnReader for NativeReader {
    fn current_turn(&self, target: &SessionAddress) -> Result<Option<NativeTurn>, ReadError> {
        exact_wait_turn(&self.read(target)?, None)
    }
    fn observed_turn(
        &self,
        target: &SessionAddress,
        turn_id: &str,
    ) -> Result<Option<NativeTurn>, ReadError> {
        exact_wait_turn(&self.read(target)?, Some(turn_id))
    }
}
fn activity(thread: &Value) -> SessionActivity {
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return SessionActivity::Unknown;
    };
    let mut active = None;
    for turn in turns {
        match turn.get("status").and_then(Value::as_str) {
            Some("inProgress") => {
                let Some(id) = turn
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    return SessionActivity::Unknown;
                };
                if active.replace(id.to_owned()).is_some() {
                    return SessionActivity::Unknown;
                }
            }
            Some("completed" | "failed" | "interrupted") => {}
            _ => return SessionActivity::Unknown,
        }
    }
    active
        .map(|turn_id| SessionActivity::Busy { turn_id })
        .unwrap_or(SessionActivity::Idle)
}
fn observe(thread: &Value, receipt: &NativeReceipt) -> Observation {
    let unknown = || Observation::Unknown {
        receipt: receipt.clone(),
    };
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return unknown();
    };
    let mut found = turns
        .iter()
        .filter(|t| t.get("id").and_then(Value::as_str) == Some(receipt.native_id.as_str()));
    let Some(turn) = found.next() else {
        return unknown();
    };
    if found.next().is_some() {
        return unknown();
    }
    match turn.get("status").and_then(Value::as_str) {
        Some("inProgress") => Observation::Pending {
            receipt: receipt.clone(),
        },
        Some("completed")
            if turn
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
                }) =>
        {
            Observation::Confirmed {
                receipt: receipt.clone(),
            }
        }
        Some("failed" | "interrupted") => unknown(),
        _ => unknown(),
    }
}
pub fn snapshot_from_metadata(target: &SessionAddress, thread: &Value) -> SessionSnapshot {
    let mut snapshot = snapshot_from_thread(target, thread);
    snapshot.activity = match thread
        .get("status")
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
    {
        Some("idle") => SessionActivity::Idle,
        _ => SessionActivity::Unknown,
    };
    snapshot
}
pub fn snapshot_from_thread(target: &SessionAddress, thread: &Value) -> SessionSnapshot {
    SessionSnapshot {
        address: target.clone(),
        human_stop: false,
        activity: activity(thread),
        capabilities: vec![Capability {
            name: "deliver.start".into(),
            version: CapabilityVersion {
                adapter_version: "codex-native".into(),
                capability_version: "1".into(),
            },
            supported: Support::Supported,
            available: Availability::Available,
            authorized: Authorization::Authorized,
        }],
    }
}
impl NativeSessionReader for NativeReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        let thread = self.read(target)?;
        Ok(snapshot_from_thread(target, &thread))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        let thread = self.read(&receipt.target)?;
        Ok(observe(&thread, receipt))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use herder::domain::address::NodeRef;
    #[test]
    fn waits_require_exact_native_turn_and_keep_prior_turn_proof_after_a_new_run() {
        let thread = json!({"status":{"type":"idle"},"turns":[{"id":"old","status":"failed"},{"id":"current","status":"inProgress"}]});
        assert_eq!(
            exact_wait_turn(&thread, None).unwrap().unwrap().turn_id,
            "current"
        );
        let old = exact_wait_turn(&thread, Some("old")).unwrap().unwrap();
        assert_eq!(old.status, NativeTurnStatus::Failed);
        assert_eq!(exact_wait_turn(&thread, Some("missing")).unwrap(), None);
        assert_eq!(
            exact_wait_turn(&json!({"status":{"type":"idle"},"turns":[]}), None).unwrap(),
            None
        );
        for malformed in [
            json!({"turns":[{"id":"same","status":"completed"},{"id":"same","status":"completed"}]}),
            json!({"turns":[{"id":"a","status":"inProgress"},{"id":"b","status":"inProgress"}]}),
            json!({"turns":[{"id":"a","status":"idle"}]}),
            json!({"turns":[{"status":"completed"}]}),
        ] {
            assert!(exact_wait_turn(&malformed, None).is_err());
        }
    }
    fn receipt() -> NativeReceipt {
        NativeReceipt {
            target: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("n".into()),
                    instance_id: "i".into(),
                },
                native_session_id: "s".into(),
            },
            native_id: "t".into(),
        }
    }
    #[test]
    fn exact_completed_turn_needs_user_item() {
        let r = receipt();
        assert!(matches!(
            observe(
                &json!({"turns":[{"id":"t","status":"completed","items":[]}]}),
                &r
            ),
            Observation::Unknown { .. }
        ));
        assert!(matches!(
            observe(
                &json!({"turns":[{"id":"t","status":"completed","items":[{"type":"userMessage"}]}]}),
                &r
            ),
            Observation::Confirmed { .. }
        ));
        assert!(matches!(
            observe(
                &json!({"turns":[{"id":"other","status":"completed","items":[{"type":"userMessage"}]}]}),
                &r
            ),
            Observation::Unknown { .. }
        ));
    }
    #[test]
    fn malformed_and_multiple_active_are_unknown() {
        assert_eq!(
            activity(
                &json!({"turns":[{"id":"a","status":"inProgress"},{"id":"b","status":"inProgress"}]})
            ),
            SessionActivity::Unknown
        );
        assert_eq!(activity(&json!({"turns":[]})), SessionActivity::Idle);
        assert_eq!(
            activity(&json!({"turns":[{"status":"new"}]})),
            SessionActivity::Unknown
        );
    }
    #[test]
    fn metadata_requires_explicit_idle() {
        let r = receipt();
        assert_eq!(
            snapshot_from_metadata(&r.target, &json!({"status":{"type":"idle"}})).activity,
            SessionActivity::Idle
        );
        for status in [
            json!({"type":"active","activeFlags":[]}),
            json!({"type":"notLoaded"}),
            json!({"type":"systemError"}),
            json!(null),
        ] {
            assert_eq!(
                snapshot_from_metadata(&r.target, &json!({"status":status})).activity,
                SessionActivity::Unknown
            );
        }
    }
    #[tokio::test]
    async fn reader_checks_profile_target_and_exact_receipt_over_rpc() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "herder-reader-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("codex");
        std::fs::write(&script,r#"#!/usr/bin/python3
import json,os,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 if r['method']=='initialize': result={'codexHome':os.path.realpath(os.environ['CODEX_HOME'])}
 elif r['method']=='thread/read':
  assert r['params']['threadId']=='s' and r['params']['includeTurns'] is True
  result={'thread':{'id':'s','turns':[{'id':'t','status':'completed','items':[{'type':'userMessage'}]}]}}
 else: raise Exception('unexpected method')
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let r = receipt();
        let process = CodexInstance {
            instance_id: "i".into(),
            executable: script,
            code_home: dir.clone(),
            cwd: dir.clone(),
        };
        let reader =
            NativeReader::open(process, r.target.instance.clone(), Duration::from_secs(3)).unwrap();
        assert_eq!(
            reader.snapshot(&r.target).await.unwrap().activity,
            SessionActivity::Idle
        );
        assert!(matches!(
            reader.reconcile(&r).await.unwrap(),
            Observation::Confirmed { .. }
        ));
        assert_eq!(
            reader.current_turn(&r.target).unwrap(),
            Some(NativeTurn {
                turn_id: "t".into(),
                status: NativeTurnStatus::Completed
            })
        );
        assert!(reader.observed_turn(&r.target, "other").unwrap().is_none());
        let mut wrong = r.target.clone();
        wrong.instance.instance_id = "other".into();
        assert!(reader.snapshot(&wrong).await.is_err());
        drop(reader);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
