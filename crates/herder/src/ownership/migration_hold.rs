//! Immutable occupancy carried from a retired release authority.
//! Unknown legacy effects never become a successful claim or expire by time.
use crate::{domain::{address::Authorization, resource::ResourceRef},
    ownership::manifest::{StorageAuthority, StorageId}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{self, Read}, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::{Path, PathBuf}};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence { pub path: PathBuf, pub sha256: String }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationHold {
    pub version: u8,
    pub kind: String,
    pub epoch: String,
    pub schema: String,
    pub storage_id: StorageId,
    pub resource_ref: ResourceRef,
    pub resource_revision: u64,
    pub source_project: String,
    pub source_fence: u64,
    pub source_owner: Value,
    pub source_token_hash: String,
    pub source_lease_sha256: String,
    pub archive: Evidence,
    pub outcome: String,
}
fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
fn exact(v: &str) -> bool { !v.is_empty() && v.len() <= 4096 && v.trim() == v && !v.chars().any(char::is_control) }
fn hash(v: &str) -> bool { v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn digest(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect() }
fn sealed(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    if !path.is_absolute() || fs::canonicalize(path)? != path { return Err(invalid("migration evidence path is not canonical")); }
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.uid() != unsafe { libc::geteuid() } || before.nlink() != 1
        || before.mode() & 0o777 != 0o400 || before.len() > maximum {
        return Err(invalid("migration evidence is not immutable private data"));
    }
    let mut bytes = Vec::new(); Read::by_ref(&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?; let named = fs::symlink_metadata(path)?;
    for m in [&after, &named] {
        if (m.dev(),m.ino(),m.len(),m.mtime(),m.mtime_nsec(),m.ctime(),m.ctime_nsec(),m.mode())
            != (before.dev(),before.ino(),before.len(),before.mtime(),before.mtime_nsec(),before.ctime(),before.ctime_nsec(),before.mode()) {
            return Err(invalid("migration evidence changed during read"));
        }
    }
    if bytes.len() as u64 != before.len() { return Err(invalid("migration evidence changed during read")); }
    Ok(bytes)
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            Value::Object(entries.into_iter().map(|(k, v)| (k.clone(), canonical(v))).collect())
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonical).collect()),
        other => other.clone(),
    }
}
pub fn read(authority: &StorageAuthority, resource_ref: &ResourceRef, authorization: Authorization) -> io::Result<Option<MigrationHold>> {
    let (dir, marker) = authority.read_local_resource_marker(resource_ref, authorization)?;
    let path = dir.join("migration-hold.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    }
    let bytes = sealed(&path, 65536)?;
    let hold: MigrationHold = serde_json::from_slice(&bytes).map_err(|_| invalid("migration hold JSON is invalid"))?;
    if hold.version != 1 || hold.kind != "herder-legacy-resource-quarantine" || !exact(&hold.epoch)
        || hold.schema != authority.schema || hold.storage_id != authority.storage_id
        || hold.resource_ref != *resource_ref || hold.resource_revision == 0
        || marker.descriptor.as_ref().map(|d| d.revision) != Some(hold.resource_revision)
        || hold.outcome != "unknown" || !Path::new(&hold.source_project).is_absolute() || hold.source_fence == 0
        || !hash(&hold.source_token_hash) || !hash(&hold.source_lease_sha256) || !hash(&hold.archive.sha256) {
        return Err(invalid("migration hold identity is invalid"));
    }
    let original = sealed(&hold.archive.path, 16 * 1024 * 1024)?;
    if digest(&original) != hold.archive.sha256 { return Err(invalid("migration archive digest differs")); }
    let ledger: Value = serde_json::from_slice(&original).map_err(|_| invalid("migration archive JSON is invalid"))?;
    let lease = ledger.get("projects").and_then(|p| p.get(&hold.source_project)).and_then(|p| p.get("lease"))
        .ok_or_else(|| invalid("legacy owner evidence is missing"))?;
    if ledger.get("version").and_then(Value::as_u64) != Some(1)
        || lease.get("fence").and_then(Value::as_u64) != Some(hold.source_fence)
        || lease.get("owner") != Some(&hold.source_owner)
        || lease.get("tokenHash").and_then(Value::as_str) != Some(hold.source_token_hash.as_str())
        || digest(&serde_json::to_vec(&canonical(lease)).map_err(io::Error::other)?) != hold.source_lease_sha256 {
        return Err(invalid("migration hold does not bind the original owner"));
    }
    Ok(Some(hold))
}
pub fn ensure_clear(authority: &StorageAuthority, resource_ref: &ResourceRef, authorization: Authorization) -> io::Result<()> {
    if read(authority, resource_ref, authorization)?.is_some() {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "resource has unresolved legacy migration occupancy"));
    }
    Ok(())
}
