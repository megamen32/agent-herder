use serde::{Deserialize, Serialize};

/// Explicit legacy operations. These schemas expose only the documented
/// compatibility surface and cannot carry arbitrary method names or kwargs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CompatTask {
    Get { task_ref: String },
    Answer { task_ref: String, request_ref: String, answer: serde_json::Value },
    Cancel { task_ref: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CompatSkill {
    List { cursor: Option<String> },
    Get { skill_ref: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CompatChanges {
    Read { cursor: Option<String> },
    Wait { cursor: Option<String>, timeout_ms: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn helper_actions_are_strict_and_have_no_generic_dispatch() {
        assert!(serde_json::from_value::<CompatTask>(json!({"action":"get","task_ref":"t"})).is_ok());
        assert!(serde_json::from_value::<CompatTask>(json!({"action":"answer","task_ref":"t","request_ref":"r","answer":{"text":"ok"}})).is_ok());
        assert!(serde_json::from_value::<CompatTask>(json!({"action":"cancel","task_ref":"t"})).is_ok());
        assert!(serde_json::from_value::<CompatTask>(json!({"action":"execute","method":"tasks/get","kwargs":{}})).is_err());
        assert!(serde_json::from_value::<CompatTask>(json!({"action":"get","task_ref":"t","principal_ref":"root"})).is_err());
    }

}
