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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub receipt: ReleaseReceipt,
    /// True only for the invocation that durably created this receipt.
    /// Retries must not spawn an effect when this is false.
    pub newly_admitted: bool,
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
) -> io::Result<Admission> {
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
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        if entry.path() == receipt_path(&dir, request_key) {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        let previous: ReleaseReceipt = serde_json::from_slice(&bytes).map_err(invalid_data)?;
        if previous.resource_ref == receipt.resource_ref
            && matches!(previous.status, ReceiptStatus::Admitted | ReceiptStatus::Unknown)
        {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "an earlier effect on this resource has an unresolved outcome",
            ));
        }
    }
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
            Ok(Admission {
                receipt,
                newly_admitted: true,
            })
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
                Ok(Admission {
                    receipt: existing,
                    newly_admitted: false,
                })
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

/// Read a receipt after acquiring its target lock. A stale admitted receipt
/// means the parent disappeared before recording an outcome, so resolve it as
/// UNKNOWN and never authorize another spawn for that request key.
pub fn resolve_after_lock(
    authority: &StorageAuthority,
    lock: &TargetExecutionLock,
    request_key: &str,
) -> io::Result<ReleaseReceipt> {
    validate_uuid(request_key)?;
    let path = receipt_path(&authority.root.join("release-receipts"), request_key);
    let mut receipt: ReleaseReceipt =
        serde_json::from_slice(&fs::read(&path)?).map_err(invalid_data)?;
    validate_receipt_target(authority, lock, &receipt)?;
    if receipt.status == ReceiptStatus::Admitted {
        receipt.status = ReceiptStatus::Unknown;
        write_receipt_atomic(&path, &receipt)?;
    }
    Ok(receipt)
}

/// Record an externally confirmed or unknown result while the target lock is
/// still held. Terminal outcomes are immutable and cannot be upgraded later.
pub fn finish_under_lock(
    authority: &StorageAuthority,
    lock: &TargetExecutionLock,
    request_key: &str,
    status: ReceiptStatus,
) -> io::Result<ReleaseReceipt> {
    if status == ReceiptStatus::Admitted {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "finish status must be confirmed or unknown",
        ));
    }
    validate_uuid(request_key)?;
    let path = receipt_path(&authority.root.join("release-receipts"), request_key);
    let mut receipt: ReleaseReceipt =
        serde_json::from_slice(&fs::read(&path)?).map_err(invalid_data)?;
    validate_receipt_target(authority, lock, &receipt)?;
    match receipt.status {
        ReceiptStatus::Admitted => {
            receipt.status = status;
            write_receipt_atomic(&path, &receipt)?;
            Ok(receipt)
        }
        current if current == status => Ok(receipt),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "terminal release receipt outcome is immutable",
        )),
    }
}

fn validate_receipt_target(
    authority: &StorageAuthority,
    lock: &TargetExecutionLock,
    receipt: &ReleaseReceipt,
) -> io::Result<()> {
    if receipt.schema != authority.schema
        || receipt.storage_id != authority.storage_id.0
        || receipt.resource_ref != *lock.resource_ref()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "release receipt belongs to another authority or target",
        ));
    }
    Ok(())
}

fn write_receipt_atomic(path: &Path, receipt: &ReleaseReceipt) -> io::Result<()> {
    static TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "receipt path has no parent"))?;
    let temp = parent.join(format!(
        ".receipt-{}-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        receipt.request_key
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
        file.write_all(&serde_json::to_vec(receipt).map_err(invalid_data)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

/// Spawn a child while transferring the already-held target lock into its
/// process descriptor table. The reserved descriptor is exposed to the child
/// as `HERDER_EXECUTION_LOCK_FD`; the lock is released by the OS at child exit.
#[cfg(unix)]
pub fn spawn_with_execution_lock(
    command: &mut Command,
    lock: &TargetExecutionLock,
) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;

    const CHILD_LOCK_FD: libc::c_int = 198;
    let child_lock = lock.cloned_lock_file()?;
    let source_fd = TargetExecutionLock::raw_lock_fd(&child_lock);
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
        assert_eq!(first.receipt.status, ReceiptStatus::Admitted);
        assert!(first.newly_admitted);
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
        assert_eq!(replay.receipt, first.receipt);
        assert!(!replay.newly_admitted);
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
        assert_eq!(
            serde_json::from_slice::<ReleaseReceipt>(&bytes).unwrap(),
            first.receipt
        );
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock.lock_path())
            .unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("read line").stdin(Stdio::piped());
        let mut child = spawn_with_execution_lock(&mut command, &lock).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(lock);
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        let mut child_stdin = child.stdin.take().unwrap();
        child_stdin.write_all(b"release\n").unwrap();
        drop(child_stdin);
        assert!(child.wait().unwrap().success());
        contender.try_lock().unwrap();
        contender.unlock().unwrap();
        let recovered_lock = TargetExecutionLock::acquire(
            &authority,
            &resource_ref,
            Authorization::Authorized,
        )
        .unwrap();
        let recovered = resolve_after_lock(
            &authority,
            &recovered_lock,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        )
        .unwrap();
        assert_eq!(recovered.status, ReceiptStatus::Unknown);
        let replay = admit(
            &authority,
            &recovered_lock,
            Authorization::Authorized,
            claim_id,
            7,
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            &"a".repeat(64),
        )
        .unwrap();
        assert!(!replay.newly_admitted);
        assert_eq!(replay.receipt.status, ReceiptStatus::Unknown);
        assert_eq!(
            admit(
                &authority,
                &recovered_lock,
                Authorization::Authorized,
                claim_id,
                7,
                "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                &"b".repeat(64),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            finish_under_lock(
                &authority,
                &recovered_lock,
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                ReceiptStatus::Confirmed,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
        fs::remove_dir_all(root).unwrap();
    }
}
