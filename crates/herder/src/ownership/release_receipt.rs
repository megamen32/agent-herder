//! Durable admission receipts for effects executed under a target lock.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceClaim, ResourceRef};
use crate::ownership::manifest::StorageAuthority;
use crate::ownership::release_runner::TargetExecutionLock;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::process::{Child, Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Admitted,
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseReceipt {
    pub schema: String,
    pub storage_id: String,
    pub resource_ref: ResourceRef,
    pub claim_id: String,
    pub request_key: String,
    pub request_hash: String,
    pub status: ReceiptStatus,
    pub admitted_at: String,
}

/// Persist an immutable admission receipt while the caller holds this target's
/// execution lock. The caller may spawn the effect only after this returns.
pub fn admit(
    authority: &StorageAuthority,
    lock: &TargetExecutionLock,
    authorization: Authorization,
    claim_id: &str,
    expected_revision: u64,
    request_key: &str,
    request_hash: &str,
) -> io::Result<ReleaseReceipt> {
    validate_uuid(request_key)?;
    if request_hash.len() != 64 || !request_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request hash must be 64 hexadecimal characters",
        ));
    }
    let current_claim: ResourceClaim = lock.verify_current_claim(
        authority,
        authorization,
        claim_id,
        expected_revision,
    )?;
    let receipt = ReleaseReceipt {
        schema: authority.schema.clone(),
        storage_id: authority.storage_id.0.clone(),
        resource_ref: current_claim.resource_ref,
        claim_id: current_claim.claim_id,
        request_key: request_key.to_ascii_lowercase(),
        request_hash: request_hash.to_ascii_lowercase(),
        status: ReceiptStatus::Admitted,
        admitted_at: format!(
            "unix-seconds:{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| io::Error::other("system clock before unix epoch"))?
                .as_secs()
        ),
    };
    let dir = authority.root.join("release-receipts");
    fs::create_dir_all(&dir)?;
    let path = receipt_path(&dir, request_key);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(&receipt).map_err(invalid_data)?)?;
            file.sync_all()?;
            File::open(&dir)?.sync_all()?;
            Ok(receipt)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let existing: ReleaseReceipt = serde_json::from_slice(&fs::read(path)?)
                .map_err(invalid_data)?;
            if existing.schema == receipt.schema
                && existing.storage_id == receipt.storage_id
                && existing.resource_ref == receipt.resource_ref
                && existing.claim_id == receipt.claim_id
                && existing.request_key == receipt.request_key
                && existing.request_hash == receipt.request_hash
            {
                Ok(existing)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "request key was reused with different effect data",
                ))
            }
        }
        Err(error) => Err(error),
    }
}

/// Spawn a child while transferring the already-held target lock into its
/// process descriptor table. The reserved descriptor is exposed to the child
/// as `HERDER_EXECUTION_LOCK_FD`; the lock is released by the OS at child exit.
#[cfg(unix)]
pub fn spawn_with_execution_lock(
    command: &mut Command,
    lock: TargetExecutionLock,
) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;

    const CHILD_LOCK_FD: libc::c_int = 198;
    let source_fd = lock.raw_lock_fd();
    command.env("HERDER_EXECUTION_LOCK_FD", CHILD_LOCK_FD.to_string());
    // SAFETY: dup2 is async-signal-safe and the closure touches no shared Rust
    // state; the parent keeps the source descriptor alive through spawn().
    unsafe {
        command.pre_exec(move || {
            let result = if source_fd == CHILD_LOCK_FD {
                libc::fcntl(source_fd, libc::F_SETFD, 0)
            } else {
                libc::dup2(source_fd, CHILD_LOCK_FD)
            };
            if result == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}

#[cfg(not(unix))]
pub fn spawn_with_execution_lock(
    _command: &mut Command,
    _lock: TargetExecutionLock,
) -> io::Result<Child> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "execution lock transfer requires Unix descriptor inheritance",
    ))
}

fn receipt_path(dir: &Path, request_key: &str) -> PathBuf {
    dir.join(format!("{}.json", request_key.to_ascii_lowercase()))
}

fn validate_uuid(value: &str) -> io::Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| bytes[i] == b'-')
        && bytes.iter().enumerate().all(|(i, byte)| {
            [8, 13, 18, 23].contains(&i) || byte.is_ascii_hexdigit()
        })
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request key must be a UUID",
        ))
    }
}

fn invalid_data(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::resource::{ResourceDescriptor, ResourceKind, ResourceScope};
    use crate::ownership::claim;
    use crate::ownership::manifest::{
        AuthorityRoute, ResourceMarker, StorageId, StorageMarker,
    };
    use std::process::Stdio;

    #[test]
    fn admission_receipt_is_durable_idempotent_and_rejects_changed_payload() {
        let root = std::env::temp_dir().join(format!(
            "herder-release-receipt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let resource_ref = ResourceRef("target-a".into());
        let resource_dir = root.join("resources/target-a");
        fs::create_dir_all(&resource_dir).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("storage-a".into()),
            authority_node: crate::domain::address::NodeRef("node-a".into()),
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
                resource_ref: resource_ref.clone(),
                scope: ResourceScope::Global,
                descriptor: Some(ResourceDescriptor::new(
                    resource_ref.clone(),
                    ResourceScope::Global,
                    ResourceKind::Deployment,
                    "deployment-a".into(),
                    authority.storage_id.0.clone(),
                    None,
                    7,
                )),
            })
            .unwrap(),
        )
        .unwrap();
        let claim_id = "12345678-1234-4234-8234-123456789abc";
        claim::claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            ResourceClaim {
                resource_ref: resource_ref.clone(),
                principal_ref: "principal-a".into(),
                session_ref: None,
                claim_id: claim_id.into(),
                purpose: "release".into(),
                acquired_at: "test-time".into(),
                expires_at: None,
            },
        )
        .unwrap();
        let lock = TargetExecutionLock::acquire(
            &authority,
            &resource_ref,
            Authorization::Authorized,
        )
        .unwrap();
        let first = admit(
            &authority,
            &lock,
            Authorization::Authorized,
            claim_id,
            7,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            &"a".repeat(64),
        )
        .unwrap();
        assert_eq!(first.status, ReceiptStatus::Admitted);
        let replay = admit(
            &authority,
            &lock,
            Authorization::Authorized,
            claim_id,
            7,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            &"a".repeat(64),
        )
        .unwrap();
        assert_eq!(replay, first);
        assert_eq!(
            admit(
                &authority,
                &lock,
                Authorization::Authorized,
                claim_id,
                7,
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                &"b".repeat(64),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
        let bytes = fs::read(
            root.join("release-receipts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json"),
        )
        .unwrap();
        assert_eq!(serde_json::from_slice::<ReleaseReceipt>(&bytes).unwrap(), first);
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock.lock_path())
            .unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("read line").stdin(Stdio::piped());
        let mut child = spawn_with_execution_lock(&mut command, lock).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        let mut child_stdin = child.stdin.take().unwrap();
        child_stdin.write_all(b"release\n").unwrap();
        drop(child_stdin);
        assert!(child.wait().unwrap().success());
        contender.try_lock().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
