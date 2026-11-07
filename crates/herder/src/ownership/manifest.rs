//! Typed storage authority and identity markers.
//! Marker reads never establish resource ownership; access still requires an
//! explicit authorization result from the trusted caller boundary.

use crate::domain::address::{Authorization, NodeRef};
use crate::domain::resource::{ResourceRef, ResourceScope, access_allowed};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

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

    /// Resolve a resource only through an explicitly local authority and after
    /// validating the storage, resource, and (for project scope) project markers.
    /// A missing marker is an invalid/unavailable authority, never a free owner.
    pub fn read_local_resource_marker(
        &self,
        resource_ref: &ResourceRef,
        authorization: Authorization,
    ) -> io::Result<(PathBuf, ResourceMarker)> {
        if !matches!(&self.route, AuthorityRoute::Local) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "authority route is not local",
            ));
        }
        if !self.root.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "authority root must be absolute",
            ));
        }
        let resource_id = safe_component(&resource_ref.0)?;
        let storage_marker: StorageMarker = read_json(&self.root.join("storage.json"))?;
        validate_marker_identity(&storage_marker.schema, &storage_marker.storage_id, self)?;

        let resource_dir = self.root.join("resources").join(resource_id);
        let marker: ResourceMarker = read_json(&resource_dir.join("resource.json"))?;
        validate_marker_identity(&marker.schema, &marker.storage_id, self)?;
        if marker.resource_ref != *resource_ref {
            return Err(invalid_data("resource marker identity does not match path"));
        }
        if !access_allowed(&marker.scope, authorization) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "resource access is not authorized",
            ));
        }

        if let ResourceScope::Project { project_ref } = &marker.scope {
            let project_id = safe_component(project_ref)?;
            let project_marker: ProjectMarker = read_json(
                &self
                    .root
                    .join("projects")
                    .join(project_id)
                    .join("project.json"),
            )?;
            validate_marker_identity(&project_marker.schema, &project_marker.storage_id, self)?;
            if project_marker.project_ref != *project_ref {
                return Err(invalid_data("project marker identity does not match path"));
            }
        }

        Ok((resource_dir, marker))
    }

    /// Read the sole owner record for a previously validated resource.
    /// `Ok(None)` means only that `owner.json` was absent while all identity
    /// markers remained valid; every other I/O or validation failure is an error.
    pub fn read_owner_bytes(
        &self,
        resource_ref: &ResourceRef,
        authorization: Authorization,
    ) -> io::Result<Option<Vec<u8>>> {
        let (resource_dir, marker) =
            self.read_local_resource_marker(resource_ref, authorization)?;
        match fs::read(resource_dir.join("owner.json")) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let (verified_dir, verified_marker) =
                    self.read_local_resource_marker(resource_ref, authorization)?;
                if verified_dir != resource_dir || verified_marker != marker {
                    return Err(invalid_data(
                        "authority identity changed while reading owner record",
                    ));
                }
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

fn validate_marker_identity(
    schema: &str,
    storage_id: &StorageId,
    authority: &StorageAuthority,
) -> io::Result<()> {
    if schema != authority.schema || storage_id != &authority.storage_id {
        return Err(invalid_data("storage marker does not match authority"));
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_data("marker JSON is invalid"))
}

fn safe_component(value: &str) -> io::Result<&str> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || value.contains('\\')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(invalid_data(
            "resource or project reference is not a path component",
        ));
    }
    Ok(value)
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
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

    #[test]
    fn local_resource_lookup_checks_storage_resource_project_and_route_markers() {
        let dir = std::env::temp_dir().join(format!(
            "herder-resource-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("resources/global")).unwrap();
        fs::create_dir_all(dir.join("resources/node")).unwrap();
        fs::create_dir_all(dir.join("resources/project")).unwrap();
        fs::create_dir_all(dir.join("projects/project-a")).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("storage-a".into()),
            authority_node: NodeRef("local-node".into()),
            root: dir.clone(),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        fs::write(
            dir.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join("projects/project-a/project.json"),
            serde_json::to_vec(&ProjectMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                project_ref: "project-a".into(),
            })
            .unwrap(),
        )
        .unwrap();

        let markers = [
            ("global", ResourceScope::Global),
            (
                "node",
                ResourceScope::Node {
                    node_ref: NodeRef("device-node".into()),
                },
            ),
            (
                "project",
                ResourceScope::Project {
                    project_ref: "project-a".into(),
                },
            ),
        ];
        for (id, scope) in markers {
            let marker = ResourceMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                resource_ref: ResourceRef(id.into()),
                scope,
            };
            fs::write(
                dir.join(format!("resources/{id}/resource.json")),
                serde_json::to_vec(&marker).unwrap(),
            )
            .unwrap();
            let (path, read) = authority
                .read_local_resource_marker(&marker.resource_ref, Authorization::Authorized)
                .unwrap();
            assert_eq!(path, dir.join(format!("resources/{id}")));
            assert_eq!(read, marker);
        }

        let global_ref = ResourceRef("global".into());
        assert_eq!(
            authority
                .read_owner_bytes(&global_ref, Authorization::Authorized)
                .unwrap(),
            None
        );
        fs::create_dir(dir.join("resources/global/owner.json")).unwrap();
        let owner_path_error = authority
            .read_owner_bytes(&global_ref, Authorization::Authorized)
            .unwrap_err();
        assert_ne!(owner_path_error.kind(), io::ErrorKind::NotFound);
        fs::remove_dir(dir.join("resources/global/owner.json")).unwrap();
        fs::write(dir.join("resources/global/owner.json"), b"owner fixture").unwrap();
        assert_eq!(
            authority
                .read_owner_bytes(&global_ref, Authorization::Authorized)
                .unwrap(),
            Some(b"owner fixture".to_vec())
        );
        fs::remove_file(dir.join("resources/global/owner.json")).unwrap();

        assert!(
            authority
                .read_local_resource_marker(
                    &ResourceRef("../outside".into()),
                    Authorization::Authorized,
                )
                .is_err()
        );
        assert_eq!(
            authority
                .read_local_resource_marker(&ResourceRef("global".into()), Authorization::Denied)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        fs::write(
            dir.join("projects/project-a/project.json"),
            serde_json::to_vec(&ProjectMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                project_ref: "other-project".into(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            authority
                .read_local_resource_marker(
                    &ResourceRef("project".into()),
                    Authorization::Authorized,
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        let remote = StorageAuthority {
            route: AuthorityRoute::Ssh {
                route_ref: "approved-route".into(),
            },
            ..authority.clone()
        };
        assert_eq!(
            remote
                .read_local_resource_marker(
                    &ResourceRef("global".into()),
                    Authorization::Authorized,
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );

        fs::write(
            dir.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: "v1".into(),
                storage_id: StorageId("wrong-storage".into()),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            authority
                .read_local_resource_marker(
                    &ResourceRef("global".into()),
                    Authorization::Authorized,
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            authority
                .read_owner_bytes(&global_ref, Authorization::Authorized)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        fs::write(
            dir.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::remove_file(dir.join("storage.json")).unwrap();
        assert_eq!(
            authority
                .read_owner_bytes(&global_ref, Authorization::Authorized)
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
