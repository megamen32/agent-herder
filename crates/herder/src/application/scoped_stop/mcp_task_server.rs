//! SEP-2663 bridge around the ordinary NativeServer; no independent task store.
use crate::{
    application::scoped_stop::ScopedAuthority,
    auth::identity::{ConnectionIdentity, Grant},
    mcp::transport::{ApplicationPort, NativeServer},
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, CreateTaskResult, GetTaskParams,
        GetTaskResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion,
        ServerCapabilities, ServerConfig, TaskPayload, Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};
use std::{borrow::Cow, sync::Arc};

pub struct ScopedTaskServer {
    inner: NativeServer,
    identity: ConnectionIdentity,
    grants: Vec<Grant>,
    authority: Arc<ScopedAuthority>,
    create_policy: Option<Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>>,
    reconciler: Option<Arc<dyn super::task_reconcile::TaskReconciler>>,
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
            reconciler: None,
        }
    }
    /// Read-only routing lookup. A multi-instance ingress must select exactly
    /// one owner before invoking reconciliation; this method performs no native I/O.
    pub fn has_task(&self, id: &str) -> Result<bool, ()> {
        match self.authority.current_task_read_grants(
            &self.identity, &self.grants, id, self.create_policy.as_deref(),
        ).map_err(|_| ())? {
            Some(grants) => self.authority.get_delivery_task(&self.identity, &grants, id)
                .map(|task| task.is_some()).map_err(|_| ()),
            None => self.authority.get_create_task_with_policy(
                &self.identity, &self.grants, id, self.create_policy.as_deref(),
            ).map(|task| task.is_some()).map_err(|_| ()),
        }
    }

    pub fn with_reconciler(
        mut self,
        reconciler: Arc<dyn super::task_reconcile::TaskReconciler>,
    ) -> Self {
        self.reconciler = Some(reconciler);
        self
    }
    pub fn with_create_policy(
        mut self,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    ) -> Self {
        self.create_policy = Some(policy);
        self
    }

    fn task_id(content: &Value) -> Option<(&str, bool)> {
        if let Some(id) = content
            .get("_herder_delivery_task")
            .and_then(Value::as_str)
        {
            Some((id, false))
        } else {
            content
                .get("_herder_create_task")
                .and_then(Value::as_str)
                .map(|id| (id, true))
        }
    }

    fn task_result(
        &self,
        id: &str,
        is_create: bool,
    ) -> Result<Option<GetTaskResult>, ()> {
        let lookup = if is_create {
            self.authority.get_create_task_with_policy(
                &self.identity,
                &self.grants,
                id,
                self.create_policy.as_deref(),
            )
        } else {
            match self.authority.current_task_read_grants(
                &self.identity,
                &self.grants,
                id,
                self.create_policy.as_deref(),
            ) {
                Ok(Some(grants)) => self
                    .authority
                    .get_delivery_task(&self.identity, &grants, id),
                Ok(None) => Ok(None),
                Err(error) => Err(error),
            }
        };
        lookup.map_err(|_| ())
    }

    fn ordinary_result(task: Option<GetTaskResult>, task_id: &str) -> CallToolResponse {
        if let Some(task) = task {
            if let TaskPayload::Completed { result } = task.task.payload {
                if let Ok(result) = serde_json::from_value::<CallToolResult>(Value::Object(result))
                {
                    return result.into();
                }
            }
        }
        let mut diagnostic = serde_json::to_value(crate::error::Diagnostic::outcome_unknown(None))
            .expect("static diagnostic");
        diagnostic["task_ref"] = json!(task_id);
        diagnostic["message"] = json!(
            "durable mutation was admitted but its native receipt is not yet confirmed; inspect the stored task before retrying"
        );
        CallToolResult::structured_error(diagnostic).into()
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
        let task_capable = ctx
            .client_capabilities()
            .is_some_and(|capabilities| capabilities.supports_tasks());
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
        let Some((id, is_create)) = Self::task_id(content) else {
            return Ok(response);
        };
        if task_capable {
            let task = match self.task_result(id, is_create) {
                Ok(Some(task)) => task,
                _ => {
                    let mut diagnostic = serde_json::to_value(
                        crate::error::Diagnostic::outcome_unknown(None),
                    )
                    .expect("static diagnostic");
                    diagnostic["task_ref"] = json!(id);
                    return Ok(rmcp::model::CallToolResult::structured_error(diagnostic).into());
                }
            };
            return Ok(CreateTaskResult::new(task.task.task).into());
        }

        // Ordinary MCP clients do not poll `tasks/get`. Reconcile the same
        // durable task before returning, then project its completed tool
        // result into the normal `tools/call` envelope. The reconciler only
        // reads native evidence and never submits a second mutation.
        if let Some(reconciler) = &self.reconciler {
            let reconciler = reconciler.clone();
            let identity = self.identity.clone();
            let grants = self.grants.clone();
            let task_id = id.to_owned();
            let policy = self.create_policy.clone();
            let _ = tokio::task::spawn_blocking(move || {
                reconciler.reconcile(identity, grants, task_id, policy)
            })
            .await;
        }
        Ok(Self::ordinary_result(
            self.task_result(id, is_create).ok().flatten(),
            id,
        ))
    }
    async fn get_task(
        &self,
        request: GetTaskParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, ErrorData> {
        if let Some(reconciler) = &self.reconciler {
            let reconciler = reconciler.clone();
            let identity = self.identity.clone();
            let grants = self.grants.clone();
            let task_id = request.task_id.clone();
            let policy = self.create_policy.clone();
            let _ = tokio::task::spawn_blocking(move || {
                reconciler.reconcile(identity, grants, task_id, policy)
            })
            .await;
        }
        match self.authority.current_task_read_grants(
            &self.identity,
            &self.grants,
            &request.task_id,
            self.create_policy.as_deref(),
        ) {
            Ok(Some(grants)) => self
                .authority
                .get_delivery_task(&self.identity, &grants, &request.task_id)
                .map_err(|_| ErrorData::invalid_params("task unavailable", None))?
                .ok_or_else(|| ErrorData::invalid_params("task unavailable", None)),
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
