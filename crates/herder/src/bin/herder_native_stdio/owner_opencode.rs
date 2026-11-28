//! Trusted owner composition for one pinned AHAP subprocess.
use super::{
    owner_launch::Ids,
    owner_policy::OwnerPolicy,
    scoped_profile::{OpenedOwner, OwnerProfile},
};
use herder::{
    adapters::{
        ahap::{AhapClient, AhapConfig, AhapError},
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
        session_recovery::{RecoveryDiscovery, SessionRecovery},
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

    fn read_attachment(
        &mut self,
        address: &SessionAddress,
        message: &str,
        file: &str,
    ) -> Result<herder::domain::attachment::InlineAttachment, ()> {
        self.0.attachment(address, message, file).map_err(|_| ())
    }
}

fn canonical_host_id(value: &str) -> &str {
    match value {
        "104.bezrabotnyi.com" | "remote-ssh-discovered:104.bezrabotnyi.com" => {
            "roomhacker-server-100"
        }
        "44.bezrabotnyi.com" | "remote-ssh-discovered:44.bezrabotnyi.com" => "server-44",
        other => other,
    }
}

/// Resolve an ordinary envelope at the receiving owner before invoking its scoped writer.
/// The authenticated connection supplies the grants. The sender is receipt attribution.
pub(super) async fn deliver_to_owner(
    identity: &ConnectionIdentity,
    operation: catalog::Deliver,
    policy: &OwnerPolicy,
    mode: SendMode,
    resolver: &WaitAutomationApplication,
    writer: &dyn ApplicationPort,
) -> Option<rmcp::model::CallToolResult> {
    use rmcp::model::CallToolResult;
    use serde_json::json;

    let catalog::Deliver::Envelope { target, sender, input_id, message, attachments } = operation else {
        return writer.call(identity, catalog::Request::Deliver(operation)).await;
    };
    if canonical_host_id(&target.host_id) != canonical_host_id(&policy.instance.node.0)
        || target.harness != policy.harness
    {
        return Some(CallToolResult::structured_error(json!({
            "code":"owner_profile_mismatch","effect":"none",
            "message":"delivery envelope target does not match the configured owner"
        })));
    }
    let resolve = catalog::Session::Resolve {
        harness: target.harness,
        native_session_id: target.native_session_id,
        node_ref: Some(policy.instance.node.0.clone()),
    };
    let unregistered = || CallToolResult::structured_error(json!({
        "code":"native_session_not_registered","effect":"none"
    }));
    let Some(resolved) = resolver.call(identity, catalog::Request::Session(resolve)).await else {
        return Some(unregistered());
    };
    if resolved.is_error == Some(true) {
        return Some(resolved);
    }
    let Some(mapping) = resolved.structured_content else { return Some(unregistered()) };
    if mapping["owner"]["instance_ref"].as_str() != Some(&policy.instance.instance_id) {
        return Some(CallToolResult::structured_error(json!({"code":"owner_profile_mismatch","effect":"none"})));
    }
    let Some(session_ref) = mapping["session_ref"].as_str() else { return Some(unregistered()) };
    let mode = match mode {
        SendMode::Queue => catalog::DeliveryMode::Queue,
        SendMode::Start => catalog::DeliveryMode::Start,
        SendMode::Current => return Some(CallToolResult::structured_error(
            json!({"code":"unsupported_delivery_mode","effect":"none"}),
        )),
    };
    let session = catalog::Deliver::Session {
        session_ref: session_ref.to_owned(), message, attachments, mode,
        request_key: input_id, sender: Some(sender),
    };
    writer.call(identity, catalog::Request::Deliver(session)).await
}

struct App {
    authority: Arc<ScopedAuthority>,
    instance: InstanceRef,
    harness: String,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    adapter: Arc<AhapOpenCode>,
    delivery_mode: SendMode,
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
            if let Some(result) = self.policy.discover_instance(identity, &request, Some(self.adapter.capabilities())) {
                return Some(result);
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
                self.adapter.as_ref(),
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
            if let catalog::Request::Deliver(operation) = request {
                return deliver_to_owner(identity, operation, &self.policy, self.delivery_mode,
                    &self.waits, self.deliver.as_ref()).await;
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
                                let process_rows: Vec<_> = add.iter()
                                    .filter(|row| row.get("kind").and_then(serde_json::Value::as_str) == Some("process_completion"))
                                    .cloned().collect();
                                let process_complete = extra.get("complete") == Some(&serde_json::Value::Bool(true))
                                    && process_rows.len() == add.len();
                                base["process_gauges"] = serde_json::json!(
                                    herder::application::process_diagnostics::list_gauges(&process_rows, process_complete));
                                base["complete"] = serde_json::json!(
                                    base.get("complete") == Some(&serde_json::Value::Bool(true)) && process_complete);
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
                    | catalog::Session::Attachment { session_ref, .. }
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
                    Ok(a) if self.adapter.supports_browser_interrupt() => {
                        ScopedStopApplication::new_with_browser_interrupt(
                            a, self.instance.clone(), grants, self.adapter.clone(),
                        )
                        .call(identity, request)
                        .await
                    }
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
    pub adapter_available: bool,
    pub autopilot: Option<Arc<herder::application::scoped_stop::session_autopilot::SessionAutopilot>>,
    pub harness: String,
    pub session_recovery: Option<Arc<dyn AutomationTick>>,
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
    let harness = owner.kind.clone();
    let args = match &owner.ahap_script {
        Some(script) => vec![script.to_string_lossy().into_owned()],
        None if owner.has_ahap_runner() => vec![
            "--harness".into(), harness.clone(),
            "--node".into(), instance.node.0.clone(),
            "--instance".into(), instance.instance_id.clone(),
        ],
        None => return Err("missing trusted AHAP runner".into()),
    };
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
        args,
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
    // The MCP controller gives Close -> Start ten seconds in total. Reserve
    // three seconds for core/compat startup after bounded owner handshakes.
    let client = AhapClient::open_bounded_startup(
        config,
        matches!(harness.as_str(), "chatgpt" | "zai"),
        Duration::from_secs(7),
    ).map_err(|error| -> Box<dyn std::error::Error> {
        if matches!(&error, AhapError::Initialization { cause, .. }
            if matches!(cause.as_ref(), AhapError::OutcomeUnknown | AhapError::BeforeSend | AhapError::Unavailable))
        {
            return Box::new(super::owner_unavailable::AdapterStartupUnavailable);
        }
        format!("AHAP {harness} startup failed: {error:?}. Verify the configured runner, native app-server arguments and provider configuration in owner.code_home/ahap_env; browser init requires the exact pinned account verifier. No create/send request was submitted by the core.").into()
    })?;
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
    let (adapter, delivery_mode) = match open_adapter(&opened.owner, &instance) {
        Ok(adapter) => adapter,
        Err(error) if error.is::<super::owner_unavailable::AdapterStartupUnavailable>() => {
            return super::owner_unavailable::build(opened, registry);
        }
        Err(error) => return Err(error),
    };
    let recovery = opened.owner.browser_recovery;
    if recovery.is_some() && !adapter.guarded_recovery_supported() {
        return Err("browser recovery requires the guarded native send capability".into());
    }
    let handoff = recovery
        .as_ref()
        .and_then(|profile| profile.legacy_handoff.clone());
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
    // The exposed delivery application remains a user prompt. Only background
    // process/wait/child completions use the adapter's typed automatic seam.
    let mut automatic_deliver = ScopedDeliverApplication::new(
        authority.clone(),
        instance.clone(),
        grants.clone(),
        adapter.clone(),
        Arc::new(adapter.for_automatic_continuation()),
        "9999-12-31T23:59:59Z".into(),
    )
    .map_err(|_| "invalid automatic delivery policy")?
    .with_delivery_mode(delivery_mode)
    .map_err(|_| "unsupported automatic delivery mode")?
    .with_policy(policy.clone())
    .with_automatic_continuation(automatic_continuation);
    if let Some(config) = &config {
        automatic_deliver = automatic_deliver.with_delivery_keys(Arc::new(
            herder::application::delivery_keys::DeliveryKeyRegistry::new(config.resources.clone())?,
        ));
    }
    let automatic_deliver = Arc::new(automatic_deliver);
    let automation = Arc::new(
        ScopedAutomationApplication::new(
            authority.clone(),
            instance.clone(),
            grants.clone(),
            policy.clone(),
            adapter.clone(),
            automatic_deliver.clone(),
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
                    automatic_deliver.clone(),
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
            automatic_deliver.clone(),
            match delivery_mode {
                SendMode::Queue => catalog::DeliveryMode::Queue,
                _ => catalog::DeliveryMode::Start,
            },
            reconciler.clone(),
            policy.clone(),
        )
        .with_automatic_continuation(automatic_continuation)
        .with_recovery_handoff(handoff, adapter.clone()),
    );
    let session_recovery = recovery.map(|profile| {
        Arc::new(SessionRecovery::new(
            authority.clone(),
            adapter.clone(),
            policy.clone(),
            waits.clone(),
            reconciler.clone(),
            profile,
            RecoveryDiscovery::new(adapter.clone(), grants.clone()),
        )) as Arc<dyn AutomationTick>
    });
    let app = Arc::new(App {
        authority: authority.clone(),
        instance: instance.clone(),
        harness: harness.clone(),
        grants: grants.clone(),
        policy: policy.clone(),
        adapter: adapter.clone(),
        delivery_mode,
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
        adapter_available: true,
        autopilot: None,
        session_recovery,
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
        if !self.adapter_available {
            return AutomationOwner::new(self.identity.clone(), vec![]);
        }
        let mut modules: Vec<Arc<dyn AutomationTick>> = Vec::new();
        if let Some(process) = &self.process {
            modules.push(process.clone());
        }
        modules.push(self.waits.clone());
        if let Some(recovery) = &self.session_recovery {
            modules.push(recovery.clone());
        }
        if let Some(autopilot) = &self.autopilot {
            modules.push(autopilot.clone());
        }
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
