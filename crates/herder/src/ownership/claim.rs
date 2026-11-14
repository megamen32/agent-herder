//! Exclusive resource ownership stored in the authority's single owner.json.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceClaim, ResourceRef, ResourceScope};
use crate::ownership::manifest::{StorageAuthority, StorageId};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Durable occupancy evidence. A dead watcher does not prove its children
/// stopped. Only the execution adapter may resolve this binding after reading
/// a durable terminal receipt for the exact execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionBinding {
    pub resource_ref: ResourceRef,
    pub claim_id: String,
    pub principal_ref: String,
    pub resource_revision: u64,
    pub execution_ref: String,
    pub resolved_receipt: Option<String>,
}

/// Atomically claim one registered resource using the caller's stable UUID nonce.
/// Every writer opens and locks the same guard inode; this function never removes it.
pub fn claim(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    requested: ResourceClaim,
) -> io::Result<ClaimOutcome> {
    claim_inner(authority, resource_ref, authorization, requested, false)
}

/// Claim a resource while allowing a retry to recover the original acquisition
/// timestamp from the owner record. All caller supplied intent fields must
/// still match exactly; only acquired_at is recovered for the same claim ID.
pub fn claim_recovering_intent(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    requested: ResourceClaim,
) -> io::Result<ClaimOutcome> {
    claim_inner(authority, resource_ref, authorization, requested, true)
}

fn claim_inner(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    requested: ResourceClaim,
    recover_acquired_at: bool,
) -> io::Result<ClaimOutcome> {
    validate_request(resource_ref, &requested)?;
    let (resource_dir, marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    require_registered(&marker)?;
    let guard = open_guard(&resource_dir)?;
    guard.lock()?;
    cleanup_owner_temps(&resource_dir)?;

    let (locked_dir, locked_marker) =
        authority.read_local_resource_marker(resource_ref, authorization)?;
    if locked_dir != resource_dir || locked_marker != marker {
        return Err(invalid_data("resource identity changed before claim"));
    }

    if crate::ownership::migration_hold::read(authority, resource_ref, authorization)?.is_some() {
        return Ok(ClaimOutcome::Busy);
    }
    if retired_nonce(&resource_dir, &requested.claim_id)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "claim nonce was retired; use a new acquisition request",
        ));
    }

    match authority.read_owner_bytes(resource_ref, authorization)? {
        Some(bytes) => {
            let current: OwnerRecord = serde_json::from_slice(&bytes)
                .map_err(|_| invalid_data("owner record JSON is invalid"))?;
            validate_owner(authority, resource_ref, &current)?;
            if !claim_live_at(&current.claim, now_seconds()?)? {
                if current.claim.claim_id == requested.claim_id {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "claim expired"));
                }
                ensure_live_at(&requested, now_seconds()?)?;
                if unresolved_binding(&resource_dir)? {
                    return Ok(ClaimOutcome::Busy);
                }
                // Never wait for an old effect while holding the owner guard.
                // A surviving effect or an unresolved binding prevents reuse.
                let _execution_lock = match crate::ownership::release_runner::TargetExecutionLock::try_acquire(
                    authority, resource_ref, authorization,
                ) {
                    Ok(lock) => lock,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(ClaimOutcome::Busy),
                    Err(error) => return Err(error),
                };
                retire_nonce(&resource_dir, &current.claim.claim_id)?;
                let replacement = OwnerRecord {
                    schema: authority.schema.clone(),
                    storage_id: authority.storage_id.clone(),
                    scope: marker.scope,
                    claim: requested,
                };
                write_owner_atomic(&resource_dir, &replacement)?;
                return Ok(ClaimOutcome::Acquired);
            }
            if current.claim.claim_id == requested.claim_id {
                // Renewal changes the effective deadline, not the acquisition
                // request. Recover its immutable payload for a lost-ACK retry.
                let intent = read_acquisition_intent(authority, resource_ref, &resource_dir, &current)?
                    .unwrap_or_else(|| current.claim.clone());
                if intent == requested
                    || (recover_acquired_at && same_intent_except_acquired_at(&intent, &requested))
                {
                    return Ok(ClaimOutcome::AlreadyOwned);
                }
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "claim nonce was reused with different owner data",
                ));
            }
            Ok(ClaimOutcome::Busy)
        }
        None => {
            ensure_live_at(&requested, now_seconds()?)?;
            if unresolved_binding(&resource_dir)? {
                return Ok(ClaimOutcome::Busy);
            }
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

fn same_intent_except_acquired_at(current: &ResourceClaim, requested: &ResourceClaim) -> bool {
    current.resource_ref == requested.resource_ref
        && current.principal_ref == requested.principal_ref
        && current.session_ref == requested.session_ref
        && current.claim_id == requested.claim_id
        && current.purpose == requested.purpose
        && current.expires_at == requested.expires_at
}

/// Read the current claim only if its nonce matches. A missing or superseded
/// nonce returns None and never creates or reacquires ownership.
pub fn read_by_claim_id(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
) -> io::Result<Option<ResourceClaim>> {
    if !is_uuid(claim_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "claim ID must be a UUID",
        ));
    }
    Ok(read_current(authority, resource_ref, authorization)?
        .filter(|claim| claim.claim_id == claim_id))
}

/// Read the canonical owner as evidence, including an expired generation.
/// Call read_live_by_claim_id under the effect lock before authorizing work.
pub fn read_current(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
) -> io::Result<Option<ResourceClaim>> {
    let Some(bytes) = authority.read_owner_bytes(resource_ref, authorization)? else {
        return Ok(None);
    };
    let owner: OwnerRecord = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_data("owner record JSON is invalid"))?;
    validate_owner(authority, resource_ref, &owner)?;
    Ok(Some(owner.claim))
}

/// Read an effective lease. Expired and retired records remain available through
/// read_by_claim_id for reconciliation, but never authorize a new effect.
pub fn read_live_by_claim_id(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
) -> io::Result<Option<ResourceClaim>> {
    let claim = read_by_claim_id(authority, resource_ref, authorization, claim_id)?;
    if let Some(current) = &claim {
        ensure_live_at(current, now_seconds()?)?;
        let (dir, _) = authority.read_local_resource_marker(resource_ref, authorization)?;
        if retired_nonce(&dir, claim_id)? {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim nonce was retired"));
        }
    }
    Ok(claim)
}

/// Extend the expiry of the current live claim only when its nonce still matches.
pub fn renew(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    expires_at: Option<String>,
) -> io::Result<ResourceClaim> {
    renew_inner(authority, resource_ref, authorization, claim_id, expires_at, None)
}

/// A delegated renewal cannot change principal, nonce or resource revision and
/// cannot resurrect an expired lease. The caller must prove execution liveness.
/// A bounded handback uses this same operation with its finite handback deadline.
pub fn renew_owned(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    principal_ref: &str,
    expected_revision: u64,
    expires_at: String,
) -> io::Result<ResourceClaim> {
    renew_inner(
        authority, resource_ref, authorization, claim_id, Some(expires_at),
        Some((principal_ref, expected_revision)),
    )
}

fn renew_inner(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    expires_at: Option<String>,
    expected_owner: Option<(&str, u64)>,
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
    if let Some((principal_ref, revision)) = expected_owner {
        if owner.claim.principal_ref != principal_ref {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim belongs to another principal"));
        }
        if marker.descriptor.as_ref().map(|d| d.revision) != Some(revision) {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "resource revision changed"));
        }
    }
    ensure_live_at(&owner.claim, now_seconds()?)?;
    if retired_nonce(&resource_dir, claim_id)? {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim nonce was retired"));
    }
    if let Some(expiry) = &expires_at {
        if parse_expiry_seconds(expiry)? <= now_seconds()? {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "new expiry must be in the future"));
        }
    }
    // Lazily preserve the original request, including its expiry, before the
    // first renewal. Existing owner.json records need no migration or rewrite.
    if read_acquisition_intent(authority, resource_ref, &resource_dir, &owner)?.is_none() {
        write_metadata_atomic(
            &resource_dir,
            "claim-intent.json",
            &serde_json::to_vec(&owner).map_err(|_| invalid_data("claim intent cannot encode"))?,
        )?;
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
    let (resource_dir, _) = authority.read_local_resource_marker(resource_ref, authorization)?;
    if unresolved_binding(&resource_dir)? {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "execution binding requires terminal reconciliation before release"));
    }
    // Serialize ownership release with a target's in-flight external effect.
    // New claims may proceed only after the old effect has released this lock.
    let _execution_lock =
        crate::ownership::release_runner::TargetExecutionLock::acquire(
            authority,
            resource_ref,
            authorization,
        )?;
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
    if unresolved_binding(&resource_dir)? {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "execution binding requires terminal reconciliation before release"));
    }
    #[cfg(test)]
    inject_owner_write_failure(FAIL_BEFORE_OWNER_UNLINK)?;
    // Persist retirement before unlink. A crash may retain the old record, but
    // replay can never reacquire the same generation after a release took effect.
    retire_nonce(&resource_dir, claim_id)?;
    fs::remove_file(resource_dir.join("owner.json"))?;
    #[cfg(test)]
    inject_owner_write_failure(FAIL_AFTER_OWNER_UNLINK)?;
    File::open(resource_dir)?.sync_all()
}

/// Persist occupancy before starting an execution. An unresolved binding
/// prevents both release and expiry takeover even if the worker loses its lock.
pub fn bind_execution(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    principal_ref: &str,
    expected_revision: u64,
    execution_ref: &str,
) -> io::Result<ExecutionBinding> {
    if execution_ref.is_empty() || execution_ref.len() > 4096 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "execution reference is required"));
    }
    let (_guard, dir, marker, owner) = locked_owner(authority, resource_ref, authorization)?;
    check_owner(&owner.claim, claim_id, principal_ref)?;
    ensure_live_at(&owner.claim, now_seconds()?)?;
    if retired_nonce(&dir, claim_id)? {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim nonce was retired"));
    }
    if marker.descriptor.as_ref().map(|d| d.revision) != Some(expected_revision) {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "resource revision changed"));
    }
    crate::ownership::migration_hold::ensure_clear(authority, resource_ref, authorization)?;
    let binding = ExecutionBinding {
        resource_ref: resource_ref.clone(),
        claim_id: claim_id.into(),
        principal_ref: principal_ref.into(),
        resource_revision: expected_revision,
        execution_ref: execution_ref.into(),
        resolved_receipt: None,
    };
    if let Some(current) = read_binding(&dir)? {
        if current == binding { return Ok(current); }
        if current.execution_ref == execution_ref {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "execution reference was already bound with different state"));
        }
        if current.resolved_receipt.is_none() {
            return Err(io::Error::new(io::ErrorKind::WouldBlock, "resource has an unresolved execution binding"));
        }
    }
    write_binding_atomic(&dir, &binding)?;
    Ok(binding)
}

/// Mark occupancy resolved after the caller verified a durable terminal receipt.
/// This does not release the claim or extend its expiry. A different execution
/// or principal cannot clear it; an expired owner may still reconcile its work.
pub fn clear_execution_binding(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
    claim_id: &str,
    principal_ref: &str,
    execution_ref: &str,
    receipt_ref: &str,
) -> io::Result<ExecutionBinding> {
    if receipt_ref.is_empty() || receipt_ref.len() > 4096 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "verified terminal receipt reference is required"));
    }
    let (_guard, dir, _, owner) = locked_owner(authority, resource_ref, authorization)?;
    check_owner(&owner.claim, claim_id, principal_ref)?;
    let mut binding = read_binding(&dir)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "execution binding not found"))?;
    if binding.resource_ref != *resource_ref || binding.claim_id != claim_id
        || binding.principal_ref != principal_ref || binding.execution_ref != execution_ref {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "execution binding identity does not match"));
    }
    if let Some(existing) = &binding.resolved_receipt {
        if existing == receipt_ref { return Ok(binding); }
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "execution binding already resolved by another receipt"));
    }
    binding.resolved_receipt = Some(receipt_ref.into());
    write_binding_atomic(&dir, &binding)?;
    Ok(binding)
}

pub fn read_execution_binding(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
) -> io::Result<Option<ExecutionBinding>> {
    let (dir, _) = authority.read_local_resource_marker(resource_ref, authorization)?;
    let binding = read_binding(&dir)?;
    if binding.as_ref().is_some_and(|b| b.resource_ref != *resource_ref) {
        return Err(invalid_data("execution binding resource identity mismatch"));
    }
    Ok(binding)
}

fn locked_owner(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    authorization: Authorization,
) -> io::Result<(File, std::path::PathBuf, crate::ownership::manifest::ResourceMarker, OwnerRecord)> {
    let (dir, marker) = authority.read_local_resource_marker(resource_ref, authorization)?;
    require_registered(&marker)?;
    let guard = open_guard(&dir)?;
    guard.lock()?;
    let (current_dir, current_marker) = authority.read_local_resource_marker(resource_ref, authorization)?;
    if current_dir != dir || current_marker != marker { return Err(invalid_data("resource identity changed before binding")); }
    let bytes = authority.read_owner_bytes(resource_ref, authorization)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "resource has no owner"))?;
    let owner: OwnerRecord = serde_json::from_slice(&bytes).map_err(|_| invalid_data("owner record JSON is invalid"))?;
    validate_owner(authority, resource_ref, &owner)?;
    Ok((guard, dir, marker, owner))
}

fn check_owner(claim: &ResourceClaim, claim_id: &str, principal_ref: &str) -> io::Result<()> {
    if claim.claim_id != claim_id || claim.principal_ref != principal_ref {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "claim principal or generation does not match"));
    }
    Ok(())
}

fn read_binding(dir: &Path) -> io::Result<Option<ExecutionBinding>> {
    let Some(bytes) = read_metadata(dir, "execution-binding.json")? else { return Ok(None); };
    let binding: ExecutionBinding = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_data("execution binding JSON is invalid"))?;
    if dir.file_name().and_then(|v| v.to_str()) != Some(binding.resource_ref.0.as_str())
        || !is_uuid(&binding.claim_id)
        || binding.principal_ref.is_empty()
        || binding.resource_revision == 0
        || binding.execution_ref.is_empty()
        || binding.execution_ref.len() > 4096
        || binding.resolved_receipt.as_ref().is_some_and(|v| v.is_empty() || v.len() > 4096)
    {
        return Err(invalid_data("execution binding identity is invalid"));
    }
    Ok(Some(binding))
}

fn unresolved_binding(dir: &Path) -> io::Result<bool> {
    Ok(read_binding(dir)?.is_some_and(|b| b.resolved_receipt.is_none()))
}

fn write_binding_atomic(dir: &Path, binding: &ExecutionBinding) -> io::Result<()> {
    write_metadata_atomic(dir, "execution-binding.json", &serde_json::to_vec(binding)
        .map_err(|_| invalid_data("execution binding cannot encode"))?)
}

fn read_acquisition_intent(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    dir: &Path,
    current: &OwnerRecord,
) -> io::Result<Option<ResourceClaim>> {
    let Some(bytes) = read_metadata(dir, "claim-intent.json")? else { return Ok(None); };
    let intent: OwnerRecord = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_data("claim intent JSON is invalid"))?;
    validate_owner(authority, resource_ref, &intent)?;
    if intent.claim.claim_id != current.claim.claim_id { return Ok(None); }
    let mut effective = intent.claim.clone();
    effective.expires_at = current.claim.expires_at.clone();
    if effective != current.claim || intent.scope != current.scope {
        return Err(invalid_data("claim acquisition intent does not match its owner"));
    }
    Ok(Some(intent.claim))
}

fn read_metadata(dir: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(invalid_data("lease metadata is not a regular file")),
        Ok(_) => fs::read(path).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_metadata_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let temp = dir.join(format!(".lease-meta-{}-{}.tmp", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dir.join(name))?;
        File::open(dir)?.sync_all()
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

fn retired_nonce(dir: &Path, claim_id: &str) -> io::Result<bool> {
    match fs::symlink_metadata(dir.join("retired-claims").join(claim_id)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn retire_nonce(dir: &Path, claim_id: &str) -> io::Result<()> {
    let retired = dir.join("retired-claims");
    fs::create_dir_all(&retired)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    match options.open(retired.join(claim_id)) {
        Ok(mut file) => { file.write_all(claim_id.as_bytes())?; file.sync_all()?; },
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    File::open(&retired)?.sync_all()?;
    File::open(dir)?.sync_all()
}

pub fn now_seconds() -> io::Result<u64> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs())
        .map_err(|_| io::Error::other("system clock unavailable"))
}

/// Expiry is enforced at second precision. Fractional RFC3339 deadlines are
/// rounded down so an effect is never authorized past the supplied deadline.
pub fn ensure_live_at(claim: &ResourceClaim, now_unix_seconds: u64) -> io::Result<()> {
    if claim_live_at(claim, now_unix_seconds)? { Ok(()) }
    else { Err(io::Error::new(io::ErrorKind::TimedOut, "claim expired")) }
}

fn claim_live_at(claim: &ResourceClaim, now_unix_seconds: u64) -> io::Result<bool> {
    claim.expires_at.as_deref().map(parse_expiry_seconds).transpose()
        .map(|expiry| expiry.is_none_or(|t| t > now_unix_seconds))
}

/// Accept the existing unix-seconds form and strict RFC3339 numeric timestamps.
pub fn parse_expiry_seconds(value: &str) -> io::Result<u64> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "expiry must be RFC3339 or unix-seconds:N");
    if let Some(seconds) = value.strip_prefix("unix-seconds:") {
        if seconds.is_empty() || !seconds.bytes().all(|c| c.is_ascii_digit()) { return Err(invalid()); }
        return seconds.parse().map_err(|_| invalid());
    }
    if !value.is_ascii() || value.len() < 20 || value.len() > 64 { return Err(invalid()); }
    let b = value.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' { return Err(invalid()); }
    let number = |range: std::ops::Range<usize>| -> io::Result<i64> {
        let v = &value[range];
        if !v.bytes().all(|c| c.is_ascii_digit()) { return Err(invalid()); }
        v.parse().map_err(|_| invalid())
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 { return Err(invalid()); }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month { 2 => if leap { 29 } else { 28 }, 4 | 6 | 9 | 11 => 30, _ => 31 };
    if day < 1 || day > max_day { return Err(invalid()); }
    let mut index = 19;
    if b[index] == b'.' {
        index += 1;
        let start = index;
        while index < b.len() && b[index].is_ascii_digit() { index += 1; }
        if index == start { return Err(invalid()); }
    }
    let offset = match b.get(index) {
        Some(b'Z' | b'z') if index + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if index + 6 == b.len() && b[index + 3] == b':' => {
            let h = number(index + 1..index + 3)?;
            let m = number(index + 4..index + 6)?;
            if h > 23 || m > 59 { return Err(invalid()); }
            (h * 3600 + m * 60) * if *sign == b'+' { 1 } else { -1 }
        },
        _ => return Err(invalid()),
    };
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let seconds = (era * 146097 + day_of_era - 719468) * 86400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds).map_err(|_| invalid())
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
    if let Some(expiry) = &claim.expires_at {
        parse_expiry_seconds(expiry)?;
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
    validate_request(resource_ref, &owner.claim)
        .map_err(|_| invalid_data("owner record claim fields are invalid"))?;
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

#[cfg(test)]
const FAIL_BEFORE_RENAME: u8 = 1;
#[cfg(test)]
const FAIL_AFTER_RENAME: u8 = 2;
#[cfg(test)]
const FAIL_BEFORE_DIRECTORY_SYNC: u8 = 3;
#[cfg(test)]
const FAIL_AFTER_DIRECTORY_SYNC: u8 = 4;
#[cfg(test)]
const FAIL_BEFORE_OWNER_UNLINK: u8 = 5;
#[cfg(test)]
const FAIL_AFTER_OWNER_UNLINK: u8 = 6;

#[cfg(test)]
thread_local! {
    static OWNER_WRITE_FAILPOINT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn inject_owner_write_failure(point: u8) -> io::Result<()> {
    OWNER_WRITE_FAILPOINT.with(|failpoint| {
        if failpoint.get() == point {
            failpoint.set(0);
            Err(io::Error::other(format!(
                "injected owner write failure at {point}"
            )))
        } else {
            Ok(())
        }
    })
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
        #[cfg(test)]
        inject_owner_write_failure(FAIL_BEFORE_RENAME)?;
        fs::rename(&temp, resource_dir.join("owner.json"))?;
        #[cfg(test)]
        inject_owner_write_failure(FAIL_AFTER_RENAME)?;
        #[cfg(test)]
        inject_owner_write_failure(FAIL_BEFORE_DIRECTORY_SYNC)?;
        File::open(resource_dir)?.sync_all()?;
        #[cfg(test)]
        inject_owner_write_failure(FAIL_AFTER_DIRECTORY_SYNC)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Remove abandoned owner temp files only while the caller holds guard.lock.
fn cleanup_owner_temps(resource_dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(resource_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".owner-") && name.ends_with(".tmp") {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
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

    fn install_legacy_hold(root:&Path, authority:&StorageAuthority) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        use sha2::{Digest,Sha256};
        let digest=|bytes:&[u8]| Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();
        let lease=serde_json::json!({"owner":{"hostId":"old-node","harness":"codex","nativeSessionId":"old-native"},
            "fence":9,"tokenHash":"a".repeat(64),"acquiredAt":1,"expiresAt":2});
        let archive=root.join("original-ledger.json");
        let raw=serde_json::to_vec(&serde_json::json!({"version":1,"projects":{"/old/project/.git":{"fence":9,"lease":lease}}})).unwrap();
        fs::write(&archive,&raw).unwrap();fs::set_permissions(&archive,fs::Permissions::from_mode(0o400)).unwrap();
        let hold=crate::ownership::migration_hold::MigrationHold {version:1,kind:"herder-legacy-resource-quarantine".into(),
            epoch:"migration".into(),schema:authority.schema.clone(),storage_id:authority.storage_id.clone(),
            resource_ref:ResourceRef("r".into()),resource_revision:1,source_project:"/old/project/.git".into(),
            source_fence:9,source_owner:lease["owner"].clone(),source_token_hash:"a".repeat(64),
            source_lease_sha256:digest(&serde_json::to_vec(&lease).unwrap()),
            archive:crate::ownership::migration_hold::Evidence{path:archive.clone(),sha256:digest(&raw)},outcome:"unknown".into()};
        let path=root.join("resources/r/migration-hold.json");
        fs::write(&path,serde_json::to_vec(&hold).unwrap()).unwrap();fs::set_permissions(&path,fs::Permissions::from_mode(0o400)).unwrap();
        archive
    }

    #[test]
    fn migration_unknown_blocks_claim_and_effect_without_expiry_or_fake_owner() {
        let (root,authority)=fixture();
        let resource_ref=ResourceRef("r".into());
        let first=requested("01234567-89ab-4cde-8fab-0123456789ab");
        assert_eq!(claim(&authority,&resource_ref,Authorization::Authorized,first.clone()).unwrap(),ClaimOutcome::Acquired);
        let before=fs::read(root.join("resources/r/owner.json")).unwrap();
        let archive=install_legacy_hold(&root,&authority);
        assert_eq!(bind_execution(&authority,&resource_ref,Authorization::Authorized,&first.claim_id,
            &first.principal_ref,1,"must-not-launch").unwrap_err().kind(),io::ErrorKind::WouldBlock);
        assert!(!root.join("resources/r/execution-binding.json").exists());
        let marker:ResourceMarker=serde_json::from_slice(&fs::read(root.join("resources/r/resource.json")).unwrap()).unwrap();
        let descriptor_bytes=fs::read(root.join("resources/r/resource.json")).unwrap();
        assert_eq!(crate::ownership::resource::register_or_update(&authority,marker.descriptor.unwrap(),
            Authorization::Authorized,Some(1)).unwrap_err().kind(),io::ErrorKind::WouldBlock);
        assert_eq!(fs::read(root.join("resources/r/resource.json")).unwrap(),descriptor_bytes);
        assert_eq!(claim(&authority,&resource_ref,Authorization::Authorized,first.clone()).unwrap(),ClaimOutcome::Busy);
        let lock=crate::ownership::release_runner::TargetExecutionLock::acquire(&authority,&resource_ref,Authorization::Authorized).unwrap();
        assert_eq!(lock.verify_current_claim(&authority,Authorization::Authorized,&first.claim_id,1).unwrap_err().kind(),io::ErrorKind::WouldBlock);
        assert_eq!(fs::read(root.join("resources/r/owner.json")).unwrap(),before);
        assert_eq!(crate::ownership::migration_hold::read(&authority,&resource_ref,Authorization::Authorized).unwrap().unwrap().outcome,"unknown");
        fs::remove_file(archive).unwrap();
        assert!(crate::ownership::migration_hold::read(&authority,&resource_ref,Authorization::Authorized).is_err());
        drop(lock);fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_hold_does_not_block_an_unrelated_resource() {
        let (root,authority)=fixture();
        install_legacy_hold(&root,&authority);
        let other_dir=root.join("resources/other");fs::create_dir(&other_dir).unwrap();
        let mut marker:serde_json::Value=serde_json::from_slice(&fs::read(root.join("resources/r/resource.json")).unwrap()).unwrap();
        marker["resource_ref"]=serde_json::json!("other");marker["descriptor"]["resource_ref"]=serde_json::json!("other");
        marker["descriptor"]["external_ref"]=serde_json::json!("other-device");
        fs::write(other_dir.join("resource.json"),serde_json::to_vec(&marker).unwrap()).unwrap();
        let mut request=requested("01234567-89ab-4cde-8fab-0123456789ab");request.resource_ref=ResourceRef("other".into());
        assert_eq!(claim(&authority,&request.resource_ref.clone(),Authorization::Authorized,request).unwrap(),ClaimOutcome::Acquired);
        assert!(!root.join("resources/r/owner.json").exists());
        fs::remove_dir_all(root).unwrap();
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
                Some("2099-11-08T00:00:00Z".into()),
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
            Some("2099-11-08T00:00:00Z".into()),
        )
        .unwrap();
        assert_eq!(updated.expires_at.as_deref(), Some("2099-11-08T00:00:00Z"));

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

#[cfg(test)]
#[path = "../../tests/ownership/crash.rs"]
mod crash_tests;

#[cfg(test)]
#[path = "../../tests/ownership/lease_lifecycle.rs"]
mod lease_tests;
