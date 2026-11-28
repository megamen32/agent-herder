use std::{borrow::Cow, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use herder_compat::LegacyEdge;
use rmcp::{ClientServiceExt, ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse, CallToolResult, ClientCapabilities,
        ClientConfig, Implementation, ListToolsResult, PaginatedRequestParams,
        ProtocolVersion, ServerCapabilities, ServerConfig, Tool},
    service::{ClientLifecycleMode, RequestContext}};
use serde_json::json;

#[derive(Clone, Default)]
struct Native {
    lists: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
    cancelled: Arc<tokio::sync::Notify>,
}

impl ServerHandler for Native {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(Implementation::new("first-call-native-fixture", "1"))
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        self.lists.fetch_add(1, Ordering::SeqCst);
        Ok(ListToolsResult::with_all_items(vec![Tool::new("discover", "read fixture", json!({"type":"object"}).as_object().unwrap().clone())]))
    }
    async fn call_tool(&self, request: CallToolRequestParams, ctx: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if request.name == "hung" {
            ctx.ct.cancelled().await;
            self.cancelled.notify_one();
            return Err(ErrorData::internal_error("fixture cancelled", None));
        }
        if request.name != "discover" {
            return Err(ErrorData::invalid_params("native unknown tool", None));
        }
        Ok(CallToolResult::structured(json!({"discovered":true,"args":request.arguments})).into())
    }
}

#[tokio::test]
async fn cached_client_calls_native_tool_after_reconnect_without_listing() {
    for _reconnect in 0..2 {
        let native = Native::default();
        let counters = native.clone();
        let (up_client, up_server) = tokio::io::duplex(16 * 1024);
        let native_server = tokio::spawn(async move {
            let service = native.serve(up_server).await.unwrap();
            let _ = service.waiting().await;
        });
        let upstream = ClientConfig::new(ClientCapabilities::default(), Implementation::new("compat-upstream-test", "1"))
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .serve_with_lifecycle(up_client, ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] }).await.unwrap();
        let edge = LegacyEdge::new(upstream.peer().clone());
        let (down_client, down_server) = tokio::io::duplex(16 * 1024);
        let edge_server = tokio::spawn(async move {
            let service = edge.serve(down_server).await.unwrap();
            let _ = service.waiting().await;
        });
        let client = ClientConfig::new(ClientCapabilities::default(), Implementation::new("cached-client", "1"))
            .with_protocol_version(ProtocolVersion::V_2025_06_18).serve(down_client).await.unwrap();
        // Cached clients legitimately skip tools/list on a new connection.
        let response = client.peer().call_tool_once(CallToolRequestParams::new("discover")
            .with_arguments(json!({"action":"instances"}).as_object().unwrap().clone())).await.unwrap();
        let CallToolResponse::Complete(done) = response else { panic!("expected complete native read"); };
        let wire = serde_json::to_value(done).unwrap();
        assert_eq!(wire["structuredContent"]["discovered"], true);
        assert_eq!(wire["structuredContent"]["args"]["action"], "instances");
        assert_eq!(counters.calls.load(Ordering::SeqCst), 1);
        // Unknown native names are rejected by the native endpoint, not a
        // stale compatibility catalog; never retried by the edge.
        assert!(client.peer().call_tool_once(CallToolRequestParams::new("absent_native_tool")).await.is_err());
        assert_eq!(counters.calls.load(Ordering::SeqCst), 2);
        // Reserved compatibility names must not fall through to native tools.
        assert!(client.peer().call_tool_once(CallToolRequestParams::new("compat_task")
            .with_arguments(json!({"action":"get","task_ref":"missing"}).as_object().unwrap().clone())).await.is_err());
        assert_eq!(counters.calls.load(Ordering::SeqCst), 2);
        assert_eq!(counters.lists.load(Ordering::SeqCst), 0);
        client.cancel().await.unwrap();
        upstream.cancel().await.unwrap();
        edge_server.abort(); native_server.abort();
    }
}

#[tokio::test(start_paused = true)]
async fn hung_native_call_has_an_edge_deadline_and_honors_cancellation() {
    use std::time::Duration;
    let (client_io, server_io) = tokio::io::duplex(16 * 1024);
    let native = Native::default();
    let cancelled = native.cancelled.clone();
    let (server, client) = tokio::join!(
        native.serve(server_io),
        async {
            let client = ClientConfig::new(ClientCapabilities::default(), Implementation::new("deadline-test", "1"))
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .serve_with_lifecycle(client_io, ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            }).await.unwrap();
            client.peer().list_tools(None).await.unwrap();
            client
        }
    );
    let server = server.unwrap();
    let edge = LegacyEdge::new(client.peer().clone());
    for cancel in [false, true] {
        let ctx = RequestContext::new(rmcp::model::RequestId::Number(7), server.peer().clone());
        let token = ctx.ct.clone();
        let started = tokio::time::Instant::now();
        if cancel {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                token.cancel();
            });
        }
        let limit = Duration::from_secs(if cancel { 2 } else { 160 });
        let error = tokio::time::timeout(limit, edge.call_tool(CallToolRequestParams::new("hung"), ctx))
            .await.expect("edge did not release its caller").unwrap_err();
        assert!(started.elapsed() < limit);
        assert!(error.message.contains(if cancel { "cancelled" } else { "deadline" }));
        tokio::time::timeout(Duration::from_secs(1), cancelled.notified()).await
            .expect("native handler did not receive notifications/cancelled");
    }
}
