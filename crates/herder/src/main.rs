//! V001 SDK gate only: no adapters, persistent state or real sessions.
use std::borrow::Cow;

use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::json;

#[derive(Clone)]
struct WireProbe;

fn probe_tool() -> Tool {
    Tool::new(
        "wire_probe",
        "Проверить обмен MCP с локальным SDK probe без внешних действий.",
        json!({"type": "object", "properties": {}, "additionalProperties": false})
            .as_object()
            .expect("literal object")
            .clone(),
    )
}

impl ServerHandler for WireProbe {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("herder-wire-probe", env!("CARGO_PKG_VERSION")))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        (name == "wire_probe").then(probe_tool)
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut result = ListToolsResult::default();
        result.tools = vec![probe_tool()];
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name != "wire_probe" {
            return Err(ErrorData::invalid_params("Unknown probe tool", None));
        }
        if request.arguments.as_ref().is_some_and(|args| !args.is_empty()) {
            return Err(ErrorData::invalid_params("wire_probe takes no arguments", None));
        }
        Ok(CallToolResult::structured(json!({"probe": "ok"})).into())
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    WireProbe.serve(rmcp::transport::stdio()).await?.waiting().await?;
    Ok(())
}
