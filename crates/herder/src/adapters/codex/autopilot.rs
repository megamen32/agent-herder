//! Exact root-thread reads and a guarded same-route continuation for semantic automation.
use super::super::{CodexConnection, CodexControl, map_rpc_error};
use super::{
    absent_or_null, index_is_quiescent, lineage, not_sent, read_refusal, read_rpc, read_thread,
    recovery_deadline, remaining_time, required_string, valid_id,
};
use crate::domain::{
    adapter::{Admission, NativeReceipt, ReadError, RequestKey, SubmitError},
    address::SessionAddress,
    recovery::RecoveryAncestor,
};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Instant};

const CONTEXT_BYTES: usize = 48 * 1024;

pub(crate) struct SemanticBaseline {
    pub cwd: String,
    pub completed: Option<String>,
    pub context_start: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct SemanticTurn {
    pub id: String,
    pub cwd: String,
    provider: String,
    model: Option<String>,
    pub human_messages: Vec<String>,
    pub assistant_answer: String,
    pub has_new_human_input: bool,
    pub ancestors: Vec<RecoveryAncestor>,
    root_turn_id: Option<String>,
}

fn unavailable() -> ReadError {
    ReadError("Codex semantic turn unavailable".into())
}

fn turns(
    conn: &mut CodexConnection,
    id: &str,
    cursor: Value,
    view: &str,
    limit: usize,
    deadline: Instant,
) -> Result<Value, ReadError> {
    read_rpc(
        conn,
        "thread/turns/list",
        json!({"threadId":id, "cursor":cursor, "sortDirection":"desc",
        "itemsView":view, "limit":limit}),
        deadline,
    )
}

impl CodexControl {
    fn with_autopilot_thread<T>(
        &self,
        address: &SessionAddress,
        read: impl FnOnce(&mut CodexConnection, &str, Instant) -> Result<T, ReadError>,
    ) -> Result<T, ReadError> {
        if address.instance != self.instance || !valid_id(&address.native_session_id) {
            return Err(unavailable());
        }
        let deadline = recovery_deadline(self.timeout)?;
        let mut state = self.state.try_lock().map_err(|_| unavailable())?;
        if state.connection.unavailable() && self.process.socket_path.is_some() {
            state.connection = Self::connect(&self.process, remaining_time(deadline)?)
                .map_err(|_| unavailable())?;
        }
        read(&mut state.connection, &address.native_session_id, deadline)
    }

    /// Arming acknowledges history. An in-progress turn is still eligible when it completes.
    pub(crate) fn autopilot_baseline(
        &self,
        target: &SessionAddress,
    ) -> Result<SemanticBaseline, ReadError> {
        self.with_autopilot_thread(target, |conn, id, deadline| {
            let thread = read_thread(conn, id, deadline)?;
            lineage::direct_input_lineage(&thread, id).ok_or_else(unavailable)?;
            let cwd = required_string(&thread, "cwd")
                .ok_or_else(unavailable)?
                .to_owned();
            let mut cursor = Value::Null;
            let mut seen = HashSet::new();
            loop {
                let page = turns(conn, id, cursor, "notLoaded", 16, deadline)?;
                let rows = page["data"].as_array().ok_or_else(unavailable)?;
                if let Some(turn) = rows.iter().find(|row| row["status"] == "completed") {
                    // The cursor acknowledges the latest completed response. Recent
                    // human instructions preceding it remain available as judge context.
                    return Ok(SemanticBaseline {
                        cwd,
                        completed: Some(
                            required_string(turn, "id").ok_or_else(unavailable)?.into(),
                        ),
                        context_start: Some(
                            required_string(rows.last().ok_or_else(unavailable)?, "id")
                                .ok_or_else(unavailable)?
                                .into(),
                        ),
                    });
                }
                cursor = page["nextCursor"].clone();
                if cursor.is_null() {
                    return Ok(SemanticBaseline {
                        cwd,
                        completed: None,
                        context_start: None,
                    });
                }
                if !seen.insert(cursor.as_str().ok_or_else(unavailable)?.to_owned()) {
                    return Err(unavailable());
                }
            }
        })
    }

    fn semantic_lineage<'a>(
        &self,
        thread: &'a Value,
        id: &str,
    ) -> Result<lineage::ThreadLineage<'a>, ReadError> {
        let sessions = self
            .process
            .code_home
            .join("sessions")
            .canonicalize()
            .map_err(|_| unavailable())?;
        let path = Path::new(required_string(thread, "path").ok_or_else(unavailable)?)
            .canonicalize()
            .map_err(|_| unavailable())?;
        if !path.starts_with(sessions)
            || !path
                .file_name()
                .and_then(|x| x.to_str())
                .is_some_and(|name| name.ends_with(&format!("-{id}.jsonl")))
        {
            return Err(unavailable());
        }
        lineage::direct_input_lineage(thread, id).ok_or_else(unavailable)
    }

    pub(crate) fn semantic_turn(
        &self,
        target: &SessionAddress,
        anchor: Option<&str>,
        skip: Option<&str>,
    ) -> Result<Option<SemanticTurn>, ReadError> {
        self.with_autopilot_thread(target, |conn, id, deadline| {
            self.read_semantic(conn, id, anchor, skip, deadline)
        })
    }

    fn read_semantic(
        &self,
        conn: &mut CodexConnection,
        id: &str,
        anchor: Option<&str>,
        skip: Option<&str>,
        deadline: Instant,
    ) -> Result<Option<SemanticTurn>, ReadError> {
        let page = turns(conn, id, Value::Null, "notLoaded", 1, deadline)?;
        let Some(turn) = page["data"].as_array().ok_or_else(unavailable)?.first() else {
            return Ok(None);
        };
        let latest = required_string(turn, "id").ok_or_else(unavailable)?;
        if Some(latest) == skip || turn["status"] != "completed" {
            return Ok(None);
        }
        let thread = read_thread(conn, id, deadline)?;
        let lineage = self.semantic_lineage(&thread, id)?;
        if !index_is_quiescent(&thread) || thread["status"]["type"] == "systemError" {
            return Ok(None);
        }
        let goal = read_rpc(conn, "thread/goal/get", json!({"threadId":id}), deadline)?;
        if !goal_allows_judgment(&goal, id) {
            return Ok(None);
        }
        let queue = read_rpc(
            conn,
            "thread/queue/list",
            json!({"threadId":id,"limit":1}),
            deadline,
        )?;
        if !queue["data"].as_array().is_some_and(Vec::is_empty)
            || !absent_or_null(&queue, "nextCursor")
        {
            return Ok(None);
        }
        let target = SessionAddress {
            instance: self.instance.clone(),
            native_session_id: id.into(),
        };
        let root_turn_id = turn["rootTurnId"].as_str();
        let Some(ancestors) =
            lineage::read_ancestors(conn, &target, lineage, latest, root_turn_id, deadline)?
        else {
            return Ok(None);
        };
        if !ancestors.is_empty() && thread["canAcceptDirectInput"] != true {
            return Ok(None);
        }
        let mut result = SemanticTurn {
            id: latest.into(),
            cwd: required_string(&thread, "cwd")
                .ok_or_else(unavailable)?
                .into(),
            provider: required_string(&thread, "modelProvider")
                .ok_or_else(unavailable)?
                .into(),
            model: required_string(&thread, "model").map(str::to_owned),
            assistant_answer: String::new(),
            human_messages: Vec::new(),
            has_new_human_input: false,
            ancestors,
            root_turn_id: root_turn_id.map(str::to_owned),
        };
        let mut cursor = Value::Null;
        let mut bytes = 0;
        let mut cursors = HashSet::new();
        loop {
            let page = turns(conn, id, cursor, "full", 4, deadline)?;
            let rows = page["data"].as_array().ok_or_else(unavailable)?;
            if cursors.is_empty()
                && !rows
                    .first()
                    .is_some_and(|t| t["id"] == latest && t["status"] == "completed")
            {
                return Ok(None);
            }
            for turn in rows {
                let turn_id = required_string(turn, "id").ok_or_else(unavailable)?;
                let items = turn["items"].as_array().ok_or_else(unavailable)?;
                if turn_id == latest {
                    let Some(final_item) = items.last().filter(|i| {
                        i["type"] == "agentMessage"
                            && matches!(i["phase"].as_str(), None | Some("final_answer"))
                    }) else {
                        return Ok(None);
                    };
                    result.assistant_answer = final_item["text"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.len() <= CONTEXT_BYTES)
                        .ok_or_else(unavailable)?
                        .to_owned();
                    bytes += result.assistant_answer.len();
                }
                for item in items.iter().rev().filter(|i| i["type"] == "userMessage") {
                    if item["clientId"].as_str().is_some_and(|s| {
                        s.starts_with("codex-autopilot:")
                            || s.starts_with("codex-recovery:")
                            || s.starts_with("agent-herder:auto:")
                    }) {
                        continue;
                    }
                    let content = item["content"].as_array().ok_or_else(unavailable)?;
                    let text = content
                        .iter()
                        .map(|part| {
                            if part["type"] != "text" {
                                return Err(unavailable());
                            }
                            part["text"]
                                .as_str()
                                .filter(|s| s.len() <= CONTEXT_BYTES)
                                .ok_or_else(unavailable)
                        })
                        .collect::<Result<Vec<_>, _>>()?
                        .join("\n");
                    bytes += text.len();
                    if text.is_empty() || bytes > CONTEXT_BYTES {
                        return Err(unavailable());
                    }
                    result.human_messages.push(text);
                    result.has_new_human_input |= turn_id == latest;
                }
                if Some(turn_id) == anchor {
                    return finish_context(result, bytes);
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                return if anchor.is_none() {
                    finish_context(result, bytes)
                } else {
                    Err(unavailable())
                };
            }
            if !cursors.insert(cursor.as_str().ok_or_else(unavailable)?.to_owned()) {
                return Err(unavailable());
            }
        }
    }

    /// Called only inside the scoped handoff after its durable claim. Reattach to the
    /// same root and re-read the exact completed boundary before the only turn/start.
    pub(crate) fn submit_semantic(
        &self,
        address: &SessionAddress,
        anchor: Option<&str>,
        expected: &SemanticTurn,
        key: &RequestKey,
        message: &str,
        allowed: impl Fn() -> bool,
    ) -> Result<Admission, SubmitError> {
        if address.instance != self.instance
            || !valid_id(&address.native_session_id)
            || !key.0.starts_with("codex-autopilot:")
            || message.trim().is_empty()
        {
            return Err(not_sent("invalid semantic continuation"));
        }
        let deadline = recovery_deadline(self.timeout).map_err(read_refusal)?;
        let id = &address.native_session_id;
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| not_sent("busy Codex control"))?;
        let conn = &mut state.connection;
        if !allowed()
            || self
                .read_semantic(conn, id, anchor, None, deadline)
                .map_err(read_refusal)?
                .as_ref()
                != Some(expected)
        {
            return Err(not_sent("semantic decision changed before resume"));
        }
        let resume = conn
            .request(
                "thread/resume",
                json!({"threadId":id,"excludeTurns":true}),
                remaining_time(deadline).map_err(read_refusal)?,
            )
            .map_err(map_rpc_error)?;
        let model = required_string(&resume, "model")
            .ok_or_else(|| not_sent("Codex did not confirm its model"))?;
        if resume["thread"]["id"] != *id
            || resume["cwd"] != expected.cwd
            || resume["modelProvider"] != expected.provider
            || expected
                .model
                .as_ref()
                .is_some_and(|model| resume["model"] != *model)
        {
            return Err(not_sent(
                "Codex did not confirm the semantic continuation route",
            ));
        }
        let Some(mut after) = self
            .read_semantic(conn, id, anchor, None, deadline)
            .map_err(read_refusal)?
        else {
            return Err(not_sent("semantic boundary unavailable after resume"));
        };
        // A cold thread can first expose its saved model on reattach.
        if expected.model.is_none() && after.model.as_deref() == Some(model) {
            after.model = None;
        }
        if &after != expected || !allowed() {
            return Err(not_sent("semantic decision changed before turn/start"));
        }
        let mut params = json!({"threadId":id, "input":[{"type":"text","text":message}],"clientUserMessageId":key.0});
        if let Some(parent) = expected.ancestors.first() {
            params["parentTurnId"] = json!(parent.turn_id);
            params["rootTurnId"] = json!(expected.root_turn_id);
        }
        let reply = conn
            .request(
                "turn/start",
                params,
                remaining_time(deadline).map_err(read_refusal)?,
            )
            .map_err(map_rpc_error)?;
        let turn = required_string(&reply["turn"], "id")
            .filter(|id| *id != expected.id)
            .ok_or_else(|| SubmitError::OutcomeUnknown {
                receipt: None,
                reason: "Codex continuation omitted distinct turn id".into(),
            })?;
        Ok(Admission {
            receipt: NativeReceipt {
                target: address.clone(),
                native_id: turn.into(),
            },
        })
    }
}

fn finish_context(mut turn: SemanticTurn, bytes: usize) -> Result<Option<SemanticTurn>, ReadError> {
    if bytes > CONTEXT_BYTES || turn.human_messages.is_empty() {
        return Err(unavailable());
    }
    turn.human_messages.reverse();
    Ok(Some(turn))
}

fn goal_allows_judgment(reply: &Value, id: &str) -> bool {
    match reply.get("goal") {
        Some(Value::Null) => true,
        Some(goal) => goal["threadId"] == id && goal["status"] == "complete",
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semantic_judge_defers_to_native_goal_until_native_completion() {
        assert!(goal_allows_judgment(&json!({"goal":null}), "t"));
        assert!(goal_allows_judgment(
            &json!({"goal":{"threadId":"t","status":"complete"}}),
            "t"
        ));
        for state in [
            "active",
            "paused",
            "blocked",
            "budgetLimited",
            "usageLimited",
            "future",
        ] {
            assert!(!goal_allows_judgment(
                &json!({"goal":{"threadId":"t","status":state}}),
                "t"
            ));
        }
        assert!(!goal_allows_judgment(
            &json!({"goal":{"threadId":"other","status":"complete"}}),
            "t"
        ));
        assert!(!goal_allows_judgment(&json!({}), "t"));
    }
}
