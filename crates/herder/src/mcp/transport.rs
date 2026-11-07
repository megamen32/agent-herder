//! Native MCP stdio boundary. The default server has no application attached.
use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc};

use crate::{auth::identity::Caller, mcp::catalog};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};

/// The application must authorize each operation and its exact resources using
/// the trusted caller; a verified principal alone is not a grant.
pub type ApplicationFuture<'a> = Pin<Box<dyn Future<Output = Option<CallToolResult>> + Send + 'a>>;
pub trait ApplicationPort: Send + Sync + 'static {
    /// None means this operation has no handler and must have no effect.
    fn call<'a>(&'a self, caller: &'a Caller, request: catalog::Request) -> ApplicationFuture<'a>;
}

#[derive(Clone)]
pub struct NativeServer {
    caller: Caller,
    application: Option<Arc<dyn ApplicationPort>>,
}

impl Default for NativeServer {
    fn default() -> Self {
        Self {
            caller: Caller::Unknown,
            application: None,
        }
    }
}

impl NativeServer {
    /// Caller must come from a trusted authentication boundary, never MCP metadata.
    pub fn with_application(caller: Caller, application: Arc<dyn ApplicationPort>) -> Self {
        Self {
            caller,
            application: Some(application),
        }
    }
}

fn check_metadata(ctx: &RequestContext<RoleServer>) -> Result<(), ErrorData> {
    if !ctx
        .meta
        .missing_required_keys(&ProtocolVersion::V_2026_07_28)
        .is_empty()
    {
        return Err(ErrorData::invalid_params(
            "request metadata requires protocolVersion and clientCapabilities",
            None,
        ));
    }
    if ctx.meta.protocol_version() != Some(ProtocolVersion::V_2026_07_28) {
        return Err(ErrorData::invalid_params(
            "unsupported protocol version",
            None,
        ));
    }
    Ok(())
}

fn tools() -> Vec<Tool> {
    catalog::discovery()
        .into_iter()
        .map(|definition| {
            Tool::new(
                definition.name,
                format!("Herder {} operation", definition.name),
                definition
                    .input_schema
                    .as_object()
                    .expect("catalog schemas are objects")
                    .clone(),
            )
        })
        .collect()
}

impl ServerHandler for NativeServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("agent-herder", env!("CARGO_PKG_VERSION")),
        )
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools().into_iter().find(|tool| tool.name == name)
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        check_metadata(&ctx)?;
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("unknown cursor", None));
        }
        let mut result = ListToolsResult::default();
        result.tools = tools();
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        check_metadata(&ctx)?;
        if request.input_responses.is_some() || request.request_state.is_some() {
            return Err(ErrorData::invalid_params(
                "request continuation is unsupported",
                None,
            ));
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        let parsed = catalog::dispatch(&request.name, input)
            .map_err(|_| ErrorData::invalid_params("unknown tool or invalid arguments", None))?;
        if let Some(application) = &self.application {
            if parsed.access == catalog::Access::Mutate
                && !matches!(self.caller, Caller::Principal(_))
            {
                return Ok(CallToolResult::structured_error(json!({"code":"unauthorized", "effect":"none", "message":"verified caller required"})).into());
            }
            if let Some(result) = application.call(&self.caller, parsed.request).await {
                return Ok(result.into());
            }
        }
        Ok(CallToolResult::structured_error(
            json!({"code":"unsupported", "effect":"none", "message":"operation is not connected"}),
        )
        .into())
    }
}

pub async fn serve_stdio() -> Result<(), Box<dyn std::error::Error>> {
    NativeServer::default()
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    struct FakeApp(AtomicUsize);
    impl ApplicationPort for FakeApp {
        fn call<'a>(
            &'a self,
            caller: &'a Caller,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                assert_eq!(*caller, Caller::Unknown);
                if matches!(
                    request,
                    catalog::Request::Discover(catalog::Discover::Instances { .. })
                ) {
                    return None;
                }
                assert!(matches!(
                    request,
                    catalog::Request::Discover(catalog::Discover::Nodes {})
                ));
                self.0.fetch_add(1, Ordering::SeqCst);
                Some(CallToolResult::structured(json!({"fake": "read"})))
            })
        }
    }

    #[tokio::test]
    async fn wire_injected_app_rejects_before_effect() {
        let app = Arc::new(FakeApp(AtomicUsize::new(0)));
        let server = NativeServer::with_application(Caller::Unknown, app.clone());
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "io.modelcontextprotocol/clientInfo":{"name":"admin", "version":"1"}});
        let mut requests = vec![
            json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":meta}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"nodes"}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"nodes","extra":true}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"s","message":"m","mode":"current","request_key":"k"}}}),
        ];
        let mut old = meta.clone();
        old["io.modelcontextprotocol/protocolVersion"] = json!("2025-06-18");
        requests.push(json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":old,"name":"discover","arguments":{"action":"nodes"}}}));
        requests.push(json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"instances"}}}));
        for (index, request) in requests.iter().enumerate() {
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let response: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            match index {
                0 => assert!(response.get("result").is_some(), "{response}"),
                1 => assert_eq!(response["result"]["structuredContent"]["fake"], "read"),
                2 | 4 => assert!(response.get("error").is_some(), "{response}"),
                3 => {
                    assert_eq!(response["result"]["isError"], true);
                    assert_eq!(response["result"]["structuredContent"]["effect"], "none");
                }
                5 => {
                    assert_eq!(response["result"]["isError"], true);
                    assert_eq!(
                        response["result"]["structuredContent"]["code"],
                        "unsupported"
                    );
                    assert_eq!(response["result"]["structuredContent"]["effect"], "none");
                }
                _ => unreachable!(),
            }
        }
        assert_eq!(app.0.load(Ordering::SeqCst), 1);
        drop(write);
        drop(lines);
        task.await.unwrap();
    }
}
