//! Generic client of existing TypeScript AHAP adapters (historical OpenCode name).
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
impl crate::application::scoped_stop::registration::BoundedSessionProbe for AhapOpenCode {
    fn instance(&self) -> &InstanceRef {
        &self.instance
    }
    fn harness(&self) -> &str {
        &self.policy.harness
    }
    fn probe_session(&self, native_session_id: &str) -> Result<SessionSnapshot, ()> {
        // read_snapshot verifies both id and harness through the configured,
        // account-pinned AHAP transport. No create or send is performed.
        self.read_snapshot(&SessionAddress {
            instance: self.instance.clone(),
            native_session_id: native_session_id.to_owned(),
        }).map_err(|_| ())
    }
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
    /// Unmodified initialize capabilities from this exact configured instance.
    pub fn capabilities(&self) -> &Value {
        self.client.capabilities()
    }

    /// Invoke only a method advertised by the existing TypeScript port.
    /// No retries, inferred completeness, or native protocol implementation.
    pub fn raw_call(&self, method: &str, params: Value) -> Result<Value, ReadError> {
        if !self.client.supports(method) {
            return Err(ReadError(format!("AHAP method not advertised: {method}")));
        }
        self.client
            .call(method, params)
            .map_err(|_| ReadError(format!("AHAP {method} unavailable")))
    }

    pub fn list_sessions(&self, options: Value) -> Result<Value, ReadError> {
        self.raw_call("listSessions", json!({"options": options}))
    }

    pub fn list_projects(&self) -> Result<Value, ReadError> {
        self.raw_call("listProjects", json!({}))
    }

    /// Preserve bytes_base64, complete, source, timestampCoverage and limitations.
    /// In particular, a message tail is never substituted for a raw transcript.
    pub fn raw_transcript(&self, address: &SessionAddress) -> Result<Value, ReadError> {
        if !self.matches(address) {
            return Err(ReadError("invalid AHAP session".into()));
        }
        self.raw_call("getRawTranscript", json!({"id": address.native_session_id}))
    }

    /// Confirm a lifecycle callback against the current native session snapshot.
    /// The callback's event_id is treated as a claimed native turn ID, never as
    /// proof by itself. Only an exact current turn with terminal `completed`
    /// status is accepted; idle, failed, stale, absent or mismatched evidence is
    /// a refusal.
    pub fn confirms_completed_turn(
        &self,
        address: &SessionAddress,
        event_id: &str,
    ) -> Result<bool, ReadError> {
        if !self.matches(address) || !valid_native_id(event_id) {
            return Ok(false);
        }
        let session = self.raw_call("getSession", json!({"id": address.native_session_id}))?;
        Ok(exact_completed_turn(
            &session,
            &address.native_session_id,
            &self.policy.harness,
            event_id,
        ))
    }

    fn advertises_mode(&self, mode: &str) -> bool {
        self.capabilities()
            .get("deliveryModes")
            .and_then(Value::as_array)
            .is_some_and(|modes| modes.iter().any(|value| value.as_str() == Some(mode)))
    }

    fn mutation_ready(&self) -> bool {
        [
            "init",
            "sendMessage",
            "getSession",
            "getSessionMessages",
        ]
        .iter()
        .all(|method| self.client.supports(method))
    }

    fn read_snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        if !self.matches(target) {
            return Err(ReadError("wrong instance".into()));
        }
        let result = self.raw_call("getSession", json!({"id":target.native_session_id}))?;
        if result.get("id").and_then(Value::as_str) != Some(target.native_session_id.as_str())
            || result.get("harness").and_then(Value::as_str) != Some(self.policy.harness.as_str())
        {
            return Err(ReadError("AHAP session identity mismatch".into()));
        }
        let status = result.get("status").and_then(Value::as_str);
        let human_stop = status == Some("stopped")
            || ["/humanStop", "/meta/humanStop", "/meta/automationStop"]
                .iter()
                .any(|path| result.pointer(path).and_then(Value::as_bool) == Some(true))
            || result
                .pointer("/meta/automationStop")
                .is_some_and(Value::is_object);
        let observed_status = if result
            .pointer("/meta/nativeStateObserved")
            .and_then(Value::as_bool)
            == Some(false)
        {
            None
        } else {
            status
        };
        let activity = match observed_status {
            Some("idle") => SessionActivity::Idle,
            Some("running" | "busy") if self.client.supports("getCoordinationActiveTurnId") => {
                match self
                    .raw_call(
                        "getCoordinationActiveTurnId",
                        json!({"id":target.native_session_id}),
                    )?
                    .as_str()
                    .filter(|id| valid_native_id(id))
                {
                    Some(id) => SessionActivity::Busy {
                        turn_id: id.to_owned(),
                    },
                    None => SessionActivity::Unknown,
                }
            }
            _ => SessionActivity::Unknown,
        };
        let modes = self
            .capabilities()
            .get("deliveryModes")
            .and_then(Value::as_array);
        let capabilities = [
            ("start", "sync", "deliver.start"),
            ("queue", "queue", "deliver.queue"),
            ("current", "steer", "deliver.current"),
        ]
        .into_iter()
        .map(|(mode, legacy_mode, name)| Capability {
            name: name.into(),
            version: CapabilityVersion {
                adapter_version: "legacy-ahap-0.1".into(),
                capability_version: "1".into(),
            },
            supported: match modes {
                Some(_) if self.advertises_mode(mode) || self.advertises_mode(legacy_mode) => {
                    Support::Supported
                }
                Some(_) => Support::Unsupported,
                None => Support::Unknown,
            },
            available: if self.mutation_ready() {
                Availability::Available
            } else {
                Availability::Unavailable
            },
            authorized: Authorization::Authorized,
        })
        .collect();
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop,
            activity,
            capabilities,
        })
    }

    fn matches(&self, a: &SessionAddress) -> bool {
        a.instance == self.instance && valid_native_id(&a.native_session_id)
    }
    pub fn messages(&self, a: &SessionAddress, limit: u32) -> Result<Value, ReadError> {
        if !self.matches(a) || !(1..=200).contains(&limit) {
            return Err(ReadError("invalid AHAP session".into()));
        }
        let result = self.raw_call(
            "getSessionMessages",
            json!({"id":a.native_session_id,"limit":limit}),
        )?;
        if !result.is_array() {
            return Err(ReadError("AHAP messages incomplete or unavailable".into()));
        }
        Ok(result)
    }
}

impl crate::application::scoped_stop::automation::CompletedTurnReader for AhapOpenCode {
    fn confirms_completed_turn(
        &self,
        target: &crate::domain::address::SessionAddress,
        event_id: &str,
    ) -> Result<bool, ReadError> {
        AhapOpenCode::confirms_completed_turn(self, target, event_id)
    }
}
fn exact_completed_turn(session: &Value, session_id: &str, harness: &str, event_id: &str) -> bool {
    if session.get("id").and_then(Value::as_str) != Some(session_id)
        || session.get("harness").and_then(Value::as_str) != Some(harness)
        || session.pointer("/meta/nativeStateObserved").and_then(Value::as_bool) == Some(false)
        || session.pointer("/meta/nativeTurnStateUnavailable").and_then(Value::as_bool) == Some(true)
    {
        return false;
    }
    let turn = session
        .pointer("/meta/nativeLastTurn")
        .or_else(|| session.get("nativeLastTurn"));
    turn.is_some_and(|turn| {
        turn.get("turnId").and_then(Value::as_str) == Some(event_id)
            && turn.get("status").and_then(Value::as_str) == Some("completed")
    })
}
fn valid_native_id(v: &str) -> bool {
    !v.is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control)
}

/// Positive evidence comes from native message fields, never a synthesized
/// display ID or prompt text. Prefixes are the exact ZCode automation mapping;
/// they are compared to observed native anchors, not stripped from caller IDs.
fn recovered_message_id(messages: &Value, session: &str, key: &str, harness: &str) -> Option<String> {
    if !valid_native_id(session) || !valid_native_id(key) {
        return None;
    }
    let mut accepted = vec![key.to_owned()];
    let mut automation_anchors = Vec::new();
    if harness == "zcode" {
        // The legacy writer's prefix mapping is not injective for caller keys
        // already in the native namespace. Such old requests stay UNKNOWN.
        if key.starts_with("agent-herder:auto:") || key.starts_with("queue_agent-herder:auto:") {
            return None;
        }
        let automation = format!("agent-herder:auto:{key}");
        automation_anchors.push(format!("queue_{automation}"));
        automation_anchors.push(automation);
        accepted.extend(automation_anchors.iter().cloned());
    }
    let rows = messages.as_array()?;
    if rows.len() > 200 { return None }
    let correlated = |value: &Value| value.as_str()
        .is_some_and(|id| accepted.iter().any(|expected| expected == id));
    let candidates: Vec<_> = rows.iter().filter(|row| {
        ["sourceCommandId", "inputId"].iter()
            .any(|field| row.get(*field).is_some_and(&correlated))
    }).collect();
    if candidates.len() != 1 { return None }
    let row = candidates[0];
    if row.get("role").and_then(Value::as_str) != Some("user")
        || row.get("sessionId").is_some_and(|id| id.as_str() != Some(session))
        || harness == "zcode" && !row.get("sourceCommandId").and_then(Value::as_str)
            .is_some_and(|id| automation_anchors.iter().any(|anchor| anchor == id))
        || ["sourceCommandId", "inputId"].iter()
            .any(|field| row.get(*field).is_some_and(|value| !correlated(value)))
    {
        return None;
    }
    let native_id = row.get("nativeMessageId").and_then(Value::as_str)?;
    if !valid_native_id(native_id) || row.get("id").and_then(Value::as_str) != Some(native_id) {
        return None;
    }
    Some(native_id.to_owned())
}
// This is an internal opaque reference, never a native user-message ID.
// Encode both kinds so a native ID resembling this prefix is still unambiguous.
const RECEIPT_PREFIX: &str = "ahap-receipt:v1:";
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    content = "native_id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum ReceiptReference {
    Message(String),
    Turn(String),
}
impl ReceiptReference {
    fn encode(&self) -> String {
        format!(
            "{RECEIPT_PREFIX}{}",
            serde_json::to_string(self).expect("string receipt")
        )
    }
    fn decode(value: &str) -> Result<Self, ReadError> {
        let reference = if let Some(json) = value.strip_prefix(RECEIPT_PREFIX) {
            if json.len() > 32768 {
                return Err(ReadError("invalid receipt".into()));
            }
            serde_json::from_str(json)
                .map_err(|_| ReadError("invalid typed AHAP receipt".into()))?
        } else {
            // Receipts persisted by the earlier message-only port remain readable.
            Self::Message(value.into())
        };
        let (Self::Message(id) | Self::Turn(id)) = &reference;
        if !valid_native_id(id) {
            return Err(ReadError("invalid native receipt ID".into()));
        }
        Ok(reference)
    }
}
fn transport_failure(e: AhapError) -> SubmitError {
    match e {
        AhapError::BrowserSendUnconfirmed(diagnostic) => SubmitError::BrowserOutcomeUnknown(diagnostic),
        AhapError::CodexCreateQuotaNotSubmitted => SubmitError::DefinitelyNotSent {
            reason: "Codex quota guard rejected thread/start before native submission".into(),
        },
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
        if !self.mutation_ready() || !self.client.supports("createSession") || !valid_native_id(key) {
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
        if !self.mutation_ready()
            || !self.matches(&plan.target)
            || message.is_empty()
            || !valid_native_id(&key.0)
        {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "invalid AHAP delivery request".into(),
            });
        }
        // Recheck native status and declared modes; the scoped core owns the
        // durable HumanStop/intent ledger, and the TS port owns native admission.
        let snapshot =
            self.read_snapshot(&plan.target)
                .map_err(|_| SubmitError::DefinitelyNotSent {
                    reason: "AHAP pre-admission snapshot unavailable".into(),
                })?;
        let checked = crate::domain::adapter::decide_send(
            &snapshot,
            &crate::domain::adapter::SendCommand { mode: plan.mode },
        )
        .map_err(|_| SubmitError::DefinitelyNotSent {
            reason: "AHAP mode, activity or stop guard rejected delivery".into(),
        })?;
        if checked.expected_turn != plan.expected_turn {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "AHAP native turn changed".into(),
            });
        }
        let mut options = match plan.mode {
            // The TS "sync" mode starts an idle session without the special
            // fresh-only OpenCode start flag. It is an explicit wire mapping.
            SendMode::Start if self.advertises_mode("sync") => {
                json!({"message":message,"queue":false,"activeTurnOnly":false,"inputId":key.0})
            }
            SendMode::Start => {
                json!({"message":message,"queue":false,"start":true,"activeTurnOnly":false,"inputId":key.0})
            }
            SendMode::Queue => {
                json!({"message":message,"queue":true,"activeTurnOnly":false,"inputId":key.0})
            }
            SendMode::Current => {
                json!({"message":message,"queue":false,"steer":true,"activeTurnOnly":true,"inputId":key.0})
            }
        };
        if let Some(turn) = &plan.expected_turn {
            options["expectedTurnId"] = json!(turn);
        }
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
        let correlated = result
            .get("inputId")
            .is_none_or(|v| v.as_str() == Some(key.0.as_str()))
            && result
                .get("sessionId")
                .is_none_or(|v| v.as_str() == Some(plan.target.native_session_id.as_str()))
            && result
                .get("harness")
                .is_none_or(|v| v.as_str() == Some(self.policy.harness.as_str()));
        if correlated
            && !admitted
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
            .filter(|s| valid_native_id(s))
            .map(|id| ReceiptReference::Message(id.into()).encode())
            .or_else(|| {
                // A turn ID without explicit admission is not evidence of a send.
                (result.get("admitted").and_then(Value::as_bool) == Some(true)
                    && result.get("admissionKind").and_then(Value::as_str)
                        != Some("current_turn_context"))
                .then(|| {
                    result
                        .get("turnId")
                        .and_then(Value::as_str)
                        .filter(|id| valid_native_id(id))
                        .map(|id| ReceiptReference::Turn(id.into()).encode())
                })
                .flatten()
            });
        let conflicting = result.get("notSubmitted").and_then(Value::as_bool) == Some(true)
            || result.get("admission").and_then(Value::as_str) == Some("not_submitted")
            || result.get("ok").and_then(Value::as_bool) == Some(false)
            || result.get("admitted").and_then(Value::as_bool) == Some(false)
            || !correlated;
        if !admitted || unknown || conflicting || id.is_none() {
            return Err(SubmitError::OutcomeUnknown {
                receipt: id.filter(|_| correlated).map(|native_id| NativeReceipt {
                    target: plan.target.clone(),
                    native_id: native_id.into(),
                }),
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
        self.read_snapshot(target)
    }
    async fn recover_admission(
        &self,
        target: &SessionAddress,
        key: &RequestKey,
    ) -> Result<Option<NativeReceipt>, ReadError> {
        if !self.matches(target) || !valid_native_id(&key.0) {
            return Err(ReadError("invalid admission recovery binding".into()));
        }
        let session = self.raw_call("getSession", json!({"id": target.native_session_id}))?;
        if session.get("id").and_then(Value::as_str) != Some(target.native_session_id.as_str())
            || session.get("harness").and_then(Value::as_str) != Some(self.policy.harness.as_str())
        {
            return Err(ReadError("AHAP session identity mismatch".into()));
        }
        let messages = self.messages(target, 200)?;
        Ok(recovered_message_id(&messages, &target.native_session_id, &key.0, &self.policy.harness)
            .map(|id| NativeReceipt {
                target: target.clone(),
                native_id: ReceiptReference::Message(id).encode(),
            }))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        if !self.matches(&receipt.target) {
            return Err(ReadError("invalid receipt".into()));
        }
        let message_id = match ReceiptReference::decode(&receipt.native_id)? {
            ReceiptReference::Message(id) => id,
            ReceiptReference::Turn(id) => {
                let session =
                    self.raw_call("getSession", json!({"id":receipt.target.native_session_id}))?;
                if session.get("id").and_then(Value::as_str)
                    != Some(receipt.target.native_session_id.as_str())
                    || session.get("harness").and_then(Value::as_str)
                        != Some(self.policy.harness.as_str())
                {
                    return Err(ReadError("AHAP session identity mismatch".into()));
                }
                let turn = session
                    .pointer("/meta/nativeLastTurn")
                    .or_else(|| session.get("nativeLastTurn"));
                let exact = session
                    .pointer("/meta/nativeStateObserved")
                    .and_then(Value::as_bool)
                    != Some(false)
                    && turn.and_then(|t| t.get("turnId")).and_then(Value::as_str)
                        == Some(id.as_str());
                // This confirms native admission only, not turn/task completion.
                return Ok(if exact {
                    Observation::Confirmed {
                        receipt: receipt.clone(),
                    }
                } else {
                    Observation::Unknown {
                        receipt: receipt.clone(),
                    }
                });
            }
        };
        let messages = self.messages(&receipt.target, 200)?;
        let matches: Vec<_> = messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str()))
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

    #[test]
    fn accepts_actual_codex_to_session_terminal_projection_without_synthetic_true_flag() {
        // CodexAppServerAdapter.toSession projects nativeLastTurn into meta;
        // it does not set nativeStateObserved=true on the successful path.
        let session = serde_json::json!({
            "id":"child-session",
            "harness":"codex",
            "status":"idle",
            "meta":{"nativeSessionId":"child-session","nativeLastTurn":{"turnId":"turn-7","status":"completed"}}
        });
        assert!(exact_completed_turn(&session, "child-session", "codex", "turn-7"));
        assert!(!exact_completed_turn(&session, "child-session", "codex", "turn-6"));
        assert!(!exact_completed_turn(&session, "child-session", "opencode", "turn-7"));
    }

    #[test]
    fn refuses_unavailable_or_failed_native_turn_projection() {
        let unavailable = serde_json::json!({
            "id":"child-session","harness":"codex",
            "meta":{"nativeLastTurn":{"turnId":"turn-7","status":"completed"},"nativeTurnStateUnavailable":true}
        });
        let failed_observation = serde_json::json!({
            "id":"child-session","harness":"codex",
            "meta":{"nativeLastTurn":{"turnId":"turn-7","status":"completed"},"nativeStateObserved":false}
        });
        assert!(!exact_completed_turn(&unavailable, "child-session", "codex", "turn-7"));
        assert!(!exact_completed_turn(&failed_observation, "child-session", "codex", "turn-7"));
        let idle_only = serde_json::json!({"id":"child-session","harness":"codex","status":"idle","meta":{}});
        assert!(!exact_completed_turn(&idle_only, "child-session", "codex", "turn-7"));
    }
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
 if m=='initialize':v={'harness':harness,'capabilities':{'methods':['init','sendMessage','getSession','getSessionMessages']+([] if os.environ['MODE']=='no_create' else ['createSession']),'deliveryModes':['start'] if harness=='opencode' else ['queue']}}
 elif m=='init':v=None
 elif m=='createSession':v={'id':session,'harness':harness}
 elif m=='getSession':v={'id':session,'harness':harness,'status':'idle'}
 elif m=='sendMessage':
  assert p['id']==session and p['options']['activeTurnOnly'] is False and p['options']['inputId']=='key'
  if harness=='opencode':assert p['options']['start'] and p['options']['queue'] is False
  else:assert p['options']['queue'] is True and 'start' not in p['options']
  if os.environ['MODE']=='runner_receipt':v={'ok':True,'admitted':True,'pending':True,'inputId':'agent-herder:auto:key'}
  elif os.environ['MODE']=='missing':v={'ok':True,'admitted':True}
  else:v={'ok':True,'admitted':True,'nativeInputMessageId':native_id}
 elif m=='getSessionMessages':
  v=[{'id':native_id,'role':'user','text':'hi','inputId':'key'}]
  if os.environ['MODE']=='recovery':v=[{'id':native_id,'nativeMessageId':native_id,'role':'user','sourceCommandId':'queue_agent-herder:auto:key','sessionId':session}]
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
    async fn existing_session_send_does_not_require_create_capability() {
        let (f, b) = setup("no_create");
        let a = SessionAddress { instance:b.instance.clone(), native_session_id:"sesABC".into() };
        assert!(b.create_root_bounded("create", "prompt").is_err());
        let snapshot=b.snapshot(&a).await.unwrap();
        let plan=crate::domain::adapter::decide_send(&snapshot, &crate::domain::adapter::SendCommand {mode:SendMode::Start}).unwrap();
        let receipt=b.submit_bounded(plan,"hi",&RequestKey("key".into())).unwrap();
        assert!(matches!(b.reconcile(&receipt.receipt).await.unwrap(),Observation::Confirmed{..}));
        drop(b);
        let trace=fs::read_to_string(f.0.join("trace")).unwrap();
        assert!(!trace.lines().any(|m|m=="createSession"));
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
        assert_eq!(snapshot.capabilities[1].name, "deliver.queue");
        assert_eq!(snapshot.capabilities[1].supported, Support::Supported);
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
            2
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

    #[test]
    fn recovery_requires_one_native_user_message_with_exact_session_and_key_evidence() {
        let row = json!({"id":"msg-native","nativeMessageId":"msg-native","role":"user",
            "sessionId":"session-a","sourceCommandId":"queue_agent-herder:auto:request-k"});
        let messages = json!([row.clone()]);
        assert_eq!(recovered_message_id(&messages, "session-a", "request-k", "zcode"), Some("msg-native".into()));
        assert_eq!(recovered_message_id(&messages, "session-b", "request-k", "zcode"), None);
        assert_eq!(recovered_message_id(&messages, "session-a", "other-key", "zcode"), None);
        assert_eq!(recovered_message_id(&messages, "session-a", "request-k", "opencode"), None);
        let opencode = json!([{"id":"msg-opencode","nativeMessageId":"msg-opencode","role":"user",
            "sessionId":"session-a","inputId":"request-k"}]);
        assert_eq!(recovered_message_id(&opencode, "session-a", "request-k", "opencode"), Some("msg-opencode".into()));
        assert_eq!(recovered_message_id(&opencode, "session-a", "other-key", "opencode"), None);
        assert_eq!(recovered_message_id(&json!([row.clone(), row.clone()]), "session-a", "request-k", "zcode"), None);
        for field in ["nativeMessageId", "sourceCommandId"] {
            let mut incomplete = row.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert_eq!(recovered_message_id(&json!([incomplete]), "session-a", "request-k", "zcode"), None);
        }
        let mut conflicting = row.clone();
        conflicting["inputId"] = json!("different-key");
        assert_eq!(recovered_message_id(&json!([conflicting]), "session-a", "request-k", "zcode"), None);
        let mut synthetic = row.clone();
        synthetic["id"] = json!("zcode-message-0");
        assert_eq!(recovered_message_id(&json!([synthetic]), "session-a", "request-k", "zcode"), None);
        let mut assistant = row;
        assistant["role"] = json!("assistant");
        assert_eq!(recovered_message_id(&json!([assistant]), "session-a", "request-k", "zcode"), None);
    }

    #[test]
    fn zcode_recovery_requires_automation_anchor_and_rejects_reserved_key_aliases() {
        let base = json!({"id":"msg-native","nativeMessageId":"msg-native","role":"user"});
        for fields in [
            json!({"sourceCommandId":"request-k"}),
            json!({"inputId":"request-k"}),
            json!({"inputId":"agent-herder:auto:request-k"}),
            json!({"sourceCommandId":"request-k","inputId":"request-k"}),
        ] {
            let mut row = base.clone();
            row.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            assert_eq!(recovered_message_id(&json!([row]), "session-a", "request-k", "zcode"), None);
        }
        for anchor in ["agent-herder:auto:request-k", "queue_agent-herder:auto:request-k"] {
            let mut row = base.clone();
            row["sourceCommandId"] = json!(anchor);
            row["inputId"] = json!("request-k");
            assert_eq!(recovered_message_id(&json!([row.clone()]), "session-a", "request-k", "zcode"), Some("msg-native".into()));
            row["sessionId"] = json!("other-session");
            assert_eq!(recovered_message_id(&json!([row]), "session-a", "request-k", "zcode"), None);
        }
        for key in ["agent-herder:auto:request-k", "queue_agent-herder:auto:request-k"] {
            let mut row = base.clone();
            row["sourceCommandId"] = json!(key);
            assert_eq!(recovered_message_id(&json!([row]), "session-a", key, "zcode"), None);
        }
        let key = "create-prompt:782a4a3d9263b0e2690f1847a710fd7597a48c57a9e0f04e8cf5a24dc85b672d";
        let row = json!({"id":"msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c",
            "nativeMessageId":"msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c","role":"user",
            "sessionId":"sess_bae78beb-46f1-4199-8eaa-d1a145b1833e",
            "sourceCommandId":format!("agent-herder:auto:{key}")});
        assert_eq!(recovered_message_id(&json!([row]), "sess_bae78beb-46f1-4199-8eaa-d1a145b1833e", key, "zcode"),
            Some("msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c".into()));
    }

    #[tokio::test]
    async fn zcode_lost_ack_recovery_uses_only_bounded_native_reads() {
        let (fixture, adapter) = setup_with_policy("recovery", "zcode", SendMode::Queue, "session:opaque").unwrap();
        let target = SessionAddress { instance: adapter.instance.clone(), native_session_id: "session:opaque".into() };
        let receipt = adapter.recover_admission(&target, &RequestKey("key".into())).await.unwrap().unwrap();
        assert!(matches!(ReceiptReference::decode(&receipt.native_id).unwrap(), ReceiptReference::Message(id) if id == "native/message:β"));
        assert!(matches!(adapter.reconcile(&receipt).await.unwrap(), Observation::Confirmed { .. }));
        drop(adapter);
        let trace = fs::read_to_string(fixture.0.join("trace")).unwrap();
        assert!(trace.lines().all(|method| matches!(method, "initialize" | "init" | "getSession" | "getSessionMessages")));
        assert_eq!(trace.lines().filter(|method| *method == "getSessionMessages").count(), 2);
    }
}

#[cfg(test)]
#[path = "../../../../tests/ahap_v1_reuse.rs"]
mod ahap_v1_reuse;
