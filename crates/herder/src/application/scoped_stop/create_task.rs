//! Durable aggregate task for fresh create plus separately fenced prompt.
//! This uses the existing tasks table, not a second store or queue.
use super::{GateError, ScopedAuthority, create_prompt::CreatePromptOutcome};
use crate::{
    application::reconcile::{ReceiptBinding, StoredReceipt, load_native_receipt},
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource},
    domain::address::{InstanceRef, NodeRef, SessionAddress},
    error::Diagnostic,
};
use rmcp::model::{CallToolResult, DetailedTask, GetTaskResult, Task, TaskPayload, TaskStatus};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Read;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    kind: String,
    instance: InstanceRef,
    session_ref: Option<String>,
    delivery_task: Option<String>,
    result: Option<Value>,
}
fn result(value: Value, is_error: bool) -> Result<Value, GateError> {
    serde_json::to_value(if is_error {
        CallToolResult::structured_error(value)
    } else {
        CallToolResult::structured(value)
    })
    .map_err(|_| GateError::Store)
}

fn prompt_unknown(record: &Record) -> bool {
    record.result.as_ref().is_some_and(|result| {
        result.get("isError").and_then(Value::as_bool) == Some(true)
            && result.pointer("/structuredContent/prompt/effect").and_then(Value::as_str) == Some("unknown")
    })
}

/// A legacy aggregate sometimes omitted its child when the prompt ACK was
/// lost. Recover that relationship only from the unique durable create receipt
/// for this exact root and the original deterministic prompt identifiers.
/// Neither session recency nor a caller-supplied message ID establishes it.
fn linked_delivery(
    connection: &Connection,
    principal: &PrincipalId,
    record: &Record,
    generation: &str,
) -> Result<Option<String>, GateError> {
    let Some(session) = record.session_ref.as_deref() else { return Ok(None) };
    let native: Option<String> = connection.query_row(
        "SELECT b.native_session_id FROM session_bindings b JOIN humanstop_sessions s ON s.session_ref=b.session_ref \
         JOIN lineage l ON l.session_ref=b.session_ref WHERE b.session_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 \
         AND s.authority_generation=?4 AND l.creator_ref=?5 AND l.parent_ref IS NULL \
         AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') \
         AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref)",
        params![session, record.instance.node.0, record.instance.instance_id, generation, principal.0],
        |row| row.get(0),
    ).optional().map_err(|_| GateError::Store)?;
    let Some(native) = native else { return Ok(None) };
    let child = if let Some(child) = &record.delivery_task {
        child.clone()
    } else {
        let target = serde_json::to_string(&record.instance).map_err(|_| GateError::Store)?;
        let mut statement = connection.prepare(
            "SELECT i.request_key,i.native_receipt FROM intents i JOIN tasks t ON t.task_id=i.task_id \
             WHERE i.principal=?1 AND t.principal=?1 AND i.target=?2 AND i.state IN ('admitted','confirmed') \
             AND json_extract(CASE WHEN json_valid(i.native_receipt) THEN i.native_receipt ELSE '{}' END,'$.session_ref')=?3 LIMIT 2",
        ).map_err(|_| GateError::Store)?;
        let receipts: Vec<(String, String)> = statement.query_map(params![principal.0, target, session],
            |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| GateError::Store)?.collect::<rusqlite::Result<_>>().map_err(|_| GateError::Store)?;
        if receipts.len() != 1 { return Ok(None) }
        let (key, raw) = &receipts[0];
        let receipt: super::create_recovery::Receipt = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if receipt.version != 1 || receipt.request_key != *key || receipt.instance != record.instance
            || receipt.native_session_id != native || receipt.session_ref != session || receipt.parent_ref.is_some()
            || key.is_empty() || key.len() > 4096
        { return Ok(None) }
        let (delivery_key, intent, child) = super::create_prompt::delivery_identifiers(principal, &record.instance, key)?;
        let exact: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM intents WHERE intent_id=?1 AND task_id=?2 AND principal=?3 AND target=?4 AND request_key=?5)",
            params![intent, child, principal.0, session, delivery_key], |row| row.get(0),
        ).map_err(|_| GateError::Store)?;
        if !exact { return Ok(None) }
        child
    };
    let exact: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.task_id=?1 AND i.principal=?2 AND t.principal=?2 AND i.target=?3)",
        params![child, principal.0, session], |row| row.get(0),
    ).map_err(|_| GateError::Store)?;
    Ok(exact.then_some(child))
}

fn confirmed_child_matches(
    connection: &Connection,
    principal: &PrincipalId,
    child: &str,
    session: &str,
    expected: &Value,
) -> Result<bool, GateError> {
    let row: Option<(String, String, String, String, String, String)> = connection.query_row(
        "SELECT i.intent_id,i.request_key,t.result_json,b.node_ref,b.instance_id,b.native_session_id \
         FROM intents i JOIN tasks t ON t.task_id=i.task_id JOIN session_bindings b ON b.session_ref=i.target \
         WHERE i.task_id=?1 AND i.principal=?2 AND t.principal=?2 AND i.target=?3 AND i.state='confirmed' AND t.status='completed'",
        params![child, principal.0, session], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).optional().map_err(|_| GateError::Store)?;
    let Some((intent, key, raw, node, instance, native)) = row else { return Ok(false) };
    if serde_json::from_str::<Value>(&raw).ok().as_ref() != Some(expected) { return Ok(false) }
    let address = SessionAddress { instance: InstanceRef { node: NodeRef(node), instance_id: instance }, native_session_id: native };
    let binding = ReceiptBinding { intent_id: &intent, principal: &principal.0, target_ref: session, request_key: &key, address: &address };
    Ok(matches!(load_native_receipt(connection, &binding).map_err(|_| GateError::Store)?, StoredReceipt::Found(receipt)
        if expected.pointer("/structuredContent/native_receipt_id").and_then(Value::as_str) == Some(receipt.native_id.as_str())))
}
fn random_task_id() -> Result<String, GateError> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| GateError::Unavailable)?;
    Ok(format!(
        "create-operation:{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
impl ScopedAuthority {
    /// Record the result before returning its handle to the caller. An error
    /// after native activity remains UNKNOWN; never retry native work here.
    pub(super) fn record_create_task(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        instance: &InstanceRef,
        delivery_task: &str,
        outcome: CreatePromptOutcome,
    ) -> Result<String, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let target = serde_json::to_string(instance).map_err(|_| GateError::Invalid)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Resource(format!("instance:{target}")),
                Action::Write,
            )
            .map_err(|_| GateError::Invalid)?;
        let (status, session, child, body) = match outcome {
            CreatePromptOutcome::CreateUnknown | CreatePromptOutcome::CreatePending => (
                "completed",
                None,
                None,
                Some(result(
                    json!({"create":{"effect":"unknown"},"prompt":{"effect":"unknown"},"diagnostic":Diagnostic::outcome_unknown(None)}),
                    true,
                )?),
            ),
            CreatePromptOutcome::CreateDefinitelyNotSent => (
                "completed",
                None,
                None,
                Some(result(
                    json!({"create":{"effect":"none"},"prompt":{"effect":"none"},"code":"create_not_sent"}),
                    true,
                )?),
            ),
            CreatePromptOutcome::Conflict => (
                "completed",
                None,
                None,
                Some(result(
                    json!({"code":"idempotency_conflict","effect":"unknown"}),
                    true,
                )?),
            ),
            CreatePromptOutcome::DeliveryUnknownOrBlocked { session } => {
                let s = session.0;
                (
                    "completed",
                    Some(s.clone()),
                    Some(delivery_task.to_owned()),
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":Diagnostic::outcome_unknown(None)}),
                        true,
                    )?),
                )
            }
            CreatePromptOutcome::DeliveryBrowserOutcomeUnknown { session, diagnostic } => {
                let s = session.0;
                (
                    "completed",
                    Some(s.clone()),
                    Some(delivery_task.to_owned()),
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":Diagnostic::browser_send_unknown(Some(diagnostic))}),
                        true,
                    )?),
                )
            }
            CreatePromptOutcome::DeliveryNotSent {
                session,
                diagnostic,
            } => {
                let s = session.0;
                (
                    "completed",
                    Some(s.clone()),
                    None,
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":diagnostic}),
                        true,
                    )?),
                )
            }
            CreatePromptOutcome::DeliveryDefinitelyNotSent { session } => {
                let s = session.0;
                (
                    "completed",
                    Some(s.clone()),
                    None,
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":{"code":"adapter_refused","effect":"none","retry":"forbidden"}}),
                        true,
                    )?),
                )
            }
            CreatePromptOutcome::StoppedBeforeHandoff { session } => {
                let s = session.0;
                (
                    "completed",
                    Some(s.clone()),
                    None,
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":{"code":"human_stop_active","effect":"none","retry":"forbidden"}}),
                        true,
                    )?),
                )
            }
            CreatePromptOutcome::Admitted { session, .. } => (
                "working",
                Some(session.0),
                Some(delivery_task.to_owned()),
                None,
            ),
        };
        let record = Record {
            kind: "fresh_create_prompt_v1".into(),
            instance: instance.clone(),
            session_ref: session,
            delivery_task: child,
            result: body,
        };
        let raw = serde_json::to_string(&record).map_err(|_| GateError::Store)?;
        let now = super::mcp_deliver::utc_now().map_err(|_| GateError::Unavailable)?;
        let (_gate, writer) = self.lock()?;
        let id = random_task_id()?;
        writer.connection().execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at,result_json) VALUES (?1,?2,?3,?4,?4,?5)",params![id,principal.id.0,status,now,raw]).map_err(|_|GateError::Store)?;
        Ok(id)
    }
    /// Read only the caller's own aggregate task under its exact instance grant.
    /// A linked delivery remains working until exact receipt confirmation is
    /// available to the caller with an independent session read grant.
    pub fn get_create_task(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        id: &str,
    ) -> Result<Option<GetTaskResult>, GateError> {
        self.get_create_task_with_policy(identity, grants, id, None)
    }
    pub fn get_create_task_with_policy(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        id: &str,
        policy: Option<&(dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync)>,
    ) -> Result<Option<GetTaskResult>, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let (_gate, writer) = self.lock()?;
        let row:Option<(String,String,String,String)>=writer.connection().query_row("SELECT status,created_at,updated_at,result_json FROM tasks WHERE task_id=?1 AND principal=?2",params![id,principal.id.0],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|GateError::Store)?;
        let Some((status, created, updated, raw)) = row else {
            return Ok(None);
        };
        let mut record: Record = match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        if record.kind != "fresh_create_prompt_v1" {
            return Ok(None);
        }
        let target = serde_json::to_string(&record.instance).map_err(|_| GateError::Store)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Resource(format!("instance:{target}")),
                Action::Write,
            )
            .map_err(|_| GateError::Invalid)?;
        let child = if status == "working" || status == "completed" && prompt_unknown(&record) {
            linked_delivery(writer.connection(), &principal.id, &record, &self.generation)?
        } else {
            record.delivery_task.clone()
        };
        let session = record.session_ref.clone();
        drop(writer);
        drop(_gate);
        let mut child_grants = grants.to_vec();
        if let (Some(policy), Some(session_ref)) = (policy, session.as_ref()) {
            let exact = crate::domain::address::SessionRef(session_ref.clone());
            if let Ok(Some(grant)) =
                policy.session_read_grant(&principal.id, &record.instance, &exact)
            {
                if grant.principal == principal.id
                    && grant.action == Action::Read
                    && grant.resource == PrivateResource::Session(exact)
                {
                    child_grants.push(grant);
                }
            }
        }
        if status == "completed" {
            if child.is_some() || record.delivery_task.is_some() {
                let exact =
                    crate::domain::address::SessionRef(session.clone().ok_or(GateError::Store)?);
                identity
                    .authorize(
                        &child_grants,
                        &PrivateResource::Session(exact),
                        Action::Read,
                    )
                    .map_err(|_| GateError::Invalid)?;
            }
            let mut visible = record.result.clone().ok_or(GateError::Store)?;
            if prompt_unknown(&record) {
                if let (Some(child), Some(session)) = (child.as_ref(), session.as_ref()) {
                    if let Ok(Some(delivery)) = self.get_delivery_task(identity, &child_grants, child) {
                        if let TaskPayload::Completed { result: child_result } = delivery.task.payload {
                            let expected = Value::Object(child_result);
                            if expected.pointer("/structuredContent/outcome").and_then(Value::as_str) == Some("confirmed")
                                && expected.get("isError").and_then(Value::as_bool) != Some(true)
                            {
                                let (_guard, writer) = self.lock()?;
                                let unchanged: bool = writer.connection().query_row(
                                    "SELECT EXISTS(SELECT 1 FROM tasks WHERE task_id=?1 AND principal=?2 AND status=?3 AND updated_at=?4 AND result_json=?5)",
                                    params![id, principal.id.0, status, updated, raw], |row| row.get(0),
                                ).map_err(|_| GateError::Store)?;
                                if !unchanged
                                    || linked_delivery(writer.connection(), &principal.id, &record, &self.generation)?.as_ref() != Some(child)
                                    || !confirmed_child_matches(writer.connection(), &principal.id, child, session, &expected)?
                                { return Err(GateError::Store) }
                                // This is a read projection. The completed original
                                // parent error record stays byte-for-byte in storage.
                                visible = result(json!({
                                    "create": {"effect":"confirmed", "session_ref":session},
                                    "prompt": expected["structuredContent"],
                                    "reconciliation": {"kind":"native_admission", "original_result_json":raw},
                                }), false)?;
                            }
                        }
                    }
                }
            }
            let object = visible.as_object().cloned().ok_or(GateError::Store)?;
            return Ok(Some(GetTaskResult::new(DetailedTask::new(
                Task::new(id, TaskStatus::Completed, created, updated),
                TaskPayload::Completed { result: object },
            ))));
        }
        if status != "working" {
            return Err(GateError::Store);
        }
        if let (Some(child), Some(session)) = (child, session) {
            if let Ok(Some(d)) = self.get_delivery_task(identity, &child_grants, &child) {
                if let TaskPayload::Completed {
                    result: child_result,
                } = d.task.payload
                {
                    let is_error = child_result
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let prompt = child_result
                        .get("structuredContent")
                        .cloned()
                        .unwrap_or_else(|| json!({"effect":"unknown"}));
                    record.result = Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":session},"prompt":prompt}),
                        is_error,
                    )?);
                    let raw = serde_json::to_string(&record).map_err(|_| GateError::Store)?;
                    let now = super::mcp_deliver::utc_now().map_err(|_| GateError::Unavailable)?;
                    let (_guard, writer) = self.lock()?;
                    writer.connection().execute("UPDATE tasks SET status='completed',result_json=?3,updated_at=?4 WHERE task_id=?1 AND principal=?2 AND status='working'",params![id,principal.id.0,raw,now]).map_err(|_|GateError::Store)?;
                    drop(writer);
                    drop(_guard);
                    return self.get_create_task_with_policy(identity, grants, id, policy);
                }
            }
        }
        Ok(Some(GetTaskResult::new(DetailedTask::new(
            Task::new(id, TaskStatus::Working, created, updated),
            TaskPayload::Working,
        ))))
    }
}

impl ScopedAuthority {
    /// Resolve a working or terminal UNKNOWN aggregate to its exact delivery.
    /// The task grant resolver still independently authorizes session read.
    pub(super) fn create_child_for_reconciliation(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        id: &str,
    ) -> Result<Option<String>, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let (_guard, writer) = self.lock()?;
        let row: Option<(String, String)> = writer.connection().query_row(
            "SELECT status,result_json FROM tasks WHERE task_id=?1 AND principal=?2 AND status IN ('working','completed')",
            params![id, principal.id.0], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| GateError::Store)?;
        let Some((status, raw)) = row else { return Ok(None) };
        let record: Record = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if record.kind != "fresh_create_prompt_v1" || status == "completed" && !prompt_unknown(&record) {
            return Ok(None);
        }
        let target = serde_json::to_string(&record.instance).map_err(|_| GateError::Store)?;
        identity.authorize(
            grants, &PrivateResource::Resource(format!("instance:{target}")), Action::Write,
        ).map_err(|_| GateError::Invalid)?;
        linked_delivery(writer.connection(), &principal.id, &record, &self.generation)
    }
}
