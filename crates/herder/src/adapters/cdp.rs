//! Direct, identity-bound Chrome DevTools Protocol transport.
//!
//! It talks to Chrome's browser/page WebSocket endpoints over loopback (usually
//! an SSH tunnel); provider credentials remain inside the selected page.

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header::ORIGIN},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CdpTargetIdentity {
    pub node_id: String,
    pub instance_id: String,
    pub browser_context_id: String,
    pub target_id: String,
}

impl CdpTargetIdentity {
    fn is_complete(&self) -> bool {
        [
            &self.node_id,
            &self.instance_id,
            &self.browser_context_id,
            &self.target_id,
        ]
        .into_iter()
        .all(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpError {
    InvalidIdentity,
    InvalidEndpoint,
    Connect,
    Closed,
    Protocol,
    OutcomeUnknown { request_id: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CdpCreateError {
    InvalidEndpoint,
    OutcomeUnknown,
    Protocol,
    Attach(CdpError),
}

pub async fn create_page_target(
    browser_websocket_endpoint: &str,
    origin: &str,
    node_id: &str,
    instance_id: &str,
    browser_context_id: &str,
) -> Result<CdpConnection, CdpCreateError> {
    create_page_target_with_origin_port(
        browser_websocket_endpoint,
        origin,
        node_id,
        instance_id,
        browser_context_id,
        None,
    )
    .await
}

pub async fn create_page_target_with_origin_port(
    browser_websocket_endpoint: &str,
    origin: &str,
    node_id: &str,
    instance_id: &str,
    browser_context_id: &str,
    origin_port: Option<u16>,
) -> Result<CdpConnection, CdpCreateError> {
    let mut connection = match origin_port {
        Some(port) => {
            CdpConnection::connect_browser_with_origin_port(
                browser_websocket_endpoint,
                node_id,
                instance_id,
                port,
            )
            .await
        }
        None => {
            CdpConnection::connect_browser(browser_websocket_endpoint, node_id, instance_id).await
        }
    }
    .map_err(CdpCreateError::Attach)?;
    connection.create_target(origin, browser_context_id).await?;
    Ok(connection)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpTargetInfo {
    pub target_id: String,
    pub browser_context_id: Option<String>,
    #[serde(rename = "type")]
    pub target_type: String,
    pub url: String,
}

pub struct CdpConnection {
    identity: CdpTargetIdentity,
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    request_timeout: Duration,
    session_id: Option<String>,
    browser_endpoint: bool,
    owns_target: bool,
}

impl CdpConnection {
    /// Connect directly to Chrome's browser endpoint for target discovery,
    /// creation and attachment. Identity labels bind this endpoint to the
    /// caller-selected node and Chrome instance.
    pub async fn connect_browser(
        endpoint: &str,
        node_id: &str,
        instance_id: &str,
    ) -> Result<Self, CdpError> {
        Self::connect_browser_with_timeout(endpoint, node_id, instance_id, DEFAULT_TIMEOUT).await
    }

    pub async fn connect_browser_with_timeout(
        endpoint: &str,
        node_id: &str,
        instance_id: &str,
        request_timeout: Duration,
    ) -> Result<Self, CdpError> {
        Self::connect_browser_inner(endpoint, node_id, instance_id, None, request_timeout).await
    }

    pub async fn connect_browser_with_origin_port(
        endpoint: &str,
        node_id: &str,
        instance_id: &str,
        remote_origin_port: u16,
    ) -> Result<Self, CdpError> {
        if remote_origin_port == 0 {
            return Err(CdpError::InvalidEndpoint);
        }
        Self::connect_browser_inner(
            endpoint,
            node_id,
            instance_id,
            Some(remote_origin_port),
            DEFAULT_TIMEOUT,
        )
        .await
    }

    async fn connect_browser_inner(
        endpoint: &str,
        node_id: &str,
        instance_id: &str,
        origin_port: Option<u16>,
        request_timeout: Duration,
    ) -> Result<Self, CdpError> {
        if node_id.trim().is_empty() || instance_id.trim().is_empty() || request_timeout.is_zero() {
            return Err(CdpError::InvalidIdentity);
        }
        let socket = open_socket(endpoint, "browser", None, request_timeout, origin_port).await?;
        let mut connection = Self {
            identity: CdpTargetIdentity {
                node_id: node_id.to_owned(),
                instance_id: instance_id.to_owned(),
                browser_context_id: String::new(),
                target_id: String::new(),
            },
            socket,
            next_id: 1,
            request_timeout,
            session_id: None,
            browser_endpoint: true,
            owns_target: false,
        };
        connection.command("Browser.getVersion", json!({})).await?;
        connection.list_targets().await?;
        Ok(connection)
    }

    /// Attach to a known page WebSocket, checking its target and browser
    /// context before returning a usable provider connection.
    pub async fn connect_page(
        endpoint: &str,
        identity: CdpTargetIdentity,
    ) -> Result<Self, CdpError> {
        Self::connect_page_with_timeout(endpoint, identity, DEFAULT_TIMEOUT).await
    }

    pub async fn connect_page_with_timeout(
        endpoint: &str,
        identity: CdpTargetIdentity,
        request_timeout: Duration,
    ) -> Result<Self, CdpError> {
        if !identity.is_complete() || request_timeout.is_zero() {
            return Err(CdpError::InvalidIdentity);
        }
        let socket = open_socket(
            endpoint,
            "page",
            Some(&identity.target_id),
            request_timeout,
            None,
        )
        .await?;
        let mut connection = Self {
            identity,
            socket,
            next_id: 1,
            request_timeout,
            session_id: None,
            browser_endpoint: false,
            owns_target: false,
        };
        connection.verify_target_context().await?;
        Ok(connection)
    }

    pub fn identity(&self) -> &CdpTargetIdentity {
        &self.identity
    }

    pub async fn list_targets(&mut self) -> Result<Vec<CdpTargetInfo>, CdpError> {
        if !self.browser_endpoint {
            return Err(CdpError::InvalidIdentity);
        }
        let value = self.command("Target.getTargets", json!({})).await?;
        serde_json::from_value(value.get("targetInfos").cloned().unwrap_or(Value::Null))
            .map_err(|_| CdpError::Protocol)
    }

    /// Attach to an existing target from Target.getTargets and bind all four
    /// identity fields before the adapter can issue provider operations.
    pub async fn attach_target(
        &mut self,
        target_id: &str,
        expected_context_id: &str,
    ) -> Result<(), CdpError> {
        if !self.browser_endpoint
            || self.session_id.is_some()
            || target_id.trim().is_empty()
            || expected_context_id.trim().is_empty()
        {
            return Err(CdpError::InvalidIdentity);
        }
        let targets = self.list_targets().await?;
        let target = targets
            .iter()
            .find(|target| target.target_id == target_id && target.target_type == "page")
            .ok_or(CdpError::InvalidIdentity)?;
        if target.browser_context_id.as_deref() != Some(expected_context_id) {
            return Err(CdpError::InvalidIdentity);
        }
        self.attach_session(target_id, expected_context_id).await
    }

    /// Create one new provider home page in the explicitly selected browser
    /// context, then attach to that exact target through CDP.
    pub async fn create_target(
        &mut self,
        origin: &str,
        browser_context_id: &str,
    ) -> Result<(), CdpCreateError> {
        if !self.browser_endpoint
            || self.session_id.is_some()
            || !matches!(origin, "https://chatgpt.com" | "https://chat.z.ai")
            || browser_context_id.trim().is_empty()
        {
            return Err(CdpCreateError::InvalidEndpoint);
        }
        let created = self
            .command(
                "Target.createTarget",
                json!({
                    "url": format!("{origin}/"),
                    "browserContextId": browser_context_id,
                    "background": true
                }),
            )
            .await
            .map_err(|error| match error {
                CdpError::OutcomeUnknown { .. } => CdpCreateError::OutcomeUnknown,
                _ => CdpCreateError::Attach(error),
            })?;
        let target_id = created
            .get("targetId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(CdpCreateError::Protocol)?
            .to_owned();
        self.owns_target = true;
        if let Err(error) = self.attach_session(&target_id, browser_context_id).await {
            let _ = self
                .command("Target.closeTarget", json!({"targetId": target_id}))
                .await;
            self.owns_target = false;
            return Err(CdpCreateError::Attach(error));
        }
        Ok(())
    }

    async fn attach_session(
        &mut self,
        target_id: &str,
        expected_context_id: &str,
    ) -> Result<(), CdpError> {
        let attached = self
            .command(
                "Target.attachToTarget",
                json!({"targetId": target_id, "flatten": true}),
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or(CdpError::Protocol)?
            .to_owned();
        self.session_id = Some(session_id);
        self.identity.target_id = target_id.to_owned();
        self.identity.browser_context_id = expected_context_id.to_owned();
        self.verify_target_context().await
    }

    async fn verify_target_context(&mut self) -> Result<(), CdpError> {
        let info = self.command("Target.getTargetInfo", json!({})).await?;
        let target = info.get("targetInfo").ok_or(CdpError::Protocol)?;
        if target.get("targetId").and_then(Value::as_str) != Some(self.identity.target_id.as_str())
            || target.get("browserContextId").and_then(Value::as_str)
                != Some(self.identity.browser_context_id.as_str())
        {
            return Err(CdpError::InvalidIdentity);
        }
        Ok(())
    }

    /// Send one CDP command and correlate only its response id. Browser and
    /// page events are ignored; post-send disconnect/timeout is never retried.
    pub async fn command(&mut self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.command_scoped(method, params, true).await
    }

    async fn command_scoped(
        &mut self,
        method: &str,
        params: Value,
        use_session: bool,
    ) -> Result<Value, CdpError> {
        if method.trim().is_empty() {
            return Err(CdpError::Protocol);
        }
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or(CdpError::Closed)?;
        let mut request = json!({"id":id,"method":method,"params":params});
        if use_session && let Some(session_id) = self.session_id.as_deref() {
            request["sessionId"] = Value::String(session_id.to_owned());
        }
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|_| CdpError::OutcomeUnknown { request_id: id })?;
        let response = timeout(self.request_timeout, async {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        if value.get("id").and_then(Value::as_u64) == Some(id) {
                            break Some(value);
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                            continue;
                        };
                        if value.get("id").and_then(Value::as_u64) == Some(id) {
                            break Some(value);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break None,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .map_err(|_| CdpError::OutcomeUnknown { request_id: id })?
        .ok_or(CdpError::OutcomeUnknown { request_id: id })?;
        if response.get("error").is_some() {
            return Err(CdpError::Protocol);
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Evaluate a promise in the identity-checked page and return only its
    /// by-value result. Provider credentials stay in the browser context.
    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, CdpError> {
        let result = self
            .command(
                "Runtime.evaluate",
                json!({"expression":expression,"awaitPromise":true,"returnByValue":true,"userGesture":false}),
            )
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err(CdpError::Protocol);
        }
        Ok(result
            .get("result")
            .and_then(|remote| remote.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Wait for a newly created provider target to finish its initial
    /// navigation. Chrome may attach the target while it is still about:blank.
    pub async fn wait_for_origin(&mut self, expected_origin: &str) -> Result<bool, CdpError> {
        if !matches!(expected_origin, "https://chatgpt.com" | "https://chat.z.ai") {
            return Err(CdpError::InvalidEndpoint);
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            match self.evaluate("location.origin").await {
                Ok(origin) if origin.as_str() == Some(expected_origin) => return Ok(true),
                Ok(_) | Err(CdpError::Protocol) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }

    pub async fn activate_target(&mut self) -> Result<(), CdpError> {
        if self.identity.target_id.is_empty() {
            return Err(CdpError::InvalidIdentity);
        }
        if self.browser_endpoint {
            self.command_scoped(
                "Target.activateTarget",
                json!({"targetId": self.identity.target_id}),
                false,
            )
            .await?;
        } else {
            self.command("Page.bringToFront", json!({})).await?;
        }
        Ok(())
    }

    pub async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }

    /// Close only a target created by this connection; attached existing tabs
    /// are retained. The browser socket sends closeTarget exactly once.
    pub async fn close_created_target(mut self) {
        if self.owns_target {
            let _ = self
                .command_scoped(
                    "Target.closeTarget",
                    json!({"targetId": self.identity.target_id}),
                    false,
                )
                .await;
        }
        let _ = self.socket.close(None).await;
    }
}

async fn open_socket(
    endpoint: &str,
    expected_kind: &str,
    target_id: Option<&str>,
    request_timeout: Duration,
    origin_port: Option<u16>,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, CdpError> {
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| CdpError::InvalidEndpoint)?;
    let uri = request.uri();
    let path_ok = match expected_kind {
        "browser" => {
            uri.path().starts_with("/devtools/browser/")
                && uri.path().len() > "/devtools/browser/".len()
        }
        "page" => target_id.is_some_and(|id| uri.path() == format!("/devtools/page/{id}")),
        _ => false,
    };
    let host = uri.host().ok_or(CdpError::InvalidEndpoint)?;
    if uri.scheme_str() != Some("ws")
        || !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        || uri.query().is_some()
        || !path_ok
        || uri
            .authority()
            .is_some_and(|auth| auth.as_str().contains('@'))
    {
        return Err(CdpError::InvalidEndpoint);
    }
    let origin = match origin_port {
        Some(port) => format!("http://127.0.0.1:{port}"),
        None => format!(
            "http://{}",
            uri.authority().ok_or(CdpError::InvalidEndpoint)?
        ),
    };
    request.headers_mut().insert(
        ORIGIN,
        origin.parse().map_err(|_| CdpError::InvalidEndpoint)?,
    );
    let (socket, _) = timeout(request_timeout, connect_async(request))
        .await
        .map_err(|_| CdpError::Connect)?
        .map_err(|_| CdpError::Connect)?;
    Ok(socket)
}
