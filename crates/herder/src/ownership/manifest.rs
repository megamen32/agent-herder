//! Typed descriptions of the single storage authority and its identity markers.
//! These values do not read storage, grant access, or establish ownership.

use crate::domain::address::NodeRef;
use crate::domain::resource::{ResourceRef, ResourceScope};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StorageId(pub String);

/// Installation configuration. References and routes must not contain secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageAuthority {
    pub storage_id: StorageId,
    pub authority_node: NodeRef,
    pub root: PathBuf,
    pub schema: String,
    pub route: AuthorityRoute,
}

/// SSH refers to an installed route, not a shell command or credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthorityRoute {
    Local,
    Ssh { route_ref: String },
}

impl StorageAuthority {
    /// Only absolute roots identify an installation independently of cwd.
    pub fn has_absolute_root(&self) -> bool {
        self.root.is_absolute()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageMarker {
    pub schema: String,
    pub storage_id: StorageId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMarker {
    pub schema: String,
    pub storage_id: StorageId,
    pub project_ref: String,
}

/// Resource identity and scope are independent of the authority's location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceMarker {
    pub schema: String,
    pub storage_id: StorageId,
    pub resource_ref: ResourceRef,
    pub scope: ResourceScope,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn fixture_roundtrip_keeps_scopes_and_resource_identity_across_locations() {
        let dir = std::env::temp_dir().join(format!(
            "herder-manifest-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let mut authority = StorageAuthority {
            storage_id: StorageId("storage-a".into()),
            authority_node: NodeRef("node-a".into()),
            root: dir.clone(),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        assert!(authority.has_absolute_root());
        let scopes = [
            ResourceScope::Global,
            ResourceScope::Project {
                project_ref: "project-a".into(),
            },
            ResourceScope::Node {
                node_ref: NodeRef("device-node".into()),
            },
        ];
        for (i, scope) in scopes.into_iter().enumerate() {
            let marker = ResourceMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                resource_ref: ResourceRef(format!("resource-{i}")),
                scope,
            };
            let path = dir.join(format!("marker-{i}.json"));
            fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
            let read: ResourceMarker = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            authority.authority_node = NodeRef("node-b".into());
            authority.root = dir.join("new-location");
            authority.route = AuthorityRoute::Ssh {
                route_ref: "route-b".into(),
            };
            assert_eq!(read, marker);
            assert_eq!(read.storage_id, authority.storage_id);
        }
        let manifest = serde_json::to_vec(&authority).unwrap();
        assert_eq!(
            serde_json::from_slice::<StorageAuthority>(&manifest).unwrap(),
            authority
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn markers_are_distinct_and_scope_does_not_encode_authority() {
        let storage = StorageMarker {
            schema: "v1".into(),
            storage_id: StorageId("s".into()),
        };
        let project = ProjectMarker {
            schema: "v1".into(),
            storage_id: storage.storage_id.clone(),
            project_ref: "p".into(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert_eq!(
            serde_json::from_str::<ProjectMarker>(&json).unwrap(),
            project
        );
        assert!(serde_json::from_str::<StorageMarker>(&json).is_err());
        assert_eq!(
            serde_json::from_str::<ResourceScope>(r#"{"type":"global"}"#).unwrap(),
            ResourceScope::Global
        );
        let authority = StorageAuthority {
            storage_id: storage.storage_id,
            authority_node: NodeRef("n".into()),
            root: "relative".into(),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        assert!(!authority.has_absolute_root());
    }
}
