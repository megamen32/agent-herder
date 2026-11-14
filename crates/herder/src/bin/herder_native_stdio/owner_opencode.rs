//! Trusted owner composition for one pinned legacy adapter AHAP subprocess.
use super::{
    owner_launch::Ids,
    owner_policy::OwnerPolicy,
    scoped_profile::{OpenedOwner, OwnerProfile},
};
use herder::{
    adapters::{
        ahap::{AhapClient, AhapConfig},
        ahap_opencode::{AhapOpenCode, AhapPortPolicy},
    },
    application::scoped_stop::{
        ScopedAuthority,
        automation::ScopedAutomationApplication,
        automation_driver::{self, AutomationOwner, AutomationTick},
        create_prompt::FreshSessionGrantPolicy,
        mcp_create::ScopedCreateApplication,
        mcp_deliver::ScopedDeliverApplication,
        mcp_read::{ScopedMessageReader, ScopedReadApplication},
        mcp_stop::ScopedStopApplication,
        mcp_task_server::ScopedTaskServer,
        process_automation::ProcessAutomationApplication,
        task_reconcile::ScopedReceiptReconciler,
        wait_automation::{DependencyRegistry, DependencySource, WaitAutomationApplication},
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::{
        adapter::SendMode,
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::ServiceExt;
use std::{sync::Arc, time::Duration};
struct Messages(Arc<AhapOpenCode>);
impl ScopedMessageReader for Messages {
    fn read_messages(&mut self, address: &SessionAddress) -> Result<serde_json::Value, ()> {
        let messages = self.0.messages(address, 200).map_err(|_| ())?;
        // This legacy API is a bounded tail and has no completeness cursor.
        Ok(serde_json::json!({"messages":messages,"next_cursor":null,"complete":false}))
    }
}
struct App {
    authority: Arc<ScopedAuthority>,
    instance: InstanceRef,
    harness: String,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    adapter: Arc<AhapOpenCode>,
    create: Arc<dyn ApplicationPort>,
    deliver: Arc<dyn ApplicationPort>,
    automation: Arc<dyn ApplicationPort>,
    waits: Arc<WaitAutomationApplication>,
    process: Option<Arc<ProcessAutomationApplication>>,
    resources: Option<Arc<dyn ApplicationPort>>,
}
impl ApplicationPort for App {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if matches!(
                &request,
                catalog::Request::Discover(
                    catalog::Discover::Nodes {} | catalog::Discover::Instances { .. }
                )
            ) {
                if !matches!(identity.caller(), Caller::Principal(p) if p.id == self.policy.principal)
                {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"unauthorized","effect":"none","message":"Use the configured owner identity to discover this instance."}),
                    ));
                }
                let value = match &request {
                    catalog::Request::Discover(catalog::Discover::Nodes {}) => serde_json::json!({
                        "nodes":[{"node_ref":self.instance.node.0}],"scope":"configured_owner_instance","complete":true}),
                    catalog::Request::Discover(catalog::Discover::Instances { node_ref }) => {
                        let rows = if node_ref.as_ref().is_none_or(|n| n == &self.instance.node.0) {
                            vec![
                                serde_json::json!({"instance_ref":self.instance.instance_id,"node_ref":self.instance.node.0,
                                "harness":self.harness,"capabilities":self.adapter.capabilities()}),
                            ]
                        } else {
                            vec![]
                        };
                        serde_json::json!({"instances":rows,"scope":"configured_owner_instance","complete":true})
                    }
                    _ => unreachable!(),
                };
                return Some(rmcp::model::CallToolResult::structured(value));
            }
            if let catalog::Request::Automation(catalog::Automation::WaitStatus {
                harness,
                native_session_id,
                node_ref,
            }) = &request
            {
                if !matches!(identity.caller(),Caller::Principal(p) if p.id==self.policy.principal)
                {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"unauthorized","effect":"none"}),
                    ));
                }
                if harness != &self.harness
                    || node_ref
                        .as_ref()
                        .is_some_and(|n| n != &self.instance.node.0)
                {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"owner_profile_mismatch","effect":"none"}),
                    ));
                }
                if native_session_id.is_empty() || native_session_id.len() > 4096 {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"invalid_native_session","effect":"none"}),
                    ));
                }
                let base = self.waits.call(identity, request.clone()).await?;
                if base.is_error == Some(true) {
                    return Some(base);
                }
                return match &self.process {
                    Some(process) => {
                        let extra = process.call(identity, request).await?;
                        Some(merge_wait_status(base, extra))
                    }
                    None => Some(base),
                };
            }
            if matches!(
                &request,
                catalog::Request::Session(catalog::Session::Resolve { .. })
            ) {
                return self.waits.call(identity, request).await;
            }
            if let Some(result) = super::owner_registration::call(
                identity,
                &request,
                &self.adapter,
                &self.policy,
                &self.instance,
                &self.authority,
                &self.grants,
            ) {
                return Some(result);
            }
            if let Some(result) = super::owner_reads::call(
                identity,
                &request,
                &self.adapter,
                &self.policy,
                &self.instance,
            )
            .await
            {
                return Some(result);
            }
            if matches!(&request, catalog::Request::Create(_)) {
                return self.create.call(identity, request).await;
            }
            if matches!(&request, catalog::Request::Deliver(_)) {
                return self.deliver.call(identity, request).await;
            }
            if matches!(
                &request,
                catalog::Request::Automation(catalog::Automation::List { .. })
            ) {
                let mut result = self.automation.call(identity, request.clone()).await?;
                if result.is_error != Some(true) {
                    if let Some(process) = &self.process {
                        let extra = process.call(identity, request.clone()).await?;
                        if extra.is_error == Some(true) {
                            return Some(extra);
                        }
                        if let (Some(base), Some(extra)) =
                            (&mut result.structured_content, extra.structured_content)
                        {
                            if let (Some(rows), Some(add)) = (
                                base.get_mut("rules")
                                    .and_then(serde_json::Value::as_array_mut),
                                extra.get("rules").and_then(serde_json::Value::as_array),
                            ) {
                                rows.extend(add.iter().cloned());
                            }
                        }
                    }
                    let extra = self.waits.call(identity, request).await?;
                    if extra.is_error == Some(true) {
                        return Some(extra);
                    }
                    if let (Some(base), Some(extra)) =
                        (&mut result.structured_content, extra.structured_content)
                    {
                        if let (Some(rows), Some(add)) = (
                            base.get_mut("rules")
                                .and_then(serde_json::Value::as_array_mut),
                            extra.get("rules").and_then(serde_json::Value::as_array),
                        ) {
                            rows.extend(add.iter().cloned());
                        }
                    }
                }
                if result.is_error != Some(true) {
                    if let Some(value) = result.structured_content.take() {
                        return Some(rmcp::model::CallToolResult::structured(value));
                    }
                }
                return Some(result);
            }
            if let Some(result) = self.waits.call(identity, request.clone()).await {
                return Some(result);
            }
            if let Some(process) = &self.process {
                if let Some(result) = process.call(identity, request.clone()).await {
                    return Some(result);
                }
            }
            if matches!(&request, catalog::Request::Resource(_)) {
                return match &self.resources {
                    Some(resources) => resources.call(identity, request).await,
                    None => Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"resource_runtime_not_configured","effect":"none"}),
                    )),
                };
            }
            if matches!(&request, catalog::Request::Automation(_)) {
                return self.automation.call(identity, request).await;
            }
            let session = match &request {
                catalog::Request::Session(
                    catalog::Session::Messages { session_ref, .. }
                    | catalog::Session::Archive { session_ref, .. },
                )
                | catalog::Request::Stop(catalog::Stop::Stop { session_ref, .. })
                | catalog::Request::Deliver(catalog::Deliver::Session { session_ref, .. }) => {
                    SessionRef(session_ref.clone())
                }
                _ => return None,
            };
            let Caller::Principal(principal) = identity.caller() else {
                return Some(rmcp::model::CallToolResult::structured_error(
                    serde_json::json!({"code":"unauthorized","effect":"none"}),
                ));
            };
            let mut grants = self.grants.clone();
            for action in [Action::Read, Action::Write] {
                let g = match action {
                    Action::Read => {
                        self.policy
                            .session_read_grant(&principal.id, &self.instance, &session)
                    }
                    _ => self
                        .policy
                        .session_write_grant(&principal.id, &self.instance, &session),
                };
                match g {
                    Ok(Some(v)) => grants.push(v),
                    Ok(None) => {}
                    Err(_) => {
                        return Some(rmcp::model::CallToolResult::structured_error(
                            serde_json::json!({"code":"policy_unavailable","effect":"none"}),
                        ));
                    }
                }
            }
            let authority = || {
                ScopedAuthority::new(
                    self.policy.db.clone(),
                    self.policy.gate.clone(),
                    self.policy.generation.clone(),
                )
            };
            match &request {
                catalog::Request::Session(catalog::Session::Archive {
                    session_ref,
                    request_key,
                }) => {
                    let supported = self
                        .adapter
                        .capabilities()
                        .get("methods")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|m| m.iter().any(|v| v.as_str() == Some("archiveSession")));
                    if !supported {
                        return Some(rmcp::model::CallToolResult::structured_error(
                            serde_json::json!({"code":"unsupported_archive","effect":"none"}),
                        ));
                    }
                    let result = authority().and_then(|a| {
                        a.archive_session(
                            identity,
                            &grants,
                            &SessionRef(session_ref.clone()),
                            &self.instance,
                            request_key,
                            |id| {
                                self.adapter
                                    .raw_call("archiveSession", serde_json::json!({"id":id}))
                                    .map_err(|_| ())
                            },
                        )
                    });
                    Some(match result {
                        Ok(value)
                            if value.get("archived") == Some(&serde_json::Value::Bool(true)) =>
                        {
                            rmcp::model::CallToolResult::structured(value)
                        }
                        Ok(value) => rmcp::model::CallToolResult::structured_error(value),
                        Err(_) => rmcp::model::CallToolResult::structured_error(
                            serde_json::json!({"code":"archive_unavailable","effect":"unknown"}),
                        ),
                    })
                }
                catalog::Request::Session(_) => match authority() {
                    Ok(a) => {
                        ScopedReadApplication::new(
                            a,
                            self.instance.clone(),
                            grants,
                            Messages(self.adapter.clone()),
                        )
                        .call(identity, request)
                        .await
                    }
                    Err(_) => None,
                },
                catalog::Request::Stop(_) => match authority() {
                    Ok(a) => {
                        ScopedStopApplication::new(a, self.instance.clone(), grants)
                            .call(identity, request)
                            .await
                    }
                    Err(_) => None,
                },
                _ => None,
            }
        })
    }
}
pub struct BoundOwner {
    pub harness: String,
    pub process: Option<Arc<ProcessAutomationApplication>>,
    pub waits: Arc<WaitAutomationApplication>,
    pub source: Arc<DependencySource>,
    pub identity: ConnectionIdentity,
    pub server: ScopedTaskServer,
    pub policy: Arc<OwnerPolicy>,
    pub instance: InstanceRef,
}

pub async fn serve(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    let binding = build(opened)?;
    automation_driver::start(vec![binding.driver_owner()])?;
    binding
        .server
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

pub(super) fn open_adapter(
    owner: &OwnerProfile,
    instance: &InstanceRef,
) -> Result<(Arc<AhapOpenCode>, SendMode), Box<dyn std::error::Error>> {
    let script = owner
        .ahap_script
        .clone()
        .ok_or("missing trusted AHAP script")?;
    let harness = owner.kind.clone();
    let mut env = vec![
        (
            "HOME".into(),
            owner.code_home.to_string_lossy().into_owned(),
        ),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    if let Some(endpoint) = owner.ahap_base_url.clone() {
        env.push(("AHAP_OPENCODE_BASE_URL".into(), endpoint));
    }
    env.extend(owner.ahap_env.clone());
    if harness == "opencode"
        && !env.iter().any(|(name, _)| name == "AHAP_OPENCODE_PASSWORD")
        && let Some(password) = std::env::var_os("AHAP_OPENCODE_PASSWORD")
    {
        env.push((
            "AHAP_OPENCODE_PASSWORD".into(),
            password
                .into_string()
                .map_err(|_| "invalid password encoding")?,
        ));
    }
    let config = AhapConfig {
        instance_id: instance.instance_id.clone(),
        harness: harness.clone(),
        executable: owner.executable.clone(),
        args: vec![script.to_string_lossy().into_owned()],
        cwd: owner.cwd.clone(),
        env,
        // Browser operations compose several existing 30-second transport calls
        // (inventory, pinned-page lookup, account verification). The outer
        // deadline must not kill a healthy inner call after only 20 seconds.
        // Expiry still poisons the runner and never retries a mutation.
        timeout: Duration::from_secs(if matches!(harness.as_str(), "chatgpt" | "zai") {
            120
        } else {
            20
        }),
    };
    let client = if matches!(harness.as_str(), "chatgpt" | "zai") {
        AhapClient::open_lazy_init(config)
    } else {
        AhapClient::open(config)
    }
    .map_err(|error| format!("AHAP {harness} startup failed: {error:?}. Verify the configured runner, native app-server arguments and provider configuration in owner.code_home/ahap_env; browser init requires the exact pinned account verifier. No create/send request was submitted by the core."))?;
    let delivery_mode = if harness == "opencode"
        && client
            .capabilities()
            .get("nativeProtocol")
            .and_then(serde_json::Value::as_str)
            != Some("v2")
    {
        SendMode::Start
    } else {
        SendMode::Queue
    };
    // Fresh v2 sessions need their first input admitted before a turn starts.
    // Continuations still use Queue. Older pinned runners retain their
    // declared compatibility route until the paired adapter update is installed.
    let initial_delivery_mode = if harness == "opencode"
        && client
            .capabilities()
            .get("nativeProtocol")
            .and_then(serde_json::Value::as_str)
            == Some("v2")
        && client
            .capabilities()
            .get("nativeStartAdmission")
            .and_then(serde_json::Value::as_str)
            == Some("steer-before-turn-v1")
    {
        SendMode::Start
    } else {
        delivery_mode
    };
    let adapter = Arc::new(
        AhapOpenCode::new_with_policy(
            Arc::new(client),
            instance.clone(),
            owner.cwd.clone(),
            "Herder".into(),
            AhapPortPolicy {
                harness: harness.clone(),
                initial_delivery_mode,
            },
        )
        .map_err(|_| "AHAP capabilities invalid")?,
    );
    Ok((adapter, delivery_mode))
}

pub fn build(opened: OpenedOwner) -> Result<BoundOwner, Box<dyn std::error::Error>> {
    let registry = Arc::new(DependencyRegistry::new());
    let binding = build_with_registry(opened, registry.clone())?;
    registry.configure(vec![binding.source.clone()])?;
    Ok(binding)
}
pub fn build_with_registry(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
) -> Result<BoundOwner, Box<dyn std::error::Error>> {
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let harness = opened.owner.kind.clone();
    let (adapter, delivery_mode) = open_adapter(&opened.owner, &instance)?;
    let automatic_continuation = adapter.automatic_continuation_supported();
    let principal = PrincipalId(opened.owner.principal);
    let identity = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: principal.clone(),
        }),
        None,
    );
    let grants = vec![Grant {
        principal: principal.clone(),
        resource: PrivateResource::Resource(format!(
            "instance:{}",
            serde_json::to_string(&instance)?
        )),
        action: Action::Write,
    }];
    let policy = Arc::new(OwnerPolicy {
        existing_sessions: opened.owner.existing_sessions,
        principal,
        instance: instance.clone(),
        harness: harness.clone(),
        generation: opened.generation,
        db: opened.database,
        gate: opened.gate,
    });
    let authority = Arc::new(opened.authority);
    let create = Arc::new(
        ScopedCreateApplication::new(
            authority.clone(),
            instance.instance_id.clone(),
            grants.clone(),
            adapter.clone(),
            Arc::new(Ids),
            Arc::new(Ids),
            adapter.clone(),
            adapter.clone(),
            policy.clone(),
            "9999-12-31T23:59:59Z".into(),
        )
        .map_err(|_| "invalid create policy")?,
    );
    let config = herder::application::process_bindings::ProcessRuntimeConfig::from_environment()?;
    let mut deliver = ScopedDeliverApplication::new(
        authority.clone(),
        instance.clone(),
        grants.clone(),
        adapter.clone(),
        adapter.clone(),
        "9999-12-31T23:59:59Z".into(),
    )
    .map_err(|_| "invalid delivery policy")?
    .with_delivery_mode(delivery_mode)
    .map_err(|_| "unsupported delivery mode")?
    .with_policy(policy.clone())
    .with_automatic_continuation(automatic_continuation);
    if let Some(config) = &config {
        deliver = deliver.with_delivery_keys(Arc::new(
            herder::application::delivery_keys::DeliveryKeyRegistry::new(config.resources.clone())?,
        ));
    }
    let deliver = Arc::new(deliver);
    let automation = Arc::new(
        ScopedAutomationApplication::new(
            authority.clone(),
            instance.clone(),
            grants.clone(),
            policy.clone(),
            adapter.clone(),
            deliver.clone(),
            match delivery_mode {
                SendMode::Queue => catalog::DeliveryMode::Queue,
                _ => catalog::DeliveryMode::Start,
            },
        )
        .with_automatic_continuation(automatic_continuation),
    );
    let reconciler = Arc::new(ScopedReceiptReconciler::new(
        authority.clone(),
        adapter.clone(),
    ));
    let resources = match &config {
        Some(config) => Some(Arc::new(
            herder::application::process_resources::ProcessResourceApplication::new(
                config.clone(),
            )?,
        ) as Arc<dyn ApplicationPort>),
        None => None,
    };
    let process = match config {
        Some(config) => {
            let process = Arc::new(
                ProcessAutomationApplication::new(
                    authority.clone(),
                    instance.clone(),
                    grants.clone(),
                    policy.clone(),
                    deliver.clone(),
                    match delivery_mode {
                        SendMode::Queue => catalog::DeliveryMode::Queue,
                        _ => catalog::DeliveryMode::Start,
                    },
                    reconciler.clone(),
                    config,
                )?
                .with_automatic_continuation(automatic_continuation),
            );
            Some(process)
        }
        None => None,
    };
    let source = Arc::new(DependencySource::new(
        authority.clone(),
        instance.clone(),
        harness.clone(),
        policy.principal.clone(),
        grants.clone(),
        policy.clone(),
        adapter.clone(),
    ));
    let waits = Arc::new(
        WaitAutomationApplication::new(
            source.clone(),
            registry,
            deliver.clone(),
            match delivery_mode {
                SendMode::Queue => catalog::DeliveryMode::Queue,
                _ => catalog::DeliveryMode::Start,
            },
            reconciler.clone(),
            policy.clone(),
        )
        .with_automatic_continuation(automatic_continuation),
    );
    let app = Arc::new(App {
        authority: authority.clone(),
        instance: instance.clone(),
        harness: harness.clone(),
        grants: grants.clone(),
        policy: policy.clone(),
        adapter: adapter.clone(),
        create,
        deliver,
        automation,
        waits: waits.clone(),
        process: process.clone(),
        resources,
    });
    let server = ScopedTaskServer::new(identity.clone(), grants, authority, app)
        .with_create_policy(policy.clone())
        .with_reconciler(reconciler);
    Ok(BoundOwner {
        server,
        policy,
        instance,
        process,
        harness,
        waits,
        source,
        identity,
    })
}

impl BoundOwner {
    pub fn driver_owner(&self) -> AutomationOwner {
        let mut modules: Vec<Arc<dyn AutomationTick>> = Vec::new();
        if let Some(process) = &self.process {
            modules.push(process.clone());
        }
        modules.push(self.waits.clone());
        AutomationOwner::new(self.identity.clone(), modules)
    }
}
fn merge_wait_status(
    mut base: rmcp::model::CallToolResult,
    extra: rmcp::model::CallToolResult,
) -> rmcp::model::CallToolResult {
    use serde_json::{Value, json};
    if extra.is_error == Some(true) {
        return extra;
    }
    let fail = || {
        rmcp::model::CallToolResult::structured_error(
            json!({"code":"canonical_wait_unavailable","effect":"none"}),
        )
    };
    let (Some(mut value), Some(extra)) = (base.structured_content.take(), extra.structured_content)
    else {
        return fail();
    };
    for data in [&value, &extra] {
        if data.get("complete") != Some(&json!(true))
            || data.get("configured") != Some(&json!(true))
            || data.get("blocked").and_then(Value::as_bool).is_none()
        {
            return fail();
        }
    }
    let blocked = value["blocked"] == true || extra["blocked"] == true;
    for field in ["sessionRefs", "ruleRefs"] {
        let Some(rows) = value.get_mut(field).and_then(Value::as_array_mut) else {
            return fail();
        };
        let Some(add) = extra.get(field).and_then(Value::as_array) else {
            return fail();
        };
        for item in add {
            if !rows.contains(item) {
                rows.push(item.clone());
            }
        }
    }
    value["mapped"] = json!(
        value["sessionRefs"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
    );
    value["blocked"] = json!(blocked);
    if value["reason"] == "human_stop_active" || extra["reason"] == "human_stop_active" {
        value["reason"] = json!("human_stop_active");
    } else {
        value["reason"] = json!(if blocked {
            "canonical_wait_active"
        } else {
            "no_canonical_wait"
        });
    }
    rmcp::model::CallToolResult::structured(value)
}
