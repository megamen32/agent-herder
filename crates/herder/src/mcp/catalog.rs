//! Strict v1 tool catalog and typed input dispatch. No operation is executed here.
use crate::domain::resource::{Attachment, ResourceKind, ResourceRef, ResourceScope};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// Discovery and input dispatch both come from this declaration. Dispatch only
// parses and classifies requests; it never executes an operation.
macro_rules! catalog {
    ($( $name:literal => $variant:ident($ty:ty) { read: [$($read:literal),* $(,)?], mutate: [$($write:literal),* $(,)?] } ),* $(,)?) => {
        pub const TOOL_NAMES: [&str; 14] = [$($name),*];
        #[derive(Debug, Clone, PartialEq)]
        pub enum Request { $($variant($ty)),* }
        pub fn discovery() -> Vec<ToolDefinition> {
            vec![$(ToolDefinition { name: $name, input_schema: serde_json::to_value(schemars::schema_for!($ty)).expect("schema serializes") }),*]
        }
        pub fn dispatch(name: &str, input: serde_json::Value) -> Result<Dispatched, DispatchError> {
            let action = input.get("action").and_then(|v| v.as_str()).map(str::to_owned);
            match name {
                $($name => {
                    let request = serde_json::from_value::<$ty>(input)
                        .map(Request::$variant).map_err(DispatchError::InvalidInput)?;
                    let access = match action.as_deref() {
                        $(Some($read) => Access::Read,)*
                        $(Some($write) => Access::Mutate,)*
                        _ => return Err(DispatchError::UnclassifiedAction),
                    };
                    Ok(Dispatched { request, access })
                }),*,
                _ => Err(DispatchError::UnknownTool),
            }
        }
    };
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub input_schema: serde_json::Value,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Mutate,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Dispatched {
    pub request: Request,
    pub access: Access,
}
#[derive(Debug)]
pub enum DispatchError {
    UnknownTool,
    InvalidInput(serde_json::Error),
    UnclassifiedAction,
}

catalog! {
    "discover" => Discover(Discover) { read: ["nodes", "instances", "models", "projects"], mutate: [] },
    "sessions" => Sessions(Sessions) { read: ["list"], mutate: [] },
    "session" => Session(Session) { read: ["recent", "context", "messages"], mutate: [] },
    "create" => Create(Create) { read: [], mutate: ["create"] },
    "deliver" => Deliver(Deliver) { read: [], mutate: ["session", "reply_to"] },
    "resume" => Resume(Resume) { read: [], mutate: ["resume"] },
    "stop" => Stop(Stop) { read: [], mutate: ["stop"] },
    "search" => Search(Search) { read: ["search"], mutate: [] },
    "export" => Export(Export) { read: ["export"], mutate: [] },
    "automation" => Automation(Automation) { read: ["list", "get"], mutate: ["create", "update", "pause", "delete"] },
    "resource" => Resource(Resource) { read: ["list", "get"], mutate: ["register", "update", "claim", "renew", "release", "declare"] },
    "configure" => Configure(Configure) { read: ["get"], mutate: ["set"] },
    "permission" => Permission(Permission) { read: ["get"], mutate: ["respond"] },
    "human_request" => HumanRequest(HumanRequest) { read: [], mutate: ["create"] },
}

// Schema mirrors for domain types owned outside the MCP module. Serde remains
// the dispatch authority; conformance tests cover the mirrored representations.
#[allow(dead_code)]
mod domain_schema {
    use schemars::JsonSchema;
    #[derive(JsonSchema)]
    #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    pub enum Scope {
        Global,
        Project { project_ref: String },
        Node { node_ref: String },
    }
    #[derive(JsonSchema)]
    #[serde(
        tag = "type",
        content = "name",
        rename_all = "snake_case",
        deny_unknown_fields
    )]
    pub enum Kind {
        Workspace,
        Deployment,
        Device,
        Plan,
        Other(String),
    }
    #[derive(JsonSchema)]
    #[serde(rename_all = "snake_case")]
    pub enum Availability {
        Available,
        Unavailable,
        Unknown,
    }
    #[derive(JsonSchema)]
    #[serde(deny_unknown_fields)]
    pub struct Attachment {
        node_ref: String,
        route_ref: Option<String>,
        availability: Availability,
        observed_at: String,
    }
}
macro_rules! schema_as {
    ($actual:ty => $mirror:ty) => {
        impl schemars::JsonSchema for $actual {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                <$mirror as schemars::JsonSchema>::schema_name()
            }
            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                <$mirror as schemars::JsonSchema>::json_schema(generator)
            }
        }
    };
}
schema_as!(ResourceRef => String);
schema_as!(ResourceScope => domain_schema::Scope);
schema_as!(ResourceKind => domain_schema::Kind);
schema_as!(Attachment => domain_schema::Attachment);

macro_rules! actions {
    ($name:ident { $($variant:ident $( { $($field:ident : $ty:ty),* $(,)? } )?),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
        pub enum $name { $($variant $( { $($field: $ty),* } )?),* }
    };
}

actions!(Discover {
    Nodes {},
    Instances { node_ref: Option<String> },
    Models { instance_ref: String },
    Projects { instance_ref: Option<String> },
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Common,
    Native,
}
actions!(Export { Export { session_ref: String, format: ExportFormat } });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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
    fn discovery_and_dispatch_agree_on_all_action_branches() {
        // Each declared action gets an input that must deserialize and carry the
        // intended access class; the schema must expose exactly those actions.
        let cases = [
            ("discover", json!({"action":"nodes"}), Access::Read),
            ("discover", json!({"action":"instances"}), Access::Read),
            ("discover", json!({"action":"projects","instance_ref":"i"}), Access::Read),
            (
                "discover",
                json!({"action":"models","instance_ref":"i"}),
                Access::Read,
            ),
            ("sessions", json!({"action":"list"}), Access::Read),
            (
                "session",
                json!({"action":"recent","session_ref":"s"}),
                Access::Read,
            ),
            ("session", json!({"action":"context"}), Access::Read),
            (
                "session",
                json!({"action":"messages","session_ref":"s"}),
                Access::Read,
            ),
            (
                "create",
                json!({"action":"create","instance_ref":"i","prompt":"p","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "deliver",
                json!({"action":"session","session_ref":"s","message":"m","mode":"current","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "deliver",
                json!({"action":"reply_to","reply_to":"r","message":"m","mode":"queue","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "resume",
                json!({"action":"resume","session_ref":"s","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "stop",
                json!({"action":"stop","session_ref":"s","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "search",
                json!({"action":"search","query":"q"}),
                Access::Read,
            ),
            (
                "export",
                json!({"action":"export","session_ref":"s","format":"common"}),
                Access::Read,
            ),
            (
                "automation",
                json!({"action":"list","session_ref":"s"}),
                Access::Read,
            ),
            (
                "automation",
                json!({"action":"get","rule_ref":"r"}),
                Access::Read,
            ),
            (
                "automation",
                json!({"action":"create","session_ref":"s","rule":{"kind":"autopilot","instructions":"i"},"request_key":"k"}),
                Access::Mutate,
            ),
            (
                "automation",
                json!({"action":"update","rule_ref":"r","revision":1,"rule":{"kind":"autopilot","instructions":"i"}}),
                Access::Mutate,
            ),
            (
                "automation",
                json!({"action":"pause","rule_ref":"r","revision":1}),
                Access::Mutate,
            ),
            (
                "automation",
                json!({"action":"delete","rule_ref":"r","revision":1}),
                Access::Mutate,
            ),
            ("resource", json!({"action":"list"}), Access::Read),
            (
                "resource",
                json!({"action":"get","resource_ref":"r"}),
                Access::Read,
            ),
            (
                "resource",
                json!({"action":"register","resource_ref":"r","scope":{"type":"global"},"kind":{"type":"device"},"external_ref":"e","authority_ref":"a"}),
                Access::Mutate,
            ),
            (
                "resource",
                json!({"action":"update","resource_ref":"r","revision":1,"scope":{"type":"global"},"kind":{"type":"device"},"external_ref":"e"}),
                Access::Mutate,
            ),
            (
                "resource",
                json!({"action":"claim","resource_ref":"r","purpose":"p","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "resource",
                json!({"action":"renew","resource_ref":"r","claim_id":"c","expires_at":"t"}),
                Access::Mutate,
            ),
            (
                "resource",
                json!({"action":"release","resource_ref":"r","claim_id":"c"}),
                Access::Mutate,
            ),
            (
                "resource",
                json!({"action":"declare","resource_ref":"r","declaration":{"operation":"remove","declaration_ref":"d"}}),
                Access::Mutate,
            ),
            (
                "configure",
                json!({"action":"get","target":{"type":"node","node_ref":"n"},"key":"k"}),
                Access::Read,
            ),
            (
                "configure",
                json!({"action":"set","target":{"type":"node","node_ref":"n"},"key":"k","value":true,"revision":1}),
                Access::Mutate,
            ),
            (
                "permission",
                json!({"action":"get","permission_ref":"p"}),
                Access::Read,
            ),
            (
                "permission",
                json!({"action":"respond","permission_ref":"p","decision":"allow","request_key":"k"}),
                Access::Mutate,
            ),
            (
                "human_request",
                json!({"action":"create","session_ref":"s","question":"q","request_key":"k"}),
                Access::Mutate,
            ),
        ];
        let tools = discovery();
        assert_eq!(tools.len(), 14);
        for tool in &tools {
            let branches = tool.input_schema["oneOf"].as_array().expect(tool.name);
            let mut advertised = std::collections::BTreeSet::new();
            for branch in branches {
                assert_eq!(
                    branch["additionalProperties"], false,
                    "{}: {branch}",
                    tool.name
                );
                assert!(
                    branch["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("action"))
                );
                advertised.insert(
                    branch["properties"]["action"]["const"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                );
            }
            let expected: std::collections::BTreeSet<_> = cases
                .iter()
                .filter(|(name, _, _)| *name == tool.name)
                .map(|(_, value, _)| value["action"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(advertised, expected, "{}", tool.name);
        }
        for (name, value, access) in cases {
            let schema = &tools
                .iter()
                .find(|tool| tool.name == name)
                .unwrap()
                .input_schema;
            let validator = jsonschema::validator_for(schema).unwrap();
            assert!(
                validator.is_valid(&value),
                "schema rejected {name}: {value}"
            );
            let result = dispatch(name, value.clone()).unwrap();
            assert_eq!(result.access, access, "{name}: {value}");
            let mut legacy = value.clone();
            legacy["workspace"] = json!("old");
            assert!(
                !validator.is_valid(&legacy),
                "schema accepted legacy field {name}: {legacy}"
            );
            assert!(
                matches!(dispatch(name, legacy), Err(DispatchError::InvalidInput(_))),
                "dispatch accepted legacy field {name}"
            );
            let mut invalid = value;
            invalid["unexpected"] = json!(true);
            assert!(
                !validator.is_valid(&invalid),
                "schema accepted {name}: {invalid}"
            );
            assert!(
                matches!(dispatch(name, invalid), Err(DispatchError::InvalidInput(_))),
                "{name}"
            );
        }
        assert!(matches!(
            dispatch("missing", json!({})),
            Err(DispatchError::UnknownTool)
        ));
        assert!(matches!(
            dispatch("workspace", json!({"action":"list"})),
            Err(DispatchError::UnknownTool)
        ));
    }
    #[test]
    fn independent_schema_validator_agrees_with_dispatch_on_nested_extra_fields() {
        let cases = [
            (
                "resource",
                json!({"action":"list","scope":{"type":"global"}}),
                "/scope",
            ),
            (
                "resource",
                json!({"action":"list","scope":{"type":"project","project_ref":"p"}}),
                "/scope",
            ),
            (
                "resource",
                json!({"action":"list","scope":{"type":"node","node_ref":"n"}}),
                "/scope",
            ),
            (
                "resource",
                json!({"action":"list","kind":{"type":"device"}}),
                "/kind",
            ),
            (
                "resource",
                json!({"action":"list","kind":{"type":"other","name":"x"}}),
                "/kind",
            ),
            (
                "resource",
                json!({"action":"register","resource_ref":"r","scope":{"type":"global"},"kind":{"type":"device"},"external_ref":"e","authority_ref":"a","attachment":{"node_ref":"n","availability":"available","observed_at":"t"}}),
                "/attachment",
            ),
            (
                "resource",
                json!({"action":"declare","resource_ref":"r","declaration":{"operation":"remove","declaration_ref":"d"}}),
                "/declaration",
            ),
            (
                "resource",
                json!({"action":"declare","resource_ref":"r","declaration":{"operation":"set","worktree":"w","scope":"s","purpose":"p","expires_at":"t"}}),
                "/declaration",
            ),
            (
                "automation",
                json!({"action":"create","session_ref":"s","rule":{"kind":"schedule","expression":"*","timezone":"UTC"},"request_key":"k"}),
                "/rule",
            ),
            (
                "automation",
                json!({"action":"create","session_ref":"s","rule":{"kind":"autopilot","instructions":"i"},"request_key":"k"}),
                "/rule",
            ),
            (
                "configure",
                json!({"action":"get","target":{"type":"node","node_ref":"n"},"key":"k"}),
                "/target",
            ),
            (
                "configure",
                json!({"action":"get","target":{"type":"instance","instance_ref":"i"},"key":"k"}),
                "/target",
            ),
            (
                "configure",
                json!({"action":"get","target":{"type":"session","session_ref":"s"},"key":"k"}),
                "/target",
            ),
        ];
        let tools = discovery();
        for (name, mut value, pointer) in cases {
            let schema = &tools
                .iter()
                .find(|tool| tool.name == name)
                .unwrap()
                .input_schema;
            let validator = jsonschema::validator_for(schema).unwrap();
            assert!(
                validator.is_valid(&value),
                "schema rejected {name}: {value}"
            );
            assert!(
                dispatch(name, value.clone()).is_ok(),
                "dispatch rejected {name}: {value}"
            );
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unexpected".into(), json!(true));
            assert!(
                !validator.is_valid(&value),
                "schema accepted {name}: {value}"
            );
            assert!(
                matches!(
                    dispatch(name, value.clone()),
                    Err(DispatchError::InvalidInput(_))
                ),
                "dispatch accepted {name}: {value}"
            );
        }
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
