//! Pure parsing for the finite `configure/set` request contract.
//!
//! Parsing does not establish support, inspect capabilities, access storage,
//! or apply a setting. The next application layer owns those decisions.
use crate::{
    domain::address::{NodeRef, SessionRef},
    mcp::catalog::SettingTarget,
};
use serde_json::Value;

pub const NODE_ENDPOINT_CAPABILITY: &str = "configure.node.endpoint";
pub const INSTANCE_ENDPOINT_CAPABILITY: &str = "configure.instance.endpoint";
pub const SESSION_MODEL_CAPABILITY: &str = "configure.session.model";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingTargetRef {
    Node(NodeRef),
    /// The wire reference is preserved exactly. Resolving it to a configured
    /// node/instance belongs to the trusted application boundary.
    Instance(String),
    Session(SessionRef),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingPatch {
    NodeEndpoint { endpoint: String },
    InstanceEndpoint { endpoint: Option<String> },
    SessionModel { model_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSettingPatch {
    pub target: SettingTargetRef,
    pub patch: SettingPatch,
    pub revision: u64,
    pub required_capability: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsPatchError {
    pub field: String,
    pub expected: String,
    pub correction: String,
}

/// Parse one `configure/set` payload without I/O or policy side effects.
/// Unsupported target/key pairs and malformed values are rejected with
/// value-free diagnostics. Accepted strings are preserved byte-for-byte.
pub fn parse_patch(
    target: SettingTarget,
    key: &str,
    value: Value,
    revision: u64,
) -> Result<ParsedSettingPatch, SettingsPatchError> {
    match target {
        SettingTarget::Node { node_ref } => {
            require_identifier("target.node_ref", &node_ref, "non-empty node reference")?;
            if key != "endpoint" {
                return Err(unsupported_key("node", "endpoint"));
            }
            let endpoint = required_string(
                "value",
                value,
                "non-empty string",
                "Provide a non-empty endpoint string.",
            )?;
            Ok(ParsedSettingPatch {
                target: SettingTargetRef::Node(NodeRef(node_ref)),
                patch: SettingPatch::NodeEndpoint { endpoint },
                revision,
                required_capability: NODE_ENDPOINT_CAPABILITY,
            })
        }
        SettingTarget::Instance { instance_ref } => {
            require_identifier(
                "target.instance_ref",
                &instance_ref,
                "non-empty instance reference",
            )?;
            if key != "endpoint" {
                return Err(unsupported_key("instance", "endpoint"));
            }
            let endpoint = optional_string(
                "value",
                value,
                "non-empty string or null",
                "Provide a non-empty endpoint string or null to clear the explicit endpoint.",
            )?;
            Ok(ParsedSettingPatch {
                target: SettingTargetRef::Instance(instance_ref),
                patch: SettingPatch::InstanceEndpoint { endpoint },
                revision,
                required_capability: INSTANCE_ENDPOINT_CAPABILITY,
            })
        }
        SettingTarget::Session { session_ref } => {
            require_identifier(
                "target.session_ref",
                &session_ref,
                "non-empty session reference",
            )?;
            if key != "model" {
                return Err(unsupported_key("session", "model"));
            }
            let model_id = required_string(
                "value",
                value,
                "non-empty native model ID string",
                "Provide the exact model ID from this session's instance catalog.",
            )?;
            Ok(ParsedSettingPatch {
                target: SettingTargetRef::Session(SessionRef(session_ref)),
                patch: SettingPatch::SessionModel { model_id },
                revision,
                required_capability: SESSION_MODEL_CAPABILITY,
            })
        }
    }
}

fn require_identifier(field: &str, value: &str, expected: &str) -> Result<(), SettingsPatchError> {
    if value.trim().is_empty() {
        return Err(SettingsPatchError {
            field: field.into(),
            expected: expected.into(),
            correction: "Provide the exact non-empty target reference.".into(),
        });
    }
    Ok(())
}

fn required_string(
    field: &str,
    value: Value,
    expected: &str,
    correction: &str,
) -> Result<String, SettingsPatchError> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(SettingsPatchError {
            field: field.into(),
            expected: expected.into(),
            correction: correction.into(),
        }),
    }
}

fn optional_string(
    field: &str,
    value: Value,
    expected: &str,
    correction: &str,
) -> Result<Option<String>, SettingsPatchError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) if !value.trim().is_empty() => Ok(Some(value)),
        _ => Err(SettingsPatchError {
            field: field.into(),
            expected: expected.into(),
            correction: correction.into(),
        }),
    }
}

fn unsupported_key(target: &str, allowed: &str) -> SettingsPatchError {
    SettingsPatchError {
        field: "key".into(),
        expected: format!("{allowed} for {target} target"),
        correction: format!("Use the supported {target} key {allowed:?}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_three_configure_contract_patches() {
        let node = parse_patch(
            SettingTarget::Node {
                node_ref: "node-a".into(),
            },
            "endpoint",
            Value::String(" https://node.example/mcp ".into()),
            7,
        )
        .unwrap();
        assert_eq!(
            node.target,
            SettingTargetRef::Node(NodeRef("node-a".into()))
        );
        assert_eq!(
            node.patch,
            SettingPatch::NodeEndpoint {
                endpoint: " https://node.example/mcp ".into()
            }
        );
        assert_eq!(node.revision, 7);
        assert_eq!(node.required_capability, NODE_ENDPOINT_CAPABILITY);

        let instance = parse_patch(
            SettingTarget::Instance {
                instance_ref: "node-a/instance-1".into(),
            },
            "endpoint",
            Value::Null,
            11,
        )
        .unwrap();
        assert_eq!(
            instance.target,
            SettingTargetRef::Instance("node-a/instance-1".into())
        );
        assert_eq!(
            instance.patch,
            SettingPatch::InstanceEndpoint { endpoint: None }
        );
        assert_eq!(instance.revision, 11);
        assert_eq!(instance.required_capability, INSTANCE_ENDPOINT_CAPABILITY);

        let session = parse_patch(
            SettingTarget::Session {
                session_ref: "session-x".into(),
            },
            "model",
            Value::String("vendor/model:exact-id".into()),
            19,
        )
        .unwrap();
        assert_eq!(
            session.target,
            SettingTargetRef::Session(SessionRef("session-x".into()))
        );
        assert_eq!(
            session.patch,
            SettingPatch::SessionModel {
                model_id: "vendor/model:exact-id".into()
            }
        );
        assert_eq!(session.revision, 19);
        assert_eq!(session.required_capability, SESSION_MODEL_CAPABILITY);
    }

    #[test]
    fn rejects_unknown_keys_and_wrong_types_without_echoing_values() {
        for (target, key, value, expected) in [
            (
                SettingTarget::Node {
                    node_ref: "node-a".into(),
                },
                "secret_ref",
                Value::String("private-secret-ref".into()),
                "endpoint for node target",
            ),
            (
                SettingTarget::Instance {
                    instance_ref: "instance-a".into(),
                },
                "runtime_cwd",
                Value::String("/tmp/new-path".into()),
                "endpoint for instance target",
            ),
            (
                SettingTarget::Session {
                    session_ref: "session-a".into(),
                },
                "permission_mode",
                Value::String("unsafe-mode".into()),
                "model for session target",
            ),
        ] {
            let error = parse_patch(target, key, value, 1).unwrap_err();
            assert_eq!(error.field, "key");
            assert_eq!(error.expected, expected);
            assert!(!error.correction.contains("private-secret-ref"));
            assert!(!error.correction.contains("/tmp/new-path"));
            assert!(!error.correction.contains("unsafe-mode"));
        }

        let error = parse_patch(
            SettingTarget::Node {
                node_ref: "node-a".into(),
            },
            "endpoint",
            Value::Number(42.into()),
            1,
        )
        .unwrap_err();
        assert_eq!(error.field, "value");
        assert_eq!(error.expected, "non-empty string");
        assert!(!error.correction.contains("42"));

        let error = parse_patch(
            SettingTarget::Instance {
                instance_ref: "instance-a".into(),
            },
            "endpoint",
            Value::String("  \t".into()),
            1,
        )
        .unwrap_err();
        assert_eq!(error.expected, "non-empty string or null");
    }

    #[test]
    fn rejects_empty_targets_and_does_not_claim_capability_support() {
        let error = parse_patch(
            SettingTarget::Session {
                session_ref: "  ".into(),
            },
            "model",
            Value::String("model-id".into()),
            0,
        )
        .unwrap_err();
        assert_eq!(error.field, "target.session_ref");
        assert_eq!(error.expected, "non-empty session reference");

        let parsed = parse_patch(
            SettingTarget::Session {
                session_ref: "session-a".into(),
            },
            "model",
            Value::String("model-id".into()),
            0,
        )
        .unwrap();
        assert_eq!(parsed.required_capability, "configure.session.model");
        // There is deliberately no supported/applied boolean in this pure DTO.
    }
}
