//! Typed, read-only session listing from one explicitly selected OpenCode instance.

use reqwest::{Method, StatusCode};
use serde::Deserialize;

use crate::{
    application::recent::{RecentMessages, SourceMessage, normalize_recent},
    domain::{
        adapter::ReadError,
        address::{InstanceRef, SessionAddress},
    },
};

use super::connection::{OpenCodeConnection, OpenCodeConnectionError};

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeSessionTime {
    pub created: f64,
    pub updated: f64,
    pub busy: Option<f64>,
    pub idle: Option<f64>,
    pub archived: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeSession {
    pub address: SessionAddress,
    pub parent_session_id: Option<String>,
    pub project_id: String,
    pub outcome: Option<String>,
    pub time: OpenCodeSessionTime,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeSessionPage {
    pub sessions: Vec<OpenCodeSession>,
    pub previous: Option<String>,
    pub next: Option<String>,
}

#[derive(Deserialize)]
struct SessionListWire {
    data: Vec<SessionWire>,
    cursor: SessionCursorWire,
}

#[derive(Deserialize)]
struct SessionCursorWire {
    previous: Option<String>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct SessionWire {
    id: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    #[serde(rename = "projectID")]
    project_id: String,
    outcome: Option<String>,
    time: SessionTimeWire,
    location: SessionLocationWire,
}

#[derive(Deserialize)]
struct SessionTimeWire {
    created: f64,
    updated: f64,
    busy: Option<f64>,
    idle: Option<f64>,
    archived: Option<f64>,
}

#[derive(Deserialize)]
struct SessionLocationWire {
    directory: String,
}

#[derive(Deserialize)]
struct MessageListWire {
    data: Vec<MessageWire>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum MessageWire {
    #[serde(rename = "user")]
    User {
        id: String,
        time: MessageTimeWire,
        text: String,
    },
    #[serde(rename = "assistant")]
    Assistant {
        id: String,
        time: AssistantTimeWire,
        content: Vec<AssistantContentWire>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct MessageTimeWire {
    created: f64,
}

#[derive(Deserialize)]
struct AssistantTimeWire {
    created: f64,
    completed: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum AssistantContentWire {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(other)]
    Other,
}

/// A reader whose identity and endpoint are fixed by its OpenCode connection.
#[derive(Debug, Clone)]
pub struct OpenCodeSessionReader {
    connection: OpenCodeConnection,
}

impl OpenCodeSessionReader {
    pub fn new(connection: OpenCodeConnection) -> Self {
        Self { connection }
    }

    pub fn instance(&self) -> &InstanceRef {
        self.connection.instance()
    }

    /// Read the native first page (OpenCode defaults to newest 50 sessions).
    /// Any returned cursor remains opaque and is passed through unchanged.
    pub async fn list_sessions(
        &self,
        request_id: impl Into<String>,
    ) -> Result<OpenCodeSessionPage, ReadError> {
        let request = self
            .connection
            .request(request_id, Method::GET, "/api/session")
            .map_err(map_connection_error)?;
        let response = request
            .send()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(ReadError(
                "OpenCode session list rejected the configured identity".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(ReadError(format!(
                "OpenCode session list returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let wire: SessionListWire = response
            .json()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        let instance = self.connection.instance().clone();
        let mut sessions = Vec::with_capacity(wire.data.len());
        for session in wire.data {
            if !session.id.starts_with("ses") {
                return Err(ReadError(
                    "OpenCode returned a session ID outside its native ID namespace".into(),
                ));
            }
            sessions.push(OpenCodeSession {
                address: SessionAddress {
                    instance: instance.clone(),
                    native_session_id: session.id,
                },
                parent_session_id: session.parent_id,
                project_id: session.project_id,
                outcome: session.outcome,
                time: OpenCodeSessionTime {
                    created: session.time.created,
                    updated: session.time.updated,
                    busy: session.time.busy,
                    idle: session.time.idle,
                    archived: session.time.archived,
                },
                directory: session.location.directory,
            });
        }
        Ok(OpenCodeSessionPage {
            sessions,
            previous: wire.cursor.previous,
            next: wire.cursor.next,
        })
    }

    /// Read the newest user and assistant message independently from the
    /// explicitly addressed session. OpenCode's schema does not expose a
    /// turn or parent reference, so this projection deliberately leaves both
    /// correlation fields unknown.
    pub async fn recent_messages(
        &self,
        address: &SessionAddress,
        request_id: impl Into<String>,
    ) -> Result<RecentMessages, ReadError> {
        if address.instance != *self.connection.instance()
            || !address.native_session_id.starts_with("ses")
            || !address
                .native_session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(ReadError(
                "OpenCode session address does not belong to this instance".into(),
            ));
        }
        let request_id = request_id.into();
        let user = self
            .latest_message(
                &address.native_session_id,
                "user",
                format!("{request_id}:user"),
            )
            .await?;
        // A separate read keeps each native filter and request receipt explicit.
        let assistant = self
            .latest_message(
                &address.native_session_id,
                "assistant",
                format!("{request_id}:assistant"),
            )
            .await?;
        Ok(normalize_recent(user, assistant))
    }

    async fn latest_message(
        &self,
        session_id: &str,
        kind: &str,
        request_id: String,
    ) -> Result<Option<SourceMessage>, ReadError> {
        let path = format!("/api/session/{session_id}/message?order=desc&limit=50&type={kind}");
        let response = self
            .connection
            .request(request_id, Method::GET, &path)
            .map_err(map_connection_error)?
            .send()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(ReadError(
                "OpenCode message history rejected the configured identity".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(ReadError(format!(
                "OpenCode message history returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let wire: MessageListWire = response
            .json()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        let Some(message) = wire.data.into_iter().find_map(|message| match message {
            MessageWire::User { id, time, text } => Some(SourceMessage {
                text,
                turn_id: None,
                time: Some(time.created.to_string()),
                partial: None,
                truncated: None,
                message_id: Some(id),
                reply_to_input_id: None,
            }),
            MessageWire::Assistant { id, time, content } => Some(SourceMessage {
                text: content
                    .into_iter()
                    .filter_map(|part| match part {
                        AssistantContentWire::Text { text } => Some(text),
                        AssistantContentWire::Other => None,
                    })
                    .collect::<Vec<_>>()
                    .join(""),
                turn_id: None,
                time: Some(time.created.to_string()),
                partial: time.completed.map(|_| false),
                truncated: None,
                message_id: Some(id),
                reply_to_input_id: None,
            }),
            MessageWire::Other => None,
        }) else {
            return Ok(None);
        };
        Ok(Some(message))
    }
}

fn map_connection_error(error: OpenCodeConnectionError) -> ReadError {
    ReadError(format!("OpenCode native read: {error}"))
}
