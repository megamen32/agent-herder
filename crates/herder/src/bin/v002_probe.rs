//! Isolated V002 SDK probe: in-memory tasks and static data only.
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::*,
    service::{RequestContext, SubscriptionContext},
    task_manager::{TaskManager, TaskOptions},
};
use serde_json::json;
use std::{
    borrow::Cow,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

const URI: &str = "skill://probe/SKILL.md";
const BODY: &str = "---\nname: probe\ndescription: Local SDK probe\n---\n\n# Probe\n";
#[derive(Clone, Default)]
struct Probe {
    tasks: TaskManager,
    created: Arc<AtomicUsize>,
}
fn skill() -> Skill {
    Skill::new(
        URI,
        SkillFrontmatter::new("probe", "Local SDK probe"),
        SkillResources::Files(vec![SkillResource::from_bytes(URI, BODY.as_bytes())]),
    )
}
impl ServerHandler for Probe {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .enable_resources()
                .enable_tasks()
                .enable_skills()
                .build(),
        )
        .with_server_info(Implementation::new("herder-v002-probe", "0.1.0"))
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name == "probe_count" {
            return Ok(CallToolResult::structured(
                json!({"created": self.created.load(Ordering::SeqCst)}),
            )
            .into());
        }
        if request.name != "probe_task" {
            return Err(ErrorData::invalid_params("unknown tool", None));
        }
        if !self.get_info().capabilities.supports_tasks() {
            return Err(ErrorData::invalid_params("server tasks disabled", None));
        }
        if !context
            .client_capabilities()
            .is_some_and(|c| c.supports_tasks())
        {
            return Err(ErrorData::missing_required_client_capability(
                ClientCapabilities::builder().enable_tasks().build(),
            ));
        }
        self.created.fetch_add(1, Ordering::SeqCst);
        let task = self.tasks.spawn(TaskOptions::default(), |ctx| Box::pin(async move {
            let input = serde_json::from_value(json!({"method":"elicitation/create","params":{"message":"probe input","requestedSchema":{"type":"object","properties":{}}}})).map_err(|e| ErrorData::internal_error(format!("{e}"), None))?;
            let response = ctx.request_input("probe-input", input).await?;
            Ok(CallToolResult::structured(json!({"response": response})))
        }));
        Ok(CallToolResponse::Task(CreateTaskResult::new(task)))
    }
    async fn get_task(
        &self,
        p: GetTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, ErrorData> {
        Ok(GetTaskResult::new(self.tasks.get_task(&p.task_id)?))
    }
    async fn update_task(
        &self,
        p: UpdateTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        self.tasks.update_task(&p.task_id, p.input_responses)
    }
    async fn cancel_task(
        &self,
        p: CancelTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        self.tasks.cancel_task(&p.task_id)
    }
    async fn list_skills(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListSkillsResult, ErrorData> {
        Ok(ListSkillsResult::with_all_items(vec![skill()]))
    }
    async fn get_skill(
        &self,
        p: GetSkillRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<GetSkillResult, ErrorData> {
        if p.uri != URI {
            return Err(ErrorData::invalid_params("unknown skill", None));
        }
        Ok(GetSkillResult::new(skill()))
    }
    async fn read_resource(
        &self,
        p: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if p.uri != URI {
            return Err(ErrorData::resource_not_found("unknown resource", None));
        }
        Ok(ReadResourceResult::new(vec![ResourceContents::text(BODY, URI)]).into())
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(requested.clone())
    }
    async fn listen(&self, ctx: SubscriptionContext) -> Result<(), ErrorData> {
        ctx.sink()
            .notify_tool_list_changed()
            .await
            .map_err(|e| ErrorData::internal_error(format!("{e}"), None))?;
        Ok(())
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    Probe::default()
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
