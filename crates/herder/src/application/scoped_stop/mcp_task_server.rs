//! SEP-2663 bridge around the ordinary NativeServer; no independent task store.
use crate::{
    application::scoped_stop::ScopedAuthority,
    auth::identity::{ConnectionIdentity, Grant},
    mcp::transport::{ApplicationPort, NativeServer},
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CreateTaskResult, GetTaskParams, GetTaskResult,
        ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
        Tool,
    },
    service::RequestContext,
};
use std::{borrow::Cow, sync::Arc};

pub struct ScopedTaskServer {
    inner: NativeServer,
    identity: ConnectionIdentity,
    grants: Vec<Grant>,
    authority: Arc<ScopedAuthority>,
    create_policy: Option<Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>>,
}
impl ScopedTaskServer {
    /// Identity and grants are issued by the same trusted ingress as the inner
    /// NativeServer; request metadata is never used to establish either.
    pub fn new(
        identity: ConnectionIdentity,
        grants: Vec<Grant>,
        authority: Arc<ScopedAuthority>,
        application: Arc<dyn ApplicationPort>,
    ) -> Self {
        Self {
            inner: NativeServer::with_connection_identity(identity.clone(), application),
            identity,
            grants,
            authority,
            create_policy: None,
        }
    }
    pub fn with_create_policy(
        mut self,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    ) -> Self {
        self.create_policy = Some(policy);
        self
    }
}
impl ServerHandler for ScopedTaskServer {
    fn get_info(&self) -> ServerConfig {
        let mut info = self.inner.get_info();
        info.capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_tasks()
            .build();
        info
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        self.inner.supported_protocol_versions()
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.inner.get_tool(name)
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.inner.list_tools(request, ctx).await
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let task_eligible = matches!(request.name.as_ref(), "create" | "deliver");
        if task_eligible
            && !ctx
                .client_capabilities()
                .is_some_and(|c| c.supports_tasks())
        {
            return Err(ErrorData::invalid_params(
                "tasks capability required before mutation",
                None,
            ));
        }
        let response = self.inner.call_tool(request, ctx).await?;
        let CallToolResponse::Complete(result) = &response else {
            return Ok(response);
        };
        if !task_eligible || result.is_error == Some(true) {
            return Ok(response);
        }
        let Some(content) = result.structured_content.as_ref() else {
            return Ok(response);
        };
        let (id, is_create) = if let Some(id) = content
            .get("_herder_delivery_task")
            .and_then(|v| v.as_str())
        {
            (id, false)
        } else if let Some(id) = content.get("_herder_create_task").and_then(|v| v.as_str()) {
            (id, true)
        } else {
            return Ok(response);
        };
        let lookup = if is_create {
            self.authority.get_create_task_with_policy(
                &self.identity,
                &self.grants,
                id,
                self.create_policy.as_deref(),
            )
        } else {
            self.authority
                .get_delivery_task(&self.identity, &self.grants, id)
        };
        let task = match lookup {
            Ok(Some(task)) => task,
            _ => {
                return Ok(rmcp::model::CallToolResult::structured_error(
                    serde_json::to_value(crate::error::Diagnostic::outcome_unknown(None))
                        .expect("static diagnostic"),
                )
                .into());
            }
        };
        Ok(CreateTaskResult::new(task.task.task).into())
    }
    async fn get_task(
        &self,
        request: GetTaskParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, ErrorData> {
        match self
            .authority
            .get_delivery_task(&self.identity, &self.grants, &request.task_id)
        {
            Ok(Some(task)) => Ok(task),
            Ok(None) => self
                .authority
                .get_create_task_with_policy(
                    &self.identity,
                    &self.grants,
                    &request.task_id,
                    self.create_policy.as_deref(),
                )
                .map_err(|_| ErrorData::invalid_params("task unavailable", None))?
                .ok_or_else(|| ErrorData::invalid_params("task unavailable", None)),
            Err(_) => Err(ErrorData::invalid_params("task unavailable", None)),
        }
    }
}
