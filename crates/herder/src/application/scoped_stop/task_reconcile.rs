//! Read-only native receipt reconciliation; never submits or holds a DB
//! transaction or the scoped gate while waiting for the native reader.
use crate::{
    application::{
        reconcile::{
            ReceiptBinding, Reconciliation, StoredReceipt, load_native_receipt,
            reconcile_dispatching,
        },
        scoped_stop::{GateError, ScopedAuthority, create_prompt::FreshSessionGrantPolicy},
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        adapter::NativeSessionReader,
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use std::sync::Arc;

impl ScopedAuthority {
    /// Read exactly the persisted receipt, release gate and writer for native
    /// I/O, then reacquire and persist confirmation only if every binding and
    /// receipt byte is still the same. No submit path is reachable here.
    pub async fn reconcile_delivery_task<R: NativeSessionReader>(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        task_id: &str,
        reader: &R,
    ) -> Result<Reconciliation, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let (intent, target, key, address, raw, receipt) = {
            let (_guard, writer) = self.lock()?;
            let row:Option<(String,String,String,Option<String>,String,String,String)>=writer.connection().query_row("SELECT i.intent_id,i.target,i.request_key,i.native_receipt,b.node_ref,b.instance_id,b.native_session_id FROM intents i JOIN tasks t ON t.task_id=i.task_id JOIN session_bindings b ON b.session_ref=i.target JOIN humanstop_sessions s ON s.session_ref=b.session_ref WHERE t.task_id=?1 AND t.principal=?2 AND i.principal=?2 AND i.state='admitted' AND t.status<>'completed' AND s.authority_generation=?3 AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref)",params![task_id,principal.id.0,self.generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|GateError::Store)?;
            let Some((intent, target, key, raw, node, instance, native)) = row else {
                return Ok(Reconciliation::Unknown);
            };
            identity
                .authorize(
                    grants,
                    &PrivateResource::Session(SessionRef(target.clone())),
                    Action::Read,
                )
                .map_err(|_| GateError::Invalid)?;
            let Some(raw) = raw else {
                return Ok(Reconciliation::Unknown);
            };
            let address = SessionAddress {
                instance: InstanceRef {
                    node: NodeRef(node),
                    instance_id: instance,
                },
                native_session_id: native,
            };
            let binding = ReceiptBinding {
                intent_id: &intent,
                principal: &principal.id.0,
                target_ref: &target,
                request_key: &key,
                address: &address,
            };
            let StoredReceipt::Found(receipt) =
                load_native_receipt(writer.connection(), &binding).map_err(|_| GateError::Store)?
            else {
                return Ok(Reconciliation::Unknown);
            };
            (intent, target, key, address, raw, receipt)
        };
        let observed = reconcile_dispatching(reader, Some(&receipt)).await;
        if !matches!(&observed,Reconciliation::Confirmed(r) if *r==receipt) {
            return Ok(observed);
        }
        let (_guard, mut writer) = self.lock()?;
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        let binding = ReceiptBinding {
            intent_id: &intent,
            principal: &principal.id.0,
            target_ref: &target,
            request_key: &key,
            address: &address,
        };
        if load_native_receipt(&tx, &binding).map_err(|_| GateError::Store)?
            != StoredReceipt::Found(receipt.clone())
        {
            return Ok(Reconciliation::Unknown);
        }
        let count=tx.execute("UPDATE intents SET state='confirmed',updated_at=?7 WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND task_id=?5 AND state='admitted' AND native_receipt=?6 AND EXISTS(SELECT 1 FROM tasks WHERE task_id=?5 AND status<>'completed')",params![intent,principal.id.0,target,key,task_id,raw,super::mcp_deliver::utc_now().map_err(|_|GateError::Unavailable)?]).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(if count == 1 {
            Reconciliation::Confirmed(receipt)
        } else {
            Reconciliation::Unknown
        })
    }
}

/// A trusted reader adapter supplies bounded, read-only receipt verification.
pub trait TaskReconciler: Send + Sync {
    fn reconcile(
        &self,
        identity: ConnectionIdentity,
        grants: Vec<Grant>,
        task_id: String,
        policy: Option<Arc<dyn FreshSessionGrantPolicy + Send + Sync>>,
    );
}
pub struct ScopedReceiptReconciler<R> {
    authority: Arc<ScopedAuthority>,
    reader: Arc<R>,
}
impl<R> ScopedReceiptReconciler<R> {
    pub fn new(authority: Arc<ScopedAuthority>, reader: Arc<R>) -> Self {
        Self { authority, reader }
    }
}
impl<R: NativeSessionReader + Send + Sync + 'static> TaskReconciler for ScopedReceiptReconciler<R> {
    fn reconcile(
        &self,
        identity: ConnectionIdentity,
        grants: Vec<Grant>,
        task_id: String,
        policy: Option<Arc<dyn FreshSessionGrantPolicy + Send + Sync>>,
    ) {
        let target = match self
            .authority
            .create_child_for_reconciliation(&identity, &grants, &task_id)
        {
            Ok(Some(child)) => child,
            Ok(None) => task_id,
            Err(_) => return,
        };
        let grants = match self.authority.current_task_read_grants(
            &identity,
            &grants,
            &target,
            policy.as_deref(),
        ) {
            Ok(Some(grants)) => grants,
            _ => return,
        };
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            let _ = runtime.block_on(self.authority.reconcile_delivery_task(
                &identity,
                &grants,
                &target,
                self.reader.as_ref(),
            ));
        }
    }
}
