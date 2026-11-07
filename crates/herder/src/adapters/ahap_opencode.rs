//! Existing OpenCode AHAP adapter mapped into the core's bounded ports.
//! This module owns no ledger; the scoped authority persists intents/receipts.
use crate::{
    adapters::ahap::{AhapClient, AhapError},
    application::{
        scoped_stop::{BoundedFreshRootCreate, BoundedNativeHandoff},
        target::RegistryUnavailable,
    },
    domain::{
        adapter::{
            Admission, DispatchPlan, NativeReceipt, NativeSessionReader, Observation, ReadError,
            RequestKey, SendMode, SessionActivity, SessionSnapshot, SubmitError,
        },
        address::{
            Authorization, Availability, Capability, CapabilityVersion, InstanceRef,
            SessionAddress, Support,
        },
    },
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

pub struct AhapOpenCode {
    client: Arc<AhapClient>,
    instance: InstanceRef,
    cwd: PathBuf,
    name: String,
}
impl AhapOpenCode {
    pub fn new(
        client: Arc<AhapClient>,
        instance: InstanceRef,
        cwd: PathBuf,
        name: String,
    ) -> Result<Self, RegistryUnavailable> {
        if client.instance_id() != instance.instance_id
            || !cwd.is_absolute()
            || name.trim().is_empty()
            || [
                "createSession",
                "sendMessage",
                "getSession",
                "getSessionMessages",
            ]
            .iter()
            .any(|m| !client.supports(m))
        {
            return Err(RegistryUnavailable);
        }
        Ok(Self {
            client,
            instance,
            cwd,
            name,
        })
    }
    fn matches(&self, a: &SessionAddress) -> bool {
        a.instance == self.instance && valid_id(&a.native_session_id)
    }
    pub fn messages(&self, a: &SessionAddress, limit: u32) -> Result<Value, ReadError> {
        if !self.matches(a) || !(1..=200).contains(&limit) {
            return Err(ReadError("invalid OpenCode session".into()));
        }
        let result = self
            .client
            .call(
                "getSessionMessages",
                json!({"id":a.native_session_id,"limit":limit}),
            )
            .map_err(|_| ReadError("AHAP messages unavailable".into()))?;
        if !result.is_array() {
            return Err(ReadError("AHAP messages incomplete or unavailable".into()));
        }
        Ok(result)
    }
}
fn valid_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 4096
        && v.starts_with("ses")
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_receipt(v: &str) -> bool {
    v.starts_with("msg_")
        && v.len() <= 4096
        && v[4..].bytes().all(|b| b.is_ascii_alphanumeric())
        && v.len() > 4
}
fn transport_failure(e: AhapError) -> SubmitError {
    match e {
        AhapError::BeforeSend
        | AhapError::Unavailable
        | AhapError::Unsupported
        | AhapError::InvalidConfig => SubmitError::DefinitelyNotSent {
            reason: "AHAP request not sent".into(),
        },
        _ => SubmitError::OutcomeUnknown {
            receipt: None,
            reason: "AHAP operation outcome unknown".into(),
        },
    }
}
impl BoundedFreshRootCreate for AhapOpenCode {
    fn instance(&self) -> &InstanceRef {
        &self.instance
    }
    fn initial_delivery_mode(&self) -> SendMode {
        SendMode::Queue
    }
    fn create_root_bounded(&self, key: &str, _prompt: &str) -> Result<SessionAddress, SubmitError> {
        if key.is_empty() || key.len() > 4096 {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "invalid request key".into(),
            });
        }
        let result = self
            .client
            .call(
                "createSession",
                json!({"options":{"name":self.name,"cwd":self.cwd}}),
            )
            .map_err(transport_failure)?;
        let id = result
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| valid_id(v));
        if result.get("harness").and_then(Value::as_str) != Some("opencode") || id.is_none() {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "invalid AHAP create receipt".into(),
            });
        }
        Ok(SessionAddress {
            instance: self.instance.clone(),
            native_session_id: id.unwrap().into(),
        })
    }
}
impl BoundedNativeHandoff for AhapOpenCode {
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        if !self.matches(&plan.target)
            || plan.mode != SendMode::Queue
            || plan.expected_turn.is_some()
            || message.is_empty()
            || key.0.is_empty()
        {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "invalid OpenCode queue request".into(),
            });
        }
        let result=self.client.call("sendMessage",json!({"id":plan.target.native_session_id,"options":{"message":message,"queue":true,"activeTurnOnly":true,"inputId":key.0}})).map_err(transport_failure)?;
        let admitted = result.get("admitted").and_then(Value::as_bool) == Some(true)
            || matches!(
                result.get("admission").and_then(Value::as_str),
                Some("accepted" | "pending")
            )
            || result
                .get("nativeInputMessageId")
                .and_then(Value::as_str)
                .is_some();
        let unknown = result.get("admissionUnknown").and_then(Value::as_bool) == Some(true)
            || result.get("admission").and_then(Value::as_str) == Some("unknown");
        if !admitted
            && !unknown
            && (result.get("notSubmitted").and_then(Value::as_bool) == Some(true)
                || result.get("admission").and_then(Value::as_str) == Some("not_submitted"))
        {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "native adapter reports no admission".into(),
            });
        }
        let id = result
            .get("nativeInputMessageId")
            .and_then(Value::as_str)
            .filter(|s| valid_receipt(s));
        if !admitted || id.is_none() {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "native input receipt unavailable".into(),
            });
        }
        Ok(Admission {
            receipt: NativeReceipt {
                target: plan.target,
                native_id: id.unwrap().into(),
            },
        })
    }
}
impl NativeSessionReader for AhapOpenCode {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        if !self.matches(target) {
            return Err(ReadError("wrong instance".into()));
        }
        let result = self
            .client
            .call("getSession", json!({"id":target.native_session_id}))
            .map_err(|_| ReadError("AHAP session unavailable".into()))?;
        if result.get("id").and_then(Value::as_str) != Some(target.native_session_id.as_str())
            || result.get("harness").and_then(Value::as_str) != Some("opencode")
        {
            return Err(ReadError("AHAP session identity mismatch".into()));
        }
        let activity = match result.get("status").and_then(Value::as_str) {
            Some("idle") => SessionActivity::Idle,
            _ => SessionActivity::Unknown,
        };
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop: false,
            activity,
            capabilities: vec![Capability {
                name: "deliver.queue".into(),
                version: CapabilityVersion {
                    adapter_version: "legacy-ahap-0.1".into(),
                    capability_version: "1".into(),
                },
                supported: Support::Supported,
                available: Availability::Available,
                authorized: Authorization::Authorized,
            }],
        })
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        if !self.matches(&receipt.target) || !valid_receipt(&receipt.native_id) {
            return Err(ReadError("invalid receipt".into()));
        }
        let messages = self.messages(&receipt.target, 200)?;
        let matches: Vec<_> = messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m.get("id").and_then(Value::as_str) == Some(receipt.native_id.as_str()))
            .collect();
        Ok(
            if matches.len() == 1 && matches[0].get("role").and_then(Value::as_str) == Some("user")
            {
                Observation::Confirmed {
                    receipt: receipt.clone(),
                }
            } else {
                Observation::Unknown {
                    receipt: receipt.clone(),
                }
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::ahap::{AhapClient, AhapConfig};
    use crate::domain::address::NodeRef;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup(mode: &str) -> (Temp, AhapOpenCode) {
        let dir = std::env::temp_dir().join(format!(
            "herder-ahap-map-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let script = dir.join("adapter");
        fs::write(&script,r##"#!/usr/bin/python3
import json,os,sys
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 with open(os.environ['TRACE'],'a') as f:f.write(m+'\n')
 if m=='initialize':v={'harness':'opencode','capabilities':{'methods':['createSession','sendMessage','getSession','getSessionMessages']}}
 elif m=='createSession':v={'id':'sesABC','harness':'opencode'}
 elif m=='getSession':v={'id':'sesABC','harness':'opencode','status':'idle'}
 elif m=='sendMessage':
  assert p['id']=='sesABC' and p['options']['queue'] and p['options']['activeTurnOnly'] and p['options']['inputId']=='key'
  v={'ok':True,'admitted':True} if os.environ['MODE']=='missing' else {'ok':True,'admitted':True,'nativeInputMessageId':'msg_ABC'}
 elif m=='getSessionMessages':
  v=[{'id':'msg_ABC','role':'user','text':'hi','inputId':'key'}]
  if os.environ['MODE']=='duplicate':v.append({'id':'msg_ABC','role':'assistant','text':'ambiguous'})
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"##).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let instance = InstanceRef {
            node: NodeRef("node".into()),
            instance_id: "profile".into(),
        };
        let client = AhapClient::open(AhapConfig {
            instance_id: "profile".into(),
            harness: "opencode".into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: dir.clone(),
            env: vec![
                (
                    "TRACE".into(),
                    dir.join("trace").to_string_lossy().into_owned(),
                ),
                ("MODE".into(), mode.into()),
            ],
            timeout: Duration::from_secs(3),
        })
        .unwrap();
        let b =
            AhapOpenCode::new(Arc::new(client), instance, dir.clone(), "fixture".into()).unwrap();
        (Temp(dir), b)
    }
    #[tokio::test]
    async fn exact_queue_receipt_and_native_readback() {
        let (f, b) = setup("success");
        let a = b.create_root_bounded("create", "prompt").unwrap();
        assert_eq!(b.initial_delivery_mode(), SendMode::Queue);
        let snapshot = b.snapshot(&a).await.unwrap();
        assert_eq!(snapshot.activity, SessionActivity::Idle);
        let plan = crate::domain::adapter::decide_send(
            &snapshot,
            &crate::domain::adapter::SendCommand {
                mode: SendMode::Queue,
            },
        )
        .unwrap();
        let admission = b
            .submit_bounded(plan, "hi", &RequestKey("key".into()))
            .unwrap();
        assert!(matches!(
            b.reconcile(&admission.receipt).await.unwrap(),
            Observation::Confirmed { .. }
        ));
        let mut other = admission.receipt.clone();
        other.native_id = "msg_other".into();
        assert!(matches!(
            b.reconcile(&other).await.unwrap(),
            Observation::Unknown { .. }
        ));
        drop(b);
        assert_eq!(
            fs::read_to_string(f.0.join("trace"))
                .unwrap()
                .lines()
                .filter(|x| *x == "sendMessage")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn missing_native_receipt_stays_unknown_and_wrong_instance_does_not_send() {
        let (f, b) = setup("missing");
        let mut a = b.create_root_bounded("create", "prompt").unwrap();
        a.instance.node.0 = "other".into();
        let wrong = DispatchPlan {
            target: a.clone(),
            mode: SendMode::Queue,
            expected_turn: None,
        };
        assert!(matches!(
            b.submit_bounded(wrong, "hi", &RequestKey("key".into())),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        a.instance = b.instance.clone();
        let p = DispatchPlan {
            target: a,
            mode: SendMode::Queue,
            expected_turn: None,
        };
        assert!(matches!(
            b.submit_bounded(p, "hi", &RequestKey("key".into())),
            Err(SubmitError::OutcomeUnknown { .. })
        ));
        drop(b);
        assert_eq!(
            fs::read_to_string(f.0.join("trace"))
                .unwrap()
                .lines()
                .filter(|x| *x == "sendMessage")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn duplicate_native_id_across_roles_is_unknown() {
        let (_f, b) = setup("duplicate");
        let a = b.create_root_bounded("create", "prompt").unwrap();
        let receipt = NativeReceipt {
            target: a,
            native_id: "msg_ABC".into(),
        };
        assert!(matches!(
            b.reconcile(&receipt).await.unwrap(),
            Observation::Unknown { .. }
        ));
    }
}
