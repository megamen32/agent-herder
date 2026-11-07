//! Native MCP stdio boundary. No application operations are connected yet.
use std::borrow::Cow;

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

#[derive(Clone, Default)]
pub struct NativeServer;

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
        let _parsed = catalog::dispatch(&request.name, input)
            .map_err(|_| ErrorData::invalid_params("unknown tool or invalid arguments", None))?;
        // Metadata is a client claim, never identity evidence. No authenticated
        // stdio principal or handler has been wired yet.
        let _caller = Caller::Unknown;
        Ok(CallToolResult::structured_error(
            json!({"code":"unsupported", "effect":"none", "message":"operation is not connected"}),
        )
        .into())
    }
}

pub async fn serve_stdio() -> Result<(), Box<dyn std::error::Error>> {
    NativeServer
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
