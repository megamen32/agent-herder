//! Strict request types for the v1 tool catalog. These types describe inputs only;
//! they do not register tools or imply that any operation is implemented.
use crate::domain::resource::{Attachment, ResourceKind, ResourceRef, ResourceScope};
use serde::{Deserialize, Serialize};

pub const TOOL_NAMES: [&str; 14] = [
    "discover",
    "sessions",
    "session",
    "create",
    "deliver",
    "resume",
    "stop",
    "search",
    "export",
    "automation",
    "resource",
    "configure",
    "permission",
    "human_request",
];

macro_rules! actions {
    ($name:ident { $($variant:ident $( { $($field:ident : $ty:ty),* $(,)? } )?),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
        pub enum $name { $($variant $( { $($field: $ty),* } )?),* }
    };
}

actions!(Discover {
    Nodes {},
    Instances { node_ref: Option<String> },
    Models { instance_ref: String },
});
actions!(Sessions {
    List { project_ref: Option<String>, node_ref: Option<String>, instance_ref: Option<String>, cursor: Option<String> },
});
actions!(Session {
    Recent { session_ref: String, cursor: Option<String> },
    Context {},
    Messages { session_ref: String, cursor: Option<String> },
});
actions!(Create {
    Create { instance_ref: String, project_ref: Option<String>, prompt: String, request_key: String },
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Current,
    Queue,
    Start,
}
actions!(Deliver {
    Session { session_ref: String, message: String, mode: DeliveryMode, request_key: String },
    ReplyTo { reply_to: String, message: String, mode: DeliveryMode, request_key: String },
});
actions!(Resume { Resume { session_ref: String, request_key: String } });
actions!(Stop { Stop { session_ref: String, request_key: String } });
actions!(Search { Search { query: String, project_ref: Option<String>, cursor: Option<String> } });
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Common,
    Native,
}
actions!(Export { Export { session_ref: String, format: ExportFormat } });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationRule {
    Schedule {
        expression: String,
        timezone: String,
    },
    Autopilot {
        instructions: String,
    },
}
actions!(Automation {
    List { session_ref: String, cursor: Option<String> },
    Get { rule_ref: String },
    Create { session_ref: String, rule: AutomationRule, request_key: String },
    Update { rule_ref: String, revision: u64, rule: AutomationRule },
    Pause { rule_ref: String, revision: u64 },
    Delete { rule_ref: String, revision: u64 },
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Declaration {
    Set {
        worktree: String,
        scope: String,
        purpose: String,
        expires_at: String,
    },
    Remove {
        declaration_ref: String,
    },
}
actions!(Resource {
    List { scope: Option<ResourceScope>, kind: Option<ResourceKind>, cursor: Option<String> },
    Get { resource_ref: ResourceRef },
    Register { resource_ref: ResourceRef, scope: ResourceScope, kind: ResourceKind, external_ref: String, authority_ref: String, attachment: Option<Attachment> },
    Update { resource_ref: ResourceRef, revision: u64, scope: ResourceScope, kind: ResourceKind, external_ref: String, attachment: Option<Attachment> },
    Claim { resource_ref: ResourceRef, purpose: String, request_key: String, expires_at: Option<String> },
    Renew { resource_ref: ResourceRef, claim_id: String, expires_at: String },
    Release { resource_ref: ResourceRef, claim_id: String },
    Declare { resource_ref: ResourceRef, declaration: Declaration },
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SettingTarget {
    Node { node_ref: String },
    Instance { instance_ref: String },
    Session { session_ref: String },
}
actions!(Configure {
    Get { target: SettingTarget, key: String },
    Set { target: SettingTarget, key: String, value: serde_json::Value, revision: u64 },
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Deny,
}
actions!(Permission {
    Get { permission_ref: String },
    Respond { permission_ref: String, decision: PermissionDecision, request_key: String },
});
actions!(HumanRequest {
    Create { session_ref: String, question: String, request_key: String },
});

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn parses<T: DeserializeOwned>(value: Value) -> bool {
        serde_json::from_value::<T>(value).is_ok()
    }

    #[test]
    fn catalog_has_exactly_fourteen_unique_names_and_no_legacy_workspace() {
        let names: std::collections::HashSet<_> = TOOL_NAMES.iter().collect();
        assert_eq!(names.len(), 14);
        assert!(names.contains(&"resource"));
        assert!(!names.contains(&"workspace"));
    }
    #[test]
    fn discriminator_required_and_unknown_fields_rejected() {
        assert!(parses::<Discover>(
            json!({"action":"models","instance_ref":"i"})
        ));
        assert!(!parses::<Discover>(json!({"instance_ref":"i"})));
        assert!(!parses::<Discover>(
            json!({"action":"models","instance_ref":"i","extra":true})
        ));
        assert!(!parses::<Session>(json!({"action":"context","self":"s"})));
        assert!(!parses::<Deliver>(
            json!({"action":"session","session_ref":"s","message":"m","mode":"implicit","request_key":"k"})
        ));
    }
    #[test]
    fn resource_actions_have_separate_strict_shapes() {
        assert!(parses::<Resource>(
            json!({"action":"get","resource_ref":"r"})
        ));
        assert!(!parses::<Resource>(
            json!({"action":"get","resource_ref":"r","claim_id":"c"})
        ));
        assert!(!parses::<Resource>(
            json!({"action":"claim","resource_ref":"r","purpose":"work"})
        ));
        assert!(parses::<Resource>(
            json!({"action":"declare","resource_ref":"r","declaration":{"operation":"set","worktree":"/w","scope":"src","purpose":"work","expires_at":"later"}})
        ));
        assert!(!parses::<Resource>(
            json!({"action":"declare","resource_ref":"r","declaration":{"operation":"remove","declaration_ref":"d","purpose":"x"}})
        ));
    }
    #[test]
    fn typed_nested_rules_and_cas_are_enforced() {
        assert!(parses::<Automation>(
            json!({"action":"create","session_ref":"s","rule":{"kind":"schedule","expression":"* * * * *","timezone":"UTC"},"request_key":"k"})
        ));
        assert!(!parses::<Automation>(
            json!({"action":"create","session_ref":"s","rule":{"kind":"schedule","expression":"* * * * *","timezone":"UTC","instructions":"x"},"request_key":"k"})
        ));
        assert!(!parses::<Configure>(
            json!({"action":"set","target":{"type":"node","node_ref":"n"},"key":"k","value":true})
        ));
    }
}
