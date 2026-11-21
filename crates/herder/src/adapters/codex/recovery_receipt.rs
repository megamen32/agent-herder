//! Read an already admitted recovery from the exact native thread. Turn pages
//! contain metadata only. Item reads are limited to the receipted and latest turns.

use super::{
    CodexConnection, NativeReceipt, RECOVERY_ITEM_PAGE_SIZE, RecoveryFailure, THREAD_PAGE_SIZE,
    is_retry_limit, native_turn_trigger, recovery_failure, required_string,
};
use crate::adapters::codex::read::{
    CodexReadError, CodexReadError::InvalidReceipt, ReceiptCursor, receipt_time_left,
};
use crate::domain::adapter::Observation;
use serde_json::{Value, json};
use std::{collections::HashSet, time::Instant};

fn read_rpc(
    connection: &mut CodexConnection,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, CodexReadError> {
    Ok(connection.request(method, params, receipt_time_left(deadline)?)?)
}

fn rows(page: &Value, limit: usize) -> Result<&[Value], CodexReadError> {
    page["data"]
        .as_array()
        .filter(|rows| rows.len() <= limit)
        .map(Vec::as_slice)
        .ok_or(InvalidReceipt("invalid Codex receipt page"))
}

fn next_cursor(page: &Value, seen: &mut HashSet<String>) -> Result<Option<String>, CodexReadError> {
    if page.get("nextCursor") == Some(&Value::Null) {
        return Ok(None);
    }
    page["nextCursor"]
        .as_str()
        .filter(|cursor| !cursor.is_empty())
        .filter(|cursor| seen.insert((*cursor).to_owned()))
        .map(|cursor| Some(cursor.to_owned()))
        .ok_or(InvalidReceipt("invalid Codex receipt cursor"))
}

fn turn_page(
    connection: &mut CodexConnection,
    thread: &str,
    cursor: Option<&str>,
    limit: usize,
    deadline: Instant,
) -> Result<Value, CodexReadError> {
    read_rpc(
        connection,
        "thread/turns/list",
        json!({
            "threadId":thread, "cursor":cursor, "limit":limit, "sortDirection":"desc", "itemsView":"notLoaded",
        }),
        deadline,
    )
}

fn metadata_id(turn: &Value) -> Result<&str, CodexReadError> {
    if turn["itemsView"] != "notLoaded" || !turn["items"].as_array().is_some_and(Vec::is_empty) {
        return Err(InvalidReceipt("invalid Codex receipt turn metadata"));
    }
    required_string(turn, "id").ok_or(InvalidReceipt("missing Codex turn ID"))
}

fn receipt_turns(
    connection: &mut CodexConnection,
    receipt: &NativeReceipt,
    search: &mut Option<ReceiptCursor>,
    deadline: Instant,
) -> Result<Option<(Value, Value)>, CodexReadError> {
    let thread = &receipt.target.native_session_id;
    let head_page = turn_page(connection, thread, None, 1, deadline)?;
    let [latest] = rows(&head_page, 1)? else {
        return Ok(None);
    };
    let head_id = metadata_id(latest)?;
    if head_id == receipt.native_id {
        return Ok(Some((latest.clone(), latest.clone())));
    }

    let search = match search {
        Some(saved) if saved.head_page == head_page => saved,
        _ => {
            let mut cursors = HashSet::new();
            let Some(next) = next_cursor(&head_page, &mut cursors)? else {
                return Ok(None);
            };
            search.insert(ReceiptCursor {
                head_page: head_page.clone(),
                next,
                seen_cursors: cursors,
                seen_turns: HashSet::from([head_id.to_owned()]),
            })
        }
    };
    loop {
        let page = turn_page(
            connection,
            thread,
            Some(&search.next),
            THREAD_PAGE_SIZE,
            deadline,
        )?;
        let turns = rows(&page, THREAD_PAGE_SIZE)?;
        if turns.is_empty() {
            return Ok(None);
        }
        let mut page_ids = HashSet::new();
        let mut matched = None;
        for turn in turns {
            let id = metadata_id(turn)?;
            if search.seen_turns.contains(id) || !page_ids.insert(id) {
                return Err(InvalidReceipt("ambiguous Codex receipt turn page"));
            }
            if id == receipt.native_id {
                matched = Some(turn);
            }
        }
        if let Some(turn) = matched {
            // Keep this page's cursor until the item proof finishes. A timeout
            // must lead to a fresh read of this turn's status on the next pass.
            return Ok(Some((latest.clone(), turn.clone())));
        }
        let Some(next) = next_cursor(&page, &mut search.seen_cursors)? else {
            return Ok(None);
        };
        search
            .seen_turns
            .extend(page_ids.into_iter().map(str::to_owned));
        search.next = next;
    }
}

// One user item proves ordinary admission. Two disprove a unique input on a
// failed turn. A partial scan that found only one cannot prove uniqueness.
fn user_items(
    connection: &mut CodexConnection,
    thread: &str,
    turn: &str,
    stop_after: usize,
    deadline: Instant,
) -> Result<Vec<Value>, CodexReadError> {
    let mut users = Vec::new();
    let mut cursor = None;
    let mut seen = HashSet::new();
    loop {
        // The normal completed/ACK proof needs only the first user input.
        let limit = if stop_after == 1 && cursor.is_none() {
            1
        } else {
            RECOVERY_ITEM_PAGE_SIZE
        };
        let page = read_rpc(
            connection,
            "thread/items/list",
            json!({
                "threadId":thread, "turnId":turn, "cursor":cursor, "sortDirection":"asc", "limit":limit,
                "deferOutput":{"commandExecution":true,"mcpToolCall":true},
            }),
            deadline,
        )?;
        let items = rows(&page, limit)?;
        for row in items {
            let item = &row["item"];
            if row["turnId"] != turn || required_string(item, "type").is_none() {
                return Err(InvalidReceipt("invalid Codex receipt item binding"));
            }
            if item["type"] == "userMessage" && users.len() < stop_after {
                users.push(json!({"id":item["id"],"clientId":item["clientId"]}));
            }
        }
        if users.len() == stop_after {
            return Ok(users);
        }
        cursor = next_cursor(&page, &mut seen)?;
        if cursor.is_none() {
            return Ok(users);
        }
        if items.is_empty() {
            return Err(InvalidReceipt("empty Codex receipt continuation page"));
        }
    }
}

fn superseding_429(old: &Value, latest: &Value) -> bool {
    old["id"] != latest["id"]
        && (latest["rootTurnId"].is_null() || latest["rootTurnId"] == latest["id"])
        && [old, latest].into_iter().all(|turn| {
            recovery_failure(turn) == Some(RecoveryFailure::Throttled)
                && is_retry_limit(&turn["error"]["codexErrorInfo"])
        })
        && old["completedAt"]
            .as_u64()
            .zip(latest["startedAt"].as_u64())
            .is_some_and(|(end, start)| end <= start)
}

impl CodexConnection {
    pub(in crate::adapters::codex) fn read_admitted_receipt(
        &mut self,
        receipt: &NativeReceipt,
        key: &str,
        search: &mut Option<ReceiptCursor>,
        deadline: Instant,
    ) -> Result<Observation, CodexReadError> {
        let id = &receipt.target.native_session_id;
        let response = read_rpc(
            self,
            "thread/read",
            json!({"threadId":id,"includeTurns":false}),
            deadline,
        )?;
        let thread = response
            .get("thread")
            .filter(|thread| thread["id"] == *id)
            .ok_or(InvalidReceipt("Codex receipt thread identity mismatch"))?;
        let unknown = Observation::Unknown {
            receipt: receipt.clone(),
        };
        let Some((latest, old)) = receipt_turns(self, receipt, search, deadline)? else {
            return Ok(unknown);
        };
        let confirmed = Observation::Confirmed {
            receipt: receipt.clone(),
        };
        match old["status"].as_str() {
            Some("inProgress") => {
                return Ok(Observation::Pending {
                    receipt: receipt.clone(),
                });
            }
            Some("completed") => {
                let users = user_items(self, id, &receipt.native_id, 1, deadline)?;
                return Ok(if users.is_empty() { unknown } else { confirmed });
            }
            Some("failed") if superseding_429(&old, &latest) => {}
            _ => return Ok(unknown),
        }
        let latest_id =
            required_string(&latest, "id").ok_or(InvalidReceipt("missing Codex latest turn"))?;
        if native_turn_trigger(self.code_home(), thread, latest_id).as_deref() != Some("composer") {
            return Ok(unknown);
        }
        let old_users = user_items(self, id, &receipt.native_id, 2, deadline)?;
        let [admitted] = old_users.as_slice() else {
            return Ok(unknown);
        };
        if required_string(admitted, "id").is_none() || admitted["clientId"] != key {
            return Ok(unknown);
        }
        let new_users = user_items(self, id, latest_id, 2, deadline)?;
        let [followup] = new_users.as_slice() else {
            return Ok(unknown);
        };
        if required_string(followup, "id").is_none()
            || followup["id"] == admitted["id"]
            || !(followup["clientId"].is_null()
                || required_string(followup, "clientId")
                    .is_some_and(|id| !id.starts_with("codex-recovery:")))
        {
            return Ok(unknown);
        }
        // Pagination and the indexed composer attribution are separate reads.
        // Confirm that the same failed user turn still heads the native history.
        let head = turn_page(self, id, None, 1, deadline)?;
        Ok(if rows(&head, 1)? == [latest] {
            confirmed
        } else {
            unknown
        })
    }
}
