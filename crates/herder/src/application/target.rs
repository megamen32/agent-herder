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

/// This port is implemented only by the selected trusted native connection;
/// an MCP request, cached session or client-supplied address is not a receipt.
#[allow(async_fn_in_trait)]
pub trait NativeCreateControl {
    fn instance(&self) -> &InstanceRef;
    async fn create_once(&self, request_key: &str, specification: &str) -> NativeCreateOutcome;
}

/// The control must return Confirmed only for its own matching native response.
#[derive(Debug, Clone)]
pub enum NativeCreateOutcome {
    Confirmed {
        request_key: String,
        instance: InstanceRef,
        native_session_id: String,
        parent_ref: Option<String>,
    },
    Unknown,
}

/// Server-side issuer; never implement by accepting a client-provided ref.
pub trait SessionRefIssuer {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable>;
}

pub struct CreateRequest<'a> {
    pub intent_id: &'a str,
    pub task_id: &'a str,
    pub request_key: &'a str,
    pub specification: &'a str,
    pub now: &'a str,
    pub retain_until: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateResult {
    Created(SessionRef),
    Unknown,
    Existing,
}

/// The selected native control and ref issuer must come from trusted server
/// composition. No supplied address is used as evidence of native creation.
pub async fn create_once<C: NativeCreateControl, I: SessionRefIssuer>(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    writer: &mut Writer,
    control: &C,
    issuer: &I,
    request: CreateRequest<'_>,
) -> Result<CreateResult, TargetError> {
    use crate::store::lineage::NewCreateLineageIntent;
    use sha2::{Digest, Sha256};
    let instance = control.instance();
    let target = serde_json::to_string(instance).map_err(|_| TargetError::Store)?;
    let resource = PrivateResource::Resource(format!("instance:{target}"));
    identity
        .authorize(grants, &resource, Action::Write)
        .map_err(|_| TargetError::Unauthorized)?;
    let Caller::Principal(principal) = identity.caller() else {
        return Err(TargetError::Unauthorized);
    };
    if !writer
        .has_session_binding_schema()
        .map_err(|_| TargetError::Store)?
    {
        return Err(TargetError::Store);
    }
    if request.request_key.is_empty()
        || instance.node.0.is_empty()
        || instance.instance_id.is_empty()
    {
        return Err(TargetError::InvalidAddress);
    }
    let payload = serde_json::to_vec(&(1u8, instance, request.specification))
        .map_err(|_| TargetError::Store)?;
    let payload_hash = format!(
        "create-v1:{}",
        Sha256::digest(payload)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let intent = NewCreateLineageIntent {
        intent_id: request.intent_id,
        task_id: request.task_id,
        creator_ref: &principal.id.0,
        target: &target,
        request_ref: request.request_key,
        payload_hash: &payload_hash,
        now: request.now,
        retain_until: request.retain_until,
    };
    match writer
        .prepare_create_lineage_intent(&intent)
        .map_err(|_| TargetError::Store)?
    {
        PrepareResult::Existing { .. } => return Ok(CreateResult::Existing),
        PrepareResult::Conflict { .. } => return Err(TargetError::Conflict),
        PrepareResult::Created { .. } => {}
    }
    let session = issuer
        .issue()
        .map_err(|_| TargetError::RegistryUnavailable)?;
    if session.0.is_empty() || session.0.len() > 4096 || session.0.chars().any(char::is_control) {
        return Err(TargetError::InvalidAddress);
    }
    if writer
        .resolve(&session)
        .map_err(|_| TargetError::RegistryUnavailable)?
        .is_some()
    {
        return Err(TargetError::Conflict);
    }
    if !writer
        .claim_create_exact(&intent)
        .map_err(|_| TargetError::Store)?
    {
        return Ok(CreateResult::Existing);
    }
    let outcome = control
        .create_once(request.request_key, request.specification)
        .await;
    let NativeCreateOutcome::Confirmed {
        request_key,
        instance: observed,
        native_session_id,
        parent_ref,
    } = outcome
    else {
        writer
            .mark_create_unknown(&intent)
            .map_err(|_| TargetError::Store)?;
        return Ok(CreateResult::Unknown);
    };
    let address = SessionAddress {
        instance: observed,
        native_session_id,
    };
    if request_key != request.request_key
        || address.instance != *instance
        || !valid_address(&address)
        || parent_ref
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 4096 || v.chars().any(char::is_control))
    {
        writer
            .mark_create_unknown(&intent)
            .map_err(|_| TargetError::Store)?;
        return Ok(CreateResult::Unknown);
    }
    let receipt=serde_json::json!({"version":1,"request_key":request_key,"instance":address.instance,"native_session_id":address.native_session_id,"session_ref":session.0,"parent_ref":parent_ref}).to_string();
    match writer.commit_created_session(
        &intent,
        &session.0,
        &address,
        parent_ref.as_deref(),
        &receipt,
    ) {
        Ok(true) => Ok(CreateResult::Created(session)),
        Ok(false) => Ok(CreateResult::Unknown),
        Err(_) => {
            writer
                .mark_create_unknown(&intent)
                .map_err(|_| TargetError::Store)?;
            Err(TargetError::Store)
        }
    }
}

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
