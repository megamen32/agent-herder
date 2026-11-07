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
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource},
    domain::{
        adapter::{NativeReceipt, NativeSessionReader, SendCommand, SendMode},
        address::{InstanceRef, SessionRef},
    },
    error::{Diagnostic, Effect, Retry},
};
use sha2::{Digest, Sha256};
/// A separately trusted policy may issue only an exact session write grant.
/// Create lineage alone is never an authorization grant.
pub trait FreshSessionGrantPolicy {
    fn session_write_grant(
        &self,
        principal: &PrincipalId,
        instance: &InstanceRef,
        session: &SessionRef,
    ) -> Result<Option<Grant>, ()>;
    /// Optional independent permission for reading the created session/task.
    fn session_read_grant(
        &self,
        _principal: &PrincipalId,
        _instance: &InstanceRef,
        _session: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok(None)
    }
}
/// Use existing server policy grants without deriving new authorization.
pub struct NoAdditionalGrant;
impl FreshSessionGrantPolicy for NoAdditionalGrant {
    fn session_write_grant(
        &self,
        _: &PrincipalId,
        _: &InstanceRef,
        _: &SessionRef,
    ) -> Result<Option<Grant>, ()> {
        Ok(None)
    }
}
fn grant_diagnostic(code: &'static str) -> Diagnostic {
    Diagnostic {
        code,
        field: Some("session_ref"),
        received: None,
        expected: Some(vec![
            "obtain an exact session write grant from trusted policy",
        ]),
        fix: None,
        effect: Effect::None,
        retry: Retry::SafeSameKey,
        receipt_ref: None,
        diagnostic_ref: None,
    }
}

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
    DeliveryNotSent {
        session: SessionRef,
        diagnostic: Diagnostic,
    },
    StoppedBeforeHandoff {
        session: SessionRef,
    },
    Admitted {
        session: SessionRef,
        receipt: NativeReceipt,
    },
}
pub(super) fn delivery_identifiers(
    principal: &PrincipalId,
    instance: &InstanceRef,
    key: &str,
) -> Result<(String, String, String), GateError> {
    let digest = Sha256::digest(
        serde_json::to_vec(&("create-prompt-v1", &principal.0, instance, key))
            .map_err(|_| GateError::Invalid)?,
    );
    let suffix = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok((
        format!("create-prompt:{suffix}"),
        format!("create-prompt-intent:{suffix}"),
        format!("create-prompt-task:{suffix}"),
    ))
}

/// The request and exact grants are supplied by trusted application policy.
/// Native create never sends the prompt. A separate durable delivery key is
/// derived from the principal, exact instance, and original create key.
pub async fn create_with_prompt<C, I, G, N, D, P>(
    authority: &ScopedAuthority,
    identity: &ConnectionIdentity,
    grants: &[Grant],
    creator: &C,
    issuer: &I,
    generations: &G,
    reader: &N,
    delivery: &D,
    policy: &P,
    request: CreateRequest<'_>,
) -> Result<CreatePromptOutcome, GateError>
where
    C: BoundedFreshRootCreate,
    I: SessionRefIssuer,
    G: ScopeGenerationIssuer,
    N: NativeSessionReader,
    D: BoundedNativeHandoff,
    P: FreshSessionGrantPolicy,
{
    let Caller::Principal(principal) = identity.caller() else {
        return Err(GateError::Invalid);
    };
    let instance = creator.instance();
    let (delivery_key, intent_id, task_id) =
        delivery_identifiers(&principal.id, instance, request.request_key)?;
    // Check key/payload reuse before a new create attempt; conflicts are
    // deterministic and must never be presented as a fresh UNKNOWN.
    if matches!(
        authority.recover_fresh_create(
            identity,
            grants,
            instance,
            request.request_key,
            request.specification
        )?,
        RecoveredCreate::Conflict
    ) {
        return Ok(CreatePromptOutcome::Conflict);
    }
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
    let new_grant = policy.session_write_grant(&principal.id, instance, &session);
    let mut effective_grants = grants.to_vec();
    if let Ok(Some(grant)) = &new_grant {
        if grant.principal == principal.id
            && grant.action == Action::Write
            && grant.resource == PrivateResource::Session(session.clone())
        {
            effective_grants.push(grant.clone());
        }
    }
    if new_grant.is_err()
        || identity
            .authorize(
                &effective_grants,
                &PrivateResource::Session(session.clone()),
                Action::Write,
            )
            .is_err()
    {
        // A prior attempt under the same key may already have reached native;
        // never turn that uncertainty into a fresh no-effect claim.
        let exists = (|| -> Result<bool, GateError> {
            let (_gate, writer) = authority.lock()?;
            writer.connection().query_row("SELECT EXISTS(SELECT 1 FROM intents WHERE principal=?1 AND target=?2 AND request_key=?3)",rusqlite::params![principal.id.0,session.0,delivery_key],|r|r.get(0)).map_err(|_|GateError::Store)
        })();
        return Ok(if matches!(exists, Ok(false)) {
            CreatePromptOutcome::DeliveryNotSent {
                session,
                diagnostic: grant_diagnostic(if new_grant.is_err() {
                    "session_policy_unavailable"
                } else {
                    "session_write_grant_required"
                }),
            }
        } else {
            CreatePromptOutcome::DeliveryUnknownOrBlocked { session }
        });
    }
    // A repeated composite request must recover its exact durable delivery
    // receipt, not submit again or erase known admission into UNKNOWN.
    let previous = (|| -> Result<Option<CreatePromptOutcome>, GateError> {
        use crate::application::reconcile::{
            ReceiptBinding, StoredReceipt, dispatch_payload_binding, load_native_receipt,
        };
        use crate::domain::adapter::DispatchPlan;
        use rusqlite::OptionalExtension;
        let (address, _) =
            authority.resolve_session(identity, &effective_grants, &session, instance)?;
        let expected = dispatch_payload_binding(
            &DispatchPlan {
                target: address.clone(),
                mode: SendMode::Start,
                expected_turn: None,
            },
            request.specification,
        );
        let (_guard, writer) = authority.lock()?;
        let row:Option<(String,String,String)> = writer.connection().query_row(
            "SELECT intent_id,payload_hash,state FROM intents WHERE principal=?1 AND target=?2 AND request_key=?3",
            rusqlite::params![principal.id.0,session.0,delivery_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))
        ).optional().map_err(|_|GateError::Store)?;
        let Some((prior_intent, hash, state)) = row else {
            return Ok(None);
        };
        if hash != expected {
            return Ok(Some(CreatePromptOutcome::Conflict));
        }
        if matches!(state.as_str(), "admitted" | "confirmed") {
            let binding = ReceiptBinding {
                intent_id: &prior_intent,
                principal: &principal.id.0,
                target_ref: &session.0,
                request_key: &delivery_key,
                address: &address,
            };
            if let StoredReceipt::Found(receipt) =
                load_native_receipt(writer.connection(), &binding).map_err(|_| GateError::Store)?
            {
                return Ok(Some(CreatePromptOutcome::Admitted {
                    session: session.clone(),
                    receipt,
                }));
            }
        }
        Ok(Some(CreatePromptOutcome::DeliveryUnknownOrBlocked {
            session: session.clone(),
        }))
    })();
    match previous {
        Ok(Some(outcome)) => return Ok(outcome),
        Err(_) => return Ok(CreatePromptOutcome::DeliveryUnknownOrBlocked { session }),
        Ok(None) => (),
    }
    let result = deliver_scoped(
        authority,
        instance,
        identity,
        &effective_grants,
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
