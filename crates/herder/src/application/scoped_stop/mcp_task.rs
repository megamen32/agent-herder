//! Durable MCP task projection from the existing scoped intent and task rows.
//! A terminal UNKNOWN reports the request's uncertainty, never native completion.
use super::{GateError, ScopedAuthority};
use crate::{
    application::reconcile::{ReceiptBinding, StoredReceipt, load_native_receipt},
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    error::{Diagnostic, Effect, Retry},
};
use rmcp::model::{CallToolResult, DetailedTask, GetTaskResult, Task, TaskPayload, TaskStatus};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

impl ScopedAuthority {
    /// Finalize and read a delivery task using the authoritative store. The
    /// terminal status/result are persisted together and never overwritten.
    /// The authenticated principal needs the exact session read grant.
    pub fn get_delivery_task(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        task_id: &str,
    ) -> Result<Option<GetTaskResult>, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        if task_id.is_empty() {
            return Err(GateError::Invalid);
        }
        let (_gate, mut writer) = self.lock()?;
        let tx = writer
            .connection_mut()
            .transaction()
            .map_err(|_| GateError::Store)?;
        let row:Option<(String,String,String,String,String,String,String,Option<String>,String,String,String)>=tx.query_row(
            "SELECT i.intent_id,i.target,i.request_key,i.state,t.status,t.created_at,t.updated_at,t.result_json,b.node_ref,b.instance_id,b.native_session_id FROM tasks t JOIN intents i ON i.task_id=t.task_id JOIN session_bindings b ON b.session_ref=i.target JOIN humanstop_sessions s ON s.session_ref=b.session_ref WHERE t.task_id=?1 AND t.principal=?2 AND i.principal=?2 AND s.authority_generation=?3 AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref)",
            params![task_id,principal.id.0,self.generation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional().map_err(|_|GateError::Store)?;
        let Some((
            intent_id,
            target_ref,
            key,
            state,
            status,
            created,
            mut updated,
            stored,
            node,
            instance,
            native,
        )) = row
        else {
            return Ok(None);
        };
        let session = SessionRef(target_ref.clone());
        identity
            .authorize(grants, &PrivateResource::Session(session), Action::Read)
            .map_err(|_| GateError::Invalid)?;
        let address = SessionAddress {
            instance: InstanceRef {
                node: NodeRef(node),
                instance_id: instance,
            },
            native_session_id: native,
        };
        let binding = ReceiptBinding {
            intent_id: &intent_id,
            principal: &principal.id.0,
            target_ref: &target_ref,
            request_key: &key,
            address: &address,
        };
        let payload = if status == "completed" {
            let value: Value = serde_json::from_str(stored.as_deref().ok_or(GateError::Store)?)
                .map_err(|_| GateError::Store)?;
            TaskPayload::Completed {
                result: value.as_object().cloned().ok_or(GateError::Store)?,
            }
        } else {
            let terminal = match state.as_str() {
                "unknown" => Some(CallToolResult::structured_error(
                    serde_json::to_value(Diagnostic::outcome_unknown(None))
                        .map_err(|_| GateError::Store)?,
                )),
                "rejected" => {
                    let diagnostic: Value = stored
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(Value::Null);
                    let no_send = diagnostic["native_submit"] == "definitely_not_sent";
                    Some(CallToolResult::structured_error(if no_send {
                        let (code, field, expected) = if diagnostic["outcome"]
                            == "stopped_before_handoff"
                        {
                            (
                                "human_stop_active",
                                Some("session_ref"),
                                "resolve the authorized HumanStop hold before using a new request key",
                            )
                        } else if diagnostic["outcome"] == "rejected" {
                            (
                                "adapter_refused",
                                None,
                                "check the configured adapter and request before using a new request key",
                            )
                        } else {
                            return Err(GateError::Store);
                        };
                        serde_json::to_value(Diagnostic {
                            code,
                            field,
                            received: None,
                            expected: Some(vec![expected]),
                            fix: None,
                            effect: Effect::None,
                            retry: Retry::Forbidden,
                            receipt_ref: None,
                            diagnostic_ref: None,
                        })
                        .map_err(|_| GateError::Store)?
                    } else {
                        serde_json::to_value(Diagnostic::outcome_unknown(None))
                            .map_err(|_| GateError::Store)?
                    }))
                }
                "confirmed" => {
                    match load_native_receipt(&tx, &binding).map_err(|_| GateError::Store)? {
                        StoredReceipt::Found(receipt) => Some(CallToolResult::structured(
                            json!({"outcome":"confirmed","native_turn_id":receipt.native_id}),
                        )),
                        StoredReceipt::Unknown => Some(CallToolResult::structured_error(
                            serde_json::to_value(Diagnostic::outcome_unknown(None))
                                .map_err(|_| GateError::Store)?,
                        )),
                    }
                }
                "prepared" | "dispatching" | "admitted" => None,
                _ => return Err(GateError::Store),
            };
            if let Some(result) = terminal {
                let value = serde_json::to_value(result).map_err(|_| GateError::Store)?;
                let object = value.as_object().cloned().ok_or(GateError::Store)?;
                let serialized = serde_json::to_string(&value).map_err(|_| GateError::Store)?;
                let terminal_time =
                    super::mcp_deliver::utc_now().map_err(|_| GateError::Unavailable)?;
                let count=tx.execute("UPDATE tasks SET status='completed',result_json=?2,updated_at=?3 WHERE task_id=?1 AND status<>'completed'",params![task_id,serialized,terminal_time]).map_err(|_|GateError::Store)?;
                if count != 1 {
                    return Err(GateError::Store);
                }
                updated = terminal_time;
                TaskPayload::Completed { result: object }
            } else {
                TaskPayload::Working
            }
        };
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(Some(GetTaskResult::new(DetailedTask::new(
            Task::new(task_id, TaskStatus::Working, created, updated),
            payload,
        ))))
    }
}
