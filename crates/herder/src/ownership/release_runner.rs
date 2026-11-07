//! Target-local serialization for resource release effects.

use crate::domain::address::Authorization;
use crate::domain::resource::ResourceRef;
use crate::ownership::manifest::StorageAuthority;
use crate::ownership::resource;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::PathBuf;

/// Holds the stable lock inode for one registered target until dropped.
pub struct TargetExecutionLock {
    _file: File,
    resource_ref: ResourceRef,
    path: PathBuf,
}

impl TargetExecutionLock {
    /// Acquire serialization for one resource target, then verify its marker
    /// did not change while waiting for the lock.
    pub fn acquire(
        authority: &StorageAuthority,
        resource_ref: &ResourceRef,
        authorization: Authorization,
    ) -> io::Result<Self> {
        resource::get(authority, resource_ref, authorization)?;
        let (resource_dir, marker) =
            authority.read_local_resource_marker(resource_ref, authorization)?;
        let path = resource_dir.join("execution.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.lock()?;

        let (locked_dir, locked_marker) =
            authority.read_local_resource_marker(resource_ref, authorization)?;
        if locked_dir != resource_dir || locked_marker != marker {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "resource identity changed while waiting for target lock",
            ));
        }
        Ok(Self {
            _file: file,
            resource_ref: resource_ref.clone(),
            path,
        })
    }

    pub fn resource_ref(&self) -> &ResourceRef {
        &self.resource_ref
    }

    pub fn lock_path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::NodeRef;
    use crate::domain::resource::{ResourceDescriptor, ResourceKind, ResourceScope};
    use crate::ownership::manifest::{
        AuthorityRoute, ResourceMarker, StorageId, StorageMarker,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn execution_lock_is_exclusive_and_bound_to_registered_resource() {
        let root = std::env::temp_dir().join(format!(
            "herder-target-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let resource_ref = ResourceRef("device-a".into());
        let resource_dir = root.join("resources/device-a");
        fs::create_dir_all(&resource_dir).unwrap();
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
        let descriptor = ResourceDescriptor::new(
            resource_ref.clone(),
            ResourceScope::Global,
            ResourceKind::Device,
            "device-a-external".into(),
            authority.storage_id.0.clone(),
            None,
            1,
        );
        fs::write(
            resource_dir.join("resource.json"),
            serde_json::to_vec(&ResourceMarker {
                schema: authority.schema.clone(),
                storage_id: authority.storage_id.clone(),
                resource_ref: resource_ref.clone(),
                scope: ResourceScope::Global,
                descriptor: Some(descriptor),
            })
            .unwrap(),
        )
        .unwrap();

        let lock = TargetExecutionLock::acquire(
            &authority,
            &resource_ref,
            Authorization::Authorized,
        )
        .unwrap();
        assert_eq!(lock.resource_ref(), &resource_ref);
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock.lock_path())
            .unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(lock);
        contender.try_lock().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
