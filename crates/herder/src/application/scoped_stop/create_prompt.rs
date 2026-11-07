//! Compose one fresh native create and a separately deduplicated prompt delivery.
use crate::{
    application::{
        reconcile::DurableDispatch,
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, GateError, ScopeGenerationIssuer,
            ScopedAuthority, create_recovery::RecoveredCreate,
        },
        target::{CreateRequest, CreateResult, DeliverRequest, SessionRefIssuer, deliver_scoped},
    },
    auth::identity::{Caller, ConnectionIdentity, Grant},
    domain::{
        adapter::{NativeReceipt, NativeSessionReader, SendCommand, SendMode},
        address::SessionRef,
    },
};
use sha2::{Digest, Sha256};
#[derive(Debug, PartialEq, Eq)]
pub enum CreatePromptOutcome {
    CreateUnknown,
    CreateDefinitelyNotSent,
    CreatePending,
    Conflict,
    /// Create succeeded; delivery may have happened or may be blocked.
    DeliveryUnknownOrBlocked {
        session: SessionRef,
    },
    DeliveryDefinitelyNotSent {
        session: SessionRef,
    },
    StoppedBeforeHandoff {
        session: SessionRef,
    },
    Admitted {
        session: SessionRef,
        receipt: NativeReceipt,
    },
}
/// The request and exact grants are supplied by trusted application policy.
/// Native create never sends the prompt. A separate durable delivery key is
/// derived from the principal, exact instance, and original create key.
pub async fn create_with_prompt<C, I, G, N, D>(
    authority: &ScopedAuthority,
    identity: &ConnectionIdentity,
    grants: &[Grant],
    creator: &C,
    issuer: &I,
    generations: &G,
    reader: &N,
    delivery: &D,
    request: CreateRequest<'_>,
) -> Result<CreatePromptOutcome, GateError>
where
    C: BoundedFreshRootCreate,
    I: SessionRefIssuer,
    G: ScopeGenerationIssuer,
    N: NativeSessionReader,
    D: BoundedNativeHandoff,
{
    let Caller::Principal(principal) = identity.caller() else {
        return Err(GateError::Invalid);
    };
    let instance = creator.instance();
    let digest = Sha256::digest(
        serde_json::to_vec(&(
            "create-prompt-v1",
            &principal.id.0,
            instance,
            request.request_key,
        ))
        .map_err(|_| GateError::Invalid)?,
    );
    let suffix = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let delivery_key = format!("create-prompt:{suffix}");
    let intent_id = format!("create-prompt-intent:{suffix}");
    let task_id = format!("create-prompt-task:{suffix}");
    let create = authority.create_fresh_root(
        identity,
        grants,
        creator,
        issuer,
        generations,
        CreateRequest {
            intent_id: request.intent_id,
            task_id: request.task_id,
            request_key: request.request_key,
            specification: request.specification,
            now: request.now,
            retain_until: request.retain_until,
        },
    )?;
    let session = match create {
        CreateResult::Created(session) => session,
        CreateResult::DefinitelyNotSent => return Ok(CreatePromptOutcome::CreateDefinitelyNotSent),
        CreateResult::Unknown => return Ok(CreatePromptOutcome::CreateUnknown),
        CreateResult::Existing => match authority.recover_fresh_create(
            identity,
            grants,
            instance,
            request.request_key,
            request.specification,
        )? {
            RecoveredCreate::Created { session, .. } => session,
            RecoveredCreate::DefinitelyNotSent { .. } => {
                return Ok(CreatePromptOutcome::CreateDefinitelyNotSent);
            }
            RecoveredCreate::Pending => return Ok(CreatePromptOutcome::CreatePending),
            RecoveredCreate::Conflict => return Ok(CreatePromptOutcome::Conflict),
            RecoveredCreate::Unknown | RecoveredCreate::Missing => {
                return Ok(CreatePromptOutcome::CreateUnknown);
            }
        },
    };
    let result = deliver_scoped(
        authority,
        instance,
        identity,
        grants,
        reader,
        delivery,
        DeliverRequest {
            session: &session,
            intent_id: &intent_id,
            task_id: &task_id,
            request_key: &delivery_key,
            message: request.specification,
            command: SendCommand {
                mode: SendMode::Start,
            },
            now: request.now,
            retain_until: request.retain_until,
        },
    )
    .await;
    Ok(match result {
        Ok(DurableDispatch::Admitted(receipt)) => {
            CreatePromptOutcome::Admitted { session, receipt }
        }
        Ok(DurableDispatch::DefinitelyNotSent) => {
            CreatePromptOutcome::DeliveryDefinitelyNotSent { session }
        }
        Ok(DurableDispatch::StoppedBeforeHandoff) => {
            CreatePromptOutcome::StoppedBeforeHandoff { session }
        }
        Ok(DurableDispatch::Unknown | DurableDispatch::NotClaimed) | Err(_) => {
            CreatePromptOutcome::DeliveryUnknownOrBlocked { session }
        }
    })
}
