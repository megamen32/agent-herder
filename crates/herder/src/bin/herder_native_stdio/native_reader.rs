//! Read-only, instance-bound Codex snapshot and exact receipt observation.
use herder::{
    adapters::codex::connection::{CodexConnection, CodexInstance},
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
impl NativeSessionReader for NativeReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        let thread = self.read(target)?;
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop: false,
            activity: activity(&thread),
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
        })
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
        let mut wrong = r.target.clone();
        wrong.instance.instance_id = "other".into();
        assert!(reader.snapshot(&wrong).await.is_err());
        drop(reader);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
