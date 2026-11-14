//! Descriptor registry backed by the authority's resource.json files.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceDescriptor, ResourceRef, access_allowed};
use crate::ownership::manifest::{
    AuthorityRoute, ProjectMarker, ResourceMarker, StorageAuthority, StorageMarker,
};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

/// Create a descriptor or update it with compare-and-swap on its revision.
/// `expected_revision=None` creates revision 1; updates advance the exact
/// expected revision by one and preserve the resource's external identity.
pub fn register_or_update(
    authority: &StorageAuthority,
    descriptor: ResourceDescriptor,
    authorization: Authorization,
    expected_revision: Option<u64>,
) -> io::Result<ResourceDescriptor> {
    validate_authority(authority, descriptor.scope(), authorization)?;
    if descriptor.authority_ref != authority.storage_id.0 {
        return Err(invalid_input(
            "descriptor authority_ref does not match canonical storage",
        ));
    }
    let resource_id = safe_component(&descriptor.resource_ref().0)?;
    let resources_dir = authority.root.join("resources");
    let lock = open_registry_guard(&authority.root)?;
    lock.lock()?;

    fs::create_dir_all(&resources_dir)?;
    let resource_dir = resources_dir.join(resource_id);
    let resource_path = resource_dir.join("resource.json");
    let exists = resource_path.exists();
    let mut stored_descriptor = descriptor;

    if exists {
        let current = read_marker(&resource_path)?;
        validate_marker_identity(authority, &current)?;
        if current.resource_ref != *stored_descriptor.resource_ref() {
            return Err(invalid_data("resource marker identity does not match path"));
        }
        crate::ownership::migration_hold::ensure_clear(authority, stored_descriptor.resource_ref(), authorization)?;
        match (current.descriptor, expected_revision) {
            (None, None) => {
                if current.resource_ref != *stored_descriptor.resource_ref()
                    || current.scope != *stored_descriptor.scope()
                {
                    return Err(invalid_input(
                        "resource marker identity does not match descriptor",
                    ));
                }
                ensure_unique_external_identity(authority, &resources_dir, &stored_descriptor)?;
                stored_descriptor = stored_descriptor.with_revision(1);
            }
            (Some(current_descriptor), Some(expected)) => {
                if current_descriptor.revision != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "stale descriptor revision; reload and retry",
                    ));
                }
                if current_descriptor.resource_ref() != stored_descriptor.resource_ref()
                    || current_descriptor.external_ref != stored_descriptor.external_ref
                    || current_descriptor.authority_ref != stored_descriptor.authority_ref
                {
                    return Err(invalid_input("resource external identity is immutable"));
                }
                stored_descriptor = stored_descriptor.with_revision(
                    expected
                        .checked_add(1)
                        .ok_or_else(|| invalid_input("descriptor revision overflow"))?,
                );
            }
            (Some(_), None) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "resource identity is already registered",
                ));
            }
            (None, Some(_)) => {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "resource descriptor does not exist",
                ));
            }
        }
    } else {
        if expected_revision.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "resource descriptor does not exist",
            ));
        }
        ensure_unique_external_identity(authority, &resources_dir, &stored_descriptor)?;
        fs::create_dir(&resource_dir)?;
        File::open(&resources_dir)?.sync_all()?;
        stored_descriptor = stored_descriptor.with_revision(1);
    }

    let marker = ResourceMarker {
        schema: authority.schema.clone(),
        storage_id: authority.storage_id.clone(),
        resource_ref: stored_descriptor.resource_ref().clone(),
        scope: stored_descriptor.scope().clone(),
        descriptor: Some(stored_descriptor.clone()),
    };
    write_marker_atomic(&resource_dir, &marker)?;
    Ok(stored_descriptor)
}

pub fn get(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
) -> io::Result<ResourceDescriptor> {
    let (_, marker) = authority.read_local_resource_marker(resource_ref, authorization)?;
    validate_marker_identity(authority, &marker)?;
    marker.descriptor.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "resource descriptor is not registered",
        )
    })
}

pub fn list(
    authority: &StorageAuthority,
    authorization: Authorization,
) -> io::Result<Vec<ResourceDescriptor>> {
    validate_authority(
        authority,
        &crate::domain::resource::ResourceScope::Global,
        authorization,
    )?;
    let resources_dir = authority.root.join("resources");
    let mut descriptors = Vec::new();
    for entry in fs::read_dir(resources_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().into_string().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "resource path is not valid UTF-8",
            )
        })?;
        let resource_ref = ResourceRef(id);
        let (_, marker) = authority.read_local_resource_marker(&resource_ref, authorization)?;
        validate_marker_identity(authority, &marker)?;
        if let Some(descriptor) = marker.descriptor {
            descriptors.push(descriptor);
        }
    }
    descriptors.sort_by(|a, b| a.resource_ref().0.cmp(&b.resource_ref().0));
    Ok(descriptors)
}

pub fn list_by_scope(
    authority: &StorageAuthority,
    scope: &crate::domain::resource::ResourceScope,
    authorization: Authorization,
) -> io::Result<Vec<ResourceDescriptor>> {
    validate_authority(authority, scope, authorization)?;
    Ok(list(authority, authorization)?
        .into_iter()
        .filter(|descriptor| descriptor.scope() == scope)
        .collect())
}

fn validate_authority(
    authority: &StorageAuthority,
    scope: &crate::domain::resource::ResourceScope,
    authorization: Authorization,
) -> io::Result<()> {
    if !matches!(authority.route, AuthorityRoute::Local) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "authority route is not local",
        ));
    }
    if !authority.root.is_absolute() {
        return Err(invalid_input("authority root must be absolute"));
    }
    if !access_allowed(scope, authorization) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "resource access is not authorized",
        ));
    }
    let marker: StorageMarker = read_json(&authority.root.join("storage.json"))?;
    if marker.schema != authority.schema || marker.storage_id != authority.storage_id {
        return Err(invalid_data("storage marker does not match authority"));
    }
    if let crate::domain::resource::ResourceScope::Project { project_ref } = scope {
        let project_id = safe_component(project_ref)?;
        let project: ProjectMarker = read_json(
            &authority
                .root
                .join("projects")
                .join(project_id)
                .join("project.json"),
        )?;
        if project.schema != authority.schema
            || project.storage_id != authority.storage_id
            || project.project_ref != *project_ref
        {
            return Err(invalid_data("project marker does not match authority"));
        }
    }
    Ok(())
}

fn ensure_unique_external_identity(
    authority: &StorageAuthority,
    resources_dir: &Path,
    descriptor: &ResourceDescriptor,
) -> io::Result<()> {
    if !resources_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(resources_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path().join("resource.json");
        if !path.exists() {
            continue;
        }
        let existing = read_marker(&path)?;
        validate_marker_identity(authority, &existing)?;
        if let Some(existing) = existing.descriptor {
            if existing.resource_ref() != descriptor.resource_ref()
                && existing.external_ref == descriptor.external_ref
            {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "external resource identity is already registered",
                ));
            }
        }
    }
    Ok(())
}

fn validate_marker_identity(
    authority: &StorageAuthority,
    marker: &ResourceMarker,
) -> io::Result<()> {
    if marker.schema != authority.schema || marker.storage_id != authority.storage_id {
        return Err(invalid_data("resource marker does not match authority"));
    }
    if marker.descriptor.as_ref().is_some_and(|descriptor| {
        descriptor.resource_ref() != &marker.resource_ref
            || descriptor.scope() != &marker.scope
            || descriptor.authority_ref != authority.storage_id.0
    }) {
        return Err(invalid_data(
            "descriptor identity does not match resource marker",
        ));
    }
    Ok(())
}

fn read_marker(path: &Path) -> io::Result<ResourceMarker> {
    read_json(path)
}

fn read_json<T: for<'de> serde::Deserialize<'de>>(path: &Path) -> io::Result<T> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_data("resource JSON is invalid"))
}

fn safe_component(value: &str) -> io::Result<&str> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || value.contains('\\')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(invalid_input("resource reference is not a path component"));
    }
    Ok(value)
}

fn open_registry_guard(root: &Path) -> io::Result<File> {
    let path = root.join("resource-registry.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn write_marker_atomic(resource_dir: &Path, marker: &ResourceMarker) -> io::Result<()> {
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let bytes = serde_json::to_vec(marker).map_err(|_| invalid_data("descriptor cannot encode"))?;
    let temp = resource_dir.join(format!(
        ".resource-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, resource_dir.join("resource.json"))?;
        File::open(resource_dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn invalid_input(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::NodeRef;
    use crate::domain::resource::{Attachment, ResourceKind, ResourceScope};
    use crate::ownership::manifest::StorageId;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (std::path::PathBuf, StorageAuthority) {
        let root = std::env::temp_dir().join(format!(
            "herder-resource-registry-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("storage-a".into()),
            authority_node: NodeRef("node-a".into()),
            root: root.clone(),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        fs::write(
            root.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        (root, authority)
    }

    fn descriptor(resource_ref: &str, external_ref: &str) -> ResourceDescriptor {
        ResourceDescriptor::new(
            ResourceRef(resource_ref.into()),
            ResourceScope::Global,
            ResourceKind::Device,
            external_ref.into(),
            "storage-a".into(),
            Some(Attachment {
                node_ref: NodeRef("node-a".into()),
                route_ref: Some("device-route".into()),
                availability: crate::domain::address::Availability::Available,
                observed_at: "2026-11-07T00:00:00Z".into(),
            }),
            0,
        )
    }

    #[test]
    fn register_update_get_list_and_authorization_use_one_marker_store() {
        let (root, authority) = fixture();
        let first = register_or_update(
            &authority,
            descriptor("device-a", "physical-device-a"),
            Authorization::Authorized,
            None,
        )
        .unwrap();
        assert_eq!(first.revision, 1);

        let updated = register_or_update(
            &authority,
            descriptor("device-a", "physical-device-a"),
            Authorization::Authorized,
            Some(1),
        )
        .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(
            get(
                &authority,
                &ResourceRef("device-a".into()),
                Authorization::Authorized
            )
            .unwrap(),
            updated
        );
        assert_eq!(
            list(&authority, Authorization::Authorized).unwrap(),
            vec![updated.clone()]
        );
        assert_eq!(
            list_by_scope(
                &authority,
                &ResourceScope::Global,
                Authorization::Authorized
            )
            .unwrap(),
            vec![updated]
        );
        assert!(
            list_by_scope(
                &authority,
                &ResourceScope::Node {
                    node_ref: NodeRef("node-b".into()),
                },
                Authorization::Authorized,
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            get(
                &authority,
                &ResourceRef("device-a".into()),
                Authorization::Denied
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            list(&authority, Authorization::Denied).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        let legacy_dir = root.join("resources/legacy");
        fs::create_dir(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("resource.json"),
            serde_json::to_vec(&ResourceMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                resource_ref: ResourceRef("legacy".into()),
                scope: ResourceScope::Global,
                descriptor: None,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            list(&authority, Authorization::Authorized).unwrap().len(),
            1
        );
        assert_eq!(
            get(
                &authority,
                &ResourceRef("legacy".into()),
                Authorization::Authorized
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::NotFound
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_identity_and_stale_revision_are_rejected_without_mutation() {
        let (root, authority) = fixture();
        let first = register_or_update(
            &authority,
            descriptor("device-a", "physical-device-a"),
            Authorization::Authorized,
            None,
        )
        .unwrap();
        assert_eq!(
            register_or_update(
                &authority,
                descriptor("device-b", "physical-device-a"),
                Authorization::Authorized,
                None,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            register_or_update(
                &authority,
                descriptor("device-a", "physical-device-a"),
                Authorization::Authorized,
                Some(0),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            get(
                &authority,
                &ResourceRef("device-a".into()),
                Authorization::Authorized
            )
            .unwrap(),
            first
        );
        assert!(list(&authority, Authorization::Authorized).unwrap().len() == 1);
        fs::remove_dir_all(root).unwrap();
    }
}
