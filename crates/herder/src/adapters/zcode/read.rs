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
}
