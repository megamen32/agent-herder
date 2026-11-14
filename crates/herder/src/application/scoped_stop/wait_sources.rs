//! Exact, read-only native turn proofs routed through configured canonical owners.
use super::{ScopedAuthority, create_prompt::FreshSessionGrantPolicy};
use crate::{
    application::target_gate::PinnedTargetGateGuard,
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource},
    domain::{
        adapter::ReadError,
        address::{InstanceRef, SessionAddress, SessionRef},
    },
    store::Writer,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    os::unix::fs::MetadataExt,
    sync::{Arc, OnceLock},
};

pub(super) type Result<T> = std::result::Result<T, &'static str>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTurnStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}
impl NativeTurnStatus {
    pub fn terminal(&self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeTurn {
    pub turn_id: String,
    pub status: NativeTurnStatus,
}

/// A missing turn or idle state is never a completion receipt.
pub trait NativeTurnReader: Send + Sync + 'static {
    fn current_turn(
        &self,
        target: &SessionAddress,
    ) -> std::result::Result<Option<NativeTurn>, ReadError>;
    fn observed_turn(
        &self,
        target: &SessionAddress,
        turn_id: &str,
    ) -> std::result::Result<Option<NativeTurn>, ReadError> {
        self.current_turn(target)
            .map(|turn| turn.filter(|t| t.turn_id == turn_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeOwner {
    pub harness: String,
    pub native_session_id: String,
    pub node_ref: String,
    pub instance_ref: String,
}
impl NativeOwner {
    pub(super) fn address(&self) -> SessionAddress {
        SessionAddress {
            instance: InstanceRef {
                node: crate::domain::address::NodeRef(self.node_ref.clone()),
                instance_id: self.instance_ref.clone(),
            },
            native_session_id: self.native_session_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionProof {
    pub session_ref: String,
    pub owner: NativeOwner,
    pub authority_ref: String,
    pub authority_generation: String,
    pub scope_generation: String,
    pub stop_epochs: BTreeMap<String, u64>,
    pub native_turn: Option<NativeTurn>,
}

pub struct DependencySource {
    pub(super) authority: Arc<ScopedAuthority>,
    pub(super) instance: InstanceRef,
    harness: String,
    principal: PrincipalId,
    grants: Vec<Grant>,
    policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
    reader: Arc<dyn NativeTurnReader>,
}
impl DependencySource {
    pub(super) fn harness(&self) -> &str {
        &self.harness
    }
    pub fn new(
        authority: Arc<ScopedAuthority>,
        instance: InstanceRef,
        harness: String,
        principal: PrincipalId,
        grants: Vec<Grant>,
        policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
        reader: Arc<dyn NativeTurnReader>,
    ) -> Self {
        Self {
            authority,
            instance,
            harness,
            principal,
            grants,
            policy,
            reader,
        }
    }
    pub(super) fn principal<'a>(&self, identity: &'a ConnectionIdentity) -> Result<&'a str> {
        let Caller::Principal(p) = identity.caller() else {
            return Err("unauthorized");
        };
        if p.id != self.principal {
            return Err("unauthorized");
        }
        Ok(&p.id.0)
    }
    pub(super) fn resolve_native(
        &self,
        identity: &ConnectionIdentity,
        native: &str,
        node: Option<&str>,
    ) -> Result<Option<Value>> {
        self.principal(identity)?;
        if !valid_id(native) || node.is_some_and(|n| !valid_id(n)) {
            return Err("invalid_native_session");
        }
        if node.is_some_and(|n| n != self.instance.node.0) {
            return Ok(None);
        }
        let rows = {
            let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
            let mut stmt=writer.connection().prepare("SELECT session_ref FROM session_bindings WHERE node_ref=?1 AND instance_id=?2 AND native_session_id=?3")
                .map_err(|_|"store_unavailable")?;
            let rows = stmt
                .query_map(
                    rusqlite::params![self.instance.node.0, self.instance.instance_id, native],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| "store_unavailable")?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| "store_unavailable")?;
            rows
        };
        match rows.as_slice() {
            [] => Ok(None),
            [session] => {
                let session = SessionRef(session.clone());
                let grants = self.grants(identity, &session, false)?;
                let (address, _) = self
                    .authority
                    .resolve_session_read(identity, &grants, &session, &self.instance)
                    .map_err(|_| "session_unavailable")?;
                Ok(Some(
                    json!({"session_ref":session.0,"owner":self.owner(&address),"complete":true}),
                ))
            }
            _ => Err("ambiguous_native_session"),
        }
    }
    fn owner(&self, address: &SessionAddress) -> NativeOwner {
        NativeOwner {
            harness: self.harness.clone(),
            native_session_id: address.native_session_id.clone(),
            node_ref: self.instance.node.0.clone(),
            instance_ref: self.instance.instance_id.clone(),
        }
    }
    fn gate_identity(&self) -> Result<(u64, u64)> {
        let m = std::fs::symlink_metadata(&self.authority.gate).map_err(|_| "scope_unavailable")?;
        if !m.is_file() {
            return Err("scope_unavailable");
        }
        Ok((m.dev(), m.ino()))
    }
    fn authority_ref(&self) -> Result<String> {
        let bytes = serde_json::to_vec(&(
            &self.authority.db,
            &self.authority.gate,
            &self.authority.generation,
            self.gate_identity()?,
        ))
        .map_err(|_| "scope_unavailable")?;
        Ok(super::wait_automation::hex(&Sha256::digest(bytes)))
    }
    pub(super) fn grants(
        &self,
        identity: &ConnectionIdentity,
        session: &SessionRef,
        write: bool,
    ) -> Result<Vec<Grant>> {
        let Caller::Principal(p) = identity.caller() else {
            return Err("unauthorized");
        };
        if p.id != self.principal {
            return Err("unauthorized");
        }
        let mut grants = self.grants.clone();
        let read = self
            .policy
            .session_read_grant(&p.id, &self.instance, session)
            .map_err(|_| "policy_unavailable")?;
        if let Some(g) = read {
            if g.principal != p.id
                || g.action != Action::Read
                || g.resource != PrivateResource::Session(session.clone())
            {
                return Err("unauthorized");
            }
            grants.push(g);
        }
        identity
            .authorize(
                &grants,
                &PrivateResource::Session(session.clone()),
                Action::Read,
            )
            .map_err(|_| "session_grant_required")?;
        if write {
            if let Some(g) = self
                .policy
                .session_write_grant(&p.id, &self.instance, session)
                .map_err(|_| "policy_unavailable")?
            {
                if g.principal != p.id
                    || g.action != Action::Write
                    || g.resource != PrivateResource::Session(session.clone())
                {
                    return Err("unauthorized");
                }
                grants.push(g);
            }
            identity
                .authorize(
                    &grants,
                    &PrivateResource::Session(session.clone()),
                    Action::Write,
                )
                .map_err(|_| "session_grant_required")?;
        }
        Ok(grants)
    }
    fn maybe_address(
        &self,
        identity: &ConnectionIdentity,
        session: &SessionRef,
    ) -> Result<Option<(SessionAddress, String)>> {
        let grants = match self.grants(identity, session, false) {
            Ok(g) => g,
            Err("session_grant_required") => return Ok(None),
            Err(code) => return Err(code),
        };
        self.authority
            .resolve_session_read(identity, &grants, session, &self.instance)
            .map(Some)
            .map_err(|_| "session_unavailable")
    }
    pub(super) fn capture(
        &self,
        identity: &ConnectionIdentity,
        session: &SessionRef,
        write: bool,
    ) -> Result<SessionProof> {
        let grants = self.grants(identity, session, write)?;
        let (address, generation) = self
            .authority
            .resolve_session_read(identity, &grants, session, &self.instance)
            .map_err(|_| "session_unavailable")?;
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        let proof = SessionProof {
            session_ref: session.0.clone(),
            owner: self.owner(&address),
            authority_ref: self.authority_ref()?,
            authority_generation: self.authority.generation.clone(),
            scope_generation: generation,
            stop_epochs: stop_epochs(writer.connection(), &session.0)?,
            native_turn: None,
        };
        self.validate_locked(&proof, &writer)?;
        Ok(proof)
    }
    pub(super) fn validate_locked(&self, proof: &SessionProof, writer: &Writer) -> Result<()> {
        if proof.authority_ref != self.authority_ref()?
            || proof.authority_generation != self.authority.generation
            || proof.owner.harness != self.harness
            || proof.owner.address().instance != self.instance
        {
            return Err("session_binding_changed");
        }
        let address = proof.owner.address();
        let binding = super::ReceiptBinding {
            intent_id: "wait-proof",
            principal: &self.principal.0,
            target_ref: &proof.session_ref,
            request_key: "wait-proof",
            address: &address,
        };
        if !super::scope_identity_valid(
            writer.connection(),
            &binding,
            &proof.scope_generation,
            &proof.authority_generation,
        )
        .map_err(|_| "scope_unavailable")?
        {
            return Err("session_binding_changed");
        }
        if super::scope_held(writer.connection(), &binding).map_err(|_| "scope_unavailable")? {
            return Err("human_stop_active");
        }
        if stop_epochs(writer.connection(), &proof.session_ref)? != proof.stop_epochs {
            return Err("human_stop_generation_changed");
        }
        Ok(())
    }
    pub(super) async fn turn(self: &Arc<Self>, proof: &SessionProof) -> Result<Option<NativeTurn>> {
        let source = self.clone();
        let address = proof.owner.address();
        let captured = proof.native_turn.as_ref().map(|t| t.turn_id.clone());
        tokio::task::spawn_blocking(move || match captured {
            Some(turn) => source.reader.observed_turn(&address, &turn),
            None => source.reader.current_turn(&address),
        })
        .await
        .map_err(|_| "completion_source_unavailable")?
        .map_err(|_| "completion_source_unavailable")
        .and_then(|turn| {
            if turn.as_ref().is_some_and(|t| !valid_id(&t.turn_id)) {
                return Err("completion_identity_unavailable");
            }
            Ok(turn)
        })
    }
}

#[derive(Default)]
pub struct DependencyRegistry {
    sources: OnceLock<Vec<Arc<DependencySource>>>,
}
impl DependencyRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn configure(
        &self,
        sources: Vec<Arc<DependencySource>>,
    ) -> std::result::Result<(), &'static str> {
        if sources.is_empty() || sources.len() > super::automation_driver::MAX_AUTOMATION_OWNERS {
            return Err("invalid_owner_count");
        }
        let principal = &sources[0].principal;
        let mut instances = std::collections::HashSet::new();
        let mut gates = BTreeMap::new();
        for source in &sources {
            if &source.principal != principal
                || !instances.insert((
                    source.instance.node.0.clone(),
                    source.instance.instance_id.clone(),
                ))
            {
                return Err("ambiguous_owner_profile");
            }
            let gate = source.gate_identity()?;
            let anchor = (&source.authority.db, &source.authority.generation);
            if let Some(existing) = gates.insert(gate, anchor) {
                if existing != anchor {
                    return Err("ambiguous_authority_gate");
                }
            }
        }
        self.sources
            .set(sources)
            .map_err(|_| "dependency_registry_already_configured")
    }
    fn sources(&self) -> Result<&[Arc<DependencySource>]> {
        self.sources
            .get()
            .map(Vec::as_slice)
            .ok_or("dependency_registry_unavailable")
    }
    pub(super) fn all_sources(&self) -> Result<Vec<Arc<DependencySource>>> {
        Ok(self.sources()?.to_vec())
    }
    pub(super) fn by_session(
        &self,
        identity: &ConnectionIdentity,
        session: &SessionRef,
    ) -> Result<Arc<DependencySource>> {
        let mut found = None;
        for source in self.sources()? {
            if source.maybe_address(identity, session)?.is_some() {
                if found.is_some() {
                    return Err("ambiguous_session");
                }
                found = Some(source.clone());
            }
        }
        found.ok_or("session_unavailable")
    }
    pub(super) fn for_proof(
        &self,
        identity: &ConnectionIdentity,
        proof: &SessionProof,
        write: bool,
    ) -> Result<Arc<DependencySource>> {
        let source = self.by_session(identity, &SessionRef(proof.session_ref.clone()))?;
        source.grants(identity, &SessionRef(proof.session_ref.clone()), write)?;
        if source.instance != proof.owner.address().instance
            || source.harness != proof.owner.harness
            || source.authority_ref() != Ok(proof.authority_ref.clone())
        {
            return Err("session_binding_changed");
        }
        Ok(source)
    }
    /// Canonical metadata only. In particular, active HumanStop does not conceal
    /// an authorized native mapping needed for read-only receipt reconciliation.
    pub fn resolve_native(
        &self,
        identity: &ConnectionIdentity,
        harness: &str,
        native: &str,
        node: Option<&str>,
    ) -> Result<Value> {
        if !valid_id(harness) || !valid_id(native) || node.is_some_and(|v| !valid_id(v)) {
            return Err("invalid_native_session");
        }
        let mut found = None;
        for source in self.sources()? {
            if source.harness != harness || node.is_some_and(|n| n != source.instance.node.0) {
                continue;
            }
            if let Some(value) = source.resolve_native(identity, native, node)? {
                if found.is_some() {
                    return Err("ambiguous_native_session");
                }
                found = Some(value);
            }
        }
        found.ok_or("native_session_not_registered")
    }
}

pub(super) struct LockedSource {
    pub source: Arc<DependencySource>,
    pub guard: PinnedTargetGateGuard,
    pub writer: Writer,
}
/// Lock order is the OS gate identity, with identical inodes deduplicated.
pub(super) fn lock_sources(sources: Vec<Arc<DependencySource>>) -> Result<Vec<LockedSource>> {
    let mut unique = BTreeMap::new();
    for source in sources {
        unique.entry(source.gate_identity()?).or_insert(source);
    }
    let mut out = Vec::new();
    for (_, source) in unique {
        let (guard, writer) = source.authority.lock().map_err(|_| "scope_unavailable")?;
        out.push(LockedSource {
            source,
            guard,
            writer,
        });
    }
    Ok(out)
}
pub(super) fn locked_for<'a>(
    locked: &'a mut [LockedSource],
    proof: &SessionProof,
) -> Result<&'a mut LockedSource> {
    locked
        .iter_mut()
        .find(|s| s.source.authority_ref().ok().as_ref() == Some(&proof.authority_ref))
        .ok_or("scope_unavailable")
}
pub(super) fn stop_epochs(
    c: &rusqlite::Connection,
    session: &str,
) -> Result<BTreeMap<String, u64>> {
    let mut stmt=c.prepare("SELECT s.scope_ref,COALESCE(e.revision,0) FROM humanstop_scopes s LEFT JOIN settings e ON e.scope='automation:stop-epoch' AND e.setting_key=s.scope_ref WHERE s.session_ref=?1 ORDER BY s.scope_ref")
        .map_err(|_|"store_unavailable")?;
    let rows = stmt
        .query_map([session], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })
        .map_err(|_| "store_unavailable")?
        .collect::<std::result::Result<BTreeMap<_, _>, _>>()
        .map_err(|_| "store_unavailable")?;
    if !rows.contains_key("global") || !rows.contains_key(&format!("session:{session}")) {
        return Err("session_unavailable");
    }
    Ok(rows)
}
pub(super) fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

/// Native status vocabularies are explicit; synthesized idle is deliberately absent.
pub fn native_turn(turn_id: &str, status: &str) -> Option<NativeTurn> {
    if !valid_id(turn_id) {
        return None;
    }
    let status = match status {
        "running" | "busy" | "inProgress" | "in_progress" => NativeTurnStatus::Running,
        "completed" => NativeTurnStatus::Completed,
        "failed" => NativeTurnStatus::Failed,
        "interrupted" => NativeTurnStatus::Interrupted,
        "cancelled" | "canceled" => NativeTurnStatus::Cancelled,
        _ => return None,
    };
    Some(NativeTurn {
        turn_id: turn_id.into(),
        status,
    })
}
