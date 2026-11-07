//! Durable aggregate task for fresh create plus separately fenced prompt.
//! This uses the existing tasks table, not a second store or queue.
use super::{GateError, ScopedAuthority, create_prompt::CreatePromptOutcome};
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::address::InstanceRef,
    error::Diagnostic,
};
use rmcp::model::{CallToolResult, DetailedTask, GetTaskResult, Task, TaskPayload, TaskStatus};
use rusqlite::{OptionalExtension, params};
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
                    None,
                    Some(result(
                        json!({"create":{"effect":"confirmed","session_ref":s},"prompt":Diagnostic::outcome_unknown(None)}),
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
        let child = record.delivery_task.clone();
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
            if child.is_some() {
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
            let object = record
                .result
                .and_then(|v| v.as_object().cloned())
                .ok_or(GateError::Store)?;
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
    /// Resolve a working aggregate to its linked delivery without granting any
    /// broader session permission. The task grant resolver validates the child.
    pub(super) fn create_child_for_reconciliation(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        id: &str,
    ) -> Result<Option<String>, GateError> {
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        let record = {
            let (_guard, writer) = self.lock()?;
            let raw:Option<String>=writer.connection().query_row("SELECT result_json FROM tasks WHERE task_id=?1 AND principal=?2 AND status='working'",params![id,principal.id.0],|r|r.get(0)).optional().map_err(|_|GateError::Store)?;
            let Some(raw) = raw else { return Ok(None) };
            let record: Record = match serde_json::from_str(&raw) {
                Ok(v) => v,
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
            record
        };
        let (Some(child), Some(_session)) = (record.delivery_task, record.session_ref) else {
            return Ok(None);
        };
        Ok(Some(child))
    }
}
