//! Native session creation on one explicitly selected OpenCode instance.
//!
//! OpenCode's create endpoint has no request-key/idempotency field. The request
//! key is kept in Herder's receipt only; this adapter sends one POST and returns
//! Unknown after any ambiguous transport or response failure without retrying.
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    application::target::{NativeCreateControl, NativeCreateOutcome},
    domain::address::InstanceRef,
};

use super::connection::OpenCodeConnection;

const CREATE_PATH: &str = "/api/session";
const MAX_REQUEST_KEY_BYTES: usize = 4096;
const MAX_NATIVE_ID_BYTES: usize = 4096;

/// The subset of the documented OpenCode SessionCreate body supported by this
/// port. The caller cannot choose the native session ID; OpenCode assigns it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionCreateSpec {
    #[serde(rename = "parentID", skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permissions: Option<Value>,
}

#[derive(Deserialize)]
struct CreateResponse {
    data: CreatedSession,
}

#[derive(Deserialize)]
struct CreatedSession {
    id: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
}

/// Create one session through the native API of the bound OpenCode connection.
#[derive(Debug, Clone)]
pub struct OpenCodeCreateControl {
    connection: OpenCodeConnection,
}

impl OpenCodeCreateControl {
    pub fn new(connection: OpenCodeConnection) -> Self {
        Self { connection }
    }

    pub fn connection(&self) -> &OpenCodeConnection {
        &self.connection
    }
}

impl NativeCreateControl for OpenCodeCreateControl {
    fn instance(&self) -> &InstanceRef {
        self.connection.instance()
    }

    async fn create_once(&self, request_key: &str, specification: &str) -> NativeCreateOutcome {
        if request_key.is_empty() || request_key.len() > MAX_REQUEST_KEY_BYTES {
            return NativeCreateOutcome::Unknown;
        }

        let spec = if specification.trim().is_empty() {
            SessionCreateSpec::default()
        } else {
            match serde_json::from_str::<SessionCreateSpec>(specification) {
                Ok(spec) => spec,
                Err(_) => return NativeCreateOutcome::Unknown,
            }
        };
        if spec
            .parent_id
            .as_deref()
            .is_some_and(|id| !valid_native_session_id(id))
        {
            return NativeCreateOutcome::Unknown;
        }

        // The request key is deliberately not sent as a made-up header or native
        // ID. OpenCode has no idempotency contract for this endpoint.
        let request = match self
            .connection
            .request(request_key, Method::POST, CREATE_PATH)
        {
            Ok(request) => request.json(&spec),
            Err(_) => return NativeCreateOutcome::Unknown,
        };
        let response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            _ => return NativeCreateOutcome::Unknown,
        };
        let created = match response.json::<CreateResponse>().await {
            Ok(created) => created.data,
            Err(_) => return NativeCreateOutcome::Unknown,
        };
        if !valid_native_session_id(&created.id)
            || created
                .parent_id
                .as_deref()
                .is_some_and(|id| !valid_native_session_id(id))
        {
            return NativeCreateOutcome::Unknown;
        }

        NativeCreateOutcome::Confirmed {
            request_key: request_key.to_owned(),
            instance: self.connection.instance().clone(),
            native_session_id: created.id,
            parent_ref: created.parent_id,
        }
    }
}

fn valid_native_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NATIVE_ID_BYTES
        && value.starts_with("ses")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Profile,
        domain::address::{NodeRef, SessionAddress},
    };
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex,
        task::JoinHandle,
        time::sleep,
    };

    const CREATED_SESSION: &str =
        include_str!("../../../../../acceptance/native/opencode/session-create-response.json");

    struct Fixture {
        endpoint: String,
        posts: Arc<Mutex<Vec<String>>>,
        task: JoinHandle<()>,
    }

    impl Fixture {
        async fn start(delay_post_response: Duration) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let posts = Arc::new(Mutex::new(Vec::new()));
            let seen = posts.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        return;
                    };
                    let seen = seen.clone();
                    tokio::spawn(async move {
                        let mut bytes = Vec::new();
                        let mut chunk = [0_u8; 2048];
                        let header_end = loop {
                            let Ok(count) = stream.read(&mut chunk).await else {
                                return;
                            };
                            if count == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&chunk[..count]);
                            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                break index + 4;
                            }
                        };
                        let headers = String::from_utf8_lossy(&bytes[..header_end]);
                        let request_line = headers.lines().next().unwrap_or_default().to_owned();
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        while bytes.len() < header_end + content_length {
                            let Ok(count) = stream.read(&mut chunk).await else {
                                return;
                            };
                            if count == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&chunk[..count]);
                        }
                        if request_line.starts_with("POST /api/session ") {
                            seen.lock().await.push(
                                String::from_utf8_lossy(
                                    &bytes[header_end..header_end + content_length],
                                )
                                .into_owned(),
                            );
                            sleep(delay_post_response).await;
                            let body = CREATED_SESSION;
                            let response = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                        } else if request_line.starts_with("GET /openapi.json ") {
                            let body = r#"{"openapi":"3.1.0","paths":{"/api/session":{"get":{},"post":{}} ,"/api/event":{"get":{}}}}"#;
                            let response = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                        } else {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                                .await;
                        }
                    });
                }
            });
            Self {
                endpoint,
                posts,
                task,
            }
        }

        async fn stop(self) -> Vec<String> {
            self.task.abort();
            self.posts.lock().await.clone()
        }
    }

    fn profile(endpoint: String) -> Profile {
        Profile {
            runtime_cwd: PathBuf::from("/tmp"),
            worktree_root: PathBuf::from("/tmp"),
            endpoint: Some(endpoint),
            secret_ref: None,
        }
    }

    fn instance() -> InstanceRef {
        InstanceRef {
            node: NodeRef("opencode-create-fixture-node".into()),
            instance_id: "opencode-create-fixture".into(),
        }
    }

    async fn control(fixture: &Fixture, timeout: Duration) -> OpenCodeCreateControl {
        let connection =
            OpenCodeConnection::open(instance(), &profile(fixture.endpoint.clone()), None)
                .await
                .unwrap()
                .with_request_timeout(timeout)
                .unwrap();
        OpenCodeCreateControl::new(connection)
    }

    #[tokio::test]
    async fn confirms_exact_instance_and_native_response_id_once() {
        let fixture = Fixture::start(Duration::ZERO).await;
        let control = control(&fixture, Duration::from_secs(2)).await;
        let expected_instance = control.instance().clone();
        let outcome = control
            .create_once(
                "request-native-create-1",
                r#"{"title":"native create fixture"}"#,
            )
            .await;
        assert!(matches!(
            outcome,
            NativeCreateOutcome::Confirmed { request_key, instance, native_session_id, .. }
                if request_key == "request-native-create-1"
                    && instance == expected_instance
                    && native_session_id == "ses_fixture_opencode_create001"
        ));
        let posts = fixture.stop().await;
        assert_eq!(posts.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&posts[0]).unwrap()["title"],
            "native create fixture"
        );
        drop(control);
    }

    #[tokio::test]
    async fn invalid_specification_fails_before_native_create() {
        let fixture = Fixture::start(Duration::ZERO).await;
        let control = control(&fixture, Duration::from_secs(2)).await;
        let outcome = control
            .create_once("request-native-create-2", r#"{"id":"ses_caller_chosen"}"#)
            .await;
        assert!(matches!(outcome, NativeCreateOutcome::Unknown));
        assert!(fixture.stop().await.is_empty());
    }

    #[tokio::test]
    async fn timeout_after_post_returns_unknown_and_never_retries() {
        let fixture = Fixture::start(Duration::from_millis(200)).await;
        let control = control(&fixture, Duration::from_millis(30)).await;
        let outcome = control
            .create_once("request-native-create-timeout", "{}")
            .await;
        assert!(matches!(outcome, NativeCreateOutcome::Unknown));
        sleep(Duration::from_millis(250)).await;
        assert_eq!(fixture.stop().await.len(), 1);
    }

    #[test]
    fn session_address_type_is_available_for_exact_response_identity() {
        let _ = SessionAddress {
            instance: instance(),
            native_session_id: "ses_fixture_opencode_create001".into(),
        };
    }
}
