//! Node and harness instance configuration. Parsing and validation perform no I/O.
use std::{collections::HashSet, error::Error, fmt, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub local_node_id: String,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub endpoint: String,
    pub authority: Authority,
    pub instances: Vec<HarnessInstance>,
}

/// Authority is a configured identity and reference, never the secret itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authority {
    pub principal: String,
    pub secret_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessInstance {
    pub id: String,
    pub kind: HarnessKind,
    pub profile: Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessKind {
    Codex,
    OpenCode,
    ZCode,
    ChatGpt,
    Zai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub runtime_cwd: PathBuf,
    pub worktree_root: PathBuf,
    pub endpoint: Option<String>,
    pub secret_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub field: String,
    pub message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "configuration field {}: {}", self.field, self.message)
    }
}
impl Error for ConfigError {}

impl Config {
    /// Parse JSON and validate identity before the configuration is used.
    pub fn from_json(input: &str) -> Result<Self, ConfigError> {
        let mut deserializer = serde_json::Deserializer::from_str(input);
        let config: Self =
            serde_path_to_error::deserialize(&mut deserializer).map_err(|error| ConfigError {
                field: error.path().to_string(),
                message: error.inner().to_string(),
            })?;
        deserializer.end().map_err(|error| ConfigError {
            field: "$".into(),
            message: error.to_string(),
        })?;
        config.validate()?;
        Ok(config)
    }

    /// Instance IDs are unique within a node; identity includes the node ID.
    pub fn validate(&self) -> Result<(), ConfigError> {
        nonempty("local_node_id", &self.local_node_id)?;
        let mut node_ids = HashSet::new();
        for (ni, node) in self.nodes.iter().enumerate() {
            let base = format!("nodes[{ni}]");
            nonempty(&format!("{base}.id"), &node.id)?;
            if !node_ids.insert(&node.id) {
                return Err(invalid(
                    format!("{base}.id"),
                    format!("duplicate node ID {:?}", node.id),
                ));
            }
            nonempty(&format!("{base}.endpoint"), &node.endpoint)?;
            nonempty(
                &format!("{base}.authority.principal"),
                &node.authority.principal,
            )?;
            optional_nonempty(
                &format!("{base}.authority.secret_ref"),
                node.authority.secret_ref.as_deref(),
            )?;
            let mut instance_ids = HashSet::new();
            for (ii, instance) in node.instances.iter().enumerate() {
                let base = format!("{base}.instances[{ii}]");
                nonempty(&format!("{base}.id"), &instance.id)?;
                if !instance_ids.insert(&instance.id) {
                    return Err(invalid(
                        format!("{base}.id"),
                        format!(
                            "duplicate instance ID {:?} on node {:?}",
                            instance.id, node.id
                        ),
                    ));
                }
                for (name, path) in [
                    ("runtime_cwd", &instance.profile.runtime_cwd),
                    ("worktree_root", &instance.profile.worktree_root),
                ] {
                    if !path.is_absolute() {
                        return Err(invalid(
                            format!("{base}.profile.{name}"),
                            "expected an absolute path",
                        ));
                    }
                }
                optional_nonempty(
                    &format!("{base}.profile.endpoint"),
                    instance.profile.endpoint.as_deref(),
                )?;
                optional_nonempty(
                    &format!("{base}.profile.secret_ref"),
                    instance.profile.secret_ref.as_deref(),
                )?;
            }
        }
        if !node_ids.contains(&self.local_node_id) {
            return Err(invalid(
                "local_node_id",
                format!("node {:?} is not configured", self.local_node_id),
            ));
        }
        Ok(())
    }
}

fn invalid(field: impl Into<String>, message: impl Into<String>) -> ConfigError {
    ConfigError {
        field: field.into(),
        message: message.into(),
    }
}
fn nonempty(field: &str, value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        Err(invalid(field, "must not be empty"))
    } else {
        Ok(())
    }
}
fn optional_nonempty(field: &str, value: Option<&str>) -> Result<(), ConfigError> {
    if let Some(value) = value {
        nonempty(field, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture() -> Value {
        json!({
            "local_node_id": "desk",
            "nodes": [{
                "id": "desk", "endpoint": "https://desk.example.invalid/mcp",
                "authority": {"principal": "operator", "secret_ref": "vault:node"},
                "instances": [
                    {"id": "first", "kind": "codex", "profile": {
                        "runtime_cwd": "/srv/one/runtime", "worktree_root": "/data/one/trees",
                        "endpoint": "http://127.0.0.1:1001", "secret_ref": "vault:first"}},
                    {"id": "second", "kind": "codex", "profile": {
                        "runtime_cwd": "/opt/two/runtime", "worktree_root": "/var/two/trees",
                        "endpoint": "http://127.0.0.1:1002", "secret_ref": "vault:second"}}
                ]
            }]
        })
    }
    fn parse(value: &Value) -> Result<Config, ConfigError> {
        Config::from_json(&value.to_string())
    }

    #[test]
    fn two_profiles_of_same_kind_remain_independent() {
        let config = parse(&fixture()).unwrap();
        let a = &config.nodes[0].instances[0];
        let b = &config.nodes[0].instances[1];
        assert_eq!(a.kind, b.kind);
        assert_ne!(a.id, b.id);
        assert_ne!(a.profile.runtime_cwd, b.profile.runtime_cwd);
        assert_ne!(a.profile.worktree_root, b.profile.worktree_root);
        assert_ne!(a.profile.endpoint, b.profile.endpoint);
        assert_ne!(a.profile.secret_ref, b.profile.secret_ref);
        assert_eq!(
            parse(&serde_json::to_value(&config).unwrap()).unwrap(),
            config
        );
    }

    #[test]
    fn duplicate_node_and_instance_ids_report_exact_field() {
        let mut value = fixture();
        value["nodes"][0]["instances"][1]["id"] = json!("first");
        let error = parse(&value).unwrap_err();
        assert_eq!(error.field, "nodes[0].instances[1].id");
        assert!(
            error
                .to_string()
                .contains("duplicate instance ID \"first\"")
        );
        let mut value = fixture();
        let duplicate = value["nodes"][0].clone();
        value["nodes"].as_array_mut().unwrap().push(duplicate);
        let error = parse(&value).unwrap_err();
        assert_eq!(error.field, "nodes[1].id");
        assert!(error.to_string().contains("duplicate node ID \"desk\""));
    }

    #[test]
    fn instance_ids_are_scoped_to_nodes() {
        let mut value = fixture();
        let mut other = value["nodes"][0].clone();
        other["id"] = json!("remote");
        other["endpoint"] = json!("https://other.invalid/mcp");
        value["nodes"].as_array_mut().unwrap().push(other);
        assert!(parse(&value).is_ok());
    }

    #[test]
    fn invalid_fields_have_paths_and_do_not_default() {
        let mut value = fixture();
        value["nodes"][0]["instances"][1]["kind"] = json!("unsupported");
        let error = parse(&value).unwrap_err();
        assert_eq!(error.field, "nodes[0].instances[1].kind");
        assert!(error.message.contains("unknown variant"));
        let mut value = fixture();
        value["nodes"][0]["instances"][1]["profile"]["runtime_cwd"] = json!("relative");
        assert_eq!(
            parse(&value).unwrap_err().field,
            "nodes[0].instances[1].profile.runtime_cwd"
        );
        let mut value = fixture();
        value["local_node_id"] = json!("missing");
        assert_eq!(parse(&value).unwrap_err().field, "local_node_id");
        let mut value = fixture();
        value["nodes"][0]["instances"][0]["profile"]["typo"] = json!(true);
        assert!(
            parse(&value)
                .unwrap_err()
                .message
                .contains("unknown field `typo`")
        );
        assert!(Config::from_json(&(fixture().to_string() + " {} ")).is_err());
    }
}
