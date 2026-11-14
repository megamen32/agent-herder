//! Remote execution protocol. The execution node has no resource authority.
//! Only the controller's canonical owner.json may grant/renew a protected effect.
use super::{ExecutionRecord, ExecutionRequest, ExecutionSnapshot, ExecutionStore, StartRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io, os::unix::fs::MetadataExt, path::{Component, Path, PathBuf}};

pub const REMOTE_VERSION: u8 = 1;
pub const MAX_PERMIT_MS: u64 = 4_000;
pub const MAX_REMOTE_RUNTIME_MS: u64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteTransportConfig {
    pub node_binary: PathBuf,
    pub node_sha256: String,
    pub bridge: PathBuf,
    pub bridge_sha256: String,
    pub fleet_mesh_config: PathBuf,
    pub credential_pin: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteExecutorConfig {
    pub executor_ref: String,
    pub node_ref: String,
    pub transport: RemoteTransportConfig,
    pub worker: PathBuf,
    pub worker_sha256: String,
    pub endpoint_config: PathBuf,
    pub endpoint_config_sha256: String,
    pub execution_root: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub max_runtime_ms: u64,
    /// This is an installed capability, never a caller-supplied assertion.
    pub deadline_capability: RemoteDeadlineCapability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteDeadlineCapability {
    LinuxBootWatchdogV1,
    /// Retained explicitly so an unsupported platform fails before preparation.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteStartRequest {
    pub principal_ref: String,
    pub session_ref: String,
    pub request_key: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub deadline_unix_ms: u64,
    pub stop_grace_ms: u64,
    pub executor: RemoteExecutorConfig,
}
impl RemoteStartRequest {
    pub fn command(&self) -> StartRequest {
        StartRequest {
            principal_ref: self.principal_ref.clone(), session_ref: self.session_ref.clone(),
            request_key: self.request_key.clone(), argv: self.argv.clone(), cwd: self.cwd.clone(),
            deadline_unix_ms: Some(self.deadline_unix_ms), stop_grace_ms: self.stop_grace_ms,
        }
    }
    pub fn validate(&self, controller_node: &str) -> io::Result<()> {
        self.executor.validate(controller_node)?;
        if self.executor.deadline_capability != RemoteDeadlineCapability::LinuxBootWatchdogV1 {
            return Err(unsupported("remote_executor_deadline_unavailable"));
        }
        for s in [&self.principal_ref, &self.session_ref, &self.request_key] { bounded(s, 4096)?; }
        absolute(&self.cwd)?;
        if self.argv.is_empty() || self.argv.len() > 128 || self.argv[0].is_empty()
            || self.argv.iter().any(|v| v.contains('\0'))
            || self.argv.iter().map(String::len).sum::<usize>() > 16_384
            || self.stop_grace_ms > 30_000 || self.deadline_unix_ms == 0 {
            return Err(invalid("remote_request_invalid"));
        }
        Ok(())
    }
}
impl RemoteExecutorConfig {
    pub fn validate(&self, controller_node: &str) -> io::Result<()> {
        bounded(&self.executor_ref, 128)?; bounded(&self.node_ref, 256)?;
        bounded(&self.transport.target, 256)?;
        if self.node_ref == controller_node || self.root_inode == 0
            || !(1_000..=MAX_REMOTE_RUNTIME_MS).contains(&self.max_runtime_ms) {
            return Err(unsupported("remote_executor_deadline_unavailable"));
        }
        for p in [&self.worker, &self.endpoint_config, &self.execution_root,
            &self.transport.node_binary, &self.transport.bridge, &self.transport.fleet_mesh_config] {
            absolute(p)?;
        }
        for h in [&self.worker_sha256, &self.endpoint_config_sha256, &self.transport.node_sha256,
            &self.transport.bridge_sha256, &self.transport.credential_pin] { hash_string(h)?; }
        Ok(())
    }
    pub fn verify_local_transport(&self) -> io::Result<()> {
        verify_pinned_file(&self.transport.node_binary, &self.transport.node_sha256, false)?;
        verify_pinned_file(&self.transport.bridge, &self.transport.bridge_sha256, false)?;
        private_file(&self.transport.fleet_mesh_config)?;
        Ok(())
    }
}

/// Installed on the execution node. No resource store, principal grant, or
/// authority route is accepted here. The authenticated Fleet route is pinned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteEndpointConfig {
    pub version: u8,
    pub controller_node_ref: String,
    pub executor_ref: String,
    pub node_ref: String,
    pub worker: PathBuf,
    pub worker_sha256: String,
    pub execution_root: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub max_runtime_ms: u64,
    pub deadline_capability: RemoteDeadlineCapability,
}
impl RemoteEndpointConfig {
    pub fn load(path: &Path, expected_hash: &str) -> io::Result<Self> {
        let bytes = verify_pinned_file(path, expected_hash, true)?;
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| invalid("remote_config_invalid"))?;
        config.validate()?;
        if std::env::current_exe()?.canonicalize()? != config.worker {
            return Err(invalid("remote_worker_identity_mismatch"));
        }
        Ok(config)
    }
    pub fn validate(&self) -> io::Result<()> {
        if self.version != REMOTE_VERSION || self.controller_node_ref == self.node_ref
            || !(1_000..=MAX_REMOTE_RUNTIME_MS).contains(&self.max_runtime_ms)
            || self.deadline_capability != RemoteDeadlineCapability::LinuxBootWatchdogV1 {
            return Err(unsupported("remote_executor_deadline_unavailable"));
        }
        bounded(&self.controller_node_ref, 256)?; bounded(&self.node_ref, 256)?;
        bounded(&self.executor_ref, 128)?; absolute(&self.execution_root)?;
        verify_pinned_file(&self.worker, &self.worker_sha256, false)?;
        let m = fs::symlink_metadata(&self.execution_root)?;
        if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0
            || m.dev() != self.root_device || m.ino() != self.root_inode
            || self.execution_root.canonicalize()? != self.execution_root {
            return Err(invalid("remote_store_identity_mismatch"));
        }
        let store = ExecutionStore::from_existing_root(&self.execution_root)?;
        if store.node_ref() != self.node_ref { return Err(invalid("remote_store_node_mismatch")); }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteHandle {
    pub version: u8,
    pub controller_node_ref: String,
    pub executor_node_ref: String,
    pub executor_ref: String,
    pub execution_ref: String,
    pub controller_payload_hash: String,
    pub command_hash: String,
    pub worker_sha256: String,
    pub endpoint_config_sha256: String,
    pub nonce: String,
    pub root_device: u64,
    pub root_inode: u64,
    pub boot_id: String,
    pub deadline_boot_ms: u64,
    pub deadline_unix_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartPermit {
    pub boot_id: String,
    pub observed_boot_ms: u64,
    pub expires_boot_ms: u64,
}
impl StartPermit {
    pub fn validate(&self, boot: &str, now: u64, deadline: u64) -> io::Result<()> {
        if self.boot_id != boot || now < self.observed_boot_ms || now >= self.expires_boot_ms
            || self.expires_boot_ms <= self.observed_boot_ms
            || self.expires_boot_ms - self.observed_boot_ms > MAX_PERMIT_MS
            || self.expires_boot_ms > deadline {
            return Err(invalid("remote_start_permit_expired"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum RemoteAction {
    Prepare { controller_payload_hash: String, command: StartRequest },
    Start { handle: RemoteHandle, permit: StartPermit },
    Status { handle: RemoteHandle },
    Reconcile { handle: RemoteHandle },
    Cancel { handle: RemoteHandle },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteRequest {
    pub version: u8,
    pub request_id: String,
    pub controller_node_ref: String,
    pub executor_node_ref: String,
    pub executor_ref: String,
    pub operation: RemoteAction,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteObservation {
    pub handle: RemoteHandle,
    pub observed_boot_id: String,
    pub observed_boot_ms: u64,
    pub snapshot: ExecutionSnapshot,
    pub source: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteResponse {
    pub version: u8,
    pub request_id: String,
    pub controller_node_ref: String,
    pub executor_node_ref: String,
    pub executor_ref: String,
    pub observation: RemoteObservation,
}
impl RemoteResponse {
    pub fn verify(&self, request: &RemoteRequest, original: &ExecutionRecord,
        expected_handle: Option<&RemoteHandle>) -> io::Result<()> {
        let ExecutionRequest::RemoteStart(spec) = &original.request else {
            return Err(invalid("remote_controller_request_mismatch"));
        };
        let h = &self.observation.handle;
        let r = &self.observation.snapshot.record;
        if self.version != REMOTE_VERSION || self.request_id != request.request_id
            || self.controller_node_ref != original.node_ref
            || self.controller_node_ref != request.controller_node_ref
            || self.executor_node_ref != spec.executor.node_ref || self.executor_node_ref != request.executor_node_ref
            || self.executor_ref != spec.executor.executor_ref || self.executor_ref != request.executor_ref
            || h.version != REMOTE_VERSION || h.controller_node_ref != original.node_ref
            || h.executor_node_ref != spec.executor.node_ref || h.executor_ref != spec.executor.executor_ref
            || h.execution_ref != original.execution_ref || h.controller_payload_hash != original.payload_hash
            || h.command_hash != hash_json(&ExecutionRequest::Start(spec.command()))?
            || h.worker_sha256 != spec.executor.worker_sha256
            || h.endpoint_config_sha256 != spec.executor.endpoint_config_sha256
            || h.root_device != spec.executor.root_device || h.root_inode != spec.executor.root_inode
            || h.deadline_unix_ms != spec.deadline_unix_ms || h.deadline_boot_ms == 0
            || expected_handle.is_some_and(|expected| h != expected)
            || r.execution_ref != original.execution_ref || r.node_ref != spec.executor.node_ref
            || r.principal_ref != original.principal_ref || r.session_ref != original.session_ref
            || r.request_key != original.request_key || r.payload_hash != h.command_hash
            || r.request != ExecutionRequest::Start(spec.command())
            || r.worker.as_ref().is_some_and(|p| p.node_ref != spec.executor.node_ref)
            || r.process.as_ref().is_some_and(|p| p.node_ref != spec.executor.node_ref)
            || r.observed_members.iter().any(|p| p.node_ref != spec.executor.node_ref)
            || r.receipt.as_ref().is_some_and(|v| v.execution_ref != original.execution_ref
                || v.node_ref != spec.executor.node_ref || v.tree_complete == v.process_may_be_running)
            || (self.observation.snapshot.confirmed_live && (r.receipt.is_some()
                || r.state != super::ExecutionState::Running || self.observation.observed_boot_id != h.boot_id
                || self.observation.snapshot.observation != super::ExecutionObservation::ConfirmedLive
                || !self.observation.snapshot.worker_lock_held || r.worker.is_none()
                || (r.process.is_none() && r.observed_members.is_empty())
                || r.heartbeat_at_unix_ms.is_none()
                || r.worker.as_ref().is_some_and(|p|p.boot_id!=h.boot_id))) {
            return Err(invalid("remote_response_identity_mismatch"));
        }
        hash_string(&h.nonce)?; hash_string(&h.command_hash)?;
        if self.observation.source["execution_ref"] != original.execution_ref
            || self.observation.source["executor_node"] != spec.executor.node_ref
            || self.observation.source["request_digest"] != h.command_hash {
            return Err(invalid("remote_source_identity_mismatch"));
        }
        Ok(())
    }
}

pub(crate) fn hash_json(value: &impl Serialize) -> io::Result<String> {
    Ok(hash_bytes(&serde_json::to_vec(value).map_err(io::Error::other)?))
}
pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|v| format!("{v:02x}")).collect()
}
pub(crate) fn hash_string(value: &str) -> io::Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(invalid("remote_digest_invalid"));
    }
    Ok(())
}
pub(crate) fn bounded(value: &str, max: usize) -> io::Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid("remote_identifier_invalid"));
    }
    Ok(())
}
pub(crate) fn absolute(path: &Path) -> io::Result<()> {
    if !path.is_absolute() || path.as_os_str().len() > 4096
        || path.components().any(|v| matches!(v, Component::ParentDir | Component::CurDir)) {
        return Err(invalid("remote_path_invalid"));
    }
    Ok(())
}
pub(crate) fn private_file(path: &Path) -> io::Result<()> {
    absolute(path)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.nlink() != 1 || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0 || path.canonicalize()? != path {
        return Err(invalid("remote_private_file_invalid"));
    }
    Ok(())
}
pub(crate) fn verify_pinned_file(path: &Path, expected: &str, private: bool) -> io::Result<Vec<u8>> {
    absolute(path)?; hash_string(expected)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.mode() & 0o022 != 0
        || (m.uid() != unsafe { libc::geteuid() } && m.uid() != 0) || path.canonicalize()? != path {
        return Err(invalid("remote_artifact_invalid"));
    }
    if private { private_file(path)?; }
    let bytes = fs::read(path)?;
    if hash_bytes(&bytes) != expected { return Err(invalid("remote_artifact_changed")); }
    Ok(bytes)
}
pub(crate) fn random_id() -> io::Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
pub(crate) fn invalid(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
pub(crate) fn unsupported(message: &str) -> io::Error { io::Error::new(io::ErrorKind::Unsupported, message) }
