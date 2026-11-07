//! Read sessions from one explicitly selected ZCode workspace and instance.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use serde_json::{Value, json};

use crate::{
    adapters::zcode::connection::{ZcodeConnection, ZcodeConnectionError, ZcodeInstance},
    domain::address::SessionAddress,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SESSIONS: u64 = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum ZcodeReadError {
    InvalidWorkspace,
    InvalidListResponse,
    InvalidSessionRow,
    DuplicateSessionId,
    InvalidMessageLimit,
    InvalidSessionAddress,
    InvalidMessagesResponse,
    Connection(ZcodeConnectionError),
}

impl From<ZcodeConnectionError> for ZcodeReadError {
    fn from(value: ZcodeConnectionError) -> Self {
        Self::Connection(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZcodeSessionEntry {
    pub address: SessionAddress,
    pub workspace_path: PathBuf,
    /// Native status is retained verbatim; missing/unknown is not inferred.
    pub status: Option<String>,
}

/// A normalized user/assistant item returned by ZCode's native transcript RPC.
/// Native identifiers and optional turn metadata are preserved verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZcodeSessionMessage {
    pub message_id: String,
    pub role: ZcodeMessageRole,
    pub parent_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub created_at: Option<Value>,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZcodeMessageRole {
    User,
    Assistant,
}

/// Reader bound to one instance and workspace. It never falls back to another
/// root or workspace when the selected source is unavailable.
#[derive(Debug, Clone)]
pub struct ZcodeSessionReader {
    instance: ZcodeInstance,
    workspace_path: PathBuf,
}

impl ZcodeSessionReader {
    pub fn new(instance: ZcodeInstance, workspace_path: PathBuf) -> Result<Self, ZcodeReadError> {
        if !workspace_path.is_absolute() {
            return Err(ZcodeReadError::InvalidWorkspace);
        }
        Ok(Self {
            instance,
            workspace_path,
        })
    }

    pub async fn list_sessions(&self) -> Result<Vec<ZcodeSessionEntry>, ZcodeReadError> {
        let workspace = self.workspace_path.to_string_lossy().into_owned();
        let workspace_ref = json!({
            "workspacePath": workspace,
            "workspaceIdentity": workspace,
            "workspaceKey": workspace,
        });
        let mut connection = ZcodeConnection::open(self.instance.clone()).await?;
        connection
            .request(
                "zcode-agent",
                "initialize",
                json!([workspace_ref]),
                REQUEST_TIMEOUT,
            )
            .await?;
        let response = connection
            .request(
                "zcode-agent",
                "listSessions",
                json!([{
                    "workspacePath": workspace,
                    "workspaceIdentity": workspace,
                    "workspaceKey": workspace,
                    "includeArchived": false,
                    "limit": MAX_SESSIONS,
                }]),
                REQUEST_TIMEOUT,
            )
            .await?;
        connection.close().await?;

        let rows = response
            .payload
            .as_array()
            .or_else(|| response.payload.get("sessions").and_then(Value::as_array))
            .ok_or(ZcodeReadError::InvalidListResponse)?;
        let mut seen = HashSet::with_capacity(rows.len());
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let root = row.as_object().ok_or(ZcodeReadError::InvalidSessionRow)?;
            let session = root
                .get("session")
                .and_then(Value::as_object)
                .filter(|nested| !nested.is_empty())
                .unwrap_or(root);
            let native_session_id = session
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or(ZcodeReadError::InvalidSessionRow)?
                .to_owned();
            if !seen.insert(native_session_id.clone()) {
                return Err(ZcodeReadError::DuplicateSessionId);
            }
            let native_workspace = session
                .get("workspace")
                .and_then(Value::as_object)
                .and_then(|w| w.get("workspacePath"))
                .or_else(|| session.get("workspacePath"))
                .and_then(Value::as_str)
                .filter(|path| PathBuf::from(path).is_absolute())
                .map(PathBuf::from)
                .unwrap_or_else(|| self.workspace_path.clone());
            entries.push(ZcodeSessionEntry {
                address: SessionAddress {
                    instance: self.instance.reference.clone(),
                    native_session_id,
                },
                workspace_path: native_workspace,
                status: session
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
        Ok(entries)
    }

    /// Read the exact session through the native legacy `readSessionMessages`
    /// contract. This method never resumes a session or sends model input.
    pub async fn read_messages(
        &self,
        session: &ZcodeSessionEntry,
        limit: u32,
    ) -> Result<Vec<ZcodeSessionMessage>, ZcodeReadError> {
        if limit == 0 || limit > 200 {
            return Err(ZcodeReadError::InvalidMessageLimit);
        }
        if session.address.instance != self.instance.reference
            || session.address.native_session_id.trim().is_empty()
            || !session.workspace_path.is_absolute()
        {
            return Err(ZcodeReadError::InvalidSessionAddress);
        }

        let workspace = session.workspace_path.to_string_lossy().into_owned();
        let workspace_ref = json!({
            "workspacePath": workspace,
            "workspaceIdentity": workspace,
            "workspaceKey": workspace,
        });
        let mut connection = ZcodeConnection::open(self.instance.clone()).await?;
        let result = async {
            connection
                .request(
                    "zcode-agent",
                    "initialize",
                    json!([workspace_ref]),
                    REQUEST_TIMEOUT,
                )
                .await?;
            let response = connection
                .request(
                    "zcode-agent",
                    "readSessionMessages",
                    json!([{
                        "workspacePath": workspace,
                        "workspaceIdentity": workspace,
                        "workspaceKey": workspace,
                        "sessionId": session.address.native_session_id,
                        "limit": limit,
                    }]),
                    REQUEST_TIMEOUT,
                )
                .await?;
            normalize_messages(&response.payload)
        }
        .await;
        let close_result = connection.close().await;
        let messages = result?;
        close_result?;
        Ok(messages)
    }
}

fn normalize_messages(payload: &Value) -> Result<Vec<ZcodeSessionMessage>, ZcodeReadError> {
    let rows = payload
        .as_array()
        .or_else(|| payload.get("messages").and_then(Value::as_array))
        .ok_or(ZcodeReadError::InvalidMessagesResponse)?;
    let mut messages = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(info) = row.get("info").and_then(Value::as_object) else {
            continue;
        };
        let role = match info.get("role").and_then(Value::as_str) {
            Some("user") => ZcodeMessageRole::User,
            Some("assistant") => ZcodeMessageRole::Assistant,
            _ => continue,
        };
        let Some(message_id) = info
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        let text = row
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        let metadata = info.get("metadata").and_then(Value::as_object);
        messages.push(ZcodeSessionMessage {
            message_id: message_id.to_owned(),
            role,
            parent_message_id: info
                .get("parentMessageId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_owned),
            turn_id: metadata
                .and_then(|metadata| metadata.get("turnId"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_owned),
            created_at: info
                .get("time")
                .and_then(|time| time.get("created"))
                .cloned(),
            text,
        });
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_user_and_assistant_messages_without_inventing_turn_refs() {
        let payload = json!({"messages": [
            {"info":{"messageId":"u-1","role":"user","time":{"created":1730000000000i64}},"parts":[{"type":"text","text":"hello"}]},
            {"info":{"messageId":"a-1","role":"assistant","parentMessageId":"u-1","metadata":{"turnId":"turn-1"},"time":{"created":"2026-11-07T10:00:00Z"}},"parts":[{"type":"text","text":"hi"},{"type":"text","text":" there"}]},
            {"info":{"messageId":"tool-1","role":"tool"},"parts":[{"type":"text","text":"hidden tool item"}]}
        ]});
        let messages = normalize_messages(&payload).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].message_id, "u-1");
        assert_eq!(messages[0].role, ZcodeMessageRole::User);
        assert_eq!(messages[0].text, "hello");
        assert_eq!(messages[0].turn_id, None);
        assert_eq!(messages[1].role, ZcodeMessageRole::Assistant);
        assert_eq!(messages[1].parent_message_id.as_deref(), Some("u-1"));
        assert_eq!(messages[1].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(messages[1].text, "hi there");
    }

    #[test]
    fn rejects_non_transcript_payload_shape() {
        assert_eq!(normalize_messages(&json!({"events":[]})), Err(ZcodeReadError::InvalidMessagesResponse));
    }
}
