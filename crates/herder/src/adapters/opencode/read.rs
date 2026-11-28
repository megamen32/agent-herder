//! Typed, read-only session listing from one explicitly selected OpenCode instance.

use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};

use crate::{
    application::recent::{RecentMessages, SourceMessage, normalize_recent},
    domain::{
        adapter::ReadError,
        address::{InstanceRef, SessionAddress},
    },
};

use super::connection::{OpenCodeConnection, OpenCodeConnectionError};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenCodeSessionTime {
    pub created: f64,
    pub updated: f64,
    pub busy: Option<f64>,
    pub idle: Option<f64>,
    pub archived: Option<f64>,
}

impl OpenCodeSessionTime {
    /// OpenCode keeps both transition timestamps after a turn completes.
    pub fn is_busy(&self) -> Option<bool> {
        match (self.busy, self.idle) {
            (Some(busy), Some(idle)) => Some(busy > idle),
            (Some(_), None) => Some(true),
            (None, Some(_)) => Some(false),
            (None, None) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenCodeSession {
    pub address: SessionAddress,
    pub parent_session_id: Option<String>,
    pub project_id: String,
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_permission: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub time: OpenCodeSessionTime,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    #[serde(rename = "needsPermission")]
    needs_permission: Option<bool>,
    model: Option<SessionModelWire>,
    time: SessionTimeWire,
    location: SessionLocationWire,
}

#[derive(Deserialize)]
struct SessionModelWire {
    #[serde(rename = "providerID")]
    provider: String,
    id: String,
}

impl SessionModelWire {
    fn qualified_id(self) -> Option<String> {
        let valid = |value: &str| !value.is_empty() && !value.chars().any(char::is_whitespace);
        if !valid(&self.provider) || self.provider.contains('/') || !valid(&self.id) {
            return None;
        }
        Some(format!("{}/{}", self.provider, self.id))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SessionResponseWire {
    Direct(SessionWire),
    Wrapped { data: SessionWire },
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
    #[serde(default)]
    cursor: Option<SessionCursorWire>,
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
        finish: Option<String>,
        error: Option<serde_json::Value>,
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

/// One native OpenCode message projected without inventing turn links.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenCodeMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created: f64,
    pub completed: Option<f64>,
    pub partial: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<&'static str>,
}

/// A bounded page returned by the native message-history route.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenCodeSessionMessages {
    pub session_id: String,
    pub messages: Vec<OpenCodeMessage>,
    pub previous: Option<String>,
    pub next: Option<String>,
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

    pub async fn confirms_missing_session(&self, id: &str) -> bool {
        if !valid_native_session_id(id) {
            return true;
        }
        let path = format!("/api/session/{id}");
        let Ok(request) = self.connection.request("herder-recovery-presence", Method::GET, &path)
        else {
            return false;
        };
        let Ok(response) = request.send().await else {
            return false;
        };
        response.status() == StatusCode::NOT_FOUND
            && response.json::<serde_json::Value>().await.is_ok_and(|error| {
                error["_tag"] == "SessionNotFoundError" && error["sessionID"] == id
            })
    }

    /// Read the native first page (OpenCode defaults to newest 50 sessions).
    /// Any returned cursor remains opaque and is passed through unchanged.
    pub async fn list_sessions(
        &self,
        request_id: impl Into<String>,
    ) -> Result<OpenCodeSessionPage, ReadError> {
        self.session_page(request_id, "/api/session").await
    }

    pub async fn list_recent_sessions(
        &self,
        request_id: impl Into<String>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<OpenCodeSessionPage, ReadError> {
        let mut url = self.connection.endpoint().clone();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", &limit.to_string());
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            } else {
                query
                    .append_pair("order", "desc")
                    .append_pair("archived", "false");
            }
        }
        let path = format!("/api/session?{}", url.query().unwrap_or_default());
        self.session_page(request_id, &path).await
    }

    async fn session_page(
        &self,
        request_id: impl Into<String>,
        path: &str,
    ) -> Result<OpenCodeSessionPage, ReadError> {
        let request = self
            .connection
            .request(request_id, Method::GET, path)
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
        let mut sessions = Vec::with_capacity(wire.data.len());
        for session in wire.data {
            sessions.push(self.project_session(session)?);
        }
        Ok(OpenCodeSessionPage {
            sessions,
            previous: wire.cursor.previous,
            next: wire.cursor.next,
        })
    }

    /// Read one exact session through the v2 session resource route.
    pub async fn get_session(
        &self,
        address: &SessionAddress,
        request_id: impl Into<String>,
    ) -> Result<OpenCodeSession, ReadError> {
        self.validate_address(address)?;
        let path = format!("/api/session/{}", address.native_session_id);
        let response = self
            .connection
            .request(request_id, Method::GET, &path)
            .map_err(map_connection_error)?
            .send()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(ReadError(
                "OpenCode session read rejected the configured identity".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(ReadError(format!(
                "OpenCode session read returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let wire = response
            .json::<SessionResponseWire>()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        let session = match wire {
            SessionResponseWire::Direct(session)
            | SessionResponseWire::Wrapped { data: session } => session,
        };
        if session.id != address.native_session_id {
            return Err(ReadError("OpenCode session read returned another identity".into()));
        }
        self.project_session(session)
    }

    /// Read the native message page without filtering away roles or content.
    pub async fn get_session_messages(
        &self,
        address: &SessionAddress,
        request_id: impl Into<String>,
    ) -> Result<OpenCodeSessionMessages, ReadError> {
        self.validate_address(address)?;
        let path = format!("/api/session/{}/message", address.native_session_id);
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
        let wire = response
            .json::<MessageListWire>()
            .await
            .map_err(|error| ReadError(error.to_string()))?;
        Ok(OpenCodeSessionMessages {
            session_id: address.native_session_id.clone(),
            messages: wire.data.into_iter().filter_map(project_message).collect(),
            previous: wire
                .cursor
                .as_ref()
                .and_then(|cursor| cursor.previous.clone()),
            next: wire.cursor.and_then(|cursor| cursor.next),
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
        self.validate_address(address)?;
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
            MessageWire::Assistant { id, time, content, .. } => Some(SourceMessage {
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

    fn validate_address(&self, address: &SessionAddress) -> Result<(), ReadError> {
        if address.instance != *self.connection.instance()
            || !valid_native_session_id(&address.native_session_id)
        {
            return Err(ReadError(
                "OpenCode session address does not belong to this instance".into(),
            ));
        }
        Ok(())
    }

    fn project_session(&self, session: SessionWire) -> Result<OpenCodeSession, ReadError> {
        if !valid_native_session_id(&session.id) {
            return Err(ReadError(
                "OpenCode returned a session ID outside its native ID namespace".into(),
            ));
        }
        Ok(OpenCodeSession {
            address: SessionAddress {
                instance: self.connection.instance().clone(),
                native_session_id: session.id,
            },
            parent_session_id: session.parent_id,
            project_id: session.project_id,
            outcome: session.outcome,
            needs_permission: session.needs_permission,
            model: session.model.and_then(SessionModelWire::qualified_id),
            time: OpenCodeSessionTime {
                created: session.time.created,
                updated: session.time.updated,
                busy: session.time.busy,
                idle: session.time.idle,
                archived: session.time.archived,
            },
            directory: session.location.directory,
        })
    }
}

fn project_message(message: MessageWire) -> Option<OpenCodeMessage> {
    match message {
        MessageWire::User { id, time, text } => Some(OpenCodeMessage {
            id,
            role: "user".into(),
            text,
            created: time.created,
            completed: None,
            partial: None,
            phase: None,
        }),
        MessageWire::Assistant { id, time, content, finish, error } => Some(OpenCodeMessage {
            id,
            role: "assistant".into(),
            text: content
                .into_iter()
                .filter_map(|part| match part {
                    AssistantContentWire::Text { text } => Some(text),
                    AssistantContentWire::Other => None,
                })
                .collect::<Vec<_>>()
                .join(""),
            created: time.created,
            completed: time.completed,
            partial: time.completed.map(|_| false),
            phase: (finish.as_deref() == Some("stop")
                && error.is_none()
                && time.completed.is_some_and(|completed| completed >= time.created))
                .then_some("stop"),
        }),
        MessageWire::Other => None,
    }
}

fn valid_native_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.starts_with("ses")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn map_connection_error(error: OpenCodeConnectionError) -> ReadError {
    ReadError(format!("OpenCode native read: {error}"))
}

#[test]
fn latest_opencode_transition_determines_activity() {
    let busy = Some(1795883278363.0);
    let idle = Some(1795883281932.0);
    for (busy, idle, expected) in [
        (busy, idle, Some(false)), (idle, busy, Some(true)), (idle, idle, Some(false)),
        (busy, None, Some(true)), (None, idle, Some(false)), (None, None, None),
    ] {
        let time = OpenCodeSessionTime { created: 0.0, updated: 0.0, busy, idle, archived: None };
        assert_eq!(time.is_busy(), expected);
    }
}
