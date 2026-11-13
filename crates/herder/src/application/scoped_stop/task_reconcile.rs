//! Read-only native receipt reconciliation. Native I/O never holds the scoped
//! gate or a DB transaction, and no prepare, submit or wake path is reachable.
use crate::{
    application::{
        reconcile::{
            ReceiptBinding, Reconciliation, StoredReceipt, encode_native_receipt,
            load_native_receipt, reconcile_dispatching,
        },
        scoped_stop::{GateError, ScopedAuthority, create_prompt::FreshSessionGrantPolicy},
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        adapter::{NativeReceipt, NativeSessionReader, RequestKey},
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
};
use rmcp::model::CallToolResult;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::sync::Arc;

/// Compare every intent byte and its task/native authority binding after I/O.
/// A changed payload, timestamp or retained diagnostic is a conflict too.
#[derive(Debug, PartialEq, Eq)]
struct DeliverySnapshot {
    intent: String,
    task: String,
    principal: String,
    target: String,
    key: String,
    payload: String,
    state: String,
    raw_receipt: Option<String>,
    intent_created: String,
    intent_updated: String,
    retain_until: String,
    task_status: String,
    task_created: String,
    task_updated: String,
    task_expires: Option<String>,
    task_result: Option<String>,
    address: SessionAddress,
    authority_generation: String,
    scope_generation: String,
    scope_created: String,
    dispatch_phase: Option<String>,
    dispatch_updated: Option<String>,
    dispatch_generation: Option<String>,
}
impl DeliverySnapshot {
    fn binding(&self) -> ReceiptBinding<'_> {
        ReceiptBinding {
            intent_id: &self.intent,
            principal: &self.principal,
            target_ref: &self.target,
            request_key: &self.key,
            address: &self.address,
        }
    }
    fn completed_unknown(&self) -> bool {
        self.task_result.as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|value| {
                value.get("isError").and_then(Value::as_bool) == Some(true)
                    && value.pointer("/structuredContent/effect").and_then(Value::as_str) == Some("unknown")
            })
    }
    fn already_confirmed(&self, receipt: &NativeReceipt) -> bool {
        self.state == "confirmed" && self.task_status == "completed"
            && self.task_result.as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .is_some_and(|value| {
                    value.pointer("/structuredContent/outcome").and_then(Value::as_str) == Some("confirmed")
                        && value.pointer("/structuredContent/native_receipt_id").and_then(Value::as_str)
                            == Some(receipt.native_id.as_str())
                })
    }
    fn dispatch_needs_finalization(&self) -> bool {
        self.dispatch_phase.as_deref() == Some("handing_off")
    }
    fn dispatch_binding_valid(&self) -> bool {
        match self.dispatch_phase.as_deref() {
            // Earlier receipt-only authorities did not persist dispatch rows.
            None => self.dispatch_generation.is_none() && self.dispatch_updated.is_none(),
            Some("handing_off" | "finished") => {
                self.dispatch_generation.as_deref() == Some(self.scope_generation.as_str())
                    && self.dispatch_updated.is_some()
            }
            // A claim that has not entered handoff cannot prove a native effect.
            _ => false,
        }
    }
}

fn delivery_snapshot(
    connection: &Connection,
    task_id: &str,
    principal: &str,
    generation: &str,
) -> Result<Option<DeliverySnapshot>, GateError> {
    connection.query_row(
        "SELECT i.intent_id,i.task_id,i.principal,i.target,i.request_key,i.payload_hash,i.state,\
         i.native_receipt,i.created_at,i.updated_at,i.retain_until,\
         t.status,t.created_at,t.updated_at,t.expires_at,t.result_json,\
         b.node_ref,b.instance_id,b.native_session_id,\
         s.authority_generation,s.scope_generation,s.created_at,d.phase,d.updated_at,d.scope_generation \
         FROM intents i JOIN tasks t ON t.task_id=i.task_id \
         JOIN session_bindings b ON b.session_ref=i.target \
         JOIN humanstop_sessions s ON s.session_ref=b.session_ref \
         LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id \
         WHERE t.task_id=?1 AND t.principal=?2 AND i.principal=?2 \
         AND s.authority_generation=?3 \
         AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') \
         AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref)",
        params![task_id, principal, generation],
        |row| Ok(DeliverySnapshot {
            intent: row.get(0)?, task: row.get(1)?, principal: row.get(2)?,
            target: row.get(3)?, key: row.get(4)?, payload: row.get(5)?,
            state: row.get(6)?, raw_receipt: row.get(7)?,
            intent_created: row.get(8)?, intent_updated: row.get(9)?, retain_until: row.get(10)?,
            task_status: row.get(11)?, task_created: row.get(12)?, task_updated: row.get(13)?,
            task_expires: row.get(14)?, task_result: row.get(15)?,
            address: SessionAddress {
                instance: InstanceRef { node: NodeRef(row.get(16)?), instance_id: row.get(17)? },
                native_session_id: row.get(18)?,
            },
            authority_generation: row.get(19)?, scope_generation: row.get(20)?, scope_created: row.get(21)?,
            dispatch_phase: row.get(22)?, dispatch_updated: row.get(23)?,
            dispatch_generation: row.get(24)?,
        }),
    ).optional().map_err(|_| GateError::Store)
}

impl ScopedAuthority {
    /// Recover a lost ACK by exact native request-key evidence, or verify an
    /// existing receipt. Confirmation means admission, never model completion.
    /// Terminal UNKNOWN gains evidence while retaining the original result bytes.
    /// HumanStop holds remain active and this function cannot launch a wake.
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
        let (snapshot, persisted) = {
            let (_guard, writer) = self.lock()?;
            let Some(snapshot) = delivery_snapshot(
                writer.connection(), task_id, &principal.id.0, &self.generation,
            )? else { return Ok(Reconciliation::Unknown) };
            identity.authorize(
                grants, &PrivateResource::Session(SessionRef(snapshot.target.clone())), Action::Read,
            ).map_err(|_| GateError::Invalid)?;
            if !matches!(snapshot.state.as_str(), "dispatching" | "admitted" | "unknown" | "confirmed") {
                return Ok(Reconciliation::Unknown);
            }
            if !snapshot.dispatch_binding_valid() {
                return Ok(Reconciliation::Unknown);
            }
            let persisted = match snapshot.raw_receipt.as_ref() {
                Some(_) => match load_native_receipt(writer.connection(), &snapshot.binding())
                    .map_err(|_| GateError::Store)? {
                    StoredReceipt::Found(receipt) => Some(receipt),
                    StoredReceipt::Unknown => return Ok(Reconciliation::Unknown),
                },
                None if snapshot.state == "confirmed" => return Ok(Reconciliation::Unknown),
                None => None,
            };
            if let Some(receipt) = &persisted {
                if snapshot.already_confirmed(receipt) && !snapshot.dispatch_needs_finalization() {
                    return Ok(Reconciliation::Confirmed(receipt.clone()));
                }
            }
            if snapshot.task_status == "completed" && !snapshot.completed_unknown()
                && !persisted.as_ref().is_some_and(|receipt| snapshot.already_confirmed(receipt))
            {
                return Ok(Reconciliation::Unknown);
            }
            (snapshot, persisted)
        };
        let recovered_ack = persisted.is_none();
        let receipt = match persisted {
            Some(receipt) => receipt,
            None => match reader.recover_admission(&snapshot.address, &RequestKey(snapshot.key.clone())).await {
                Ok(Some(receipt)) if receipt.target == snapshot.address => receipt,
                _ => return Ok(Reconciliation::Unknown),
            },
        };
        let Some(encoded) = encode_native_receipt(&snapshot.binding(), &receipt) else {
            return Ok(Reconciliation::Unknown);
        };
        let observed = reconcile_dispatching(reader, Some(&receipt)).await;
        if !matches!(&observed, Reconciliation::Confirmed(value) if *value == receipt) {
            return Ok(observed);
        }

        let (_guard, mut writer) = self.lock()?;
        let tx = writer.connection_mut().transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        if delivery_snapshot(&tx, task_id, &principal.id.0, &self.generation)?.as_ref() != Some(&snapshot) {
            return Ok(Reconciliation::Unknown);
        }
        identity.authorize(
            grants, &PrivateResource::Session(SessionRef(snapshot.target.clone())), Action::Read,
        ).map_err(|_| GateError::Invalid)?;
        let now = super::mcp_deliver::utc_now().map_err(|_| GateError::Unavailable)?;
        if snapshot.dispatch_needs_finalization() {
            // An exact native admission settles only its own durable handoff.
            // This is in the same transaction as the intent/task receipt, so
            // scope_unsettled cannot retain a confirmed, orphaned handoff.
            let changed = tx.execute(
                "UPDATE humanstop_dispatches SET phase='finished',updated_at=?4 \
                 WHERE intent_id=?1 AND scope_generation=?2 AND phase='handing_off' AND updated_at=?3",
                params![snapshot.intent, snapshot.dispatch_generation, snapshot.dispatch_updated, now],
            ).map_err(|_| GateError::Store)?;
            if changed != 1 { return Ok(Reconciliation::Unknown) }
        }
        if snapshot.already_confirmed(&receipt) {
            // Repair an earlier confirmed receipt with an unfinished dispatch
            // without replacing its original task result or diagnostics.
            tx.commit().map_err(|_| GateError::Store)?;
            return Ok(Reconciliation::Confirmed(receipt));
        }
        // Preserve pre-existing receipt bytes, including their original encoding.
        let raw = snapshot.raw_receipt.as_deref().unwrap_or(&encoded);
        let changed = tx.execute(
            "UPDATE intents SET state='confirmed',native_receipt=?2,updated_at=?3 WHERE intent_id=?1",
            params![snapshot.intent, raw, now],
        ).map_err(|_| GateError::Store)?;
        if changed != 1 { return Ok(Reconciliation::Unknown) }
        let result = CallToolResult::structured(json!({
            "outcome": "confirmed",
            "native_receipt_id": receipt.native_id,
            "reconciliation": {
                "kind": "native_admission",
                "ack_recovered": recovered_ack,
                "observed_at": now,
                "original_intent_state": snapshot.state,
                "original_task_status": snapshot.task_status,
                "original_result_json": snapshot.task_result,
                "original_dispatch_phase": snapshot.dispatch_phase,
                "dispatch_scope_generation": snapshot.dispatch_generation,
            },
        }));
        let serialized = serde_json::to_string(&result).map_err(|_| GateError::Store)?;
        let changed = tx.execute(
            "UPDATE tasks SET status='completed',result_json=?2,updated_at=?3 WHERE task_id=?1 AND principal=?4",
            params![task_id, serialized, now, principal.id.0],
        ).map_err(|_| GateError::Store)?;
        if changed != 1 { return Ok(Reconciliation::Unknown) }
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(Reconciliation::Confirmed(receipt))
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
        let target = match self.authority.create_child_for_reconciliation(&identity, &grants, &task_id) {
            Ok(Some(child)) => child,
            Ok(None) => task_id,
            Err(_) => return,
        };
        let grants = match self.authority.current_task_read_grants(
            &identity, &grants, &target, policy.as_deref(),
        ) {
            Ok(Some(grants)) => grants,
            _ => return,
        };
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
            let _ = runtime.block_on(self.authority.reconcile_delivery_task(
                &identity, &grants, &target, self.reader.as_ref(),
            ));
        }
    }
}
