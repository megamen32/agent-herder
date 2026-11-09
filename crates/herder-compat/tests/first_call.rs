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
    async fn call_tool(&self, request: CallToolRequestParams, _: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        self.calls.fetch_add(1, Ordering::SeqCst);
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
