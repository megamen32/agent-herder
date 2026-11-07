//! Read thread addresses from one explicitly selected Codex app-server profile.

use std::{fs, path::PathBuf, time::Duration};

use serde_json::{Value, json};

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
