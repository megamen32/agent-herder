//! Target-local serialization for resource release effects.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceClaim, ResourceRef};
use crate::ownership::claim;
use crate::ownership::manifest::StorageAuthority;
use crate::ownership::resource;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::PathBuf;

/// Holds the stable lock inode for one registered target until dropped.
#[derive(Debug)]
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
        Self::acquire_inner(authority, resource_ref, authorization, true)
    }

    /// Nonblocking acquisition for lease takeover and supervised work. Busy
    /// resources return WouldBlock instead of holding an MCP request open.
    pub fn try_acquire(
        authority: &StorageAuthority,
        resource_ref: &ResourceRef,
        authorization: Authorization,
    ) -> io::Result<Self> {
        Self::acquire_inner(authority, resource_ref, authorization, false)
    }

    fn acquire_inner(
        authority: &StorageAuthority,
        resource_ref: &ResourceRef,
        authorization: Authorization,
        blocking: bool,
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
        if blocking {
            file.lock()?;
        } else {
            file.try_lock().map_err(|error| match error {
                std::fs::TryLockError::WouldBlock => io::Error::new(io::ErrorKind::WouldBlock, "resource execution is still active"),
                std::fs::TryLockError::Error(error) => error,
            })?;
        }

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

    #[cfg(unix)]
    pub(crate) fn cloned_lock_file(&self) -> io::Result<File> {
        self._file.try_clone()
    }

    #[cfg(not(unix))]
    pub(crate) fn cloned_lock_file(&self) -> io::Result<File> {
        self._file.try_clone()
    }

    #[cfg(unix)]
    pub(crate) fn raw_lock_fd(file: &File) -> std::os::fd::RawFd {
        use std::os::fd::AsRawFd;
        file.as_raw_fd()
    }

    /// Revalidate the deployed descriptor revision and current owner while
    /// this target's execution lock is still held.
    pub fn verify_current_claim(
        &self,
        authority: &StorageAuthority,
        authorization: Authorization,
        claim_id: &str,
        expected_revision: u64,
    ) -> io::Result<ResourceClaim> {
        let descriptor = resource::get(authority, &self.resource_ref, authorization)?;
        if descriptor.revision != expected_revision {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "deployed resource revision changed; reload before effect",
            ));
        }
        claim::read_live_by_claim_id(authority, &self.resource_ref, authorization, claim_id)?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "claim is no longer the current resource owner",
                )
            })
    }

    /// Check the exact principal as well as current nonce, expiry and revision
    /// while the caller holds the execution lock for the external effect.
    pub fn verify_owned_claim(
        &self,
        authority: &StorageAuthority,
        authorization: Authorization,
        claim_id: &str,
        principal_ref: &str,
        expected_revision: u64,
    ) -> io::Result<ResourceClaim> {
        let claim = self.verify_current_claim(authority, authorization, claim_id, expected_revision)?;
        if claim.principal_ref != principal_ref {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim belongs to another principal"));
        }
        Ok(claim)
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
        // Other tests can fork while this lock is open. A pre-exec child keeps
        // the inherited open-file description locked even after our drop. Run
        // this test in a process that cannot be forked by other test threads.
        const ISOLATED: &str = "HERDER_TARGET_LOCK_TEST_ISOLATED";
        if std::env::var_os(ISOLATED).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "ownership::release_runner::tests::execution_lock_is_exclusive_and_bound_to_registered_resource",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(ISOLATED, "1")
                .status()
                .unwrap();
            assert!(status.success(), "isolated lock test failed: {status}");
            return;
        }
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
        let current_claim = ResourceClaim {
            resource_ref: resource_ref.clone(),
            principal_ref: "principal-a".into(),
            session_ref: None,
            claim_id: "12345678-1234-4234-8234-123456789abc".into(),
            purpose: "release test".into(),
            acquired_at: "test-time".into(),
            expires_at: None,
        };
        claim::claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            current_claim.clone(),
        )
        .unwrap();

        let lock = TargetExecutionLock::acquire(
            &authority,
            &resource_ref,
            Authorization::Authorized,
        )
        .unwrap();
        assert_eq!(lock.resource_ref(), &resource_ref);
        assert_eq!(
            lock.verify_current_claim(
                &authority,
                Authorization::Authorized,
                &current_claim.claim_id,
                1,
            )
            .unwrap(),
            current_claim
        );
        assert_eq!(
            lock.verify_current_claim(
                &authority,
                Authorization::Authorized,
                "87654321-4321-4321-8321-cba987654321",
                1,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            lock.verify_current_claim(
                &authority,
                Authorization::Authorized,
                &current_claim.claim_id,
                2,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::WouldBlock
        );
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
        contender.unlock().unwrap();

        claim::release(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            &current_claim.claim_id,
        )
        .unwrap();
        let replacement = ResourceClaim {
            claim_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
            principal_ref: "principal-b".into(),
            ..current_claim.clone()
        };
        claim::claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            replacement,
        )
        .unwrap();
        let stale_lock = TargetExecutionLock::acquire(
            &authority,
            &resource_ref,
            Authorization::Authorized,
        )
        .unwrap();
        assert_eq!(
            stale_lock
                .verify_current_claim(
                    &authority,
                    Authorization::Authorized,
                    &current_claim.claim_id,
                    1,
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let mut ssh_authority = authority.clone();
        ssh_authority.route = AuthorityRoute::Ssh {
            route_ref: "remote-authority".into(),
        };
        assert_eq!(
            TargetExecutionLock::acquire(
                &ssh_authority,
                &resource_ref,
                Authorization::Authorized,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::Unsupported
        );
        fs::remove_dir_all(root).unwrap();
    }
}
