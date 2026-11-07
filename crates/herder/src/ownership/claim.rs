//! Exclusive resource ownership stored in the authority's single owner.json.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceClaim, ResourceRef, ResourceScope};
use crate::ownership::manifest::{StorageAuthority, StorageId};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerRecord {
    pub schema: String,
    pub storage_id: StorageId,
    pub scope: ResourceScope,
    pub claim: ResourceClaim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    Acquired,
    AlreadyOwned,
    Busy,
}

/// Atomically claim one registered resource using the caller's stable UUID nonce.
/// Every writer opens and locks the same guard inode; this function never removes it.
pub fn claim(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    requested: ResourceClaim,
) -> io::Result<ClaimOutcome> {
    validate_request(resource_ref, &requested)?;
    let (resource_dir, marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    require_registered(&marker)?;
    let guard = open_guard(&resource_dir)?;
    guard.lock()?;

    let (locked_dir, locked_marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    if locked_dir != resource_dir || locked_marker != marker {
        return Err(invalid_data("resource identity changed before claim"));
    }

    match authority.read_owner_bytes(resource_ref, authorization)? {
        Some(bytes) => {
            let current: OwnerRecord = serde_json::from_slice(&bytes)
                .map_err(|_| invalid_data("owner record JSON is invalid"))?;
            validate_owner(authority, resource_ref, &current)?;
            if current.claim == requested {
                return Ok(ClaimOutcome::AlreadyOwned);
            }
            if current.claim.claim_id == requested.claim_id {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "claim nonce was reused with different owner data",
                ));
            }
            Ok(ClaimOutcome::Busy)
        }
        None => {
            let (current_dir, current_marker) =
                authority.read_local_resource_marker(resource_ref, authorization)?;
            if current_dir != resource_dir || current_marker != marker {
                return Err(invalid_data(
                    "resource identity changed before owner creation",
                ));
            }
            let owner = OwnerRecord {
                schema: authority.schema.clone(),
                storage_id: authority.storage_id.clone(),
                scope: marker.scope,
                claim: requested,
            };
            write_owner_atomic(&resource_dir, &owner)?;
            Ok(ClaimOutcome::Acquired)
        }
    }
}

/// Extend the expiry of the current claim only when its claim ID still matches.
pub fn renew(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    expires_at: Option<String>,
) -> io::Result<ResourceClaim> {
    if !is_uuid(claim_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "claim ID must be a UUID",
        ));
    }
    let (resource_dir, marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    require_registered(&marker)?;
    let guard = open_guard(&resource_dir)?;
    guard.lock()?;

    let (locked_dir, locked_marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    if locked_dir != resource_dir || locked_marker != marker {
        return Err(invalid_data("resource identity changed before renew"));
    }
    let bytes = authority
        .read_owner_bytes(resource_ref, authorization)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "resource has no owner"))?;
    let mut owner: OwnerRecord =
        serde_json::from_slice(&bytes).map_err(|_| invalid_data("owner record JSON is invalid"))?;
    validate_owner(authority, resource_ref, &owner)?;
    if owner.claim.claim_id != claim_id {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claim ID does not own this resource",
        ));
    }
    owner.claim.expires_at = expires_at;
    write_owner_atomic(&resource_dir, &owner)?;
    Ok(owner.claim)
}

/// Release the current claim only when its claim ID still matches.
pub fn release(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
) -> io::Result<()> {
    if !is_uuid(claim_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "claim ID must be a UUID",
        ));
    }
    let (resource_dir, marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    require_registered(&marker)?;
    let guard = open_guard(&resource_dir)?;
    guard.lock()?;

    let (locked_dir, locked_marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    if locked_dir != resource_dir || locked_marker != marker {
        return Err(invalid_data("resource identity changed before release"));
    }
    let bytes = authority
        .read_owner_bytes(resource_ref, authorization)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "resource has no owner"))?;
    let owner: OwnerRecord =
        serde_json::from_slice(&bytes).map_err(|_| invalid_data("owner record JSON is invalid"))?;
    validate_owner(authority, resource_ref, &owner)?;
    if owner.claim.claim_id != claim_id {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claim ID does not own this resource",
        ));
    }
    fs::remove_file(resource_dir.join("owner.json"))?;
    File::open(resource_dir)?.sync_all()
}

fn validate_request(resource_ref: &ResourceRef, claim: &ResourceClaim) -> io::Result<()> {
    if claim.resource_ref != *resource_ref
        || !is_uuid(&claim.claim_id)
        || claim.principal_ref.is_empty()
        || claim.purpose.is_empty()
        || claim.acquired_at.is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "claim identity, UUID nonce, principal, purpose, and acquired_at are required",
        ));
    }
    Ok(())
}

fn require_registered(marker: &crate::ownership::manifest::ResourceMarker) -> io::Result<()> {
    if marker.descriptor.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "resource descriptor is not registered",
        ));
    }
    Ok(())
}

fn validate_owner(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    owner: &OwnerRecord,
) -> io::Result<()> {
    if owner.schema != authority.schema
        || owner.storage_id != authority.storage_id
        || owner.claim.resource_ref != *resource_ref
    {
        return Err(invalid_data(
            "owner record identity does not match resource",
        ));
    }
    Ok(())
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| bytes[i] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(i, byte)| [8, 13, 18, 23].contains(&i) || byte.is_ascii_hexdigit())
}

fn open_guard(resource_dir: &Path) -> io::Result<File> {
    let path = resource_dir.join("guard.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn write_owner_atomic(resource_dir: &Path, owner: &OwnerRecord) -> io::Result<()> {
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let bytes =
        serde_json::to_vec(owner).map_err(|_| invalid_data("owner record cannot encode"))?;
    let temp = resource_dir.join(format!(
        ".owner-{}-{}.tmp",
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
        fs::rename(&temp, resource_dir.join("owner.json"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::{Availability, NodeRef, SessionRef};
    use crate::domain::resource::{Attachment, ResourceDescriptor, ResourceKind};
    use crate::ownership::manifest::{AuthorityRoute, ResourceMarker, StorageMarker};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (std::path::PathBuf, StorageAuthority) {
        let root = std::env::temp_dir().join(format!(
            "herder-claim-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let resource_dir = root.join("resources/r");
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
        fs::write(
            resource_dir.join("resource.json"),
            serde_json::to_vec(&ResourceMarker {
                schema: "v1".into(),
                storage_id: authority.storage_id.clone(),
                resource_ref: ResourceRef("r".into()),
                scope: ResourceScope::Global,
                descriptor: Some(ResourceDescriptor::new(
                    ResourceRef("r".into()),
                    ResourceScope::Global,
                    ResourceKind::Device,
                    "physical-device-r".into(),
                    authority.storage_id.0.clone(),
                    Some(Attachment {
                        node_ref: NodeRef("node-a".into()),
                        route_ref: Some("device-route".into()),
                        availability: Availability::Available,
                        observed_at: "2026-11-07T00:00:00Z".into(),
                    }),
                    1,
                )),
            })
            .unwrap(),
        )
        .unwrap();
        (root, authority)
    }

    fn requested(claim_id: &str) -> ResourceClaim {
        ResourceClaim {
            resource_ref: ResourceRef("r".into()),
            principal_ref: "principal-a".into(),
            session_ref: Some(SessionRef("session-a".into())),
            claim_id: claim_id.into(),
            purpose: "test ownership".into(),
            acquired_at: "2026-11-07T00:00:00Z".into(),
            expires_at: None,
        }
    }

    #[test]
    fn claim_writes_one_owner_and_replay_reads_it_without_replacing_guard() {
        let (root, authority) = fixture();
        let resource_ref = ResourceRef("r".into());
        let first = requested("01234567-89ab-4cde-8fab-0123456789ab");
        let dir = root.join("resources/r");

        assert_eq!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                first.clone(),
            )
            .unwrap(),
            ClaimOutcome::Acquired
        );
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(unix)]
        let guard_metadata = fs::metadata(dir.join("guard.lock")).unwrap();
        #[cfg(unix)]
        let guard_identity = (guard_metadata.dev(), guard_metadata.ino());
        let owner: OwnerRecord =
            serde_json::from_slice(&fs::read(dir.join("owner.json")).unwrap()).unwrap();
        assert_eq!(owner.claim, first);
        assert_eq!(owner.scope, ResourceScope::Global);
        assert_eq!(owner.storage_id, authority.storage_id);

        assert_eq!(
            claim(&authority, &resource_ref, Authorization::Authorized, first,).unwrap(),
            ClaimOutcome::AlreadyOwned
        );
        assert_eq!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                requested("fedcba98-7654-4321-8abc-fedcba987654"),
            )
            .unwrap(),
            ClaimOutcome::Busy
        );
        #[cfg(unix)]
        {
            let after = fs::metadata(dir.join("guard.lock")).unwrap();
            assert_eq!((after.dev(), after.ino()), guard_identity);
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claim_requires_a_valid_nonce_and_never_claims_unauthorized_resources() {
        let (root, authority) = fixture();
        let resource_ref = ResourceRef("r".into());
        assert_eq!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                requested("not-a-uuid"),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Denied,
                requested("01234567-89ab-4cde-8fab-0123456789ab"),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(!root.join("resources/r/owner.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claim_does_not_treat_an_unregistered_marker_as_a_free_resource() {
        let (root, authority) = fixture();
        let marker_path = root.join("resources/r/resource.json");
        let mut marker: ResourceMarker =
            serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        marker.descriptor = None;
        fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(
            claim(
                &authority,
                &ResourceRef("r".into()),
                Authorization::Authorized,
                requested("01234567-89ab-4cde-8fab-0123456789ab"),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::NotFound
        );
        assert!(!root.join("resources/r/owner.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renew_and_release_compare_claim_id_and_preserve_guard() {
        let (root, authority) = fixture();
        let resource_ref = ResourceRef("r".into());
        let claim_id = "01234567-89ab-4cde-8fab-0123456789ab";
        let wrong_id = "fedcba98-7654-4321-8abc-fedcba987654";
        let dir = root.join("resources/r");
        claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            requested(claim_id),
        )
        .unwrap();
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(unix)]
        let guard_before = {
            let metadata = fs::metadata(dir.join("guard.lock")).unwrap();
            (metadata.dev(), metadata.ino())
        };

        assert_eq!(
            renew(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                wrong_id,
                Some("2026-11-08T00:00:00Z".into()),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        let updated = renew(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            claim_id,
            Some("2026-11-08T00:00:00Z".into()),
        )
        .unwrap();
        assert_eq!(updated.expires_at.as_deref(), Some("2026-11-08T00:00:00Z"));

        assert_eq!(
            release(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                wrong_id
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(dir.join("owner.json").exists());
        release(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            claim_id,
        )
        .unwrap();
        assert!(!dir.join("owner.json").exists());
        #[cfg(unix)]
        {
            let metadata = fs::metadata(dir.join("guard.lock")).unwrap();
            assert_eq!((metadata.dev(), metadata.ino()), guard_before);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_claims_have_exactly_one_winner() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let (root, authority) = fixture();
        let authority = Arc::new(authority);
        let resource_ref = Arc::new(ResourceRef("r".into()));
        let barrier = Arc::new(Barrier::new(3));
        let claims = [
            requested("01234567-89ab-4cde-8fab-0123456789ab"),
            requested("fedcba98-7654-4321-8abc-fedcba987654"),
        ];
        let workers = claims.clone().map(|request| {
            let authority = Arc::clone(&authority);
            let resource_ref = Arc::clone(&resource_ref);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                claim(
                    &authority,
                    &resource_ref,
                    Authorization::Authorized,
                    request,
                )
                .unwrap()
            })
        });
        barrier.wait();
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == ClaimOutcome::Acquired)
                .count(),
            1,
            "exactly one concurrent caller must acquire the claim"
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == ClaimOutcome::Busy)
                .count(),
            1,
            "the losing caller must observe the existing owner"
        );
        let owner: OwnerRecord =
            serde_json::from_slice(&fs::read(root.join("resources/r/owner.json")).unwrap())
                .unwrap();
        assert!(
            claims
                .iter()
                .any(|claim| claim.claim_id == owner.claim.claim_id)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
