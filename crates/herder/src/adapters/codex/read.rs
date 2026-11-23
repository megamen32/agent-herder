//! Read thread addresses from one explicitly selected Codex app-server profile.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Value, json};

use super::connection::{CodexConnection, CodexInstance, OpenError, RpcError};
use crate::domain::adapter::{NativeReceipt, Observation};

#[derive(Debug)]
pub enum CodexReadError {
    Open(OpenError),
    Rpc(RpcError),
    ProfilePath(std::io::Error),
    ProfileMismatch { expected: PathBuf, observed: String },
    InvalidThreadList(String),
    InvalidReceipt(&'static str),
    ReceiptDeadline,
}

impl std::fmt::Display for CodexReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(error) => write!(f, "could not open Codex profile: {error}"),
            Self::Rpc(error) => write!(f, "Codex app-server read failed: {error}"),
            Self::ProfilePath(error) => write!(f, "could not resolve Codex profile path: {error}"),
            Self::ProfileMismatch { expected, observed } => write!(
                f,
                "Codex app-server opened a different profile: expected {}, observed {observed}",
                expected.display()
            ),
            Self::InvalidThreadList(message) => {
                write!(f, "invalid Codex thread/list response: {message}")
            }
            Self::InvalidReceipt(message) => f.write_str(message),
            Self::ReceiptDeadline => f.write_str("Codex receipt deadline elapsed"),
        }
    }
}

impl std::error::Error for CodexReadError {}

impl From<OpenError> for CodexReadError {
    fn from(value: OpenError) -> Self {
        Self::Open(value)
    }
}

impl From<RpcError> for CodexReadError {
    fn from(value: RpcError) -> Self {
        Self::Rpc(value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NativeThread {
    /// Codex's stable native thread/session address.
    pub id: String,
    pub cwd: Option<String>,
    pub status: Option<Value>,
    /// Native last-activity time in Unix seconds.
    #[serde(skip)]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NativeThreadPage {
    pub data: Vec<NativeThread>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeMessage {
    pub id: String,
    pub role: NativeMessageRole,
    pub text: Option<String>,
    /// Native turn containing this item, as returned by `thread/items/list`.
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeMessagePage {
    pub data: Vec<NativeMessage>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemSortDirection {
    #[default]
    Asc,
    Desc,
}

// Only pagination progress survives a receipt deadline. The next attempt reads
// the native head and the exact receipt page again before observing any items.
pub(super) struct ReceiptCursor {
    pub(super) head_page: Value,
    pub(super) next: String,
    pub(super) seen_cursors: HashSet<String>,
    pub(super) seen_turns: HashSet<String>,
}

#[path = "inventory_runtime.rs"]
mod inventory_runtime;

pub struct CodexReader {
    connection: CodexConnection,
    instance: CodexInstance,
    timeout: Duration,
    refresh_before_first_message_read: bool,
    receipt_cursors: HashMap<(String, String, String), ReceiptCursor>,
}

impl CodexReader {
    pub fn open(instance: CodexInstance, timeout: Duration) -> Result<Self, CodexReadError> {
        let connection = open_connection(&instance, timeout, None)?;
        Ok(Self {
            connection,
            instance,
            timeout,
            refresh_before_first_message_read: true,
            receipt_cursors: HashMap::new(),
        })
    }

    fn reopen(&mut self) -> Result<(), CodexReadError> {
        self.reopen_with_deadline(None)
    }

    fn shared_connection_closed(&mut self) -> bool {
        self.instance.socket_path.is_some() && self.connection.unavailable()
    }

    fn reopen_with_deadline(&mut self, deadline: Option<Instant>) -> Result<(), CodexReadError> {
        self.receipt_cursors.clear();
        self.connection = open_connection(&self.instance, self.timeout, deadline)?;
        Ok(())
    }

    pub fn observe_admitted_recovery(
        &mut self,
        receipt: &NativeReceipt,
        key: &str,
    ) -> Result<Observation, CodexReadError> {
        if receipt.target.instance.instance_id != self.instance_id()
            || receipt.target.native_session_id.is_empty()
            || receipt.native_id.is_empty()
            || key.is_empty()
        {
            return Err(CodexReadError::InvalidReceipt(
                "invalid Codex receipt binding",
            ));
        }
        let deadline =
            Instant::now()
                .checked_add(self.timeout)
                .ok_or(CodexReadError::InvalidReceipt(
                    "invalid Codex receipt timeout",
                ))?;
        if self.shared_connection_closed() {
            self.reopen_with_deadline(Some(deadline))?;
        }
        let result = self.read_receipt_before(receipt, key, deadline);
        if matches!(&result, Err(CodexReadError::Rpc(error)) if is_stale_history_lineage(error))
            || (result.is_err() && self.shared_connection_closed())
        {
            // Restart pagination from the head on the verified replacement reader.
            self.reopen_with_deadline(Some(deadline))?;
            return self.read_receipt_before(receipt, key, deadline);
        }
        result
    }

    fn read_receipt_before(
        &mut self,
        receipt: &NativeReceipt,
        key: &str,
        deadline: Instant,
    ) -> Result<Observation, CodexReadError> {
        let binding = (
            receipt.target.native_session_id.clone(),
            receipt.native_id.clone(),
            key.to_owned(),
        );
        let mut cursor = self.receipt_cursors.remove(&binding);
        let result = self
            .connection
            .read_admitted_receipt(receipt, key, &mut cursor, deadline);
        if matches!(
            &result,
            Err(CodexReadError::ReceiptDeadline | CodexReadError::Rpc(RpcError::Timeout { .. }))
        ) && let Some(cursor) = cursor
        {
            self.receipt_cursors.insert(binding, cursor);
        }
        result
    }

    pub fn read_thread_with_turns(&mut self, thread_id: &str) -> Result<Value, CodexReadError> {
        if self.shared_connection_closed() {
            self.reopen()?;
        }
        let params = json!({"threadId": thread_id, "includeTurns": true});
        let response = match self
            .connection
            .request("thread/read", params.clone(), self.timeout)
        {
            Ok(response) => response,
            Err(error) if self.shared_connection_closed() || is_stale_history_lineage(&error) => {
                // A shared server can disconnect between the health check and
                // this read. Only repeat the read on a newly verified connection.
                self.reopen()?;
                self.connection
                    .request("thread/read", params, self.timeout)?
            }
            Err(error) => return Err(error.into()),
        };
        response
            .get("thread")
            .filter(|thread| thread["id"] == thread_id && thread["turns"].is_array())
            .cloned()
            .ok_or_else(|| {
                CodexReadError::InvalidThreadList("missing bound thread or turns".into())
            })
    }
}

pub(super) fn receipt_time_left(deadline: Instant) -> Result<Duration, CodexReadError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|time| !time.is_zero())
        .ok_or(CodexReadError::ReceiptDeadline)
}

fn open_connection(
    instance: &CodexInstance,
    timeout: Duration,
    deadline: Option<Instant>,
) -> Result<CodexConnection, CodexReadError> {
    if let Some(deadline) = deadline {
        receipt_time_left(deadline)?;
    }
    let expected_profile =
        fs::canonicalize(&instance.code_home).map_err(CodexReadError::ProfilePath)?;
    let mut connection = CodexConnection::open_with_deadline(instance.clone(), deadline)?;
    let initialized = connection.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "agent-herder-native",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {"experimentalApi": true},
        }),
        match deadline {
            Some(deadline) => receipt_time_left(deadline)?,
            None => timeout,
        },
    )?;
    let observed = initialized
        .get("codexHome")
        .and_then(Value::as_str)
        .ok_or_else(|| CodexReadError::InvalidThreadList("initialize omitted codexHome".into()))?;
    if PathBuf::from(observed) != expected_profile {
        return Err(CodexReadError::ProfileMismatch {
            expected: expected_profile,
            observed: observed.to_owned(),
        });
    }
    connection.notify_with_deadline("initialized", json!({}), deadline)?;
    Ok(connection)
}

fn is_stale_history_lineage(error: &RpcError) -> bool {
    matches!(
        error,
        RpcError::Remote { message, .. }
            if message.contains("invalid paginated history lineage")
    )
}

impl CodexReader {
    pub fn instance_id(&self) -> &str {
        self.connection.instance_id()
    }

    pub fn list_threads(
        &mut self,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<NativeThreadPage, CodexReadError> {
        self.thread_page(json!({"cursor": cursor, "limit": limit}), limit)
    }

    pub fn list_recent_threads(
        &mut self,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<NativeThreadPage, CodexReadError> {
        self.thread_page(
            json!({
                "cursor": cursor, "limit": limit, "archived": false,
                "sortKey": "updated_at", "sortDirection": "desc", "modelProviders": [],
                "sourceKinds": ["cli", "vscode", "appServer", "exec", "subAgentThreadSpawn"],
                "useStateDbOnly": true,
            }),
            limit,
        )
    }

    fn thread_page(
        &mut self,
        params: Value,
        limit: u32,
    ) -> Result<NativeThreadPage, CodexReadError> {
        if limit == 0 {
            return Err(CodexReadError::InvalidThreadList(
                "limit must be positive".into(),
            ));
        }
        if self.shared_connection_closed() {
            self.reopen()?;
        }
        let result = self
            .connection
            .request("thread/list", params, self.timeout)?;
        let rows = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| CodexReadError::InvalidThreadList("missing data array".into()))?;
        let mut data = Vec::with_capacity(rows.len());
        for row in rows {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| CodexReadError::InvalidThreadList("thread has no stable id".into()))?
                .to_owned();
            data.push(NativeThread {
                id,
                cwd: row.get("cwd").and_then(Value::as_str).map(str::to_owned),
                status: row.get("status").cloned(),
                updated_at: row.get("updatedAt").and_then(Value::as_u64),
            });
        }
        Ok(NativeThreadPage {
            data,
            next_cursor: optional_cursor(&result, "nextCursor")?,
            backwards_cursor: optional_cursor(&result, "backwardsCursor")?,
        })
    }

    /// Read one paginated page of user and assistant messages with native turn refs.
    /// Other Codex item kinds are intentionally omitted from this normalized view.
    pub fn list_messages(
        &mut self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<NativeMessagePage, CodexReadError> {
        self.list_messages_in_order(thread_id, cursor, limit, ItemSortDirection::Asc)
    }

    pub fn list_messages_in_order(
        &mut self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: u32,
        direction: ItemSortDirection,
    ) -> Result<NativeMessagePage, CodexReadError> {
        if thread_id.is_empty() || limit == 0 {
            return Err(CodexReadError::InvalidThreadList(
                "thread_id and limit must be non-empty/positive".into(),
            ));
        }
        if self.refresh_before_first_message_read || self.shared_connection_closed() {
            self.reopen()?;
            self.refresh_before_first_message_read = false;
        }
        let params = json!({
            "threadId": thread_id,
            "cursor": cursor,
            "limit": limit,
            "sortDirection": direction,
        });
        let result =
            match self
                .connection
                .request("thread/items/list", params.clone(), self.timeout)
            {
                Ok(result) => result,
                Err(error) if is_stale_history_lineage(&error) => {
                    // A reader opened before a new thread can retain a stale
                    // app-server history index. Refresh only this read connection;
                    // never replay a native mutation after an uncertain outcome.
                    self.reopen()?;
                    self.connection
                        .request("thread/items/list", params, self.timeout)?
                }
                Err(error) => return Err(error.into()),
            };
        let rows = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| CodexReadError::InvalidThreadList("missing item data array".into()))?;
        let mut data = Vec::new();
        for row in rows {
            let turn_id = row
                .get("turnId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| CodexReadError::InvalidThreadList("item has no turn id".into()))?
                .to_owned();
            let item = row.get("item").ok_or_else(|| {
                CodexReadError::InvalidThreadList("item entry has no item".into())
            })?;
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            let role_and_text = match item_type {
                "userMessage" => {
                    let content =
                        item.get("content")
                            .and_then(Value::as_array)
                            .ok_or_else(|| {
                                CodexReadError::InvalidThreadList(
                                    "user item has no content array".into(),
                                )
                            })?;
                    let text = content
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>();
                    (
                        NativeMessageRole::User,
                        (!text.is_empty()).then(|| text.join("")),
                    )
                }
                "agentMessage" => (
                    NativeMessageRole::Assistant,
                    Some(
                        item.get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                CodexReadError::InvalidThreadList(
                                    "assistant item has no text".into(),
                                )
                            })?
                            .to_owned(),
                    ),
                ),
                _ => continue,
            };
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    CodexReadError::InvalidThreadList("message has no stable id".into())
                })?
                .to_owned();
            data.push(NativeMessage {
                id,
                role: role_and_text.0,
                text: role_and_text.1,
                turn_id,
            });
        }
        Ok(NativeMessagePage {
            data,
            next_cursor: optional_cursor(&result, "nextCursor")?,
            backwards_cursor: optional_cursor(&result, "backwardsCursor")?,
        })
    }
}

fn optional_cursor(result: &Value, name: &str) -> Result<Option<String>, CodexReadError> {
    match result.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(cursor)) => Ok(Some(cursor.clone())),
        Some(_) => Err(CodexReadError::InvalidThreadList(format!(
            "{name} must be a string or null"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_only_stale_paginated_history_errors() {
        let stale = RpcError::Remote {
            request_id: 1,
            code: Some(-32600),
            message: "invalid paginated history lineage for thread: missing source rollout".into(),
        };
        assert!(is_stale_history_lineage(&stale));
        let other = RpcError::Remote {
            request_id: 1,
            code: Some(-32600),
            message: "invalid request".into(),
        };
        assert!(!is_stale_history_lineage(&other));
    }
}
