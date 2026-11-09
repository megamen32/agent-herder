//! Register existing native sessions without inventing a native-create receipt.
//!
//! The configured adapter observes the exact native route. Registration records
//! addressability and local stop scopes, not native ancestry or caller selfhood.
//! Workspace announcements are metadata in the existing fenced settings table;
//! they never acquire filesystem ownership or release a stop.
use super::{GateError, ScopedAuthority};
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        adapter::SessionSnapshot,
        address::{InstanceRef, SessionAddress, SessionRef},
    },
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use crate::mcp::catalog::SessionWorkspace as WorkspaceDeclaration;

const WORKSPACE_KEY: &str = "session.workspace.v1";
const RETAIN_FOREVER: &str = "9999-12-31T23:59:59Z";

/// Implemented by trusted per-instance composition, never from MCP metadata.
/// A successful observation must already verify the configured provider and
/// account. The application additionally checks the full returned address.
pub trait BoundedSessionProbe {
    fn instance(&self) -> &InstanceRef;
    fn harness(&self) -> &str;
    fn probe_session(&self, native_session_id: &str) -> Result<SessionSnapshot, ()>;
}

pub struct RegistrationRequest<'a> {
    pub native_session_id: &'a str,
    /// None preserves an existing announcement. Use update_session_workspace
    /// with None to clear it explicitly.
    pub workspace: Option<&'a WorkspaceDeclaration>,
    pub request_key: &'a str,
    pub now: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegistrationError {
    Unauthorized,
    InvalidInput,
    ProbeUnavailable,
    IdentityMismatch,
    RequestKeyConflict,
    UnverifiedExistingSession,
    Gate(GateError),
    Store,
}

pub fn utc_now() -> Result<String, RegistrationError> {
    super::mcp_deliver::utc_now().map_err(|_| RegistrationError::InvalidInput)
}

impl From<GateError> for RegistrationError {
    fn from(value: GateError) -> Self {
        Self::Gate(value)
    }
}
impl From<rusqlite::Error> for RegistrationError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Store
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceState {
    pub workspace: Option<WorkspaceDeclaration>,
    pub revision: u64,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationResult {
    pub session_ref: String,
    pub address: SessionAddress,
    pub harness: String,
    pub workspace: Option<WorkspaceDeclaration>,
    pub workspace_revision: u64,
    /// True only when this request first added the immutable route.
    pub registered: bool,
    /// Exact request-key replays return the original result without writes.
    pub replayed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationProof {
    version: u8,
    request_key: String,
    instance: InstanceRef,
    native_session_id: String,
    session_ref: String,
    harness: String,
    authority_generation: String,
    workspace: Option<WorkspaceDeclaration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateProof {
    version: u8,
    request_key: String,
    instance: InstanceRef,
    native_session_id: String,
    session_ref: String,
    parent_ref: Option<String>,
}

/// Exact owner membership is backed by one canonical proof under the current
/// authority. Re-registration request receipts never count as extra proofs.
/// The caller must validate the store and hold its existing pinned gate/read
/// transaction, just as the pre-registration owner membership implementation.
pub fn is_owned_session(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
) -> rusqlite::Result<bool> {
    Ok(membership_source(db, principal, instance, generation, session)?.is_some())
}

/// Live owner composition must also pin the provider. Reusing an instance ID
/// for another harness cannot adopt the first provider's registered sessions.
pub fn is_owned_session_for_harness(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
    harness: &str,
) -> rusqlite::Result<bool> {
    Ok(
        membership_source_for_harness(db, principal, instance, generation, session, harness)?
            .is_some(),
    )
}

/// `verified_native_registration` does not establish native parent ancestry.
/// This shares all membership validation with delivery grant issuance.
pub fn membership_source(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
) -> rusqlite::Result<Option<&'static str>> {
    membership_source_inner(db, principal, instance, generation, session, None)
}

pub fn membership_source_for_harness(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
    harness: &str,
) -> rusqlite::Result<Option<&'static str>> {
    if !matches!(harness, "codex" | "opencode" | "zcode" | "chatgpt" | "zai") {
        return Ok(None);
    }
    membership_source_inner(db, principal, instance, generation, session, Some(harness))
}

fn membership_source_inner(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
    expected_harness: Option<&str>,
) -> rusqlite::Result<Option<&'static str>> {
    if [
        principal,
        generation,
        &session.0,
        &instance.node.0,
        &instance.instance_id,
    ]
    .iter()
    .any(|s| !valid(s))
    {
        return Ok(None);
    }
    let target = serde_json::to_string(instance).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt=db.prepare("SELECT i.request_key,i.native_receipt,b.native_session_id,i.payload_hash FROM intents i JOIN session_bindings b ON b.session_ref=?4 JOIN humanstop_sessions h ON h.session_ref=b.session_ref JOIN lineage l ON l.session_ref=b.session_ref JOIN humanstop_authority a ON a.singleton=1 WHERE i.principal=?1 AND i.target=?2 AND i.state IN ('admitted','confirmed') AND (i.payload_hash LIKE 'create-v1:%' OR i.payload_hash LIKE 'register-v1:%') AND i.native_receipt IS NOT NULL AND b.node_ref=?5 AND b.instance_id=?6 AND h.authority_generation=?3 AND a.generation=?3 AND l.creator_ref=?1 AND l.parent_ref IS NULL AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='session:'||b.session_ref)")?;
    let rows = stmt.query_map(
        params![
            principal,
            target,
            generation,
            session.0,
            instance.node.0,
            instance.instance_id
        ],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )?;
    let mut source = None;
    for row in rows {
        let (key, raw, native, payload) = row?;
        if raw.len() > 65536 || !valid(&key) || !valid(&native) {
            continue;
        }
        let matched = if payload.starts_with("create-v1:") {
            serde_json::from_str::<CreateProof>(&raw)
                .ok()
                .filter(|proof| {
                    proof.version == 1
                        && proof.request_key == key
                        && proof.instance == *instance
                        && proof.native_session_id == native
                        && proof.session_ref == session.0
                        && proof.parent_ref.is_none()
                })
                .map(|_| ("verified_fresh_root_receipt", None))
        } else {
            serde_json::from_str::<RegistrationProof>(&raw)
                .ok()
                .filter(|proof| {
                    proof.version == 1
                        && proof.request_key == key
                        && proof.instance == *instance
                        && proof.native_session_id == native
                        && proof.session_ref == session.0
                        && proof.authority_generation == generation
                        && matches!(
                            proof.harness.as_str(),
                            "codex" | "opencode" | "zcode" | "chatgpt" | "zai"
                        )
                        && validate_workspace(proof.workspace.as_ref()).is_ok()
                        && registration_payload(
                            instance,
                            &proof.harness,
                            &native,
                            proof.workspace.as_ref(),
                        )
                        .is_ok_and(|hash| payload == format!("register-v1:{hash}"))
                })
                .map(|proof| ("verified_native_registration", Some(proof.harness)))
        };
        if let Some(matched) = matched {
            if source.is_some() {
                return Ok(None);
            }
            source = Some(matched);
        }
    }
    // Count all valid canonical proofs before applying the harness check, so
    // conflicting proofs from two providers remain ambiguous, never a match.
    match source {
        Some((source, observed_harness))
            if expected_harness.is_none_or(|expected| {
                observed_harness
                    .as_deref()
                    .is_none_or(|observed| observed == expected)
            }) =>
        {
            Ok(Some(source))
        }
        _ => Ok(None),
    }
}

fn valid(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn validate_workspace(workspace: Option<&WorkspaceDeclaration>) -> Result<(), RegistrationError> {
    if workspace.is_some_and(|w| {
        !valid(&w.node_ref)
            || !valid(&w.path)
            || !w.path.starts_with('/')
            || w.project_ref.as_ref().is_some_and(|s| !valid(s))
            || w.purpose.as_ref().is_some_and(|s| !valid(s))
    }) {
        return Err(RegistrationError::InvalidInput);
    }
    Ok(())
}

fn digest<T: Serialize>(value: &T) -> Result<String, RegistrationError> {
    let bytes = serde_json::to_vec(value).map_err(|_| RegistrationError::InvalidInput)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn registration_payload(
    instance: &InstanceRef,
    harness: &str,
    native: &str,
    workspace: Option<&WorkspaceDeclaration>,
) -> Result<String, RegistrationError> {
    digest(&(1u8, instance, harness, native, workspace))
}

fn workspace_scope(session: &SessionRef) -> String {
    format!("session:{}", session.0)
}

/// Read only after the caller has authorized this exact session. This helper
/// shares the caller's transaction and does not infer access from a path.
pub fn read_workspace(
    db: &Connection,
    session: &SessionRef,
) -> Result<WorkspaceState, RegistrationError> {
    if !valid(&session.0) {
        return Err(RegistrationError::InvalidInput);
    }
    let row: Option<(String, i64, String)> = db
        .query_row(
            "SELECT value_json,revision,updated_at FROM settings WHERE scope=?1 AND setting_key=?2",
            params![workspace_scope(session), WORKSPACE_KEY],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(WorkspaceState {
            workspace: None,
            revision: 0,
            updated_at: None,
        }),
        Some((raw, revision, updated_at)) => {
            if raw.len() > 65536 || revision <= 0 || !valid(&updated_at) {
                return Err(RegistrationError::Store);
            }
            let workspace: Option<WorkspaceDeclaration> =
                serde_json::from_str(&raw).map_err(|_| RegistrationError::Store)?;
            validate_workspace(workspace.as_ref()).map_err(|_| RegistrationError::Store)?;
            Ok(WorkspaceState {
                workspace,
                revision: revision as u64,
                updated_at: Some(updated_at),
            })
        }
    }
}

fn write_workspace(
    tx: &Transaction<'_>,
    session: &SessionRef,
    workspace: Option<&WorkspaceDeclaration>,
    now: &str,
) -> Result<WorkspaceState, RegistrationError> {
    let previous = read_workspace(tx, session)?;
    if previous.workspace.as_ref() == workspace {
        return Ok(previous);
    }
    let revision = previous
        .revision
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or(RegistrationError::Store)?;
    let raw = serde_json::to_string(&workspace).map_err(|_| RegistrationError::Store)?;
    tx.execute(
        "INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(scope,setting_key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at",
        params![workspace_scope(session),WORKSPACE_KEY,raw,revision as i64,now],
    )?;
    Ok(WorkspaceState {
        workspace: workspace.cloned(),
        revision,
        updated_at: Some(now.into()),
    })
}

fn record_completed<T: Serialize>(
    tx: &Transaction<'_>,
    principal: &str,
    target: &str,
    key: &str,
    payload_hash: &str,
    receipt: Option<&str>,
    result: &T,
    now: &str,
) -> Result<(), RegistrationError> {
    let id = digest(&("registration-operation-v1", principal, target, key))?;
    let task = format!("task:registry:{id}");
    let intent = format!("intent:registry:{id}");
    let result = serde_json::to_string(result).map_err(|_| RegistrationError::Store)?;
    tx.execute(
        "INSERT INTO tasks(task_id,principal,status,created_at,updated_at,result_json) VALUES (?1,?2,'completed',?3,?3,?4)",
        params![task,principal,now,result],
    )?;
    tx.execute(
        "INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,native_receipt,created_at,updated_at,retain_until) VALUES (?1,?2,?3,?4,?5,?6,'confirmed',?7,?8,?8,?9)",
        params![intent,task,principal,target,key,payload_hash,receipt,now,RETAIN_FOREVER],
    )?;
    Ok(())
}

fn previous_result(
    db: &Connection,
    principal: &str,
    target: &str,
    key: &str,
) -> Result<Option<(String, String)>, RegistrationError> {
    let row: Option<(String, String, Option<String>, String)> = db.query_row(
        "SELECT i.payload_hash,i.state,t.result_json,t.principal FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.principal=?1 AND i.target=?2 AND i.request_key=?3",
        params![principal,target,key],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional()?;
    match row {
        None => Ok(None),
        Some((payload, state, Some(result), owner))
            if state == "confirmed" && owner == principal && result.len() <= 65536 =>
        {
            Ok(Some((payload, result)))
        }
        Some(_) => Err(RegistrationError::RequestKeyConflict),
    }
}

fn scoped_address(
    db: &Connection,
    session: &SessionRef,
    instance: &InstanceRef,
    generation: &str,
) -> Result<SessionAddress, RegistrationError> {
    let native: Option<String> = db.query_row(
        "SELECT b.native_session_id FROM session_bindings b JOIN humanstop_sessions h ON h.session_ref=b.session_ref WHERE b.session_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 AND h.authority_generation=?4 AND EXISTS(SELECT 1 FROM humanstop_scopes s WHERE s.session_ref=b.session_ref AND s.scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes s WHERE s.session_ref=b.session_ref AND s.scope_ref='session:'||b.session_ref)",
        params![session.0,instance.node.0,instance.instance_id,generation],
        |r| r.get(0),
    ).optional()?;
    let native_session_id = native
        .filter(|s| valid(s))
        .ok_or(RegistrationError::UnverifiedExistingSession)?;
    Ok(SessionAddress {
        instance: instance.clone(),
        native_session_id,
    })
}

impl ScopedAuthority {
    /// Observe once through the configured adapter, then atomically retain one
    /// distinct registration proof with immutable route and sealed stop scopes.
    /// An existing valid create/registration route is reused verbatim.
    pub fn register_existing<P: BoundedSessionProbe>(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        probe: &P,
        request: RegistrationRequest<'_>,
    ) -> Result<RegistrationResult, RegistrationError> {
        let instance = probe.instance();
        let harness = probe.harness();
        if [
            instance.node.0.as_str(),
            instance.instance_id.as_str(),
            request.native_session_id,
            request.request_key,
            request.now,
        ]
        .into_iter()
        .any(|s| !valid(s))
            || !matches!(harness, "codex" | "opencode" | "zcode" | "chatgpt" | "zai")
        {
            return Err(RegistrationError::InvalidInput);
        }
        validate_workspace(request.workspace)?;
        let target =
            serde_json::to_string(instance).map_err(|_| RegistrationError::InvalidInput)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Resource(format!("instance:{target}")),
                Action::Write,
            )
            .map_err(|_| RegistrationError::Unauthorized)?;
        let Caller::Principal(principal) = identity.caller() else {
            return Err(RegistrationError::Unauthorized);
        };
        let hash = registration_payload(
            instance,
            harness,
            request.native_session_id,
            request.workspace,
        )?;
        let address = SessionAddress {
            instance: instance.clone(),
            native_session_id: request.native_session_id.into(),
        };
        let (_gate, mut writer) = self.lock()?;
        if let Some((payload, raw)) = previous_result(
            writer.connection(),
            &principal.id.0,
            &target,
            request.request_key,
        )? {
            if payload != format!("register-v1:{hash}")
                && payload != format!("register-replay-v1:{hash}")
            {
                return Err(RegistrationError::RequestKeyConflict);
            }
            let mut result: RegistrationResult =
                serde_json::from_str(&raw).map_err(|_| RegistrationError::Store)?;
            if result.address != address
                || result.harness != harness
                || !is_owned_session_for_harness(
                    writer.connection(),
                    &principal.id.0,
                    instance,
                    &self.generation,
                    &SessionRef(result.session_ref.clone()),
                    harness,
                )?
            {
                return Err(RegistrationError::UnverifiedExistingSession);
            }
            result.replayed = true;
            return Ok(result);
        }
        let observed = probe
            .probe_session(request.native_session_id)
            .map_err(|_| RegistrationError::ProbeUnavailable)?;
        if observed.address != address {
            return Err(RegistrationError::IdentityMismatch);
        }
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx.query_row(
            "SELECT session_ref FROM session_bindings WHERE node_ref=?1 AND instance_id=?2 AND native_session_id=?3",
            params![instance.node.0,instance.instance_id,request.native_session_id], |r| r.get(0),
        ).optional()?;
        let registered = existing.is_none();
        let session = match existing {
            Some(session) => {
                let session = SessionRef(session);
                if !is_owned_session_for_harness(
                    &tx,
                    &principal.id.0,
                    instance,
                    &self.generation,
                    &session,
                    harness,
                )? {
                    return Err(RegistrationError::UnverifiedExistingSession);
                }
                session
            }
            None => SessionRef(format!(
                "session:{}",
                &digest(&("native-registration-v1", &address))?[..32]
            )),
        };
        let mut proof = None;
        if registered {
            let scope_generation =
                format!("registration:{}", digest(&(&self.generation, &session))?);
            tx.execute("INSERT INTO session_bindings(session_ref,node_ref,instance_id,native_session_id) VALUES (?1,?2,?3,?4)",
                params![session.0,instance.node.0,instance.instance_id,address.native_session_id])?;
            // This is a local registry root, not evidence of native ancestry.
            tx.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,created_at) VALUES (?1,?2,NULL,?3)",
                params![session.0,principal.id.0,request.now])?;
            tx.execute(
                "INSERT INTO humanstop_scopes(session_ref,scope_ref) VALUES (?1,'global'),(?1,?2)",
                params![session.0, format!("session:{}", session.0)],
            )?;
            tx.execute("INSERT INTO humanstop_sessions(session_ref,authority_generation,scope_generation,created_at) VALUES (?1,?2,?3,?4)",
                params![session.0,self.generation,scope_generation,request.now])?;
            if observed.human_stop {
                tx.execute("INSERT INTO humanstop_holds(scope_ref,reason,created_at,released_at) VALUES (?1,'native session stopped at registration',?2,NULL) ON CONFLICT(scope_ref) DO UPDATE SET released_at=NULL,reason=excluded.reason,created_at=excluded.created_at WHERE humanstop_holds.released_at IS NOT NULL",
                    params![format!("session:{}",session.0),request.now])?;
            }
            proof = Some(
                serde_json::to_string(&RegistrationProof {
                    version: 1,
                    request_key: request.request_key.into(),
                    instance: instance.clone(),
                    native_session_id: address.native_session_id.clone(),
                    session_ref: session.0.clone(),
                    harness: harness.into(),
                    authority_generation: self.generation.clone(),
                    workspace: request.workspace.cloned(),
                })
                .map_err(|_| RegistrationError::Store)?,
            );
        }
        let state = match request.workspace {
            Some(workspace) => write_workspace(&tx, &session, Some(workspace), request.now)?,
            None => read_workspace(&tx, &session)?,
        };
        let result = RegistrationResult {
            session_ref: session.0,
            address,
            harness: harness.into(),
            workspace: state.workspace,
            workspace_revision: state.revision,
            registered,
            replayed: false,
        };
        let prefix = if registered {
            "register-v1"
        } else {
            "register-replay-v1"
        };
        record_completed(
            &tx,
            &principal.id.0,
            &target,
            request.request_key,
            &format!("{prefix}:{hash}"),
            proof.as_deref(),
            &result,
            request.now,
        )?;
        tx.commit()?;
        Ok(result)
    }

    /// Updating metadata requires an exact session-write grant. No stop or
    /// resource ownership row is modified, including during replay.
    pub fn update_session_workspace(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &InstanceRef,
        workspace: Option<&WorkspaceDeclaration>,
        request_key: &str,
        now: &str,
    ) -> Result<WorkspaceState, RegistrationError> {
        if [
            session.0.as_str(),
            instance.node.0.as_str(),
            instance.instance_id.as_str(),
            request_key,
            now,
        ]
        .into_iter()
        .any(|s| !valid(s))
        {
            return Err(RegistrationError::InvalidInput);
        }
        validate_workspace(workspace)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Session(session.clone()),
                Action::Write,
            )
            .map_err(|_| RegistrationError::Unauthorized)?;
        let Caller::Principal(principal) = identity.caller() else {
            return Err(RegistrationError::Unauthorized);
        };
        let (_gate, mut writer) = self.lock()?;
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        scoped_address(&tx, session, instance, &self.generation)?;
        let target = format!("workspace:{}", session.0);
        let payload = format!(
            "workspace-v1:{}",
            digest(&(1u8, session, instance, workspace))?
        );
        if let Some((old, raw)) = previous_result(&tx, &principal.id.0, &target, request_key)? {
            if old != payload {
                return Err(RegistrationError::RequestKeyConflict);
            }
            return serde_json::from_str(&raw).map_err(|_| RegistrationError::Store);
        }
        let state = write_workspace(&tx, session, workspace, now)?;
        record_completed(
            &tx,
            &principal.id.0,
            &target,
            request_key,
            &payload,
            None,
            &state,
            now,
        )?;
        tx.commit()?;
        Ok(state)
    }

    pub fn session_workspace(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &InstanceRef,
    ) -> Result<WorkspaceState, RegistrationError> {
        identity
            .authorize(
                grants,
                &PrivateResource::Session(session.clone()),
                Action::Read,
            )
            .map_err(|_| RegistrationError::Unauthorized)?;
        let (_gate, writer) = self.lock()?;
        scoped_address(writer.connection(), session, instance, &self.generation)?;
        read_workspace(writer.connection(), session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::{
            scoped_stop::{BoundedFreshRootCreate, ScopeGenerationIssuer},
            target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
            target_gate::acquire_pinned,
        },
        auth::identity::{PrincipalId, VerifiedPrincipal},
        domain::{
            adapter::{SessionActivity, SubmitError},
            address::NodeRef,
        },
        store::Writer,
    };
    use rusqlite::functions::FunctionFlags;
    use std::{
        cell::Cell,
        fs::{self, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
        db: PathBuf,
        gate: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "herder-registration-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let db = root.join("state.db");
            let gate = root.join("gate");
            drop(Writer::create_file(&db).unwrap());
            let mut c = Connection::open(&db).unwrap();
            c.pragma_update(None, "foreign_keys", true).unwrap();
            c.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_| Ok(1),
            )
            .unwrap();
            for migration in [
                include_str!("../../store/migration_v1_v2.sql"),
                include_str!("../../store/migration_v2_v3.sql"),
            ] {
                let tx = c.transaction().unwrap();
                tx.execute_batch(migration).unwrap();
                tx.commit().unwrap();
            }
            drop(c);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&gate)
                .unwrap();
            let m = file.metadata().unwrap();
            let guard = acquire_pinned(&gate, m.dev(), m.ino()).unwrap();
            assert!(
                Writer::open_file(&db)
                    .unwrap()
                    .initialize_fresh_stop_authority(&guard, "authority", "now")
                    .unwrap()
            );
            drop(guard);
            drop(file);
            Self { root, db, gate }
        }
        fn authority(&self) -> ScopedAuthority {
            ScopedAuthority::new(self.db.clone(), self.gate.clone(), "authority".into()).unwrap()
        }
        fn register(
            &self,
            probe: &Probe,
            key: &str,
            workspace: Option<&WorkspaceDeclaration>,
        ) -> Result<RegistrationResult, RegistrationError> {
            self.authority().register_existing(
                &identity("owner"),
                &instance_grants("owner", probe.instance()),
                probe,
                RegistrationRequest {
                    native_session_id: "native",
                    workspace,
                    request_key: key,
                    now: "now",
                },
            )
        }
        fn db(&self) -> Writer {
            Writer::open_file(&self.db).unwrap()
        }
        fn count(&self, table: &str) -> i64 {
            self.db()
                .connection()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        }
        fn source(&self, session: &str, instance: &InstanceRef) -> Option<&'static str> {
            membership_source(
                self.db().connection(),
                "owner",
                instance,
                "authority",
                &SessionRef(session.into()),
            )
            .unwrap()
        }
    }
    fn instance(profile: &str) -> InstanceRef {
        InstanceRef {
            node: NodeRef("browser-node".into()),
            instance_id: profile.into(),
        }
    }
    fn identity(owner: &str) -> ConnectionIdentity {
        ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal {
                id: PrincipalId(owner.into()),
            }),
            None,
        )
    }
    fn instance_grants(owner: &str, instance: &InstanceRef) -> Vec<Grant> {
        vec![Grant {
            principal: PrincipalId(owner.into()),
            resource: PrivateResource::Resource(format!(
                "instance:{}",
                serde_json::to_string(instance).unwrap()
            )),
            action: Action::Write,
        }]
    }
    fn session_grants(session: &str) -> Vec<Grant> {
        [Action::Read, Action::Write]
            .into_iter()
            .map(|action| Grant {
                principal: PrincipalId("owner".into()),
                resource: PrivateResource::Session(SessionRef(session.into())),
                action,
            })
            .collect()
    }
    fn workspace(path: &str) -> WorkspaceDeclaration {
        WorkspaceDeclaration {
            node_ref: "workspace-node".into(),
            path: path.into(),
            project_ref: Some("project".into()),
            purpose: Some("implementation".into()),
        }
    }
    struct Probe {
        configured: InstanceRef,
        returned: InstanceRef,
        calls: Cell<u32>,
        fail: bool,
        stopped: bool,
        harness: &'static str,
    }
    impl Probe {
        fn new(profile: &str) -> Self {
            Self {
                configured: instance(profile),
                returned: instance(profile),
                calls: Cell::new(0),
                fail: false,
                stopped: false,
                harness: "chatgpt",
            }
        }
    }
    impl BoundedSessionProbe for Probe {
        fn instance(&self) -> &InstanceRef {
            &self.configured
        }
        fn harness(&self) -> &str {
            self.harness
        }
        fn probe_session(&self, native_session_id: &str) -> Result<SessionSnapshot, ()> {
            self.calls.set(self.calls.get() + 1);
            if self.fail {
                return Err(());
            }
            Ok(SessionSnapshot {
                address: SessionAddress {
                    instance: self.returned.clone(),
                    native_session_id: native_session_id.into(),
                },
                human_stop: self.stopped,
                activity: SessionActivity::Idle,
                capabilities: vec![],
            })
        }
    }

    #[test]
    fn registration_reopens_reuses_route_and_never_releases_stop() {
        for migrate_v4 in [false, true] {
            let f = Fixture::new();
            if migrate_v4 {
                let meta = fs::metadata(&f.gate).unwrap();
                let guard = acquire_pinned(&f.gate, meta.dev(), meta.ino()).unwrap();
                f.db().migrate_search_v4(&guard).unwrap();
            }
            let mut probe = Probe::new("profile-a");
            probe.stopped = true;
            let first = f
                .register(&probe, "first", Some(&workspace("/repo")))
                .unwrap();
            assert!(first.registered);
            assert!(!first.replayed);
            assert_eq!(
                f.source(&first.session_ref, probe.instance()),
                Some("verified_native_registration")
            );
            assert_eq!(probe.calls.get(), 1);
            probe.fail = true;
            let replay = f
                .register(&probe, "first", Some(&workspace("/repo")))
                .unwrap();
            assert!(replay.replayed);
            assert_eq!(replay.session_ref, first.session_ref);
            assert_eq!(
                probe.calls.get(),
                1,
                "exact replay must not depend on another provider read"
            );
            probe.fail = false;
            probe.stopped = false;
            let again = f.register(&probe, "new-key", None).unwrap();
            assert!(!again.registered);
            assert_eq!(again.session_ref, first.session_ref);
            assert_eq!(again.workspace, Some(workspace("/repo")));
            assert_eq!(f.count("session_bindings"), 1);
            assert_eq!(f.count("humanstop_sessions"), 1);
            assert_eq!(f.count("humanstop_scopes"), 2);
            let stopped:bool=f.db().connection().query_row("SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref=?1 AND released_at IS NULL)",
                [format!("session:{}",first.session_ref)],|r|r.get(0)).unwrap();
            assert!(stopped);
            assert_eq!(
                f.source(&first.session_ref, probe.instance()),
                Some("verified_native_registration")
            );
            let proofs: i64 = f
                .db()
                .connection()
                .query_row(
                    "SELECT count(*) FROM intents WHERE payload_hash LIKE 'register-v1:%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(proofs, 1);
            assert_eq!(
                identity("owner").require_self(None),
                Err(crate::auth::identity::IdentityError::SelfBindingRequired)
            );
        }
    }

    #[test]
    fn mismatched_or_unavailable_native_probe_creates_no_registration() {
        let f = Fixture::new();
        let mut probe = Probe::new("profile-a");
        probe.returned = instance("wrong-profile");
        assert_eq!(
            f.register(&probe, "mismatch", None),
            Err(RegistrationError::IdentityMismatch)
        );
        probe.fail = true;
        assert_eq!(
            f.register(&probe, "unavailable", None),
            Err(RegistrationError::ProbeUnavailable)
        );
        for table in [
            "session_bindings",
            "humanstop_sessions",
            "lineage",
            "tasks",
            "intents",
            "settings",
        ] {
            assert_eq!(f.count(table), 0);
        }
    }

    #[test]
    fn registration_rejects_ungranted_callers_bad_ids_and_reused_key_changes() {
        let f = Fixture::new();
        let probe = Probe::new("profile-a");
        let request = || RegistrationRequest {
            native_session_id: "native",
            workspace: None,
            request_key: "first",
            now: "now",
        };
        assert_eq!(
            f.authority()
                .register_existing(&identity("owner"), &[], &probe, request()),
            Err(RegistrationError::Unauthorized)
        );
        assert_eq!(probe.calls.get(), 0);
        let grants = instance_grants("owner", probe.instance());
        for native in ["", "  ", "bad\nidentifier"] {
            assert_eq!(
                f.authority().register_existing(
                    &identity("owner"),
                    &grants,
                    &probe,
                    RegistrationRequest {
                        native_session_id: native,
                        ..request()
                    }
                ),
                Err(RegistrationError::InvalidInput)
            );
        }
        assert_eq!(
            f.register(&probe, "first", Some(&workspace("relative"))),
            Err(RegistrationError::InvalidInput)
        );
        assert_eq!(probe.calls.get(), 0);
        f.register(&probe, "first", Some(&workspace("/one")))
            .unwrap();
        assert_eq!(
            f.register(&probe, "first", Some(&workspace("/two"))),
            Err(RegistrationError::RequestKeyConflict)
        );
        assert_eq!(
            f.authority().register_existing(
                &identity("owner"),
                &grants,
                &probe,
                RegistrationRequest {
                    native_session_id: "different",
                    workspace: Some(&workspace("/one")),
                    request_key: "first",
                    now: "now"
                }
            ),
            Err(RegistrationError::RequestKeyConflict)
        );
        assert_eq!(probe.calls.get(), 1);
        assert_eq!(
            f.authority().register_existing(
                &identity("other"),
                &instance_grants("other", probe.instance()),
                &probe,
                RegistrationRequest {
                    native_session_id: "native",
                    workspace: None,
                    request_key: "other",
                    now: "now"
                }
            ),
            Err(RegistrationError::UnverifiedExistingSession)
        );
        assert_eq!(f.count("session_bindings"), 1);
    }

    #[test]
    fn equal_native_ids_on_different_profiles_remain_distinct() {
        let f = Fixture::new();
        let a = Probe::new("profile-a");
        let mut b = Probe::new("profile-b");
        b.harness = "zai";
        let first = f.register(&a, "same-key", None).unwrap();
        let second = f.register(&b, "same-key", None).unwrap();
        assert_ne!(first.session_ref, second.session_ref);
        assert_eq!(f.count("session_bindings"), 2);
        assert!(
            !is_owned_session(
                f.db().connection(),
                "owner",
                b.instance(),
                "authority",
                &SessionRef(first.session_ref)
            )
            .unwrap()
        );
    }

    #[test]
    fn changing_configured_provider_cannot_adopt_the_registered_route() {
        let f = Fixture::new();
        let mut probe = Probe::new("profile-a");
        let first = f
            .register(&probe, "first", Some(&workspace("/original")))
            .unwrap();
        let session = SessionRef(first.session_ref);
        probe.harness = "zai";
        assert_eq!(
            f.register(&probe, "fresh-key", Some(&workspace("/changed"))),
            Err(RegistrationError::UnverifiedExistingSession)
        );
        assert_eq!(
            f.register(&probe, "first", Some(&workspace("/original"))),
            Err(RegistrationError::RequestKeyConflict)
        );
        assert!(
            !is_owned_session_for_harness(
                f.db().connection(),
                "owner",
                probe.instance(),
                "authority",
                &session,
                "zai"
            )
            .unwrap()
        );
        assert!(
            is_owned_session_for_harness(
                f.db().connection(),
                "owner",
                probe.instance(),
                "authority",
                &session,
                "chatgpt"
            )
            .unwrap()
        );
        for table in [
            "session_bindings",
            "humanstop_sessions",
            "tasks",
            "intents",
            "settings",
        ] {
            assert_eq!(f.count(table), 1);
        }
        assert_eq!(
            read_workspace(f.db().connection(), &session)
                .unwrap()
                .workspace,
            Some(workspace("/original"))
        );
    }

    #[test]
    fn workspace_updates_are_authorized_durable_clearable_and_replay_safe() {
        let f = Fixture::new();
        let probe = Probe::new("profile-a");
        let registered = f
            .register(&probe, "first", Some(&workspace("/one")))
            .unwrap();
        let session = SessionRef(registered.session_ref);
        let grants = session_grants(&session.0);
        assert_eq!(
            f.authority().update_session_workspace(
                &identity("owner"),
                &[],
                &session,
                probe.instance(),
                None,
                "no-grant",
                "now"
            ),
            Err(RegistrationError::Unauthorized)
        );
        let second = f
            .authority()
            .update_session_workspace(
                &identity("owner"),
                &grants,
                &session,
                probe.instance(),
                Some(&workspace("/two")),
                "second",
                "then",
            )
            .unwrap();
        assert_eq!(second.revision, 2);
        let third = f
            .authority()
            .update_session_workspace(
                &identity("owner"),
                &grants,
                &session,
                probe.instance(),
                Some(&workspace("/three")),
                "third",
                "later",
            )
            .unwrap();
        let replay = f
            .authority()
            .update_session_workspace(
                &identity("owner"),
                &grants,
                &session,
                probe.instance(),
                Some(&workspace("/two")),
                "second",
                "later",
            )
            .unwrap();
        assert_eq!(replay, second);
        assert_eq!(
            f.authority()
                .session_workspace(&identity("owner"), &grants, &session, probe.instance())
                .unwrap(),
            third
        );
        assert_eq!(
            f.authority().update_session_workspace(
                &identity("owner"),
                &grants,
                &session,
                probe.instance(),
                None,
                "second",
                "later"
            ),
            Err(RegistrationError::RequestKeyConflict)
        );
        let cleared = f
            .authority()
            .update_session_workspace(
                &identity("owner"),
                &grants,
                &session,
                probe.instance(),
                None,
                "clear",
                "later",
            )
            .unwrap();
        assert_eq!(cleared.workspace, None);
        assert_eq!(cleared.revision, 4);
        assert_eq!(
            f.authority()
                .session_workspace(&identity("owner"), &grants, &session, probe.instance())
                .unwrap(),
            cleared
        );
        assert_eq!(f.count("session_bindings"), 1);
    }

    struct Issuer;
    impl SessionRefIssuer for Issuer {
        fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
            Ok(SessionRef("created-ref".into()))
        }
    }
    impl ScopeGenerationIssuer for Issuer {
        fn issue(&self) -> Result<String, ()> {
            Ok("created-scope".into())
        }
    }
    struct Creator(InstanceRef);
    impl BoundedFreshRootCreate for Creator {
        fn instance(&self) -> &InstanceRef {
            &self.0
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            Ok(SessionAddress {
                instance: self.0.clone(),
                native_session_id: "native".into(),
            })
        }
    }
    #[test]
    fn existing_native_create_keeps_original_ref_and_provenance() {
        let f = Fixture::new();
        let probe = Probe::new("profile-a");
        let created = f
            .authority()
            .create_fresh_root(
                &identity("owner"),
                &instance_grants("owner", probe.instance()),
                &Creator(probe.instance().clone()),
                &Issuer,
                &Issuer,
                CreateRequest {
                    intent_id: "create-intent",
                    task_id: "create-task",
                    request_key: "create-key",
                    specification: "fresh root",
                    now: "now",
                    retain_until: RETAIN_FOREVER,
                },
            )
            .unwrap();
        assert_eq!(
            created,
            CreateResult::Created(SessionRef("created-ref".into()))
        );
        let registered = f
            .register(&probe, "register-key", Some(&workspace("/repo")))
            .unwrap();
        assert!(!registered.registered);
        assert_eq!(registered.session_ref, "created-ref");
        assert_eq!(
            f.source(&registered.session_ref, probe.instance()),
            Some("verified_fresh_root_receipt")
        );
        assert!(
            is_owned_session_for_harness(
                f.db().connection(),
                "owner",
                probe.instance(),
                "authority",
                &SessionRef(registered.session_ref),
                "chatgpt"
            )
            .unwrap()
        );
        assert_eq!(f.count("session_bindings"), 1);
        assert_eq!(f.count("humanstop_scopes"), 2);
    }

    #[test]
    fn ambiguous_registration_provenance_is_not_repaired_or_granted() {
        let f = Fixture::new();
        let probe = Probe::new("profile-a");
        let registered = f.register(&probe, "first", None).unwrap();
        let mut writer = f.db();
        let tx = writer.connection_mut().transaction().unwrap();
        let (target, payload, raw): (String, String, String) = tx
            .query_row(
                "SELECT target,payload_hash,native_receipt FROM intents",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let mut proof: RegistrationProof = serde_json::from_str(&raw).unwrap();
        proof.request_key = "duplicate".into();
        record_completed(
            &tx,
            "owner",
            &target,
            "duplicate",
            &payload,
            Some(&serde_json::to_string(&proof).unwrap()),
            &registered,
            "now",
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(f.source(&registered.session_ref, probe.instance()), None);
        assert_eq!(
            f.register(&probe, "retry", None),
            Err(RegistrationError::UnverifiedExistingSession)
        );
        assert_eq!(f.count("session_bindings"), 1);
    }
}
