//! Existing-session registration on the same trusted owner/adapter boundary
//! used by create and deliver. Request claims never establish a self binding.
use super::owner_policy::OwnerPolicy;
use herder::{
    adapters::ahap_opencode::AhapOpenCode,
    application::scoped_stop::{
        GateError, ScopedAuthority,
        create_prompt::FreshSessionGrantPolicy,
        registration::{self, RegistrationError, RegistrationRequest},
    },
    auth::identity::{Caller, ConnectionIdentity, Grant},
    domain::address::{InstanceRef, SessionRef},
    mcp::catalog::{Request, Session},
};
use rmcp::model::CallToolResult;
use serde_json::json;
use std::sync::Arc;

pub fn call(
    identity: &ConnectionIdentity,
    request: &Request,
    adapter: &Arc<AhapOpenCode>,
    policy: &Arc<OwnerPolicy>,
    instance: &InstanceRef,
    authority: &Arc<ScopedAuthority>,
    grants: &[Grant],
) -> Option<CallToolResult> {
    if !matches!(
        request,
        Request::Session(Session::Register { .. } | Session::Workspace { .. })
    ) {
        return None;
    }
    let Caller::Principal(principal) = identity.caller() else {
        return Some(error(RegistrationError::Unauthorized));
    };
    if principal.id != policy.principal || instance != &policy.instance {
        return Some(error(RegistrationError::Unauthorized));
    }
    let result = (|| {
        let now = registration::utc_now()?;
        match request {
            Request::Session(Session::Register {
                instance_ref,
                native_session_id,
                workspace,
                request_key,
            }) => {
                if instance_ref != &instance.instance_id {
                    return Err(RegistrationError::IdentityMismatch);
                }
                let result = authority.register_existing(
                    identity,
                    grants,
                    adapter.as_ref(),
                    RegistrationRequest {
                        native_session_id,
                        workspace: workspace.as_ref(),
                        request_key,
                        now: &now,
                    },
                )?;
                let session = SessionRef(result.session_ref.clone());
                let mut value =
                    serde_json::to_value(&result).map_err(|_| RegistrationError::Store)?;
                value["is_self"] = json!(identity.require_self(Some(&session)).is_ok());
                value["identity_source"] = json!("authorized_native_registration");
                value["workspace_source"] = json!("session_declaration");
                value["message_target"] =
                    json!({"tool":"deliver","action":"session","session_ref":session.0});
                Ok(value)
            }
            Request::Session(Session::Workspace {
                session_ref,
                workspace,
                request_key,
            }) => {
                let session = SessionRef(session_ref.clone());
                let grant = policy
                    .session_write_grant(&principal.id, instance, &session)
                    .map_err(|_| RegistrationError::Gate(GateError::Unavailable))?
                    .ok_or(RegistrationError::Unauthorized)?;
                let result = authority.update_session_workspace(
                    identity,
                    &[grant],
                    &session,
                    instance,
                    workspace.as_ref(),
                    request_key,
                    &now,
                )?;
                Ok(
                    json!({"session_ref":session_ref,"workspace":result.workspace,
                    "workspace_revision":result.revision,"updated_at":result.updated_at,
                    "workspace_source":"session_declaration"}),
                )
            }
            _ => unreachable!("request ownership checked above"),
        }
    })();
    Some(match result {
        Ok(value) => CallToolResult::structured(value),
        Err(failure) => error(failure),
    })
}

fn error(error: RegistrationError) -> CallToolResult {
    let (code, message, correction) = match &error {
        RegistrationError::Unauthorized => (
            "unauthorized",
            "The configured owner does not have access to this session.",
            "Use the exact instance_ref or an authorized registered session_ref.",
        ),
        RegistrationError::InvalidInput => (
            "invalid_registration",
            "The session identity, request key or workspace is invalid.",
            "Provide the exact native session ID, a nonempty request_key and an absolute workspace path with its node_ref.",
        ),
        RegistrationError::ProbeUnavailable | RegistrationError::IdentityMismatch => (
            "native_identity_unverified",
            "The configured adapter could not verify this exact native session.",
            "Check the selected provider, browser profile/account and native session ID. No native conversation was created or messaged.",
        ),
        RegistrationError::RequestKeyConflict => (
            "idempotency_conflict",
            "This request_key is already bound to different registration or workspace data.",
            "Replay the original request unchanged, or use a new request_key for a new operation.",
        ),
        RegistrationError::UnverifiedExistingSession => (
            "session_provenance_unavailable",
            "The existing binding has no valid ownership proof for this caller.",
            "Restore the original owner profile and registration provenance; a native ID alone does not grant access.",
        ),
        RegistrationError::Gate(GateError::Busy) => (
            "authority_busy",
            "Another scoped operation currently holds the session authority gate.",
            "Retry the same request_key after the current operation finishes.",
        ),
        RegistrationError::Gate(_) | RegistrationError::Store => (
            "registration_store_unavailable",
            "The authoritative registration store could not complete this operation.",
            "Check the pinned owner authority and read the session registry before replaying the same request_key.",
        ),
    };
    CallToolResult::structured_error(json!({"code":code,"message":message,
        "effect":if matches!(error, RegistrationError::Store) {"unknown"} else {"none"},
        "correction":correction}))
}
