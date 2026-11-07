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
    policy: AhapPortPolicy,
}

/// Trusted per-instance configuration for the shared AHAP port.
#[derive(Clone, Debug)]
pub struct AhapPortPolicy {
    pub harness: String,
    pub initial_delivery_mode: SendMode,
}
impl AhapOpenCode {
    pub fn new(
        client: Arc<AhapClient>,
        instance: InstanceRef,
        cwd: PathBuf,
        name: String,
    ) -> Result<Self, RegistryUnavailable> {
        Self::new_with_policy(
            client,
            instance,
            cwd,
            name,
            AhapPortPolicy {
                harness: "opencode".into(),
                initial_delivery_mode: SendMode::Start,
            },
        )
    }

    pub fn new_with_policy(
        client: Arc<AhapClient>,
        instance: InstanceRef,
        cwd: PathBuf,
        name: String,
        policy: AhapPortPolicy,
    ) -> Result<Self, RegistryUnavailable> {
        if client.instance_id() != instance.instance_id
            || client.harness() != policy.harness
            || policy.harness.is_empty()
            || !matches!(
                policy.initial_delivery_mode,
                SendMode::Start | SendMode::Queue
            )
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
            policy,
        })
    }
    fn matches(&self, a: &SessionAddress) -> bool {
        a.instance == self.instance && valid_native_id(&a.native_session_id)
    }
    pub fn messages(&self, a: &SessionAddress, limit: u32) -> Result<Value, ReadError> {
        if !self.matches(a) || !(1..=200).contains(&limit) {
            return Err(ReadError("invalid AHAP session".into()));
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
fn valid_native_id(v: &str) -> bool {
    !v.is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control)
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
        self.policy.initial_delivery_mode
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
            .filter(|v| valid_native_id(v));
        if result.get("harness").and_then(Value::as_str) != Some(self.policy.harness.as_str())
            || id.is_none()
        {
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
            || plan.mode != self.policy.initial_delivery_mode
            || plan.expected_turn.is_some()
            || message.is_empty()
            || key.0.is_empty()
        {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "invalid AHAP initial delivery request".into(),
            });
        }
        let options = match self.policy.initial_delivery_mode {
            SendMode::Start => {
                json!({"message":message,"queue":false,"start":true,"activeTurnOnly":true,"inputId":key.0})
            }
            SendMode::Queue => {
                json!({"message":message,"queue":true,"activeTurnOnly":true,"inputId":key.0})
            }
            SendMode::Current => unreachable!("constructor rejects Current as initial delivery"),
        };
        let result = self
            .client
            .call(
                "sendMessage",
                json!({"id":plan.target.native_session_id,"options":options}),
            )
            .map_err(transport_failure)?;
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
            .filter(|s| valid_native_id(s));
        if !admitted || id.is_none() {
            return Err(SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "native input receipt unavailable or invalid".into(),
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
            || result.get("harness").and_then(Value::as_str) != Some(self.policy.harness.as_str())
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
                name: match self.policy.initial_delivery_mode {
                    SendMode::Start => "deliver.start",
                    SendMode::Queue => "deliver.queue",
                    SendMode::Current => {
                        unreachable!("constructor rejects Current as initial delivery")
                    }
                }
                .into(),
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
        if !self.matches(&receipt.target) || !valid_native_id(&receipt.native_id) {
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
        setup_with_policy(mode, "opencode", SendMode::Start, "sesABC").unwrap()
    }
    fn setup_with_policy(
        mode: &str,
        harness: &str,
        initial_delivery_mode: SendMode,
        session_id: &str,
    ) -> Result<(Temp, AhapOpenCode), RegistryUnavailable> {
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
harness=os.environ['AHAP_HARNESS'];session=os.environ['SESSION_ID'];native_id=os.environ['NATIVE_ID']
for line in sys.stdin:
 r=json.loads(line);m=r['method'];p=r.get('params',{})
 with open(os.environ['TRACE'],'a') as f:f.write(m+'\n')
 if m=='initialize':v={'harness':harness,'capabilities':{'methods':['createSession','sendMessage','getSession','getSessionMessages']}}
 elif m=='createSession':v={'id':session,'harness':harness}
 elif m=='getSession':v={'id':session,'harness':harness,'status':'idle'}
 elif m=='sendMessage':
  assert p['id']==session and p['options']['activeTurnOnly'] and p['options']['inputId']=='key'
  if harness=='opencode':assert p['options']['start'] and p['options']['queue'] is False
  else:assert p['options']['queue'] is True and 'start' not in p['options']
  if os.environ['MODE']=='runner_receipt':v={'ok':True,'admitted':True,'pending':True,'inputId':'agent-herder:auto:key'}
  elif os.environ['MODE']=='missing':v={'ok':True,'admitted':True}
  else:v={'ok':True,'admitted':True,'nativeInputMessageId':native_id}
 elif m=='getSessionMessages':
  v=[{'id':native_id,'role':'user','text':'hi','inputId':'key'}]
  if os.environ['MODE']=='duplicate':v.append({'id':native_id,'role':'assistant','text':'ambiguous'})
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
            harness: harness.into(),
            executable: fs::canonicalize("/usr/bin/python3").unwrap(),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: dir.clone(),
            env: vec![
                (
                    "TRACE".into(),
                    dir.join("trace").to_string_lossy().into_owned(),
                ),
                ("MODE".into(), mode.into()),
                ("SESSION_ID".into(), session_id.into()),
                (
                    "NATIVE_ID".into(),
                    if harness == "opencode" {
                        "msg_ABC"
                    } else {
                        "native/message:β"
                    }
                    .into(),
                ),
            ],
            timeout: Duration::from_secs(3),
        })
        .unwrap();
        let b = AhapOpenCode::new_with_policy(
            Arc::new(client),
            instance,
            dir.clone(),
            "fixture".into(),
            AhapPortPolicy {
                harness: harness.into(),
                initial_delivery_mode,
            },
        );
        b.map(|port| (Temp(dir), port))
    }
    #[tokio::test]
    async fn exact_start_receipt_and_native_readback() {
        let (f, b) = setup("success");
        let a = b.create_root_bounded("create", "prompt").unwrap();
        assert_eq!(b.initial_delivery_mode(), SendMode::Start);
        let snapshot = b.snapshot(&a).await.unwrap();
        assert_eq!(snapshot.activity, SessionActivity::Idle);
        let plan = crate::domain::adapter::decide_send(
            &snapshot,
            &crate::domain::adapter::SendCommand {
                mode: SendMode::Start,
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
            mode: SendMode::Start,
            expected_turn: None,
        };
        assert!(matches!(
            b.submit_bounded(wrong, "hi", &RequestKey("key".into())),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        a.instance = b.instance.clone();
        let p = DispatchPlan {
            target: a,
            mode: SendMode::Start,
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

    #[tokio::test]
    async fn zcode_queue_uses_opaque_ids_and_runner_receipt_stays_unknown_once() {
        let (f, b) = setup_with_policy(
            "runner_receipt",
            "zcode",
            SendMode::Queue,
            "session:opaque/β",
        )
        .unwrap();
        assert_eq!(b.client.harness(), "zcode");
        assert_eq!(b.initial_delivery_mode(), SendMode::Queue);

        let address = b.create_root_bounded("create", "prompt").unwrap();
        assert_eq!(address.native_session_id, "session:opaque/β");
        let snapshot = b.snapshot(&address).await.unwrap();
        assert_eq!(snapshot.capabilities[0].name, "deliver.queue");
        let mut wrong_mode = crate::domain::adapter::decide_send(
            &snapshot,
            &crate::domain::adapter::SendCommand {
                mode: SendMode::Queue,
            },
        )
        .unwrap();
        wrong_mode.mode = SendMode::Start;
        assert!(matches!(
            b.submit_bounded(wrong_mode, "hi", &RequestKey("key".into())),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));

        let plan = crate::domain::adapter::decide_send(
            &snapshot,
            &crate::domain::adapter::SendCommand {
                mode: SendMode::Queue,
            },
        )
        .unwrap();
        assert!(matches!(
            b.submit_bounded(plan, "hi", &RequestKey("key".into())),
            Err(SubmitError::OutcomeUnknown { .. })
        ));

        let readback = NativeReceipt {
            target: address,
            native_id: "native/message:β".into(),
        };
        assert!(matches!(
            b.reconcile(&readback).await.unwrap(),
            Observation::Confirmed { .. }
        ));
        drop(b);
        let trace = fs::read_to_string(f.0.join("trace")).unwrap();
        assert_eq!(trace.lines().filter(|m| *m == "sendMessage").count(), 1);
    }

    #[test]
    fn configured_harness_and_instance_must_match_verified_client() {
        let (f, b) =
            setup_with_policy("success", "zcode", SendMode::Queue, "session:opaque").unwrap();
        let opencode_policy = AhapPortPolicy {
            harness: "opencode".into(),
            initial_delivery_mode: SendMode::Start,
        };
        assert!(
            AhapOpenCode::new_with_policy(
                b.client.clone(),
                b.instance.clone(),
                b.cwd.clone(),
                b.name.clone(),
                opencode_policy,
            )
            .is_err()
        );
        let mut other_instance = b.instance.clone();
        other_instance.instance_id = "other-profile".into();
        assert!(
            AhapOpenCode::new_with_policy(
                b.client.clone(),
                other_instance,
                b.cwd.clone(),
                b.name.clone(),
                b.policy.clone(),
            )
            .is_err()
        );
        drop(b);
        assert_eq!(
            fs::read_to_string(f.0.join("trace"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn native_ids_are_opaque_bounded_and_control_free() {
        assert!(valid_native_id("session:opaque/β"));
        assert!(valid_native_id("native/message:β"));
        assert!(!valid_native_id(""));
        assert!(!valid_native_id(&"x".repeat(4097)));
        assert!(!valid_native_id("session\nforged"));
    }
}
