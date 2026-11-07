//! Safe, structured diagnostics. Constructors never retain arbitrary request values.
use crate::domain::adapter::SendMode;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    None,
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Retry {
    /// The identical rejected request may be retried with its original key.
    /// A changed payload needs a new key if the original intent was recorded.
    SafeSameKey,
    ReadReceipt,
    Forbidden,
}

/// A suggested field value, never an instruction to modify or replay a call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fix {
    pub mode: &'static str,
}

/// Values are constructed from known literals, never from user-supplied strings.
/// Receipt and diagnostic references must be server-issued opaque, non-secret IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub code: &'static str,
    pub field: Option<&'static str>,
    pub received: Option<&'static str>,
    pub expected: Option<Vec<&'static str>>,
    pub fix: Option<Fix>,
    pub effect: Effect,
    pub retry: Retry,
    pub receipt_ref: Option<String>,
    pub diagnostic_ref: Option<String>,
}

fn mode_name(mode: SendMode) -> &'static str {
    match mode {
        SendMode::Current => "current",
        SendMode::Queue => "queue",
        SendMode::Start => "start",
    }
}

impl Diagnostic {
    /// Call only after the requested mode is proven unsupported, before dispatch.
    /// A suggestion requires one distinct supported alternative; it is conditional
    /// on the caller wanting that behavior and is never applied automatically.
    pub fn wrong_mode(received: SendMode, supported: &[SendMode]) -> Self {
        let mut expected = Vec::new();
        for &mode in supported {
            let name = mode_name(mode);
            if !expected.contains(&name) {
                expected.push(name);
            }
        }
        let fix = match expected.as_slice() {
            [only] if *only != mode_name(received) => Some(Fix { mode: only }),
            _ => None,
        };
        Self {
            code: "unsupported_mode",
            field: Some("mode"),
            received: Some(mode_name(received)),
            expected: Some(expected),
            fix,
            effect: Effect::None,
            retry: Retry::SafeSameKey,
            receipt_ref: None,
            diagnostic_ref: None,
        }
    }

    /// Explicit target and reply target disagree. Neither value is safe to echo;
    /// only the caller can decide which target was intended.
    pub fn reply_to_conflict(_target: &str, _reply_to: &str) -> Self {
        Self {
            code: "reply_to_conflict",
            field: Some("reply_to"),
            received: Some("[REDACTED]"),
            expected: Some(vec![
                "reply_to and explicit target must identify the same session",
            ]),
            fix: None,
            effect: Effect::None,
            retry: Retry::SafeSameKey,
            receipt_ref: None,
            diagnostic_ref: None,
        }
    }

    /// An unknown outcome must never be resubmitted; reconcile a known receipt.
    pub fn outcome_unknown(receipt_ref: Option<String>) -> Self {
        let retry = if receipt_ref.as_deref().is_some_and(|r| !r.is_empty()) {
            Retry::ReadReceipt
        } else {
            Retry::Forbidden
        };
        Self {
            code: "outcome_unknown",
            field: None,
            received: None,
            expected: None,
            fix: None,
            effect: Effect::Unknown,
            retry,
            receipt_ref: receipt_ref.filter(|r| !r.is_empty()),
            diagnostic_ref: None,
        }
    }
}

/// Validate resolved identities before any intent or native submission. Resolution
/// itself belongs to the caller; missing identities must not be treated as equal.
pub fn validate_reply_target(target: &str, reply_target: &str) -> Result<(), Diagnostic> {
    if target.is_empty() || reply_target.is_empty() || target != reply_target {
        return Err(Diagnostic::reply_to_conflict(target, reply_target));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::adapter::SendMode;

    #[test]
    fn wrong_mode_is_rejected_and_only_one_supported_mode_is_suggested() {
        let err = Diagnostic::wrong_mode(SendMode::Current, &[SendMode::Start]);
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["field"], "mode");
        assert_eq!(value["received"], "current");
        assert_eq!(value["effect"], "none");
        assert_eq!(value["retry"], "safe_same_key");
        assert_eq!(value["fix"]["mode"], "start");
        assert!(
            Diagnostic::wrong_mode(SendMode::Current, &[SendMode::Start, SendMode::Queue])
                .fix
                .is_none()
        );
        assert!(Diagnostic::wrong_mode(SendMode::Current, &[]).fix.is_none());
    }

    #[test]
    fn unsupported_mode_never_reaches_submit() {
        use crate::domain::adapter::{
            DecisionError, SendCommand, SessionActivity, SessionSnapshot, decide_send,
        };
        use crate::domain::address::{
            Authorization, Availability, Capability, CapabilityVersion, InstanceRef, NodeRef,
            SessionAddress, Support,
        };
        let snapshot = SessionSnapshot {
            address: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("node".into()),
                    instance_id: "instance".into(),
                },
                native_session_id: "session".into(),
            },
            human_stop: false,
            activity: SessionActivity::Idle,
            capabilities: vec![Capability {
                name: "deliver.current".into(),
                version: CapabilityVersion {
                    adapter_version: "1".into(),
                    capability_version: "1".into(),
                },
                supported: Support::Unsupported,
                available: Availability::Available,
                authorized: Authorization::Authorized,
            }],
        };
        let mut effects = 0;
        let result = decide_send(
            &snapshot,
            &SendCommand {
                mode: SendMode::Current,
            },
        )
        .map(|_| effects += 1)
        .map_err(|err| match err {
            DecisionError::UnsupportedMode(mode) => {
                Diagnostic::wrong_mode(mode, &[SendMode::Start])
            }
            other => panic!("unexpected decision: {other:?}"),
        });
        assert_eq!(effects, 0);
        assert_eq!(result.unwrap_err().effect, Effect::None);
    }

    #[test]
    fn reply_conflict_does_not_choose_a_target_or_expose_values() {
        let mut effects = 0;
        let result = validate_reply_target("secret-session", "secret-reply").map(|()| effects += 1);
        let err = result.unwrap_err();
        assert_eq!(effects, 0);
        assert!(validate_reply_target("", "").is_err());
        assert!(validate_reply_target("same", "same").is_ok());
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["field"], "reply_to");
        assert_eq!(value["effect"], "none");
        assert_eq!(value["retry"], "safe_same_key");
        assert!(value["fix"].is_null());
        assert!(!value.to_string().contains("secret-"));
        assert!(!format!("{err:?}").contains("secret-"));
    }

    #[test]
    fn unknown_outcome_requires_receipt_read_and_never_retries() {
        let err = Diagnostic::outcome_unknown(Some("receipt-1".into()));
        let value = serde_json::to_value(err).unwrap();
        assert_eq!(value["effect"], "unknown");
        assert_eq!(value["retry"], "read_receipt");
        assert_eq!(value["receipt_ref"], "receipt-1");
        let no_receipt = serde_json::to_value(Diagnostic::outcome_unknown(None)).unwrap();
        assert_eq!(no_receipt["retry"], "forbidden");
    }
}
