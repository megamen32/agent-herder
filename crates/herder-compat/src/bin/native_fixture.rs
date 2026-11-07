//! Isolated native MCP fixture for exercising the removable legacy edge with
//! an unchanged consumer. This process has deterministic in-memory state and
//! must never be used as a production server.
use std::{borrow::Cow, collections::{BTreeMap, HashMap}, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};

use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, CancelTaskParams,
        CreateTaskResult, DetailedTask, GetSkillRequestParams, GetSkillResult,
        GetTaskParams, GetTaskResult, Implementation, ListResourcesResult,
        ListSkillsResult, ListToolsResult, PaginatedRequestParams,
        ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse,
        ServerCapabilities, ServerConfig, Skill, SkillFrontmatter, SkillResource,
        SkillResources, Task, TaskPayload, TaskStatus, Tool, UpdateTaskParams,
    },
    service::RequestContext,
};
use serde_json::json;

const SKILL_URI: &str = "file:///fixture/skills/compat-probe/SKILL.md";
const SKILL_TEXT: &str = "---\nname: compat-probe\ndescription: Isolated compatibility fixture skill\n---\n\nFixture skill content is readable.\n";

#[derive(Clone, Default)]
struct Fixture {
    count: Arc<AtomicUsize>,
    tasks: Arc<Mutex<HashMap<String, DetailedTask>>>,
}

fn skill() -> Skill {
    Skill::new(
        SKILL_URI,
        SkillFrontmatter::new("compat-probe", "Isolated compatibility fixture skill"),
        SkillResources::Files(vec![SkillResource::from_bytes(SKILL_URI, SKILL_TEXT.as_bytes())]),
    )
}

fn fixture_tool(name: &'static str) -> Tool {
    let schema = match name {
        "probe_task" => json!({"type":"object","properties":{},"additionalProperties":false}),
        _ => json!({"type":"object","properties":{},"additionalProperties":false}),
    };
    Tool::new(name, format!("Deterministic isolated compatibility fixture: {name}."), schema.as_object().unwrap().clone())
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_tasks()
                .enable_skills()
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
        .with_server_info(Implementation::new("isolated-compat-native-fixture", "0.1.0"))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        match name {
            "probe_task" => Some(fixture_tool("probe_task")),
            "probe_count" => Some(fixture_tool("probe_count")),
            _ => None,
        }
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("fixture has no tool pages", None));
        }
        let mut result = ListToolsResult::default();
        result.tools = vec![fixture_tool("probe_task"), fixture_tool("probe_count")];
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        match request.name.as_ref() {
            "probe_task" => {
                let ordinal = self.count.fetch_add(1, Ordering::SeqCst) + 1;
                let task_id = format!("fixture-task-{ordinal}");
                let seed = Task::new(
                    task_id.clone(),
                    TaskStatus::Working,
                    "2026-11-07T00:00:00Z",
                    "2026-11-07T00:00:00Z",
                )
                .with_ttl_ms(60_000)
                .with_poll_interval_ms(1);
                let payload = if ordinal == 1 {
                    let input: rmcp::model::InputRequest = serde_json::from_value(json!({
                        "method":"elicitation/create",
                        "params":{"message":"Provide an empty fixture response", "requestedSchema":{"type":"object","properties":{}}}
                    })).map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
                    TaskPayload::InputRequired {
                        input_requests: BTreeMap::from([("fixture-input".to_owned(), input)]),
                    }
                } else {
                    TaskPayload::Working
                };
                let mut tasks = self.tasks.lock().map_err(|_| ErrorData::internal_error("fixture task lock poisoned", None))?;
                tasks.insert(task_id, DetailedTask::new(seed.clone(), payload));
                Ok(CallToolResponse::Task(CreateTaskResult::new(seed)))
            }
            "probe_count" => Ok(CallToolResult::structured(json!({"count":self.count.load(Ordering::SeqCst)})).into()),
            _ => Err(ErrorData::invalid_params("unknown fixture tool", None)),
        }
    }

    async fn get_task(
        &self,
        request: GetTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, ErrorData> {
        let tasks = self.tasks.lock().map_err(|_| ErrorData::internal_error("fixture task lock poisoned", None))?;
        tasks.get(&request.task_id).cloned().map(GetTaskResult::new)
            .ok_or_else(|| ErrorData::invalid_params("unknown fixture task", None))
    }

    async fn update_task(
        &self,
        request: UpdateTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        let mut tasks = self.tasks.lock().map_err(|_| ErrorData::internal_error("fixture task lock poisoned", None))?;
        let task = tasks.get_mut(&request.task_id).ok_or_else(|| ErrorData::invalid_params("unknown fixture task", None))?;
        if request.input_responses.contains_key("fixture-input") {
            let result = json!({"content":[{"type":"text","text":"fixture task completed"}]});
            let object = result.as_object().cloned().ok_or_else(|| ErrorData::internal_error("fixture completion is not an object", None))?;
            task.task.last_updated_at = "2026-11-07T00:00:01Z".to_owned();
            *task = DetailedTask::new(task.task.clone(), TaskPayload::Completed { result: object });
        }
        Ok(())
    }

    async fn cancel_task(
        &self,
        request: CancelTaskParams,
        _: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        let mut tasks = self.tasks.lock().map_err(|_| ErrorData::internal_error("fixture task lock poisoned", None))?;
        let task = tasks.get_mut(&request.task_id).ok_or_else(|| ErrorData::invalid_params("unknown fixture task", None))?;
        task.task.last_updated_at = "2026-11-07T00:00:02Z".to_owned();
        *task = DetailedTask::new(task.task.clone(), TaskPayload::Cancelled);
        Ok(())
    }

    async fn list_skills(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListSkillsResult, ErrorData> {
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("fixture has no skill pages", None));
        }
        serde_json::from_value(json!({"skills":[skill()],"ttlMs":60000,"cacheScope":"private"}))
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))
    }

    async fn get_skill(
        &self,
        request: GetSkillRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<GetSkillResult, ErrorData> {
        if request.uri != SKILL_URI {
            return Err(ErrorData::invalid_params("unknown fixture skill", None));
        }
        Ok(GetSkillResult::new(skill()).with_ttl_ms(60_000))
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("fixture has no resource pages", None));
        }
        serde_json::from_value(json!({"resources":[{"uri":SKILL_URI,"name":"compat-probe skill","description":"Fixture content","mimeType":"text/markdown"}]}))
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if request.uri != SKILL_URI {
            return Err(ErrorData::invalid_params("unknown fixture resource", None));
        }
        let result = serde_json::from_value(json!({
            "contents":[{"uri":SKILL_URI,"mimeType":"text/markdown","text":SKILL_TEXT}],
            "ttlMs":60000,"cacheScope":"private"
        })).map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(ReadResourceResponse::Complete(result))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    Fixture::default().serve(rmcp::transport::stdio()).await?.waiting().await?;
    Ok(())
}
