//! Typed, read-only session listing from one explicitly selected OpenCode instance.

use reqwest::{Method, StatusCode};
use serde::Deserialize;

use crate::domain::{
    adapter::ReadError,
    address::{InstanceRef, SessionAddress},
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
}

fn map_connection_error(error: OpenCodeConnectionError) -> ReadError {
    ReadError(format!("OpenCode session list: {error}"))
}
