//! Sealed project-release compatibility over the canonical resource owner.
//! The compatibility ledger is never a second ownership authority.
use crate::{
    application::process_bindings::ProcessRuntimeConfig,
    auth::identity::PrincipalId,
    domain::{
        address::{Authorization, SessionRef},
        resource::{ResourceClaim, ResourceRef},
    },
    ownership::{
        claim::{self, ClaimOutcome, ExecutionBinding},
        manifest::StorageAuthority,
        release_runner::TargetExecutionLock,
        resource,
    },
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, BufRead, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const AUTH: Authorization = Authorization::Authorized;
const MAX_FENCE: u64 = 9_007_199_254_740_991;
const MAX_LINE: usize = 64 * 1024;
const MAX_FILE: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeError(pub &'static str);
impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for BridgeError {}
type Result<T> = std::result::Result<T, BridgeError>;
fn invalid() -> BridgeError {
    BridgeError("invalid_request")
}
fn unavailable(_: io::Error) -> BridgeError {
    BridgeError("io_unavailable")
}
fn config_error() -> BridgeError {
    BridgeError("configuration_invalid")
}
fn proof_error() -> BridgeError {
    BridgeError("proof_mismatch")
}
fn claim_error(error: io::Error) -> BridgeError {
    match error.kind() {
        io::ErrorKind::TimedOut => BridgeError("lease_expired"),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound => proof_error(),
        io::ErrorKind::WouldBlock => BridgeError("resource_busy"),
        io::ErrorKind::AlreadyExists | io::ErrorKind::InvalidInput => {
            BridgeError("idempotency_conflict")
        }
        _ => BridgeError("io_unavailable"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseOwner {
    pub host_id: String,
    pub harness: String,
    pub native_session_id: String,
}
impl ReleaseOwner {
    fn validate(&self) -> Result<()> {
        for value in [&self.host_id, &self.harness, &self.native_session_id] {
            if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentTarget {
    pub fleet_dir: PathBuf,
    pub unit: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectMapping {
    pub project: PathBuf,
    pub resource_ref: ResourceRef,
    pub revision: u64,
    pub previous_fence: u64,
    pub deployment_target: Option<DeploymentTarget>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeConfig {
    pub version: u8,
    pub process_config: PathBuf,
    pub ledger: PathBuf,
    pub seal_id: String,
    pub principal_ref: String,
    pub mappings: Vec<ProjectMapping>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalSeal {
    version: u8,
    config: PathBuf,
    bridge: PathBuf,
    seal_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedLedger {
    version: u8,
    canonical: CanonicalSeal,
    projects: serde_json::Map<String, Value>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeAction {
    Acquire,
    Status,
    Renew,
    Release,
    Check,
    Guard,
    Finished,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRequest {
    pub action: BridgeAction,
    pub project: Option<PathBuf>,
    pub owner: Option<ReleaseOwner>,
    pub ttl_seconds: Option<u64>,
    pub token: Option<String>,
    pub fence: Option<u64>,
    pub deployment_target: Option<DeploymentTarget>,
    #[serde(default)]
    pub cleanup: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcquirePayload {
    project: PathBuf,
    resource_ref: ResourceRef,
    revision: u64,
    owner: ReleaseOwner,
    ttl_seconds: u64,
    deployment_target: Option<DeploymentTarget>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcquireIntent {
    version: u8,
    claim_id: String,
    payload: AcquirePayload,
    fence: u64,
    acquired_at_seconds: u64,
    expires_at_seconds: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatPurpose {
    schema: String,
    seal_id: String,
    project: PathBuf,
    owner: ReleaseOwner,
    fence: u64,
    revision: u64,
    ttl_seconds: u64,
    deployment_target: Option<DeploymentTarget>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FenceCounter {
    version: u8,
    resource_ref: ResourceRef,
    next_fence: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuardEvidence {
    version: u8,
    guard_id: String,
    execution_ref: String,
    resource_ref: ResourceRef,
    claim_id: String,
    principal_ref: String,
    revision: u64,
    fence: u64,
    started_at_seconds: u64,
    finished_at_seconds: Option<u64>,
}
struct HeldGuard {
    lock: TargetExecutionLock,
    mapping: ProjectMapping,
    claim_id: String,
    purpose: CompatPurpose,
    evidence: GuardEvidence,
    evidence_dir: PathBuf,
}

/// An instance holds at most one target execution lock. Dropping it releases
/// only the OS lock; unresolved durable occupancy is intentionally retained.
pub struct Bridge {
    config: BridgeConfig,
    authority: StorageAuthority,
    guard: Option<HeldGuard>,
}
impl Bridge {
    pub fn open(config_path: &Path) -> Result<Self> {
        let path = canonical_path(config_path).map_err(|_| config_error())?;
        let config: BridgeConfig = read_private(&path, true).map_err(|_| config_error())?;
        if config.version != 1
            || config.seal_id.is_empty()
            || config.seal_id.len() > 256
            || config.principal_ref.is_empty()
            || config.mappings.is_empty()
            || config.mappings.len() > 4096
        {
            return Err(config_error());
        }
        let process_path = canonical_path(&config.process_config).map_err(|_| config_error())?;
        let runtime: ProcessRuntimeConfig =
            read_private(&process_path, true).map_err(|_| config_error())?;
        runtime.validate().map_err(|_| config_error())?;
        if !runtime.authorizes_principal(&PrincipalId(config.principal_ref.clone())) {
            return Err(BridgeError("permission_denied"));
        }
        canonical_directory(&runtime.resources.root).map_err(|_| config_error())?;
        let ledger_path = canonical_path(&config.ledger).map_err(|_| config_error())?;
        let raw: Value = read_private(&ledger_path, true).map_err(|_| config_error())?;
        if contains_lease(&raw) {
            return Err(config_error());
        }
        let ledger: SealedLedger = serde_json::from_value(raw).map_err(|_| config_error())?;
        let executable = std::env::current_exe()
            .and_then(|p| p.canonicalize())
            .map_err(|_| config_error())?;
        if ledger.version != 2
            || ledger.canonical.version != 1
            || ledger.canonical.config != path
            || ledger.canonical.bridge != executable
            || ledger.canonical.seal_id != config.seal_id
            || ledger.projects.values().any(|value| !value.is_object())
        {
            return Err(config_error());
        }
        canonical_path(&ledger.canonical.bridge).map_err(|_| config_error())?;
        let binary_meta = fs::metadata(&executable).map_err(|_| config_error())?;
        if !binary_meta.is_file()
            || binary_meta.uid() != unsafe { libc::geteuid() }
            || binary_meta.mode() & 0o022 != 0
        {
            return Err(config_error());
        }
        let mut projects = HashSet::new();
        let mut resources: HashMap<ResourceRef, (u64, Option<DeploymentTarget>)> = HashMap::new();
        let mut units: HashMap<String, (ResourceRef, DeploymentTarget)> = HashMap::new();
        for mapping in &config.mappings {
            project_identity(&mapping.project, false).map_err(|_| config_error())?;
            if mapping.revision == 0
                || mapping.previous_fence >= MAX_FENCE
                || !projects.insert(mapping.project.clone())
            {
                return Err(config_error());
            }
            if let Some(target) = &mapping.deployment_target {
                validate_target(target, true).map_err(|_| config_error())?;
                // A systemd unit is the local effect identity even when a
                // different fleet directory or project alias names it.
                let identity = (mapping.resource_ref.clone(), target.clone());
                if units
                    .insert(target.unit.clone(), identity.clone())
                    .is_some_and(|previous| previous != identity)
                {
                    return Err(config_error());
                }
            }
            let value = (mapping.revision, mapping.deployment_target.clone());
            if resources
                .insert(mapping.resource_ref.clone(), value.clone())
                .is_some_and(|old| old != value)
            {
                return Err(config_error());
            }
            let descriptor = resource::get(&runtime.resources, &mapping.resource_ref, AUTH)
                .map_err(|_| config_error())?;
            if descriptor.revision != mapping.revision {
                return Err(BridgeError("revision_mismatch"));
            }
        }
        Ok(Self {
            config,
            authority: runtime.resources,
            guard: None,
        })
    }
    pub fn guarded(&self) -> bool {
        self.guard.is_some()
    }
    pub fn handle(&mut self, request: BridgeRequest) -> Result<Value> {
        if self.guard.is_some() {
            return self.guard_request(request);
        }
        if request.cleanup || request.action == BridgeAction::Finished {
            return Err(invalid());
        }
        let mapping = self.mapping(&request)?.clone();
        self.validate_target_request(&mapping, request.deployment_target.as_ref())?;
        self.validate_revision(&mapping)?;
        match request.action {
            BridgeAction::Acquire => self.acquire(&mapping, &request),
            BridgeAction::Status => self.status(&mapping),
            BridgeAction::Check => {
                let (current, _) = self.verify(&mapping, &request, true)?;
                self.lease(&mapping, &current)
            }
            BridgeAction::Renew => {
                let (current, _) = self.verify(&mapping, &request, true)?;
                let until = claim::now_seconds()
                    .map_err(unavailable)?
                    .checked_add(ttl(request.ttl_seconds)?)
                    .ok_or_else(invalid)?;
                let current = claim::renew_owned(
                    &self.authority,
                    &mapping.resource_ref,
                    AUTH,
                    &current.claim_id,
                    &self.config.principal_ref,
                    mapping.revision,
                    format!("unix-seconds:{until}"),
                )
                .map_err(claim_error)?;
                self.lease(&mapping, &current)
            }
            BridgeAction::Release => {
                let (current, _) = self.verify(&mapping, &request, false)?;
                claim::release(
                    &self.authority,
                    &mapping.resource_ref,
                    AUTH,
                    &current.claim_id,
                )
                .map_err(claim_error)?;
                Ok(json!({"released":true}))
            }
            BridgeAction::Guard => self.begin_guard(mapping, &request),
            BridgeAction::Finished => Err(invalid()),
        }
    }
    fn mapping<'a>(&'a self, request: &BridgeRequest) -> Result<&'a ProjectMapping> {
        let project = request.project.as_ref().ok_or_else(invalid)?;
        if !project.is_absolute() {
            return Err(invalid());
        }
        let identity = match project.canonicalize() {
            Ok(p) => p,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                project_identity(project, false).map_err(|_| BridgeError("project_unmapped"))?;
                project.clone()
            }
            Err(_) => return Err(BridgeError("project_unmapped")),
        };
        self.config
            .mappings
            .iter()
            .find(|m| m.project == identity)
            .ok_or(BridgeError("project_unmapped"))
    }
    fn validate_revision(&self, mapping: &ProjectMapping) -> Result<()> {
        let descriptor =
            resource::get(&self.authority, &mapping.resource_ref, AUTH).map_err(unavailable)?;
        if descriptor.revision != mapping.revision {
            return Err(BridgeError("revision_mismatch"));
        }
        Ok(())
    }
    fn validate_target_request(
        &self,
        mapping: &ProjectMapping,
        target: Option<&DeploymentTarget>,
    ) -> Result<()> {
        if let Some(target) = target {
            let actual = validate_target(target, false)?;
            if mapping.deployment_target.as_ref() != Some(&actual) {
                return Err(proof_error());
            }
        }
        Ok(())
    }
    fn purpose(&self, current: &ResourceClaim) -> Result<CompatPurpose> {
        let purpose: CompatPurpose =
            serde_json::from_str(&current.purpose).map_err(|_| proof_error())?;
        if purpose.schema != "herder.project-release.v1"
            || purpose.seal_id != self.config.seal_id
            || current.principal_ref != self.config.principal_ref
            || purpose.fence == 0
            || purpose.fence > MAX_FENCE
        {
            return Err(proof_error());
        }
        purpose.owner.validate().map_err(|_| proof_error())?;
        Ok(purpose)
    }
    fn verify(
        &self,
        mapping: &ProjectMapping,
        request: &BridgeRequest,
        live: bool,
    ) -> Result<(ResourceClaim, CompatPurpose)> {
        let owner = request.owner.as_ref().ok_or_else(invalid)?;
        owner.validate()?;
        let token = request.token.as_deref().ok_or_else(invalid)?;
        let nonce = token_claim_id(token)?;
        let fence = request
            .fence
            .filter(|v| *v > 0 && *v <= MAX_FENCE)
            .ok_or_else(invalid)?;
        let current = if live {
            claim::read_live_by_claim_id(&self.authority, &mapping.resource_ref, AUTH, &nonce)
        } else {
            claim::read_by_claim_id(&self.authority, &mapping.resource_ref, AUTH, &nonce)
        }
        .map_err(claim_error)?
        .ok_or_else(proof_error)?;
        let purpose = self.purpose(&current)?;
        if purpose.owner != *owner
            || purpose.fence != fence
            || purpose.revision != mapping.revision
            || purpose.deployment_target != mapping.deployment_target
        {
            return Err(proof_error());
        }
        Ok((current, purpose))
    }
    fn lease(&self, mapping: &ProjectMapping, current: &ResourceClaim) -> Result<Value> {
        let purpose = self.purpose(current)?;
        let acquired = claim::parse_expiry_seconds(&current.acquired_at).map_err(unavailable)?;
        let expiry = current
            .expires_at
            .as_deref()
            .ok_or_else(proof_error)
            .and_then(|v| claim::parse_expiry_seconds(v).map_err(unavailable))?;
        let mut lease = json!({"project":mapping.project,"owner":purpose.owner,"fence":purpose.fence,
            "acquiredAt":acquired.checked_mul(1000).ok_or_else(invalid)?,
            "expiresAt":expiry.checked_mul(1000).ok_or_else(invalid)?});
        if let Some(target) = &purpose.deployment_target {
            lease["deploymentTarget"] = json!(target)
        }
        Ok(lease)
    }
    fn resource_dir(&self, mapping: &ProjectMapping) -> Result<PathBuf> {
        let (dir, _) = self
            .authority
            .read_local_resource_marker(&mapping.resource_ref, AUTH)
            .map_err(unavailable)?;
        canonical_directory(&dir).map_err(unavailable)?;
        Ok(dir)
    }
    fn counter(&self, mapping: &ProjectMapping, dir: &Path) -> Result<FenceCounter> {
        let seed = self
            .config
            .mappings
            .iter()
            .filter(|m| m.resource_ref == mapping.resource_ref)
            .map(|m| m.previous_fence + 1)
            .max()
            .ok_or_else(config_error)?;
        let mut counter = match read_private::<FenceCounter>(&dir.join("compat-fence.json"), false)
        {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound => FenceCounter {
                version: 1,
                resource_ref: mapping.resource_ref.clone(),
                next_fence: seed,
            },
            Err(e) => return Err(unavailable(e)),
        };
        if counter.version != 1
            || counter.resource_ref != mapping.resource_ref
            || counter.next_fence == 0
            || counter.next_fence > MAX_FENCE
        {
            return Err(config_error());
        }
        counter.next_fence = counter.next_fence.max(seed);
        Ok(counter)
    }
    fn occupancy(&self, mapping: &ProjectMapping) -> Result<bool> {
        if crate::ownership::migration_hold::read(&self.authority, &mapping.resource_ref, AUTH).map_err(unavailable)?.is_some() {
            return Ok(true);
        }
        if claim::read_execution_binding(&self.authority, &mapping.resource_ref, AUTH)
            .map_err(unavailable)?
            .is_some_and(|b| b.resolved_receipt.is_none())
        {
            return Ok(true);
        }
        match TargetExecutionLock::try_acquire(&self.authority, &mapping.resource_ref, AUTH) {
            Ok(_) => Ok(false),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(true),
            Err(e) => Err(unavailable(e)),
        }
    }
    fn status(&self, mapping: &ProjectMapping) -> Result<Value> {
        let dir = self.resource_dir(mapping)?;
        let _gate = compat_lock(&dir).map_err(unavailable)?;
        let counter = self.counter(mapping, &dir)?;
        let current = claim::read_current(&self.authority, &mapping.resource_ref, AUTH)
            .map_err(unavailable)?;
        let now = claim::now_seconds().map_err(unavailable)?;
        let occupied = self.occupancy(mapping)?;
        let live = current
            .as_ref()
            .is_some_and(|c| claim::ensure_live_at(c, now).is_ok());
        let effective = if live || occupied {
            current.as_ref()
        } else {
            None
        };
        let lease = effective
            .and_then(|c| self.lease(mapping, c).ok())
            .unwrap_or(Value::Null);
        let remaining = effective
            .map(|c| remaining_seconds(c, now))
            .transpose()?
            .unwrap_or(0);
        let contact = lease
            .get("owner")
            .map(|owner| {
                json!({"tool":"SendMessage","hostId":owner["hostId"],
            "harness":owner["harness"],"sessionId":owner["nativeSessionId"]})
            })
            .unwrap_or(Value::Null);
        let canonical_busy = (effective.is_some() || occupied) && lease.is_null();
        let migration = crate::ownership::migration_hold::read(&self.authority, &mapping.resource_ref, AUTH).map_err(unavailable)?;
        let current_claim = if canonical_busy {
            effective.map(public_claim).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(
            json!({"lease":lease,"remainingSeconds":remaining,"nextFence":counter.next_fence,
            "deploymentInProgress":occupied,"contact":contact,"resourceRef":mapping.resource_ref,
            "revision":mapping.revision,"canonicalBusy":canonical_busy,"currentClaim":current_claim,"migrationQuarantine":migration}),
        )
    }
    fn acquire(&self, mapping: &ProjectMapping, request: &BridgeRequest) -> Result<Value> {
        let owner = request.owner.clone().ok_or_else(invalid)?;
        owner.validate()?;
        let duration = ttl(request.ttl_seconds)?;
        let token = match &request.token {
            Some(v) => checked_token(v)?,
            None => hex(&random_bytes::<32>().map_err(unavailable)?),
        };
        let nonce = token_claim_id(&token)?;
        // A lost-ACK retry may still recover its owner after the repository
        // moved. A fresh acquisition needs the configured project to exist.
        if claim::read_by_claim_id(&self.authority, &mapping.resource_ref, AUTH, &nonce)
            .map_err(unavailable)?
            .is_none()
        {
            project_identity(&mapping.project, true)
                .map_err(|_| BridgeError("project_unavailable"))?;
        }

        let payload = AcquirePayload {
            project: mapping.project.clone(),
            resource_ref: mapping.resource_ref.clone(),
            revision: mapping.revision,
            owner,
            ttl_seconds: duration,
            deployment_target: mapping.deployment_target.clone(),
        };
        let dir = self.resource_dir(mapping)?;
        let _gate = compat_lock(&dir).map_err(unavailable)?;
        let intent_dir = dir.join("compat-intents");
        create_private_directory(&intent_dir).map_err(unavailable)?;
        let path = intent_dir.join(format!("{nonce}.json"));
        let intent = match read_private::<AcquireIntent>(&path, false) {
            Ok(intent) => {
                if intent.version != 1 || intent.claim_id != nonce || intent.payload != payload {
                    return Err(BridgeError("idempotency_conflict"));
                }
                intent
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let now = claim::now_seconds().map_err(unavailable)?;
                // A busy owner is authoritative. Do not reserve tokens/fences for
                // requests that have no chance to acquire the resource.
                if let Some(current) =
                    claim::read_current(&self.authority, &mapping.resource_ref, AUTH)
                        .map_err(unavailable)?
                {
                    if claim::ensure_live_at(&current, now).is_ok() || self.occupancy(mapping)? {
                        return self.busy(mapping, Some(&current), now);
                    }
                } else if self.occupancy(mapping)? {
                    return self.busy(mapping, None, now);
                }
                let mut counter = self.counter(mapping, &dir)?;
                let fence = counter.next_fence;
                if fence >= MAX_FENCE {
                    return Err(BridgeError("fence_exhausted"));
                }
                counter.next_fence += 1;
                // A crash can consume a fence, but cannot reuse one.
                atomic_json(&dir.join("compat-fence.json"), &counter).map_err(unavailable)?;
                let intent = AcquireIntent {
                    version: 1,
                    claim_id: nonce.clone(),
                    payload: payload.clone(),
                    fence,
                    acquired_at_seconds: now,
                    expires_at_seconds: now.checked_add(duration).ok_or_else(invalid)?,
                };
                atomic_json(&path, &intent).map_err(unavailable)?;
                intent
            }
            Err(e) => return Err(unavailable(e)),
        };
        if intent.fence == 0
            || intent.fence > MAX_FENCE
            || intent.expires_at_seconds <= intent.acquired_at_seconds
        {
            return Err(config_error());
        }
        let purpose = CompatPurpose {
            schema: "herder.project-release.v1".into(),
            seal_id: self.config.seal_id.clone(),
            project: intent.payload.project.clone(),
            owner: intent.payload.owner.clone(),
            fence: intent.fence,
            revision: mapping.revision,
            ttl_seconds: intent.payload.ttl_seconds,
            deployment_target: intent.payload.deployment_target.clone(),
        };
        let requested = ResourceClaim {
            resource_ref: mapping.resource_ref.clone(),
            principal_ref: self.config.principal_ref.clone(),
            session_ref: Some(SessionRef(format!(
                "{}:{}:{}",
                purpose.owner.host_id, purpose.owner.harness, purpose.owner.native_session_id
            ))),
            claim_id: nonce.clone(),
            purpose: serde_json::to_string(&purpose).map_err(|_| config_error())?,
            acquired_at: format!("unix-seconds:{}", intent.acquired_at_seconds),
            expires_at: Some(format!("unix-seconds:{}", intent.expires_at_seconds)),
        };
        match claim::claim_recovering_intent(
            &self.authority,
            &mapping.resource_ref,
            AUTH,
            requested,
        )
        .map_err(claim_error)?
        {
            ClaimOutcome::Acquired | ClaimOutcome::AlreadyOwned => {
                let current = claim::read_live_by_claim_id(
                    &self.authority,
                    &mapping.resource_ref,
                    AUTH,
                    &nonce,
                )
                .map_err(claim_error)?
                .ok_or_else(proof_error)?;
                Ok(json!({"acquired":true,"lease":self.lease(mapping,&current)?,"token":token}))
            }
            ClaimOutcome::Busy => {
                let current = claim::read_current(&self.authority, &mapping.resource_ref, AUTH)
                    .map_err(unavailable)?;
                self.busy(
                    mapping,
                    current.as_ref(),
                    claim::now_seconds().map_err(unavailable)?,
                )
            }
        }
    }
    fn busy(
        &self,
        mapping: &ProjectMapping,
        current: Option<&ResourceClaim>,
        now: u64,
    ) -> Result<Value> {
        let lease = current
            .and_then(|c| self.lease(mapping, c).ok())
            .unwrap_or(Value::Null);
        let generic = lease.is_null();
        Ok(json!({"acquired":false,"lease":lease,
            "remainingSeconds":current.map(|c|remaining_seconds(c,now)).transpose()?.unwrap_or(0),
            "canonicalBusy":generic,"currentClaim":if generic {current.map(public_claim).unwrap_or(Value::Null)}else{Value::Null}}))
    }
    fn begin_guard(&mut self, mapping: ProjectMapping, request: &BridgeRequest) -> Result<Value> {
        let lock = TargetExecutionLock::try_acquire(&self.authority, &mapping.resource_ref, AUTH)
            .map_err(claim_error)?;
        let (current, purpose) = self.verify(&mapping, request, true)?;
        lock.verify_owned_claim(
            &self.authority,
            AUTH,
            &current.claim_id,
            &self.config.principal_ref,
            mapping.revision,
        )
        .map_err(claim_error)?;
        if claim::read_execution_binding(&self.authority, &mapping.resource_ref, AUTH)
            .map_err(unavailable)?
            .is_some_and(|b| b.resolved_receipt.is_none())
        {
            return Err(BridgeError("resource_busy"));
        }
        let guard_id = format!("guard-{}", hex(&random_bytes::<16>().map_err(unavailable)?));
        let evidence_dir = self.resource_dir(&mapping)?.join("compat-guards");
        create_private_directory(&evidence_dir).map_err(unavailable)?;
        let evidence = GuardEvidence {
            version: 1,
            guard_id: guard_id.clone(),
            execution_ref: format!("release-{guard_id}"),
            resource_ref: mapping.resource_ref.clone(),
            claim_id: current.claim_id.clone(),
            principal_ref: self.config.principal_ref.clone(),
            revision: mapping.revision,
            fence: purpose.fence,
            started_at_seconds: claim::now_seconds().map_err(unavailable)?,
            finished_at_seconds: None,
        };
        atomic_json(
            &evidence_dir.join(format!("{guard_id}.intent.json")),
            &evidence,
        )
        .map_err(unavailable)?;
        claim::bind_execution(
            &self.authority,
            &mapping.resource_ref,
            AUTH,
            &current.claim_id,
            &self.config.principal_ref,
            mapping.revision,
            &evidence.execution_ref,
        )
        .map_err(claim_error)?;
        let reply =
            json!({"guarded":true,"guardId":guard_id,"lease":self.lease(&mapping,&current)?});
        self.guard = Some(HeldGuard {
            lock,
            mapping,
            claim_id: current.claim_id,
            purpose,
            evidence,
            evidence_dir,
        });
        Ok(reply)
    }
    fn guard_request(&mut self, request: BridgeRequest) -> Result<Value> {
        if request.project.is_some()
            || request.owner.is_some()
            || request.token.is_some()
            || request.fence.is_some()
            || request.deployment_target.is_some()
            || request.ttl_seconds.is_some()
            || !matches!(request.action, BridgeAction::Check | BridgeAction::Finished)
            || (request.action == BridgeAction::Finished && request.cleanup)
        {
            return Err(invalid());
        }
        let guard = self.guard.as_ref().ok_or_else(invalid)?;
        self.validate_revision(&guard.mapping)?;
        let current = if request.cleanup || request.action == BridgeAction::Finished {
            // This exact proof was admitted live and the execution lock has
            // never been released. Cleanup cannot create or revive a guard.
            claim::read_by_claim_id(
                &self.authority,
                &guard.mapping.resource_ref,
                AUTH,
                &guard.claim_id,
            )
            .map_err(claim_error)?
            .ok_or_else(proof_error)?
        } else {
            guard
                .lock
                .verify_owned_claim(
                    &self.authority,
                    AUTH,
                    &guard.claim_id,
                    &self.config.principal_ref,
                    guard.mapping.revision,
                )
                .map_err(claim_error)?
        };
        let purpose = self.purpose(&current)?;
        if purpose.owner != guard.purpose.owner || purpose.fence != guard.purpose.fence {
            return Err(proof_error());
        }
        let binding =
            claim::read_execution_binding(&self.authority, &guard.mapping.resource_ref, AUTH)
                .map_err(unavailable)?
                .ok_or_else(proof_error)?;
        validate_binding(&binding, guard)?;
        if request.action == BridgeAction::Check {
            if binding.resolved_receipt.is_some() {
                return Err(proof_error());
            }
            return self.lease(&guard.mapping, &current);
        }
        let path = guard
            .evidence_dir
            .join(format!("{}.receipt.json", guard.evidence.guard_id));
        let terminal = match read_private::<GuardEvidence>(&path, false) {
            Ok(v) => {
                let mut expected = guard.evidence.clone();
                expected.finished_at_seconds = v.finished_at_seconds;
                if v != expected || v.finished_at_seconds.is_none() {
                    return Err(proof_error());
                }
                v
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let mut v = guard.evidence.clone();
                v.finished_at_seconds = Some(claim::now_seconds().map_err(unavailable)?);
                atomic_json(&path, &v).map_err(unavailable)?;
                v
            }
            Err(e) => return Err(unavailable(e)),
        };
        let digest = hex(&Sha256::digest(
            serde_json::to_vec(&terminal).map_err(|_| config_error())?,
        ));
        let receipt_ref = format!("{}:{digest}", terminal.execution_ref);
        claim::clear_execution_binding(
            &self.authority,
            &guard.mapping.resource_ref,
            AUTH,
            &guard.claim_id,
            &self.config.principal_ref,
            &terminal.execution_ref,
            &receipt_ref,
        )
        .map_err(claim_error)?;
        let result = json!({"finished":true,"guardId":terminal.guard_id,"receiptRef":receipt_ref});
        self.guard.take(); // Drops only the OS lock after durable reconciliation.
        Ok(result)
    }
}
fn validate_binding(binding: &ExecutionBinding, guard: &HeldGuard) -> Result<()> {
    if binding.resource_ref != guard.mapping.resource_ref
        || binding.claim_id != guard.claim_id
        || binding.principal_ref != guard.evidence.principal_ref
        || binding.resource_revision != guard.mapping.revision
        || binding.execution_ref != guard.evidence.execution_ref
    {
        return Err(proof_error());
    }
    Ok(())
}
fn public_claim(claim: &ResourceClaim) -> Value {
    json!({"resourceRef":claim.resource_ref,"claimId":claim.claim_id,"principalRef":claim.principal_ref,
        "sessionRef":claim.session_ref,"acquiredAt":claim.acquired_at,"expiresAt":claim.expires_at})
}
fn remaining_seconds(claim: &ResourceClaim, now: u64) -> Result<u64> {
    match &claim.expires_at {
        Some(v) => Ok(claim::parse_expiry_seconds(v)
            .map_err(unavailable)?
            .saturating_sub(now)),
        None => Ok(0),
    }
}
fn ttl(value: Option<u64>) -> Result<u64> {
    let value = value.unwrap_or(300);
    if !(30..=1800).contains(&value) {
        return Err(invalid());
    }
    Ok(value)
}
fn checked_token(value: &str) -> Result<String> {
    if value.len() != 64 || !value.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    Ok(value.to_owned())
}
/// Secret token -> stable UUID nonce. The nonce is an identifier, never proof.
pub fn token_claim_id(token: &str) -> Result<String> {
    let token = checked_token(token)?;
    let digest = Sha256::digest(token.as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id[6] = (id[6] & 0x0f) | 0x50;
    id[8] = (id[8] & 0x3f) | 0x80;
    let h = hex(&id);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
#[cfg(target_os = "linux")]
fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    let mut offset = 0;
    while offset < N {
        let read = unsafe { libc::getrandom(bytes[offset..].as_mut_ptr().cast(), N - offset, 0) };
        if read < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if read == 0 {
            return Err(io::Error::other("entropy unavailable"));
        }
        offset += read as usize;
    }
    Ok(bytes)
}
#[cfg(target_os = "macos")]
fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    // Darwin getentropy fills at most 256 bytes per call, or fails entirely.
    for chunk in bytes.chunks_mut(256) {
        loop {
            let result = unsafe { libc::getentropy(chunk.as_mut_ptr().cast(), chunk.len()) };
            if result == 0 { break; }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
        }
    }
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn contains_lease(value: &Value) -> bool {
    match value {
        Value::Object(o) => o.contains_key("lease") || o.values().any(contains_lease),
        Value::Array(a) => a.iter().any(contains_lease),
        _ => false,
    }
}
fn canonical_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let actual = path.canonicalize()?;
    if actual != path {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(actual)
}
/// A project path is a stable, explicitly mapped identifier, not authority
/// storage. Moving the repository must not prevent its old owner from cleanup.
fn project_identity(path: &Path, require_exists: bool) -> io::Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if !m.is_dir() || path.canonicalize()? != path {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound && !require_exists => {
            let mut parent = path
                .parent()
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            loop {
                match fs::symlink_metadata(parent) {
                    Ok(_) => break,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        parent = parent
                            .parent()
                            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
                    }
                    Err(e) => return Err(e),
                }
            }
            if parent.canonicalize()? != parent {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
        }
        Err(e) => return Err(e),
    }
    Ok(())
}
fn canonical_directory(path: &Path) -> io::Result<()> {
    canonical_path(path)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(())
}
fn validate_target(target: &DeploymentTarget, strict: bool) -> Result<DeploymentTarget> {
    if !target.fleet_dir.is_absolute()
        || target.unit.is_empty()
        || target.unit.len() > 255
        || !target
            .unit
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@-".contains(&b))
    {
        return Err(invalid());
    }
    let actual = target.fleet_dir.canonicalize().map_err(|_| invalid())?;
    if strict && actual != target.fleet_dir {
        return Err(invalid());
    }
    if !actual.is_dir() {
        return Err(invalid());
    }
    Ok(DeploymentTarget {
        fleet_dir: actual,
        unit: target.unit.clone(),
    })
}
fn read_private<T: DeserializeOwned>(path: &Path, strict_snapshot: bool) -> io::Result<T> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    let m = f.metadata()?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.nlink() > 1
        || (strict_snapshot && m.nlink() != 1)
        || m.len() > MAX_FILE
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    if strict_snapshot {
        let named = fs::symlink_metadata(path)?;
        if (named.dev(), named.ino()) != (m.dev(), m.ino()) {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
    }
    let mut bytes = Vec::new();
    f.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    canonical_directory(path)
}
fn compat_lock(dir: &Path) -> io::Result<File> {
    let path = dir.join("compat.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let m = file.metadata()?;
    let named = fs::symlink_metadata(&path)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || (m.dev(), m.ino()) != (named.dev(), named.ino())
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    file.lock()?;
    Ok(file)
}
fn atomic_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    canonical_directory(parent)?;
    let temp = parent.join(format!(
        ".bridge-{}-{}.tmp",
        std::process::id(),
        hex(&random_bytes::<16>()?)
    ));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)?;
    let result = (|| {
        serde_json::to_writer(&mut f, value).map_err(io::Error::other)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

/// One bounded JSON line produces one envelope. No request or credential is
/// copied into error text. EOF deliberately leaves a held guard unresolved.
pub fn serve_json_lines(
    config_path: &Path,
    mut input: impl BufRead,
    mut output: impl Write,
) -> io::Result<()> {
    let mut bridge = match Bridge::open(config_path) {
        Ok(v) => v,
        Err(error) => {
            write_envelope(&mut output, Err(error))?;
            return Ok(());
        }
    };
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_LINE {
            write_envelope(&mut output, Err(invalid()))?;
            return Ok(());
        }
        let request = serde_json::from_slice::<BridgeRequest>(&line);
        let finished = request
            .as_ref()
            .is_ok_and(|r| r.action == BridgeAction::Finished);
        let result = request
            .map_err(|_| invalid())
            .and_then(|r| bridge.handle(r));
        let success = result.is_ok();
        write_envelope(&mut output, result)?;
        if finished && success {
            return Ok(());
        }
    }
}
fn write_envelope(output: &mut impl Write, result: Result<Value>) -> io::Result<()> {
    let envelope = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error.0}),
    };
    serde_json::to_writer(&mut *output, &envelope).map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}
