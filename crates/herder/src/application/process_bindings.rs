//! Delegated renewal for supervised executions, using the canonical owner.json.
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource},
    domain::address::Authorization,
    mcp::catalog::{ProcessLeaseBinding, ProcessLeaseExit},
    ownership::{claim, manifest::StorageAuthority},
    process::{CompletionReceipt, ExecutionHooks, ExecutionRecord, ExecutionStore},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{self, Read, Write}, os::{fd::AsRawFd, unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt}},
    path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRuntimeConfig {
    pub version: u8,
    pub node_ref: String,
    pub worker: PathBuf,
    pub execution_root: PathBuf,
    pub resources: StorageAuthority,
    pub administrators: Vec<String>,
    #[serde(default)]
    pub remote_executors: Vec<crate::process::remote::RemoteExecutorConfig>,
}

impl ProcessRuntimeConfig {
    pub fn from_environment() -> io::Result<Option<Self>> {
        let Some(path) = std::env::var_os("HERDER_PROCESS_CONFIG") else { return Ok(None) };
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err(invalid("process configuration must be absolute")) }
        let config: Self = serde_json::from_slice(&fs::read(path)?).map_err(invalid)?;
        config.validate()?;
        Ok(Some(config))
    }
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1 || self.node_ref.is_empty() || !self.worker.is_absolute()
            || !self.execution_root.is_absolute() || !self.resources.root.is_absolute()
            || self.administrators.is_empty() || self.administrators.iter().any(|v|v.is_empty()) {
            return Err(invalid("invalid installed process configuration"));
        }
        let mut executors = std::collections::HashSet::new();
        let mut targets = std::collections::HashSet::new();
        for executor in &self.remote_executors {
            executor.validate(&self.node_ref)?;
            if !executors.insert(&executor.executor_ref)
                || !targets.insert((&executor.node_ref, &executor.execution_root)) {
                return Err(invalid("duplicate installed remote executor"));
            }
        }
        Ok(())
    }
    /// Grants are issued only from trusted installation policy. A principal
    /// supplied by an MCP request is never used to establish access.
    pub fn grants_for(&self, identity: &ConnectionIdentity, bindings: &[ProcessLeaseBinding])
        -> io::Result<Vec<Grant>> {
        let Caller::Principal(p) = identity.caller() else { return Err(denied()) };
        if !self.administrators.contains(&p.id.0) { return Err(denied()) }
        let mut grants = vec![Grant {
            principal:p.id.clone(), resource:PrivateResource::Resource(format!("process:{}",self.node_ref)),
            action:Action::Write,
        }];
        for b in bindings {
            for action in [Action::Read,Action::Write] {
                grants.push(Grant {principal:p.id.clone(),resource:PrivateResource::Resource(b.resource_ref.0.clone()),action});
            }
        }
        Ok(grants)
    }
    pub fn authorizes_principal(&self, principal: &PrincipalId) -> bool {
        self.administrators.contains(&principal.0)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delegation {
    pub version: u8,
    pub execution_ref: String,
    pub principal_ref: String,
    pub authority: StorageAuthority,
    pub bindings: Vec<ProcessLeaseBinding>,
}

pub fn validate_bindings(bindings: &[ProcessLeaseBinding]) -> io::Result<()> {
    if bindings.len() > 64 { return Err(invalid("too many lease bindings")) }
    let mut seen=std::collections::HashSet::new();
    for b in bindings {
        if b.claim_id.is_empty() || b.revision == 0 || b.ttl_seconds < 10 || b.ttl_seconds > 86400
            || !seen.insert(&b.resource_ref.0)
            || b.handback_seconds.is_some_and(|v|v==0 || v>86400) {
            return Err(invalid("invalid or duplicate lease binding"));
        }
    }
    Ok(())
}

/// Read current enrollment metadata for diagnostics only. Access comes from the
/// current installed configuration, never from this file's authority field.
/// This operation neither locks nor changes an owner, lease, or execution.
pub fn read_delegation_for_diagnostics(store: &ExecutionStore, execution_ref: &str,
    principal: &PrincipalId, config: &ProcessRuntimeConfig) -> io::Result<Delegation> {
    if !config.authorizes_principal(principal) || config.node_ref!=store.node_ref()
        || config.execution_root!=store.root() {return Err(denied())}
    let dir=store.execution_directory(execution_ref)?;
    let path=dir.join("bindings.json");
    let file=OpenOptions::new().read(true)
        .custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK).open(&path)?;
    let opened=file.metadata()?;
    let named=fs::symlink_metadata(&path)?;
    const MAX_BYTES:u64=262_144;
    if !opened.is_file() || opened.uid()!=unsafe{libc::geteuid()} || opened.nlink()!=1
        || opened.mode()&0o077!=0 || opened.len()>MAX_BYTES
        || (opened.dev(),opened.ino())!=(named.dev(),named.ino()) {return Err(denied())}
    let mut bytes=Vec::new();
    (&file).take(MAX_BYTES+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>MAX_BYTES {return Err(io::Error::new(io::ErrorKind::InvalidData,"delegation exceeds diagnostic limit"))}
    let current=file.metadata()?;
    let named=fs::symlink_metadata(&path)?;
    if (opened.dev(),opened.ino(),opened.len(),opened.mtime(),opened.mtime_nsec(),opened.ctime(),opened.ctime_nsec())
        !=(current.dev(),current.ino(),current.len(),current.mtime(),current.mtime_nsec(),current.ctime(),current.ctime_nsec())
        || (current.dev(),current.ino())!=(named.dev(),named.ino()) {
        return Err(io::Error::new(io::ErrorKind::WouldBlock,"delegation changed during diagnostic read"));
    }
    let d:Delegation=serde_json::from_slice(&bytes)
        .map_err(|_|io::Error::new(io::ErrorKind::InvalidData,"invalid delegation metadata"))?;
    if d.version!=1 || d.execution_ref!=execution_ref || d.principal_ref!=principal.0
        || d.authority!=config.resources {return Err(denied())}
    validate_bindings(&d.bindings)?;
    Ok(d)
}

pub fn write_delegation(store: &ExecutionStore, execution_ref: &str, principal: &str,
    authority: &StorageAuthority, bindings: Vec<ProcessLeaseBinding>) -> io::Result<()> {
    validate_bindings(&bindings)?;
    let dir=store.execution_directory(execution_ref)?;
    let _gate=delegation_lock(&dir)?;
    let path=dir.join("bindings.json");
    let desired=Delegation {version:1, execution_ref:execution_ref.into(),principal_ref:principal.into(),
        authority:authority.clone(),bindings};
    if path.exists() {
        let existing:Delegation=serde_json::from_slice(&fs::read(&path)?).map_err(invalid)?;
        if existing.version!=1 || existing.execution_ref!=desired.execution_ref
            || existing.principal_ref!=desired.principal_ref || existing.authority!=desired.authority
            || !desired.bindings.iter().all(|b|existing.bindings.contains(b)) {
            return Err(invalid("binding idempotency conflict"));
        }
        return Ok(());
    }
    atomic_json(&path,&desired)
}

pub fn add_delegation(store: &ExecutionStore, execution_ref: &str, principal: &str,
    binding: ProcessLeaseBinding) -> io::Result<()> {
    validate_bindings(std::slice::from_ref(&binding))?;
    let dir=store.execution_directory(execution_ref)?;
    let _gate=delegation_lock(&dir)?;
    let snapshot=store.status(execution_ref)?;
    if snapshot.record.principal_ref!=principal { return Err(denied()) }
    if !snapshot.confirmed_live || snapshot.record.receipt.is_some() {
        return Err(invalid("execution is not confirmed live"));
    }
    let path=dir.join("bindings.json");
    let mut d:Delegation=serde_json::from_slice(&fs::read(&path)?).map_err(invalid)?;
    if d.execution_ref!=execution_ref || d.principal_ref!=principal { return Err(denied()) }
    if let Some(old)=d.bindings.iter().find(|b|b.resource_ref==binding.resource_ref) {
        return if old==&binding {Ok(())} else {Err(invalid("resource binding conflict"))};
    }
    let owner=claim::read_live_by_claim_id(&d.authority,&binding.resource_ref,
        Authorization::Authorized,&binding.claim_id)?.ok_or_else(denied)?;
    let descriptor=crate::ownership::resource::get(&d.authority,&binding.resource_ref,Authorization::Authorized)?;
    if owner.principal_ref!=principal || descriptor.revision!=binding.revision {return Err(denied())}
    d.bindings.push(binding.clone());
    validate_bindings(&d.bindings)?;
    // Persist the enrollment intent before occupancy. Recovery and the worker
    // complete this same intent; a partial write can never orphan a binding.
    atomic_json(&path,&d)?;
    claim::bind_execution(&d.authority,&binding.resource_ref,Authorization::Authorized,
        &binding.claim_id,principal,binding.revision,execution_ref)?;
    Ok(())
}
struct DelegationLock(fs::File);
impl Drop for DelegationLock {
    fn drop(&mut self){unsafe{libc::flock(self.0.as_raw_fd(),libc::LOCK_UN);}}
}
fn delegation_lock(dir:&Path)->io::Result<DelegationLock>{
    let path=dir.join("bindings.lock");
    let file=OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&path)?;
    let m=file.metadata()?;let named=fs::symlink_metadata(&path)?;
    if !m.is_file() || m.nlink()!=1 || m.uid()!=unsafe{libc::geteuid()} || m.mode()&0o077!=0
        || (m.dev(),m.ino())!=(named.dev(),named.ino()){return Err(denied())}
    if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX)}!=0{return Err(io::Error::last_os_error())}
    Ok(DelegationLock(file))
}

pub struct BindingHooks {
    execution_dir: PathBuf,
    execution_ref: String,
    principal_ref: String,
    seen_delegation: bool,
}

impl BindingHooks {
    pub fn new(store:&ExecutionStore, execution_ref:&str, principal:&str) -> io::Result<Self> {
        Ok(Self {execution_dir:store.execution_directory(execution_ref)?, execution_ref:execution_ref.into(),
            principal_ref:principal.into(),seen_delegation:false})
    }
    fn delegation(&mut self) -> io::Result<Option<Delegation>> {
        let path=self.execution_dir.join("bindings.json");
        if !path.exists() && !self.seen_delegation { return Ok(None) }
        let d:Delegation=serde_json::from_slice(&fs::read(path)?).map_err(invalid)?;
        if d.version!=1 || d.execution_ref!=self.execution_ref || d.principal_ref!=self.principal_ref {
            return Err(invalid("delegation identity mismatch"));
        }
        validate_bindings(&d.bindings)?;
        self.seen_delegation=true;
        Ok(Some(d))
    }
    fn renew(&mut self) -> io::Result<()> {
        let _gate=delegation_lock(&self.execution_dir)?;
        let Some(d)=self.delegation()? else {return Ok(())};
        let now=claim::now_seconds()?;
        for b in d.bindings {
            use crate::application::process_diagnostics::{record_renewal_attempt,RenewalStage};
            if let Err(error)=claim::bind_execution(&d.authority,&b.resource_ref,Authorization::Authorized,
                &b.claim_id,&d.principal_ref,b.revision,&d.execution_ref) {
                let _=record_renewal_attempt(&self.execution_dir,&d.execution_ref,&d.principal_ref,
                    &b,RenewalStage::BindExecution,Err(&error),
                    crate::process::unix_millis().unwrap_or(now.saturating_mul(1000)));
                return Err(error);
            }
            let renewed=claim::renew_owned(&d.authority,&b.resource_ref,Authorization::Authorized,
                &b.claim_id,&d.principal_ref,b.revision,format!("unix-seconds:{}",now+b.ttl_seconds));
            // Recording a result never participates in lease authorization.
            // Preserve the canonical success/error even if telemetry is unwritable.
            let _=record_renewal_attempt(&self.execution_dir,&d.execution_ref,&d.principal_ref,
                &b,RenewalStage::RenewLease,renewed.as_ref(),
                crate::process::unix_millis().unwrap_or(now.saturating_mul(1000)));
            renewed?;
        }
        Ok(())
    }
}
impl ExecutionHooks for BindingHooks {
    fn before_spawn(&mut self,_record:&ExecutionRecord)->io::Result<()> { self.renew() }
    fn tick(&mut self,_record:&ExecutionRecord)->io::Result<()> { self.renew() }
    fn launch_valid_for_ms(&mut self,_record:&ExecutionRecord)->io::Result<u64> {
        let _gate=delegation_lock(&self.execution_dir)?;
        let Some(d)=self.delegation()? else {return Err(denied())};
        let now_ms=crate::process::unix_millis()?;
        let mut remaining=crate::process::remote::MAX_PERMIT_MS;
        for b in d.bindings {
            let c=claim::read_live_by_claim_id(&d.authority,&b.resource_ref,Authorization::Authorized,&b.claim_id)?
                .ok_or_else(denied)?;
            let descriptor=crate::ownership::resource::get(&d.authority,&b.resource_ref,Authorization::Authorized)?;
            let occupancy=claim::read_execution_binding(&d.authority,&b.resource_ref,Authorization::Authorized)?
                .ok_or_else(denied)?;
            if c.principal_ref!=d.principal_ref || descriptor.revision!=b.revision
                || occupancy.claim_id!=b.claim_id || occupancy.execution_ref!=d.execution_ref {
                return Err(denied());
            }
            if let Some(expiry)=c.expires_at.as_ref() {
                let expiry_ms=claim::parse_expiry_seconds(expiry)?.checked_mul(1000).ok_or_else(denied)?;
                remaining=remaining.min(expiry_ms.saturating_sub(now_ms));
            }
        }
        // Reserve time for the final local write. The remote permit clock is
        // anchored at the preceding remote observation, so network delay only
        // shortens this permission. Retry never changes an issued permit.
        Ok(remaining.saturating_sub(250))
    }
    fn terminal(&mut self,record:&ExecutionRecord,receipt:&CompletionReceipt)->io::Result<()> {
        if record.execution_ref!=self.execution_ref || record.principal_ref!=self.principal_ref
            || receipt.execution_ref!=record.execution_ref || receipt.node_ref!=record.executor_node_ref() {
            return Err(invalid("terminal receipt identity mismatch"));
        }
        let _gate=delegation_lock(&self.execution_dir)?;
        let Some(d)=self.delegation()? else{return Ok(())};
        if !receipt.tree_complete || receipt.process_may_be_running { return Ok(()) }
        let digest=Sha256::digest(serde_json::to_vec(receipt).map_err(invalid)?);
        let receipt_ref=format!("{}:{}",d.execution_ref,digest.iter().map(|v|format!("{v:02x}")).collect::<String>());
        for b in d.bindings {
            let current=claim::read_by_claim_id(&d.authority,&b.resource_ref,Authorization::Authorized,&b.claim_id)?;
            let Some(current)=current else {continue};
            if current.principal_ref!=d.principal_ref {return Err(denied())}
            if let Some(binding)=claim::read_execution_binding(&d.authority,&b.resource_ref,Authorization::Authorized)? {
                if binding.execution_ref!=d.execution_ref || binding.claim_id!=b.claim_id {continue}
                claim::clear_execution_binding(&d.authority,&b.resource_ref,Authorization::Authorized,
                    &b.claim_id,&d.principal_ref,&d.execution_ref,&receipt_ref)?;
            }
            match b.on_exit {
                ProcessLeaseExit::Release => claim::release(&d.authority,&b.resource_ref,Authorization::Authorized,&b.claim_id)?,
                ProcessLeaseExit::Handback => {
                    let now=claim::now_seconds()?;
                    let terminal_at=crate::process::remote_terminal_observed_at(record,&self.execution_dir)?
                        .unwrap_or(receipt.finished_at_unix_ms);
                    let until=terminal_at/1000+b.handback_seconds.unwrap_or(120);
                    if until>now && claim::ensure_live_at(&current,now).is_ok() {
                        claim::renew_owned(&d.authority,&b.resource_ref,Authorization::Authorized,
                            &b.claim_id,&d.principal_ref,b.revision,
                            format!("unix-seconds:{until}"))?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn atomic_json<T:Serialize>(path:&Path,value:&T)->io::Result<()> {
    let parent=path.parent().ok_or_else(||invalid("missing parent"))?;
    let nonce=SystemTime::now().duration_since(UNIX_EPOCH).map_err(invalid)?.as_nanos();
    let temp=parent.join(format!(".bindings-{}-{nonce}",std::process::id()));
    let mut f=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
    f.write_all(&serde_json::to_vec(value).map_err(invalid)?)?;
    f.sync_all()?;
    fs::rename(&temp,path)?;
    fs::set_permissions(path,fs::Permissions::from_mode(0o600))?;
    fs::File::open(parent)?.sync_all()
}
fn invalid(e:impl std::fmt::Display)->io::Error {io::Error::new(io::ErrorKind::InvalidData,e.to_string())}
fn denied()->io::Error {io::Error::new(io::ErrorKind::PermissionDenied,"process/resource grant unavailable")}
