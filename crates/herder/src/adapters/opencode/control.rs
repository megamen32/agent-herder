//! Native OpenCode message admission for an explicitly addressed session.
//!
//! OpenCode exposes `steer` and `queue` delivery on its prompt route, but no
//! idle compare-and-swap for starting a turn and no idempotency contract. This
//! adapter issues one request only. The Herder key is metadata for correlation;
//! OpenCode does not promise that resubmitting that key dedupes.

use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::json;

use crate::domain::adapter::{
    Admission, DispatchPlan, NativeReceipt, NativeSessionControl, RequestKey, SendMode, SubmitError,
};

use super::connection::{OpenCodeConnection, OpenCodeRequestFailure};

const MAX_REQUEST_KEY_BYTES: usize = 4096;
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct PromptResponse {
    data: PromptReceipt,
}

#[derive(Debug, Deserialize)]
struct PromptReceipt {
    id: String,
    #[serde(rename = "sessionID")]
    session_id: String,
    delivery: String,
}

/// A submit port bound to one configured OpenCode instance.
#[derive(Debug, Clone)]
pub struct OpenCodeSessionControl {
    connection: OpenCodeConnection,
}

impl OpenCodeSessionControl {
    pub fn new(connection: OpenCodeConnection) -> Self {
        Self { connection }
    }

    pub fn connection(&self) -> &OpenCodeConnection {
        &self.connection
    }
}

impl NativeSessionControl for OpenCodeSessionControl {
    async fn submit(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        if plan.target.instance != *self.connection.instance() {
            return Err(definitely_not_sent(
                "OpenCode target belongs to a different configured instance",
            ));
        }
        if !valid_session_id(&plan.target.native_session_id) {
            return Err(definitely_not_sent(
                "OpenCode target has an invalid native session ID",
            ));
        }
        if key.0.trim().is_empty() || key.0.len() > MAX_REQUEST_KEY_BYTES {
            return Err(definitely_not_sent("OpenCode request key is invalid"));
        }
        if message.is_empty() || message.len() > MAX_MESSAGE_BYTES {
            return Err(definitely_not_sent(
                "OpenCode message is empty or too large",
            ));
        }

        let delivery = match plan.mode {
            SendMode::Current
                if plan
                    .expected_turn
                    .as_deref()
                    .is_some_and(|id| !id.is_empty()) =>
            {
                "steer"
            }
            SendMode::Current => {
                return Err(definitely_not_sent(
                    "OpenCode current delivery requires the observed active turn",
                ));
            }
            SendMode::Queue => "queue",
            SendMode::Start => {
                return Err(definitely_not_sent(
                    "OpenCode start delivery is unsupported: native prompt has no idle compare-and-swap",
                ));
            }
        };

        let path = format!("/api/session/{}/prompt", plan.target.native_session_id);
        let request = match self.connection.request(key.0.clone(), Method::POST, &path) {
            Ok(request) => request.json(&json!({
                "text": message,
                "delivery": delivery,
                "metadata": { "agentHerderInputId": key.0 },
            })),
            Err(error) => {
                return Err(definitely_not_sent(&error.to_string()));
            }
        };

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return Err(match error.failure {
                    OpenCodeRequestFailure::DefinitelyNotSent => {
                        definitely_not_sent(&error.to_string())
                    }
                    OpenCodeRequestFailure::OutcomeUnknown => {
                        outcome_unknown(None, &error.to_string())
                    }
                });
            }
        };
        let status = response.status();
        if !status.is_success() {
            let reason = format!("OpenCode prompt returned HTTP {}", status.as_u16());
            return Err(
                if status.is_client_error() && status != StatusCode::CONFLICT {
                    definitely_not_sent(&reason)
                } else {
                    outcome_unknown(None, &reason)
                },
            );
        }

        let wire = match response.json::<PromptResponse>().await {
            Ok(wire) => wire,
            Err(error) => return Err(outcome_unknown(None, &error.to_string())),
        };
        if !valid_message_id(&wire.data.id) || wire.data.session_id != plan.target.native_session_id
        {
            return Err(outcome_unknown(
                None,
                "OpenCode prompt response omitted a valid native message ID or returned a different session",
            ));
        }

        let receipt = NativeReceipt {
            target: plan.target,
            native_id: wire.data.id,
        };
        if wire.data.delivery != delivery {
            return Err(outcome_unknown(
                Some(receipt),
                "OpenCode prompt response returned a different delivery mode",
            ));
        }

        Ok(Admission { receipt })
    }
}

fn valid_session_id(value: &str) -> bool {
    value.starts_with("ses")
        && value.len() <= 4096
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_message_id(value: &str) -> bool {
    value.strip_prefix("msg_").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

fn definitely_not_sent(reason: &str) -> SubmitError {
    SubmitError::DefinitelyNotSent {
        reason: reason.to_owned(),
    }
}

fn outcome_unknown(receipt: Option<NativeReceipt>, reason: &str) -> SubmitError {
    SubmitError::OutcomeUnknown {
        receipt,
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Profile,
        domain::address::{InstanceRef, NodeRef, SessionAddress},
    };
    use serde_json::{Value, json};
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex,
        task::JoinHandle,
        time::sleep,
    };

    const INSTANCE_ID: &str = "opencode-submit-fixture";
    const SESSION_ID: &str = "ses_fixture_submit001";

    struct Fixture {
        endpoint: String,
        posts: Arc<Mutex<Vec<(String, Value)>>>,
        task: JoinHandle<()>,
    }

    impl Fixture {
        async fn start(delay_response: Duration) -> Self {
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
                        let mut chunk = [0_u8; 4096];
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
                        if request_line.starts_with("GET /openapi.json ") {
                            let body = r#"{"openapi":"3.1.0","paths":{"/api/session":{"get":{},"post":{}},"/api/event":{"get":{}}}}"#;
                            write_response(&mut stream, 200, body).await;
                            return;
                        }
                        let request_path = request_line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or_default()
                            .to_owned();
                        let body = &bytes[header_end..header_end + content_length];
                        let payload: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
                        seen.lock()
                            .await
                            .push((request_path.clone(), payload.clone()));
                        sleep(delay_response).await;
                        let session_id = request_path
                            .strip_prefix("/api/session/")
                            .and_then(|path| path.strip_suffix("/prompt"))
                            .unwrap_or_default();
                        let delivery = payload["delivery"].as_str().unwrap_or_default();
                        let response = json!({"data":{"id":"msg_v064submit001","sessionID":session_id,"delivery":delivery}}).to_string();
                        write_response(&mut stream, 200, &response).await;
                    });
                }
            });
            Self {
                endpoint,
                posts,
                task,
            }
        }

        async fn stop(self) -> Vec<(String, Value)> {
            self.task.abort();
            self.posts.lock().await.clone()
        }
    }

    async fn write_response(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
        let label = if status == 200 { "OK" } else { "Error" };
        let response = format!(
            "HTTP/1.1 {status} {label}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }

    fn instance() -> InstanceRef {
        InstanceRef {
            node: NodeRef("opencode-submit-fixture-node".into()),
            instance_id: INSTANCE_ID.into(),
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

    async fn control(fixture: &Fixture, timeout: Duration) -> OpenCodeSessionControl {
        let connection =
            OpenCodeConnection::open(instance(), &profile(fixture.endpoint.clone()), None)
                .await
                .unwrap()
                .with_request_timeout(timeout)
                .unwrap();
        OpenCodeSessionControl::new(connection)
    }

    fn address(instance: InstanceRef, session_id: &str) -> SessionAddress {
        SessionAddress {
            instance,
            native_session_id: session_id.into(),
        }
    }

    fn plan(target: SessionAddress, mode: SendMode, turn: Option<&str>) -> DispatchPlan {
        DispatchPlan {
            target,
            mode,
            expected_turn: turn.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn submits_once_and_returns_exact_native_receipt() {
        let fixture = Fixture::start(Duration::ZERO).await;
        let control = control(&fixture, Duration::from_secs(2)).await;
        let target = address(instance(), SESSION_ID);
        let admission = control
            .submit(
                plan(target.clone(), SendMode::Current, Some("turn-current")),
                "one harmless fixture input",
                &RequestKey("native-submit-success".into()),
            )
            .await
            .unwrap();
        assert_eq!(admission.receipt.target, target);
        assert_eq!(admission.receipt.native_id, "msg_v064submit001");
        let posts = fixture.stop().await;
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0, format!("/api/session/{SESSION_ID}/prompt"));
        assert_eq!(posts[0].1.get("id"), None);
        assert_eq!(posts[0].1["text"], "one harmless fixture input");
        assert_eq!(posts[0].1["delivery"], "steer");
        assert_eq!(
            posts[0].1["metadata"]["agentHerderInputId"],
            "native-submit-success"
        );
    }

    #[tokio::test]
    async fn wrong_target_and_start_without_idle_cas_have_no_effect() {
        let fixture = Fixture::start(Duration::ZERO).await;
        let control = control(&fixture, Duration::from_secs(2)).await;
        let wrong_target = address(
            InstanceRef {
                node: NodeRef("other-node".into()),
                instance_id: INSTANCE_ID.into(),
            },
            SESSION_ID,
        );
        let wrong_target_result = control
            .submit(
                plan(wrong_target, SendMode::Queue, None),
                "must not be sent",
                &RequestKey("native-submit-wrong-target".into()),
            )
            .await;
        assert!(matches!(
            wrong_target_result,
            Err(SubmitError::DefinitelyNotSent { .. })
        ));

        let current_without_turn = control
            .submit(
                plan(address(instance(), SESSION_ID), SendMode::Current, None),
                "must not steer without an observed turn",
                &RequestKey("native-submit-current-without-turn".into()),
            )
            .await;
        assert!(matches!(
            current_without_turn,
            Err(SubmitError::DefinitelyNotSent { .. })
        ));

        let start_result = control
            .submit(
                plan(address(instance(), SESSION_ID), SendMode::Start, None),
                "must not start without native idle CAS",
                &RequestKey("native-submit-start".into()),
            )
            .await;
        assert!(
            matches!(start_result, Err(SubmitError::DefinitelyNotSent { reason }) if reason.contains("compare-and-swap"))
        );
        assert!(fixture.stop().await.is_empty());
    }

    #[tokio::test]
    async fn timeout_returns_unknown_with_reconciliation_receipt_and_never_retries() {
        let fixture = Fixture::start(Duration::from_millis(200)).await;
        let control = control(&fixture, Duration::from_millis(30)).await;
        let target = address(instance(), SESSION_ID);
        let result = control
            .submit(
                plan(target.clone(), SendMode::Queue, None),
                "one queued fixture input",
                &RequestKey("native-submit-timeout".into()),
            )
            .await;
        let receipt = match result {
            Err(SubmitError::OutcomeUnknown { receipt, .. }) => receipt,
            other => panic!("expected an unknown result, got {other:?}"),
        };
        assert!(receipt.is_none());
        sleep(Duration::from_millis(240)).await;
        let posts = fixture.stop().await;
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1["delivery"], "queue");
        assert_eq!(
            posts[0].1["metadata"]["agentHerderInputId"],
            "native-submit-timeout"
        );
    }
}
