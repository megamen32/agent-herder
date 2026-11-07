//! Read thread addresses from one explicitly selected Codex app-server profile.

use std::{fs, path::PathBuf, time::Duration};

use serde_json::{json, Value};

use super::connection::{CodexConnection, CodexInstance, OpenError, RpcError};

#[derive(Debug)]
pub enum CodexReadError {
    Open(OpenError),
    Rpc(RpcError),
    ProfilePath(std::io::Error),
    ProfileMismatch { expected: PathBuf, observed: String },
    InvalidThreadList(String),
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

#[derive(Debug, Clone, PartialEq)]
pub struct NativeThread {
    /// Codex's stable native thread/session address.
    pub id: String,
    pub cwd: Option<String>,
    pub status: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeThreadPage {
    pub data: Vec<NativeThread>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMessage {
    pub id: String,
    pub role: NativeMessageRole,
    pub text: Option<String>,
    /// Native turn containing this item, as returned by `thread/items/list`.
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMessagePage {
    pub data: Vec<NativeMessage>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

pub struct CodexReader {
    connection: CodexConnection,
    timeout: Duration,
}

impl CodexReader {
    pub fn open(instance: CodexInstance, timeout: Duration) -> Result<Self, CodexReadError> {
        let expected_profile =
            fs::canonicalize(&instance.code_home).map_err(CodexReadError::ProfilePath)?;
        let mut connection = CodexConnection::open(instance)?;
        let initialized = connection.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-herder-native",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {},
            }),
            timeout,
        )?;
        let observed = initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CodexReadError::InvalidThreadList("initialize omitted codexHome".into())
            })?;
        if PathBuf::from(observed) != expected_profile {
            return Err(CodexReadError::ProfileMismatch {
                expected: expected_profile,
                observed: observed.to_owned(),
            });
        }
        connection.notify("initialized", json!({}))?;
        Ok(Self {
            connection,
            timeout,
        })
    }

    pub fn instance_id(&self) -> &str {
        self.connection.instance_id()
    }

    pub fn list_threads(
        &mut self,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<NativeThreadPage, CodexReadError> {
        if limit == 0 {
            return Err(CodexReadError::InvalidThreadList(
                "limit must be positive".into(),
            ));
        }
        let result = self.connection.request(
            "thread/list",
            json!({"cursor": cursor, "limit": limit}),
            self.timeout,
        )?;
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
        if thread_id.is_empty() || limit == 0 {
            return Err(CodexReadError::InvalidThreadList(
                "thread_id and limit must be non-empty/positive".into(),
            ));
        }
        let result = self.connection.request(
            "thread/items/list",
            json!({
                "threadId": thread_id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": "desc",
            }),
            self.timeout,
        )?;
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
