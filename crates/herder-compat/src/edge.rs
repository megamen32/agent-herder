use std::{borrow::Cow, collections::HashSet, sync::Arc};

use rmcp::{
    ErrorData, Peer, RoleClient, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, CancelTaskParams,
        GetSkillRequestParams, GetTaskParams, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams,
        ReadResourceResponse, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};

use crate::{LEGACY_TOOLS, contract::{CompatChanges, CompatSkill, CompatTask}};

#[derive(Clone)]
pub struct LegacyEdge {
    upstream: Peer<RoleClient>,
}

impl LegacyEdge {
    pub fn new(upstream: Peer<RoleClient>) -> Self {
        Self { upstream }
    }

    fn upstream_capabilities(&self) -> Option<rmcp::model::ServerCapabilities> {
        self.upstream.peer_info().map(|info| info.capabilities.clone())
    }

    fn helper_available(&self, name: &str) -> bool {
        self.upstream_capabilities().is_some_and(|capabilities| match name {
            "compat_task" => capabilities.supports_tasks(),
            "compat_skill" => capabilities.supports_skills(),
            "compat_changes" => capabilities.resources.is_some(),
            _ => false,
        })
    }
}

fn helper_tool(name: &str) -> Tool {
    let schema = match name {
        "compat_task" => json!({"type":"object","properties":{"action":{"type":"string","enum":["get","answer","cancel"]},"task_ref":{"type":"string"},"request_ref":{"type":"string"},"answer":{}},"required":["action"],"additionalProperties":false}),
        "compat_skill" => json!({"type":"object","properties":{"action":{"type":"string","enum":["list","get"]},"cursor":{"type":["string","null"]},"skill_ref":{"type":"string"}},"required":["action"],"additionalProperties":false}),
        _ => json!({"type":"object","properties":{"action":{"type":"string","enum":["read","wait"]},"cursor":{"type":["string","null"]},"timeout_ms":{"type":"integer","minimum":0,"maximum":30000}},"required":["action"],"additionalProperties":false}),
    };
    Tool::new(Cow::Owned(name.to_owned()), format!("Temporary compatibility operation: {name}."), schema.as_object().expect("object schema").clone())
}

fn result(value: Value) -> CallToolResponse {
    CallToolResult::structured(value).into()
}

impl ServerHandler for LegacyEdge {
    fn get_info(&self) -> ServerConfig {
        let capabilities = if self.upstream_capabilities().is_some_and(|caps| caps.resources.is_some()) {
            ServerCapabilities::builder().enable_tools().enable_resources().build()
        } else {
            ServerCapabilities::builder().enable_tools().build()
        };
        ServerConfig::new(capabilities)
            .with_protocol_version(ProtocolVersion::V_2025_06_18)
            .with_server_info(Implementation::new("herder-compat", env!("CARGO_PKG_VERSION")))
            .with_instructions("Legacy compatibility endpoint. Native clients should connect to Herder directly.")
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2025_06_18])
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        (LEGACY_TOOLS.contains(&name) && self.helper_available(name)).then(|| helper_tool(name))
    }

    async fn list_tools(&self, cursor: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        let mut listing = self.upstream.list_tools(cursor).await.map_err(|_| ErrorData::internal_error("Native tool discovery failed", None))?;
        let names = listing.tools.iter().map(|tool| tool.name.to_string()).collect::<HashSet<_>>();
        if names.iter().any(|name| LEGACY_TOOLS.contains(&name.as_str())) {
            return Err(ErrorData::internal_error("Native discovery collides with a reserved compatibility tool", None));
        }
        for tool in &mut listing.tools {
            let schema = Arc::make_mut(&mut tool.input_schema);
            match schema.get("type") {
                None => { schema.insert("type".to_owned(), json!("object")); }
                Some(Value::String(kind)) if kind == "object" => {}
                Some(_) => return Err(ErrorData::internal_error("Native tool input schema is not an object", None)),
            }
        }
        if listing.next_cursor.is_none() {
            listing.tools.extend(LEGACY_TOOLS.iter().filter(|name| self.helper_available(name)).map(|name| helper_tool(name)));
        }
        Ok(listing)
    }

    async fn call_tool(&self, request: CallToolRequestParams, _: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.unwrap_or_default();
        match request.name.as_ref() {
            "compat_task" => {
                if !self.helper_available("compat_task") { return Err(ErrorData::method_not_found::<rmcp::model::CallToolRequestMethod>()); }
                let action: CompatTask = serde_json::from_value(Value::Object(args)).map_err(|_| ErrorData::invalid_params("Invalid compat_task arguments", None))?;
                match action {
                    CompatTask::Get { task_ref } => self.upstream.get_task(GetTaskParams::new(task_ref)).await.map(|task| result(serde_json::to_value(task).unwrap_or(Value::Null))).map_err(|_| ErrorData::internal_error("Task read failed", None)),
                    CompatTask::Cancel { task_ref } => self.upstream.cancel_task(CancelTaskParams::new(task_ref)).await.map(|()| result(json!({"cancel_requested":true,"effect":"unknown","retry":"read_receipt"}))).map_err(|_| ErrorData::internal_error("Task cancellation request failed", None)),
                    CompatTask::Answer { task_ref, request_ref, answer } => {
                        let params = serde_json::from_value(json!({"taskId":task_ref,"inputResponses":{request_ref:answer}})).map_err(|_| ErrorData::invalid_params("Invalid task input response", None))?;
                        self.upstream.update_task(params).await.map(|()| result(json!({"accepted":true}))).map_err(|_| ErrorData::internal_error("Task answer was not accepted", None))
                    }
                }
            }
            "compat_skill" => {
                if !self.helper_available("compat_skill") { return Err(ErrorData::method_not_found::<rmcp::model::CallToolRequestMethod>()); }
                let action: CompatSkill = serde_json::from_value(Value::Object(args)).map_err(|_| ErrorData::invalid_params("Invalid compat_skill arguments", None))?;
                match action {
                    CompatSkill::List { cursor } => {
                        let params = cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
                        self.upstream.list_skills(params).await.map(|items| result(serde_json::to_value(items).unwrap_or(Value::Null))).map_err(|_| ErrorData::internal_error("Skill listing failed", None))
                    }
                    CompatSkill::Get { skill_ref } => self.upstream.get_skill(GetSkillRequestParams::new(skill_ref)).await.map(|skill| result(serde_json::to_value(skill).unwrap_or(Value::Null))).map_err(|_| ErrorData::internal_error("Skill read failed", None))
                }
            }
            "compat_changes" => {
                if !self.helper_available("compat_changes") { return Err(ErrorData::method_not_found::<rmcp::model::CallToolRequestMethod>()); }
                let action: CompatChanges = serde_json::from_value(Value::Object(args)).map_err(|_| ErrorData::invalid_params("Invalid compat_changes arguments", None))?;
                match action {
                    CompatChanges::Read { cursor } => self.upstream.list_resources(cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)))).await.map(|items| result(serde_json::to_value(items).unwrap_or(Value::Null))).map_err(|_| ErrorData::internal_error("Change snapshot failed", None)),
                    CompatChanges::Wait { cursor, timeout_ms } => {
                        let before = self.upstream.list_resources(cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)))).await.map_err(|_| ErrorData::internal_error("Change snapshot failed", None))?;
                        if timeout_ms > 0 { tokio::time::sleep(std::time::Duration::from_millis(u64::from(timeout_ms.min(30_000)))).await; }
                        let after = self.upstream.list_resources(None).await.map_err(|_| ErrorData::internal_error("Change resync failed", None))?;
                        let changed = serde_json::to_value(&before).ok() != serde_json::to_value(&after).ok();
                        Ok(result(json!({"changed":changed,"snapshot":after,"resync_required":true})))
                    }
                }
            }
            // A reconnecting client may retain its catalog and call a native
            // tool before tools/list. Discovery is not authorization: preserve
            // the native endpoint as the authority for non-compat tool names.
            name => {
                let mut params = CallToolRequestParams::new(Cow::Owned(name.to_owned())).with_arguments(args);
                params.meta = Some(serde_json::from_value(json!({"task":{"ttl":60000}})).expect("valid task metadata"));
                match self.upstream.call_tool_once(params).await.map_err(|_| ErrorData::internal_error("Native operation failed; reconcile its receipt before retrying", None))? {
                    CallToolResponse::Task(task) => Ok(result(json!({"task_ref":task.task.task_id,"status":"working","native_task":true}))),
                    CallToolResponse::Complete(done) => Ok(CallToolResponse::Complete(done)),
                    CallToolResponse::InputRequired(input) => Ok(CallToolResponse::InputRequired(input)),
                    _ => Err(ErrorData::internal_error("Unsupported native response; reconcile its receipt before retrying", None)),
                }
            }
        }
    }

    async fn read_resource(&self, request: ReadResourceRequestParams, _: RequestContext<RoleServer>) -> Result<ReadResourceResponse, ErrorData> {
        self.upstream.read_resource_once(request).await.map_err(|_| ErrorData::internal_error("Resource read failed", None))
    }
}
