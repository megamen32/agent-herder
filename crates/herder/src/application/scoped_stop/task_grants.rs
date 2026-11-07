//! Resolve current exact Session Read for a durable delivery task.
use super::{GateError, ScopedAuthority, create_prompt::FreshSessionGrantPolicy};
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, NodeRef, SessionRef},
};
use rusqlite::{OptionalExtension, params};

impl ScopedAuthority {
    /// A missing row means this is not a delivery task owned by the caller.
    /// Policy is consulted only after the authoritative binding is read and
    /// the gate released; lineage never creates a grant by itself.
    pub(super) fn current_task_read_grants(
        &self,
        identity: &ConnectionIdentity,
        base: &[Grant],
        task_id: &str,
        policy: Option<&(dyn FreshSessionGrantPolicy + Send + Sync)>,
    ) -> Result<Option<Vec<Grant>>, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let row = {
            let (_guard, writer) = self.lock()?;
            writer.connection().query_row("SELECT i.target,b.node_ref,b.instance_id FROM intents i JOIN tasks t ON t.task_id=i.task_id JOIN session_bindings b ON b.session_ref=i.target JOIN humanstop_sessions s ON s.session_ref=b.session_ref WHERE t.task_id=?1 AND t.principal=?2 AND i.principal=?2 AND s.authority_generation=?3 AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref)",params![task_id,principal.id.0,self.generation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional().map_err(|_|GateError::Store)?
        };
        let Some((target, node, instance)) = row else {
            return Ok(None);
        };
        let session = SessionRef(target);
        let instance = InstanceRef {
            node: NodeRef(node),
            instance_id: instance,
        };
        let mut grants = base.to_vec();
        if let Some(policy) = policy {
            if let Ok(Some(grant)) = policy.session_read_grant(&principal.id, &instance, &session) {
                if grant.principal == principal.id
                    && grant.action == Action::Read
                    && grant.resource == PrivateResource::Session(session.clone())
                {
                    grants.push(grant);
                }
            }
        }
        identity
            .authorize(&grants, &PrivateResource::Session(session), Action::Read)
            .map_err(|_| GateError::Invalid)?;
        Ok(Some(grants))
    }
}
