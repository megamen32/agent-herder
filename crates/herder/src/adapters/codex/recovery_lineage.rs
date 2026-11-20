use std::{collections::HashSet, path::Path, time::Instant};

use serde_json::{Value, json};

use super::{
    CodexConnection, THREAD_PAGE_SIZE, absent_or_null, goal_allows_recovery, read_rpc,
    required_string,
};
use crate::domain::{adapter::ReadError, address::SessionAddress, recovery::RecoveryAncestor};

const MAX_PARENT_DEPTH: u64 = 8;

impl super::CodexControl {
    /// A metadata read can report "not loaded" for a cold thread. On the same
    /// control connection, an existing thread can return a null goal. A
    /// missing thread returns a distinct error naming the requested ID.
    pub fn confirms_missing_recovery_thread(&self, id: &str) -> bool {
        let Ok(mut state) = self.state.try_lock() else {
            return false;
        };
        matches!(
            state.connection.request("thread/goal/get", json!({"threadId": id}), self.timeout),
            Err(super::RpcError::Remote { code: Some(-32600), message, .. })
                if message == format!("thread not found: {id}") || message.starts_with("invalid thread id:")
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ThreadLineage<'a> {
    Root,
    Spawned {
        parent: &'a str,
        session: &'a str,
        depth: u64,
    },
}

pub(super) fn thread_lineage<'a>(thread: &'a Value, id: &str) -> Option<ThreadLineage<'a>> {
    if !absent_or_null(thread, "forkedFromId") {
        return None;
    }
    direct_input_lineage(thread, id)
}

/// An explicitly selected fork has its own address and history. Recovery discovery
/// retains its stricter fork exclusion above.
pub(super) fn direct_input_lineage<'a>(thread: &'a Value, id: &str) -> Option<ThreadLineage<'a>> {
    if thread["id"] != id
        || !matches!(thread.get("ephemeral"), None | Some(Value::Bool(false)))
        || !matches!(thread.get("archived"), None | Some(Value::Bool(false)))
        || !absent_or_null(thread, "attachedToThreadId")
    {
        return None;
    }
    let source = &thread["source"];
    if matches!(
        source.as_str(),
        Some("cli" | "vscode" | "appServer" | "exec")
    ) {
        return ((absent_or_null(thread, "sessionId") || thread["sessionId"] == id)
            && ["parentThreadId", "agentNickname", "agentRole"]
                .into_iter()
                .all(|field| absent_or_null(thread, field)))
        .then_some(ThreadLineage::Root);
    }

    let subagent = source
        .as_object()
        .filter(|source| source.len() == 1)?
        .get("subAgent")?;
    let spawn = subagent
        .as_object()
        .filter(|source| source.len() == 1)?
        .get("thread_spawn")?;
    let parent = required_string(spawn, "parent_thread_id")?;
    let session = required_string(thread, "sessionId")?;
    let depth = spawn["depth"]
        .as_u64()
        .filter(|depth| (1..=MAX_PARENT_DEPTH).contains(depth))?;
    (thread["parentThreadId"] == parent && parent != id).then_some(ThreadLineage::Spawned {
        parent,
        session,
        depth,
    })
}

pub(super) fn read_thread(
    connection: &mut CodexConnection,
    id: &str,
    deadline: Instant,
) -> Result<Value, ReadError> {
    let mut response = read_rpc(
        connection,
        "thread/read",
        json!({"threadId": id, "includeTurns": false}),
        deadline,
    )?;
    response
        .get_mut("thread")
        .filter(|thread| thread["id"] == id)
        .map(Value::take)
        .ok_or_else(|| ReadError("Codex recovery thread identity mismatch".into()))
}

pub(super) fn is_unarchived(
    connection: &mut CodexConnection,
    thread_id: &str,
    cwd: &str,
    lineage: ThreadLineage<'_>,
    deadline: Instant,
    accepts_status: fn(&Value) -> bool,
) -> Result<bool, ReadError> {
    let mut params = json!({
        "archived": false, "cwd": cwd, "limit": THREAD_PAGE_SIZE,
        "sortKey": "updated_at", "sortDirection": "desc",
        "modelProviders": [], "sourceKinds": ["cli", "vscode", "appServer", "exec"],
        "useStateDbOnly": true,
    });
    if let ThreadLineage::Spawned { parent, .. } = lineage {
        params["sourceKinds"] = json!(["subAgentThreadSpawn"]);
        params["parentThreadId"] = json!(parent);
    }
    let mut seen_cursors = HashSet::new();
    let mut cursor = Value::Null;
    // Every request shares the native read deadline. An exact membership
    // proof can be on any page, including during the final admission recheck.
    loop {
        params["cursor"] = cursor;
        let page = read_rpc(connection, "thread/list", params.clone(), deadline)?;
        let rows = page["data"]
            .as_array()
            .filter(|rows| rows.len() <= THREAD_PAGE_SIZE)
            .ok_or_else(|| ReadError("Codex recovery unarchived thread page is invalid".into()))?;
        let mut matches = rows.iter().filter(|row| row["id"] == thread_id);
        if let Some(row) = matches.next() {
            return Ok(matches.next().is_none()
                && row["cwd"] == cwd
                && thread_lineage(row, thread_id) == Some(lineage)
                && accepts_status(row));
        }
        if absent_or_null(&page, "nextCursor") {
            return Ok(false);
        }
        let next = required_string(&page, "nextCursor")
            .filter(|next| seen_cursors.insert((*next).to_owned()))
            .ok_or_else(|| ReadError("Codex recovery unarchived page cursor is invalid".into()))?;
        cursor = json!(next);
    }
}

fn active_without_human_input(thread: &Value) -> bool {
    thread["status"]["type"] == "active"
        && thread["status"]["activeFlags"]
            .as_array()
            .is_some_and(Vec::is_empty)
}

pub(super) fn read_ancestors(
    connection: &mut CodexConnection,
    target: &SessionAddress,
    lineage: ThreadLineage<'_>,
    child_turn: &str,
    root_turn: Option<&str>,
    deadline: Instant,
) -> Result<Option<Vec<RecoveryAncestor>>, ReadError> {
    let ThreadLineage::Spawned {
        parent,
        session,
        depth,
    } = lineage
    else {
        return Ok(Some(Vec::new()));
    };
    let Some(root_turn) = root_turn.filter(|root| *root != child_turn) else {
        return Ok(None);
    };

    let mut parent_id = parent.to_owned();
    let mut seen_threads = HashSet::from([target.native_session_id.clone()]);
    let mut seen_turns = HashSet::from([child_turn.to_owned()]);
    let mut ancestors = Vec::new();
    for expected_depth in (0..depth).rev() {
        if !seen_threads.insert(parent_id.clone()) {
            return Ok(None);
        }
        let thread = read_thread(connection, &parent_id, deadline)?;
        let Some(parent_lineage) = thread_lineage(&thread, &parent_id) else {
            return Ok(None);
        };
        let next = match parent_lineage {
            ThreadLineage::Root if expected_depth == 0 => None,
            ThreadLineage::Spawned { parent, depth, .. } if depth == expected_depth => Some(parent),
            _ => return Ok(None),
        };
        // Codex can report a thread's own session ID at every depth after
        // reload. Older daemons report the root session ID on every node.
        // Keep one encoding across the chain and still verify each spawn
        // edge and its active root turn below.
        let expected_session = if session == target.native_session_id {
            parent_id.as_str()
        } else {
            session
        };
        if thread["sessionId"] != expected_session || !active_without_human_input(&thread) {
            return Ok(None);
        }
        let Some(cwd) = required_string(&thread, "cwd").filter(|cwd| Path::new(cwd).is_absolute())
        else {
            return Ok(None);
        };
        if !is_unarchived(
            connection,
            &parent_id,
            cwd,
            parent_lineage,
            deadline,
            active_without_human_input,
        )? {
            return Ok(None);
        }
        if !goal_allows_recovery(connection, &parent_id, deadline)? {
            return Ok(None);
        }
        let turns = read_rpc(
            connection,
            "thread/turns/list",
            json!({"threadId": parent_id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}),
            deadline,
        )?;
        let Some([turn]) = turns["data"].as_array().map(Vec::as_slice) else {
            return Ok(None);
        };
        let Some(turn_id) = required_string(turn, "id") else {
            return Ok(None);
        };
        let same_work = match turn.get("rootTurnId") {
            None | Some(Value::Null) => turn_id == root_turn,
            Some(value) => value == root_turn,
        };
        if turn["status"] != "inProgress"
            || !absent_or_null(turn, "completedAt")
            || !absent_or_null(turn, "error")
            || (!absent_or_null(&thread, "activeTurnId") && thread["activeTurnId"] != turn_id)
            || !same_work
            || !seen_turns.insert(turn_id.to_owned())
        {
            return Ok(None);
        }
        ancestors.push(RecoveryAncestor {
            address: SessionAddress {
                instance: target.instance.clone(),
                native_session_id: parent_id,
            },
            cwd: cwd.to_owned(),
            turn_id: turn_id.to_owned(),
        });
        if let Some(next) = next {
            parent_id = next.to_owned();
        } else {
            return Ok(Some(ancestors));
        }
    }
    Ok(None)
}
