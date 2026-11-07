//! Exact scoped hold through the MCP application boundary.
//!
//! Authentication belongs to ingress; this application never interprets MCP
//! metadata as identity. The stop response does not claim native interruption.
use crate::{
    application::scoped_stop::{ScopedAuthority, StopDisposition},
    auth::identity::{Action, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, SessionRef},
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ScopedStopApplication {
    authority: ScopedAuthority,
    instance: InstanceRef,
    grants: Vec<Grant>,
}
impl ScopedStopApplication {
    /// The instance and grants come from server policy, never from a request.
    pub fn new(authority: ScopedAuthority, instance: InstanceRef, grants: Vec<Grant>) -> Self {
        Self {
            authority,
            instance,
            grants,
        }
    }
}
impl ApplicationPort for ScopedStopApplication {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let catalog::Request::Stop(catalog::Stop::Stop {
                session_ref,
                request_key,
            }) = request
            else {
                return None;
            };
            let session = SessionRef(session_ref);
            if identity
                .authorize(
                    &self.grants,
                    &PrivateResource::Session(session.clone()),
                    Action::Write,
                )
                .is_err()
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unauthorized","effect":"none"}),
                ));
            }
            if request_key.is_empty()
                || request_key.len() > 4096
                || request_key.chars().any(char::is_control)
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"invalid_request","effect":"none"}),
                ));
            }
            // Resolve through the same authority before allowing a hold. A
            // mapping alone is not proof that an imported session is owned.
            if self
                .authority
                .resolve_session(identity, &self.grants, &session, &self.instance)
                .is_err()
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"scope_unavailable","effect":"none"}),
                ));
            }
            let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(v) => v.as_millis().to_string(),
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"clock_unavailable","effect":"none"}),
                    ));
                }
            };
            match self.authority.stop(
                identity,
                &self.grants,
                &format!("session:{}", session.0),
                "mcp_stop",
                &now,
            ) {
                Ok(StopDisposition::HeldBeforeHandoff) => Some(CallToolResult::structured(
                    json!({"session_ref":session.0,"hold":"active","native_interrupt":"not_attempted_no_known_handoff"}),
                )),
                Ok(StopDisposition::InterruptOrReconcileRequired) => {
                    Some(CallToolResult::structured(
                        json!({"session_ref":session.0,"hold":"active","native_interrupt":"required_or_reconcile"}),
                    ))
                }
                Err(_) => Some(CallToolResult::structured_error(
                    json!({"code":"stop_unavailable","effect":"unknown"}),
                )),
            }
        })
    }
}
