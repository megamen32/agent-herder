//! Resolution at the boundary between opaque session references and native control.
//!
//! A production implementation must read immutable, uniquely issued bindings
//! from the authoritative store. The existing v1 schema has no such mapping.
use crate::application::reconcile::{DurableDispatch, ReceiptBinding, dispatch_payload_binding};
use crate::auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource};
use crate::domain::adapter::{
    DecisionError, NativeSessionControl, NativeSessionReader, SendCommand, decide_send,
};
use crate::domain::address::{InstanceRef, SessionAddress, SessionRef};
use crate::store::{
    Writer,
    intents::{NewIntent, PrepareResult},
};

/// Implementations must use the authoritative immutable registry, not a cache,
/// client-supplied address, derived name, lineage, or adapter scan. Unavailable
/// and missing bindings fail closed. No implementation is supplied by v1 store.
pub trait SessionRegistry {
    fn resolve(&self, session: &SessionRef) -> Result<Option<SessionAddress>, RegistryUnavailable>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryUnavailable;

#[derive(Debug, PartialEq, Eq)]
pub enum TargetError {
    Unauthorized,
    RegistryUnavailable,
    NotFound,
    InvalidAddress,
    WrongInstance,
    CreateReceiptMismatch,
    ReadUnavailable,
    SnapshotMismatch,
    Decision(DecisionError),
    Conflict,
    Store,
}

fn valid_address(address: &SessionAddress) -> bool {
    [
        &address.instance.node.0,
        &address.instance.instance_id,
        &address.native_session_id,
    ]
    .iter()
    .all(|part| !part.is_empty() && part.len() <= 4096 && !part.chars().any(char::is_control))
}

/// `instance` must come from the server's selected connection, not a client claim.
pub fn resolve_target<R: SessionRegistry>(
    registry: &R,
    session: &SessionRef,
    instance: &InstanceRef,
) -> Result<SessionAddress, TargetError> {
    if session.0.is_empty() {
        return Err(TargetError::NotFound);
    }
    let address = registry
        .resolve(session)
        .map_err(|_| TargetError::RegistryUnavailable)?
        .ok_or(TargetError::NotFound)?;
    if !valid_address(&address) {
        return Err(TargetError::InvalidAddress);
    }
    if address.instance != *instance {
        return Err(TargetError::WrongInstance);
    }
    Ok(address)
}

/// Verify an already-created native session against the authoritative mapping.
/// `native_created` must come directly from the selected native create operation.
/// This does not create, register or claim durable provenance for a session.
pub fn verify_created_target<R: SessionRegistry>(
    registry: &R,
    session: &SessionRef,
    instance: &InstanceRef,
    native_created: &SessionAddress,
) -> Result<SessionAddress, TargetError> {
    let resolved = resolve_target(registry, session, instance)?;
    if &resolved != native_created {
        return Err(TargetError::CreateReceiptMismatch);
    }
    Ok(resolved)
}

pub struct DeliverRequest<'a> {
    pub session: &'a SessionRef,
    pub intent_id: &'a str,
    pub task_id: &'a str,
    pub request_key: &'a str,
    pub message: &'a str,
    pub command: SendCommand,
    pub now: &'a str,
    pub retain_until: &'a str,
}

/// Resolve and authorize before native preflight, intent admission or submit.
/// The reader/control and selected instance must be bound by trusted composition.
pub async fn deliver<R: SessionRegistry, N: NativeSessionReader + NativeSessionControl>(
    registry: &R,
    instance: &InstanceRef,
    identity: &ConnectionIdentity,
    grants: &[Grant],
    writer: &mut Writer,
    native: &N,
    request: DeliverRequest<'_>,
) -> Result<DurableDispatch, TargetError> {
    identity
        .authorize(
            grants,
            &PrivateResource::Session(request.session.clone()),
            Action::Write,
        )
        .map_err(|_| TargetError::Unauthorized)?;
    let Caller::Principal(principal) = identity.caller() else {
        return Err(TargetError::Unauthorized);
    };
    let address = resolve_target(registry, request.session, instance)?;
    let snapshot = native
        .snapshot(&address)
        .await
        .map_err(|_| TargetError::ReadUnavailable)?;
    if snapshot.address != address {
        return Err(TargetError::SnapshotMismatch);
    }
    let plan = decide_send(&snapshot, &request.command).map_err(TargetError::Decision)?;
    let payload_hash = dispatch_payload_binding(&plan, request.message);
    let prepared = writer
        .prepare_intent(&NewIntent {
            intent_id: request.intent_id,
            task_id: request.task_id,
            principal: &principal.id.0,
            target: &request.session.0,
            request_key: request.request_key,
            payload_hash: &payload_hash,
            now: request.now,
            retain_until: request.retain_until,
        })
        .map_err(|_| TargetError::Store)?;
    let intent_id = match prepared {
        PrepareResult::Created { intent_id, .. } | PrepareResult::Existing { intent_id, .. } => {
            intent_id
        }
        PrepareResult::Conflict { .. } => return Err(TargetError::Conflict),
    };
    let binding = ReceiptBinding {
        intent_id: &intent_id,
        principal: &principal.id.0,
        target_ref: &request.session.0,
        request_key: request.request_key,
        address: &address,
    };
    writer
        .dispatch_once(&binding, plan, request.message, request.now, native)
        .await
        .map_err(|_| TargetError::Store)
}
