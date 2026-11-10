use std::{borrow::Cow, fs, path::PathBuf};

use herder_compat::LegacyEdge;
use rmcp::{
    ClientServiceExt, ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        ClientCapabilities, ClientConfig, Implementation, ProtocolVersion,
        ServerCapabilities, ServerConfig, ListToolsResult, PaginatedRequestParams, Tool,
    },
    service::{ClientLifecycleMode, RequestContext},
    transport::TokioChildProcess,
};
use tokio::process::Command;

#[derive(Clone)]
struct NativeProbe;

impl ServerHandler for NativeProbe {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(Implementation::new("isolated-native-wire-probe", "0.1.0"))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }

    async fn ping(&self, _: RequestContext<RoleServer>) -> Result<(), ErrorData> { Ok(()) }

    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        let mut listing = ListToolsResult::default();
        let schema = serde_json::json!({"oneOf":[{"type":"object","properties":{"action":{"const":"read"}},"required":["action"]},{"type":"object","properties":{"action":{"const":"other"}},"required":["action"]}]});
        listing.tools = vec![Tool::new("probe", "schema probe", schema.as_object().unwrap().clone())];
        Ok(listing)
    }
}

#[tokio::test]
async fn native_and_legacy_handshakes_keep_their_explicit_protocol_versions() {
    let (native_client_io, native_server_io) = tokio::io::duplex(16 * 1024);
    let native_server = tokio::spawn(async move {
        if let Ok(service) = NativeProbe.serve(native_server_io).await {
            let _ = service.waiting().await;
        }
    });
    let native_config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::new("herder-compat-wire-test", "0.1.0"),
    ).with_protocol_version(ProtocolVersion::V_2026_07_28);
    let native_client = tokio::time::timeout(std::time::Duration::from_secs(5), native_config.serve_with_lifecycle(
        native_client_io,
        ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
    )).await.unwrap().unwrap();
    let upstream_version = native_client.peer().peer_info().unwrap().protocol_version.clone();
    assert_eq!(upstream_version, ProtocolVersion::V_2026_07_28);

    let edge = LegacyEdge::new(native_client.peer().clone());
    let (legacy_client_io, legacy_server_io) = tokio::io::duplex(16 * 1024);
    let legacy_server = tokio::spawn(async move {
        if let Ok(service) = edge.serve(legacy_server_io).await {
            let _ = service.waiting().await;
        }
    });
    let legacy_config = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("unchanged-legacy-wire-probe", "0.1.0"),
    ).with_protocol_version(ProtocolVersion::V_2025_06_18);
    let legacy_client = tokio::time::timeout(std::time::Duration::from_secs(5), legacy_config.serve(legacy_client_io)).await.unwrap().unwrap();
    let downstream_version = legacy_client.peer().peer_info().unwrap().protocol_version.clone();
    assert_eq!(downstream_version, ProtocolVersion::V_2025_06_18);
    let original = native_client.peer().list_tools(None).await.unwrap();
    let forwarded = legacy_client.peer().list_tools(None).await.unwrap();
    let mut expected = (*original.tools[0].input_schema).clone();
    expected.insert("type".into(), serde_json::json!("object"));
    assert_eq!(*forwarded.tools[0].input_schema, expected);
    let record = serde_json::json!({
        "probe": "rmcp-3.9.0 in-memory wire handshake",
        "upstream_protocol": upstream_version.to_string(),
        "downstream_protocol": downstream_version.to_string(),
        "native_endpoint_downgraded": false,
        "fixture_only": true
    });
    if let Some(dir) = std::env::var_os("HERDER_COMPAT_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("handshakes.json"), serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    }

    legacy_client.cancel().await.unwrap();
    native_client.cancel().await.unwrap();
    legacy_server.abort();
    native_server.abort();
}

#[tokio::test]
#[ignore = "requires an explicitly built native stdio binary in HERDER_NATIVE_BINARY"]
async fn real_native_stdio_endpoint_is_forwarded_without_legacy_downgrade() {
    let binary = std::env::var("HERDER_NATIVE_BINARY").expect("HERDER_NATIVE_BINARY must point to the built native stdio binary");
    let upstream = TokioChildProcess::new(Command::new(binary)).unwrap();
    let config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::new("herder-compat-wire-probe", "0.1.0"),
    ).with_protocol_version(ProtocolVersion::V_2026_07_28);
    let native_client = config.serve_with_lifecycle(
        upstream,
        ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
    ).await.unwrap();
    let upstream_version = native_client.peer().peer_info().unwrap().protocol_version.clone();
    assert_eq!(upstream_version, ProtocolVersion::V_2026_07_28);

    let edge = LegacyEdge::new(native_client.peer().clone());
    let (legacy_client_io, legacy_server_io) = tokio::io::duplex(16 * 1024);
    let legacy_server = tokio::spawn(async move {
        if let Ok(service) = edge.serve(legacy_server_io).await { let _ = service.waiting().await; }
    });
    let legacy_config = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("unchanged-legacy-wire-probe", "codex-observed-2025-06-18"),
    ).with_protocol_version(ProtocolVersion::V_2025_06_18);
    let legacy_client = legacy_config.serve(legacy_client_io).await.unwrap();
    let downstream_version = legacy_client.peer().peer_info().unwrap().protocol_version.clone();
    assert_eq!(downstream_version, ProtocolVersion::V_2025_06_18);
    let listing = legacy_client.peer().list_tools(None).await.unwrap();
    assert_eq!(listing.tools.len(), 14);
    assert!(listing.tools.iter().any(|tool| tool.name == "resource"));
    let native_listing = native_client.peer().list_tools(None).await.unwrap();
    for (legacy, native) in listing.tools.iter().zip(&native_listing.tools) {
        assert_eq!(legacy.name, native.name);
        let mut expected = (*native.input_schema).clone();
        expected.insert("type".into(), serde_json::json!("object"));
        assert_eq!(*legacy.input_schema, expected, "{}", legacy.name);
        assert!(!legacy.input_schema["oneOf"].as_array().unwrap().is_empty());
    }

    let record = serde_json::json!({
        "probe": "official rmcp client through LegacyEdge to compiled herder_native_stdio",
        "upstream_protocol": upstream_version.to_string(),
        "downstream_protocol": downstream_version.to_string(),
        "forwarded_tools": listing.tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>(),
        "native_endpoint_downgraded": false,
        "fixture_only": false,
        "business_operations_connected": false
    });
    if let Some(dir) = std::env::var_os("HERDER_COMPAT_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("native-endpoint.json"), serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    }
    legacy_client.cancel().await.unwrap();
    native_client.cancel().await.unwrap();
    legacy_server.abort();
}
