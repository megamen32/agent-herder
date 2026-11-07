//! Exact scoped hold through the MCP application boundary.
//!
//! Authentication belongs to ingress; this application never interprets MCP
//! metadata as identity. The stop response does not claim native interruption.
use crate::{
    application::scoped_stop::{GateError, ScopedAuthority, StopDisposition},
    auth::identity::{Action, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, SessionRef},
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use rusqlite::{TransactionBehavior, params};
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
            let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(v) => v.as_millis().to_string(),
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"clock_unavailable","effect":"none"}),
                    ));
                }
            };
            match self.authority.stop_exact_session(
                identity,
                &self.grants,
                &session,
                &self.instance,
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
                Err(GateError::Invalid) => Some(CallToolResult::structured_error(
                    json!({"code":"scope_unavailable","effect":"none"}),
                )),
                Err(_) => Some(CallToolResult::structured_error(
                    json!({"code":"stop_unavailable","effect":"unknown"}),
                )),
            }
        })
    }
}

impl ScopedAuthority {
    /// Wait for the canonical gate, then validate exact scoped membership and
    /// commit the hold under that same guard. No DB transaction spans the wait.
    fn stop_exact_session(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &InstanceRef,
        now: &str,
    ) -> Result<StopDisposition, GateError> {
        identity
            .authorize(
                grants,
                &PrivateResource::Session(session.clone()),
                Action::Write,
            )
            .map_err(|_| GateError::Invalid)?;
        let (_gate, mut writer) = self.lock_wait()?;
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_sessions s JOIN session_bindings b ON b.session_ref=s.session_ref WHERE s.session_ref=?1 AND s.authority_generation=?2 AND b.node_ref=?3 AND b.instance_id=?4 AND length(b.native_session_id)>0 AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref))",params![session.0,self.generation,instance.node.0,instance.instance_id],|r|r.get(0)).map_err(|_|GateError::Store)?;
        if !valid || now.is_empty() {
            return Err(GateError::Invalid);
        }
        let scope = format!("session:{}", session.0);
        tx.execute("INSERT INTO humanstop_holds(scope_ref,reason,created_at,released_at) VALUES (?1,'mcp_stop',?2,NULL) ON CONFLICT(scope_ref) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,released_at=NULL",params![scope,now]).map_err(|_|GateError::Store)?;
        let possible:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intents WHERE target=?1 AND state IN ('dispatching','admitted','unknown','confirmed'))",[&session.0],|r|r.get(0)).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(if possible {
            StopDisposition::InterruptOrReconcileRequired
        } else {
            StopDisposition::HeldBeforeHandoff
        })
    }
}
