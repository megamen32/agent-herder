//! Several existing AHAP instances behind one native MCP process.
//! Each binding retains its own trusted authority, account state and grants.
use super::{owner_opencode::{self, BoundOwner}, scoped_profile::OpenedOwner};
use herder::{application::scoped_stop::create_prompt::FreshSessionGrantPolicy,
    domain::address::SessionRef};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse, CallToolResult, GetTaskParams,
        GetTaskResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerConfig},
    service::RequestContext};
use serde_json::{json, Value};
use std::{borrow::Cow, collections::HashSet, sync::Arc};

struct MultiOwner { bindings: Vec<BoundOwner> }
fn unavailable() -> ErrorData { ErrorData::invalid_params("unknown or ambiguous owner instance/session/task", None) }
fn denied(code: &str) -> CallToolResponse {
    CallToolResult::structured_error(json!({"code":code,"effect":"none"})).into()
}
impl MultiOwner {
    fn by_instance(&self, instance: &str) -> Result<&BoundOwner, ErrorData> {
        self.bindings.iter().find(|binding| binding.instance.instance_id == instance).ok_or_else(unavailable)
    }
    fn by_session(&self, session: &str) -> Result<&BoundOwner, ErrorData> {
        let mut found = None;
        for binding in &self.bindings {
            let policy = &binding.policy;
            if policy.session_read_grant(&policy.principal, &binding.instance, &SessionRef(session.into()))
                .map_err(|_| unavailable())?.is_some() {
                if found.is_some() { return Err(unavailable()); }
                found = Some(binding);
            }
        }
        found.ok_or_else(unavailable)
    }
}
impl ServerHandler for MultiOwner {
    fn get_info(&self) -> ServerConfig { self.bindings[0].server.get_info() }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        self.bindings[0].server.supported_protocol_versions()
    }
    async fn list_tools(&self, request: Option<PaginatedRequestParams>, ctx: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        self.bindings[0].server.list_tools(request, ctx).await
    }
    async fn call_tool(&self, request: CallToolRequestParams, ctx: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let args = request.arguments.as_ref();
        if request.name.as_ref()=="session" && args.and_then(|a|a.get("action")).and_then(Value::as_str)==Some("resolve"){
            // The shared registry resolves exact canonical metadata with fresh ACLs.
            return self.bindings[0].server.call_tool(request,ctx).await;
        }
        if let Some(instance) = args.and_then(|a| a.get("instance_ref")).and_then(Value::as_str) {
            let Ok(binding) = self.by_instance(instance) else { return Ok(denied("invalid_instance")); };
            return binding.server.call_tool(request, ctx).await;
        }
        if let Some(session) = args.and_then(|a| a.get("session_ref")).and_then(Value::as_str) {
            let Ok(binding) = self.by_session(session) else { return Ok(denied("session_unavailable")); };
            return binding.server.call_tool(request, ctx).await;
        }
        if request.name.as_ref()=="automation" && args.and_then(|a|a.get("action")).and_then(Value::as_str)==Some("wait_status"){
            let Some(arguments)=args else{return Ok(denied("invalid_request"))};
            let dispatched=herder::mcp::catalog::dispatch("automation",Value::Object(arguments.clone()));
            let Ok(herder::mcp::catalog::Dispatched{request:herder::mcp::catalog::Request::Automation(
                herder::mcp::catalog::Automation::WaitStatus{harness,node_ref,..}),..})=dispatched else{return Ok(denied("invalid_request"))};
            let mut mapped=Vec::new();let mut count=0usize;let mut observed=None;let mut blocking_unmapped=None;
            for binding in &self.bindings{
                if binding.harness!=harness || node_ref.as_ref().is_some_and(|n|n!=&binding.instance.node.0){continue}
                count+=1;
                let result=binding.server.call_tool(request.clone(),ctx.clone()).await?;
                let CallToolResponse::Complete(result)=result else{return Ok(denied("process_wait_unavailable"))};
                if result.is_error==Some(true){return Ok(result.into())}
                let Some(value)=result.structured_content else{return Ok(denied("process_wait_unavailable"))};
                if value.get("version")!=Some(&json!(1)) || value.get("configured")!=Some(&Value::Bool(true))
                    || value.get("complete")!=Some(&Value::Bool(true))
                    || value.get("blocked").and_then(Value::as_bool).is_none()
                    || value.get("mapped").and_then(Value::as_bool).is_none()
                    || value.get("observedAt").and_then(Value::as_str).is_none()
                    {return Ok(denied("process_wait_unavailable"))}
                observed=value.get("observedAt").cloned();
                if value.get("mapped")==Some(&Value::Bool(true)){mapped.push(value)}
                else if value.get("blocked")==Some(&Value::Bool(true)){blocking_unmapped=Some(value)}
            }
            if count==0{return Ok(denied("harness_authority_not_configured"))}
            let value=if mapped.len()>1{
                json!({"version":1,"configured":true,"complete":true,"blocked":true,"reason":"ambiguous_native_session",
                    "mapped":true,"sessionRefs":[],"ruleRefs":[],"observedAt":observed})
            }else if let Some(value)=blocking_unmapped{value}
            else if let Some(value)=mapped.pop(){value}else{
                json!({"version":1,"configured":true,"complete":true,"blocked":false,"reason":"native_session_not_registered",
                    "mapped":false,"sessionRefs":[],"ruleRefs":[],"observedAt":observed})
            };
            return Ok(CallToolResult::structured(value).into());
        }
        // Process rule refs are located in the exact owner authority. No
        // adapter request or native session probe is used for this routing.
        if request.name.as_ref()=="automation" {
            if let Some(rule_ref)=args.and_then(|a|a.get("rule_ref")).and_then(Value::as_str) {
                if rule_ref.starts_with("process-rule:") || rule_ref.starts_with("wait-rule:") {
                    let mut selected=None;
                    for binding in &self.bindings {
                        if rule_ref.starts_with("wait-rule:") && binding.waits.owns_rule(&binding.policy.principal.0,rule_ref).map_err(|_|unavailable())?{
                            if selected.is_some(){return Ok(denied("ambiguous_automation_rule"))}
                            selected=Some(binding);
                        }
                        if let Some(process)=&binding.process {
                            if process.owns_rule(&binding.policy.principal.0,rule_ref).map_err(|_|unavailable())? {
                                if selected.is_some(){return Ok(denied("ambiguous_process_rule"))}
                                selected=Some(binding);
                            }
                        }
                    }
                    let Some(binding)=selected else{return Ok(denied("rule_not_found"))};
                    return binding.server.call_tool(request,ctx).await;
                }
            }
        }
        if request.name.as_ref()=="resource" {
            if args.and_then(|a|a.get("action")).and_then(Value::as_str)==Some("bind") {
                let Some(execution)=args.and_then(|a|a.get("execution_ref")).and_then(Value::as_str) else{return Ok(denied("execution_ref_required"))};
                let Some(process)=&self.bindings[0].process else{return Ok(denied("process_runtime_not_configured"))};
                let Some(session)=process.execution_session(&self.bindings[0].policy.principal.0,execution)
                    .map_err(|_|unavailable())? else{return Ok(denied("execution_unavailable"))};
                let Ok(binding)=self.by_session(&session) else{return Ok(denied("session_unavailable"))};
                return binding.server.call_tool(request,ctx).await;
            }
            // All configured owners share one launcher-pinned resource authority
            // and one authenticated principal (validated by serve).
            return self.bindings[0].server.call_tool(request,ctx).await;
        }
        // A completion callback routes only through its exact registered child.
        // The selected authority verifies the rule's parent/child binding.
        if request.name.as_ref() == "automation"
            && args.and_then(|a| a.get("action")).and_then(Value::as_str) == Some("reconcile") {
            let Some(child) = args.and_then(|a| a.get("child_ref")).and_then(Value::as_str) else {
                return Ok(denied("child_binding_required"));
            };
            let Ok(binding) = self.by_session(child) else { return Ok(denied("session_unavailable")); };
            return binding.server.call_tool(request, ctx).await;
        }
        // Only these read operations may fan out. Mutations never probe adapters.
        let action = args.and_then(|a| a.get("action")).and_then(Value::as_str).unwrap_or("");
        if request.name.as_ref() == "session" && action == "context" {
            // A shared account can invoke this core from several conversations.
            // Neither the first configured profile nor a previous registration
            // is proof of the current caller's conversation.
            return Ok(CallToolResult::structured_error(json!({
                "code":"self_binding_required","effect":"none",
                "message":"The caller conversation is not bound to this connection.",
                "correction":"Register the exact native session and pass its session_ref to session.context."
            })).into());
        }
        let field = match (request.name.as_ref(), action) {
            ("discover", "nodes") => "nodes", ("discover", "instances") => "instances",
            ("discover", "projects") => "projects", ("sessions", "list") => "sessions",
            ("search", "search") => "hits", ("automation", "list") => "rules", _ => return Ok(denied("instance_or_session_required")),
        };
        let node = args.and_then(|a| a.get("node_ref")).and_then(Value::as_str);
        let mut rows = Vec::new();
        let mut sources = Vec::new();
        let mut complete = true;
        let mut total_hits = 0u64;
        let mut has_more = false;
        for binding in &self.bindings {
            if node.is_some_and(|node| node != binding.instance.node.0) { continue; }
            let result = binding.server.call_tool(request.clone(), ctx.clone()).await?;
            let CallToolResponse::Complete(result) = result else { return Err(unavailable()); };
            if result.is_error == Some(true) { return Ok(result.into()); }
            let Some(data) = result.structured_content else { return Err(unavailable()); };
            let Some(items) = data.get(field).and_then(Value::as_array) else { return Err(unavailable()); };
            for item in items { if !rows.contains(item) { rows.push(item.clone()); } }
            complete &= data.get("complete") == Some(&Value::Bool(true));
            total_hits += data.get("total_hits").and_then(Value::as_u64).unwrap_or(0);
            has_more |= data.get("has_more") == Some(&Value::Bool(true));
            sources.push(json!({"instance_ref":binding.instance.instance_id,"result":data}));
        }
        let mut value = json!({"complete":complete,"next_cursor":null,"scope":"configured_owner_instances", "sources":sources});
        value[field] = json!(rows);
        if field == "hits" {
            value["total_hits"] = json!(total_hits); value["has_more"] = json!(has_more);
            value["coverage"] = json!(if complete {"complete"} else {"partial"});
        }
        Ok(CallToolResult::structured(value).into())
    }
    async fn get_task(&self, request: GetTaskParams, ctx: RequestContext<RoleServer>) -> Result<GetTaskResult, ErrorData> {
        let mut owner = None;
        for binding in &self.bindings {
            if binding.server.has_task(&request.task_id).map_err(|_| unavailable())? {
                if owner.is_some() { return Err(unavailable()); }
                owner = Some(binding);
            }
        }
        owner.ok_or_else(unavailable)?.server.get_task(request, ctx).await
    }
}
pub async fn serve(profiles: Vec<OpenedOwner>) -> Result<(), Box<dyn std::error::Error>> {
    let principal = &profiles.first().ok_or("owner profiles required")?.owner.principal;
    let mut instances = HashSet::new();
    // Validate the complete set before starting any adapter.
    for profile in &profiles {
        if &profile.owner.principal != principal || profile.owner.ahap_script.is_none()
            || !instances.insert(profile.owner.instance.clone()) {
            return Err("multi-owner requires one principal and distinct AHAP instance refs".into());
        }
    }
    let registry=Arc::new(herder::application::scoped_stop::wait_automation::DependencyRegistry::new());
    let bindings = profiles.into_iter().map(|profile|owner_opencode::build_with_registry(profile,registry.clone())).collect::<Result<Vec<_>, _>>()?;
    registry.configure(bindings.iter().map(|b|b.source.clone()).collect())?;
    herder::application::scoped_stop::automation_driver::start(bindings.iter().map(BoundOwner::driver_owner).collect())?;
    MultiOwner { bindings }.serve(rmcp::transport::stdio()).await?.waiting().await?;
    Ok(())
}
