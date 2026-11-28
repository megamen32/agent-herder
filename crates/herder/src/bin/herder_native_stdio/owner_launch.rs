//! Explicit single-principal local-owner composition. Never used by default.
use super::{native_reader::NativeReader, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    adapters::codex::{
        connection::CodexInstance, control::RequestReceiptLookup, create::CodexCreateControl,
        read::CodexReader,
    },
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, BoundedNativeInterrupt, InterruptAttempt,
            ScopeGenerationIssuer, ScopedAuthority,
            automation_driver,
            session_autopilot::SessionAutopilot,
            session_recovery::{
                RecoveryDiscovery, RecoveryListing, RecoveryPage, RecoveryRunner, SessionRecovery,
            },
            create_prompt::FreshSessionGrantPolicy,
            mcp_create::ScopedCreateApplication,
            mcp_deliver::ScopedDeliverApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_stop::ScopedStopApplication,
            mcp_task_server::ScopedTaskServer,
            registration::BoundedSessionProbe,
            wait_automation::{DependencyRegistry, DependencySource, WaitAutomationApplication},
        },
        target::{RegistryUnavailable, SessionRefIssuer},
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::{
        adapter::{
            Admission, DispatchPlan, NativeReceipt, NativeSessionReader, Observation, ReadError,
            RequestKey, SendMode, SessionSnapshot, SubmitError,
        },
        address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::ServiceExt;
use std::{
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(super) struct Ids;
fn random_id() -> Result<String, ()> {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|_| ())?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
impl SessionRefIssuer for Ids {
    fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
        random_id()
            .map(|v| SessionRef(format!("session:{v}")))
            .map_err(|_| RegistryUnavailable)
    }
}
impl ScopeGenerationIssuer for Ids {
    fn issue(&self) -> Result<String, ()> {
        random_id()
    }
}
struct Control {
    create: Arc<CodexCreateControl>,
    reader: Arc<Mutex<CodexReader>>,
}
impl BoundedFreshRootCreate for Control {
    fn instance(&self) -> &InstanceRef {
        self.create.native_control().instance()
    }
    fn create_root_bounded(&self, k: &str, s: &str) -> Result<SessionAddress, SubmitError> {
        self.create.create_root_bounded(k, s)
    }
}
impl BoundedNativeHandoff for Control {
    fn submit_bounded(
        &self,
        p: DispatchPlan,
        m: &str,
        k: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        self.create.native_control().submit_bounded(p, m, k)
    }
}
impl BoundedNativeInterrupt for Control {
    fn interrupt_exact(
        &self,
        target: &SessionAddress,
        native_turn_id: &str,
    ) -> InterruptAttempt {
        use herder::adapters::codex::control::InterruptOutcome;
        match self
            .create
            .native_control()
            .interrupt_exact(target, native_turn_id)
        {
            InterruptOutcome::Interrupted => InterruptAttempt::Interrupted,
            InterruptOutcome::DefinitelyNotSent { .. } => InterruptAttempt::DefinitelyNotSent,
            InterruptOutcome::OutcomeUnknown { .. } => InterruptAttempt::OutcomeUnknown,
        }
    }
}

impl BoundedSessionProbe for Control {
    fn instance(&self) -> &InstanceRef {
        self.create.native_control().instance()
    }

    fn harness(&self) -> &str {
        "codex"
    }

    fn probe_session(&self, native_session_id: &str) -> Result<SessionSnapshot, ()> {
        let target = SessionAddress {
            instance: BoundedSessionProbe::instance(self).clone(),
            native_session_id: native_session_id.to_owned(),
        };
        let thread = self.create.native_control().read_snapshot_thread(&target).map_err(|_| ())?;
        Ok(super::native_reader::snapshot_from_metadata(&target, &thread))
    }
}
impl RecoveryListing for Control {
    fn confirms_absence(&self, native_id: &str) -> bool {
        self.create.native_control().confirms_missing_recovery_thread(native_id)
    }

    fn list_recent(&self, cursor: Option<&str>, limit: u32) -> Result<RecoveryPage, ReadError> {
        let page = self
            .reader
            .lock()
            .map_err(|_| ReadError("Codex reader unavailable".into()))?
            .list_recent_threads(cursor, limit)
            .map_err(|e| ReadError(e.to_string()))?;
        Ok(RecoveryPage {
            sessions: page
                .data
                .into_iter()
                .filter_map(|t| Some((t.id, t.updated_at?.checked_mul(1000)?)))
                .collect(),
            next_cursor: page.next_cursor,
        })
    }
}
struct OwnerNativeReader {
    control: Arc<Control>,
    reopened: Arc<NativeReader>,
}
#[cfg(test)]
#[path = "owner_recovery_receipt_tests.rs"]
mod receipt_tests;

impl NativeSessionReader for OwnerNativeReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        let thread = self
            .control
            .create
            .native_control()
            .read_snapshot_thread(target)?;
        Ok(super::native_reader::snapshot_from_metadata(
            target, &thread,
        ))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        self.reopened.reconcile(receipt).await
    }

    async fn reconcile_admitted_recovery(
        &self,
        receipt: &NativeReceipt,
        key: &str,
    ) -> Result<Observation, ReadError> {
        self.reopened.reconcile_admitted_recovery(receipt, key).await
    }

    async fn recover_admission(
        &self,
        target: &SessionAddress,
        key: &RequestKey,
    ) -> Result<Option<NativeReceipt>, ReadError> {
        match self
            .control
            .create
            .native_control()
            .lookup_request(target, key)
        {
            Ok(RequestReceiptLookup::Found(receipt)) => Ok(Some(receipt)),
            Ok(_) => Ok(None),
            Err(_) => Err(ReadError("Codex request correlation unavailable".into())),
        }
    }
}
struct SharedRead(Arc<Mutex<CodexReader>>);
impl ScopedMessageReader for SharedRead {
    fn read_messages(&mut self, a: &SessionAddress) -> Result<serde_json::Value, ()> {
        let mut r = self.0.lock().map_err(|_| ())?;
        ScopedMessageReader::read_messages(&mut *r, a)
    }
}
struct OwnerApp {
    metadata_inventory_home: Option<std::path::PathBuf>,
    authority: Arc<ScopedAuthority>,
    instance: InstanceRef,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    messages: Arc<Mutex<CodexReader>>,
    create: Arc<dyn ApplicationPort>,
    deliver: Arc<dyn ApplicationPort>,
    resources: Option<Arc<dyn ApplicationPort>>,
    interrupt: Arc<Control>,
    waits: Arc<WaitAutomationApplication>,
    autopilot: Option<Arc<SessionAutopilot>>,
}
impl ApplicationPort for OwnerApp {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if let Some(result) = super::owner_reads::codex_registered_list(identity, &request, &self.policy, &self.messages) {
                return Some(result);
            }
            if let catalog::Request::Sessions(catalog::Sessions::Inventory { node_ref, instance_ref, cwd, cursor, limit, updated_since_ms, archived }) = &request {
                return Some(super::owner_codex_inventory::list(
                    identity, &self.policy, self.metadata_inventory_home.as_deref(), &self.messages,
                    node_ref, instance_ref, cwd.as_deref(), cursor.as_deref(), *limit, *updated_since_ms, *archived,
                ));
            }
            if let Some(result) = self.policy.discover_instance(identity, &request, None) {
                return Some(result);
            }
            if let Some(result) = super::owner_registration::call(
                identity, &request, self.interrupt.as_ref(), &self.policy,
                &self.instance, &self.authority, &self.grants,
            ) {
                return Some(result);
            }
            if matches!(&request, catalog::Request::Create(_)) {
                return self.create.call(identity, request).await;
            }
            if let catalog::Request::Deliver(operation) = request {
                return super::owner_opencode::deliver_to_owner(
                    identity, operation, &self.policy, SendMode::Start, &self.waits, self.deliver.as_ref(),
                ).await;
            }
            if let Some(pilot) = &self.autopilot {
                if let Some(result) = pilot.call(identity, request.clone()).await {
                    return Some(result);
                }
            } else if matches!(&request, catalog::Request::Automation(catalog::Automation::Create {
                rule: catalog::AutomationRule::Autopilot { .. }, ..
            })) {
                return Some(rmcp::model::CallToolResult::structured_error(
                    serde_json::json!({"code":"autopilot_not_configured","effect":"none"})));
            }
            if let Some(mut result) = self.waits.call(identity, request.clone()).await {
                if let (Some(pilot), catalog::Request::Automation(catalog::Automation::List {session_ref,..}))
                    = (&self.autopilot, &request)
                    && result.is_error != Some(true)
                    && let Some(rows) = result.structured_content.as_mut().and_then(|v| v["rules"].as_array_mut()) {
                    match pilot.list(identity, session_ref.as_deref()) {
                        Ok(extra) => rows.extend(extra),
                        Err(code) => return Some(rmcp::model::CallToolResult::structured_error(
                            serde_json::json!({"code":code,"effect":"none"}))),
                    }
                    return Some(rmcp::model::CallToolResult::structured(result.structured_content.take().unwrap()));
                }
                return Some(result);
            }
            if matches!(&request, catalog::Request::Resource(_)) {
                return match &self.resources {
                    Some(resources) => resources.call(identity, request).await,
                    None => Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"resource_runtime_not_configured","effect":"none"}),
                    )),
                };
            }
            let session = match &request {
                catalog::Request::Session(catalog::Session::Messages { session_ref, .. })
                | catalog::Request::Stop(catalog::Stop::Stop { session_ref, .. }) => {
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
                let grant = match action {
                    Action::Read => {
                        self.policy
                            .session_read_grant(&principal.id, &self.instance, &session)
                    }
                    _ => self
                        .policy
                        .session_write_grant(&principal.id, &self.instance, &session),
                };
                match grant {
                    Ok(Some(g)) => grants.push(g),
                    Ok(None) => {}
                    Err(_) => {
                        return Some(rmcp::model::CallToolResult::structured_error(
                            serde_json::json!({"code":"policy_unavailable","effect":"none"}),
                        ));
                    }
                }
            }
            let make_authority = || {
                ScopedAuthority::new(
                    self.policy.db.clone(),
                    self.policy.gate.clone(),
                    self.policy.generation.clone(),
                )
            };
            match &request {
                catalog::Request::Session(_) => match make_authority() {
                    Ok(a) => {
                        ScopedReadApplication::new(
                            a,
                            self.instance.clone(),
                            grants,
                            SharedRead(self.messages.clone()),
                        )
                        .call(identity, request)
                        .await
                    }
                    Err(_) => None,
                },
                catalog::Request::Stop(_) => match make_authority() {
                    Ok(a) => {
                        ScopedStopApplication::new_with_interrupt(
                            a,
                            self.instance.clone(),
                            grants,
                            self.interrupt.clone(),
                        )
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
pub async fn serve(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    if has_native_opencode_binding(&opened.owner) {
        return super::owner_native_opencode::serve(opened).await;
    }
    // Codex profiles may retain an AHAP field for older manifests, but their
    // exact native executable/profile binding is now consumed directly by the
    // Rust app-server adapter. Both forms of browser runner use the AHAP port.
    if !opened.owner.has_native_codex_binding() && opened.owner.has_ahap_runner() {
        return super::owner_opencode::serve(opened).await;
    }
    let binding = build(opened, RecoveryRunner::Mcp)?;
    automation_driver::start(vec![binding.driver_owner()])?;
    let service = binding.server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Run the protected native owner under an OS supervisor without an MCP transport.
pub(super) async fn run_recovery(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::signal::unix::{SignalKind, signal};

    let owner = &opened.owner;
    if owner
        .codex_recovery
        .as_ref()
        .is_none_or(|profile| profile.runner != RecoveryRunner::Service)
    {
        return Err("Codex recovery service requires codex_recovery.runner=service".into());
    }
    let code_home = Path::new(&owner.ahap_env["CODEX_HOME"]).canonicalize()?;
    let directory = code_home.metadata()?;
    if !directory.is_dir()
        || directory.uid() != unsafe { libc::geteuid() }
        || directory.mode() & 0o077 != 0
    {
        return Err("Codex recovery service requires a private Codex home".into());
    }
    let lock = code_home.join(".agent-herder-codex-recovery.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&lock)?;
    let metadata = file.metadata()?;
    let _owner =
        herder::application::target_gate::acquire_pinned(&lock, metadata.dev(), metadata.ino())
            .map_err(|error| {
                if error.kind() == io::ErrorKind::WouldBlock {
                    io::Error::new(error.kind(), "Codex recovery service is already running")
                } else {
                    error
                }
            })?;
    drop(file);

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let binding = build(opened, RecoveryRunner::Service)?;
    let recovery = binding
        .session_recovery
        .as_ref()
        .ok_or("Codex recovery is not configured")?;
    let owner =
        automation_driver::AutomationOwner::new(binding.identity.clone(), vec![recovery.clone()]);
    let shutdown = async move {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    };
    automation_driver::start_until_shutdown(vec![owner], shutdown)?.await?;
    drop(binding);
    Ok(())
}

fn build(
    opened: OpenedOwner,
    runner: RecoveryRunner,
) -> Result<super::owner_opencode::BoundOwner, Box<dyn std::error::Error>> {
    let registry = Arc::new(DependencyRegistry::new());
    let binding = build_owner(opened, registry.clone(), runner)?;
    registry.configure(vec![binding.source.clone()])?;
    Ok(binding)
}

pub fn build_with_registry(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
) -> Result<super::owner_opencode::BoundOwner, Box<dyn std::error::Error>> {
    build_owner(opened, registry, RecoveryRunner::Mcp)
}

fn build_owner(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
    runner: RecoveryRunner,
) -> Result<super::owner_opencode::BoundOwner, Box<dyn std::error::Error>> {
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let process = codex_process(&opened.owner, &instance)?;
    let metadata_inventory_home = opened.owner.codex_metadata_inventory.then(|| process.code_home.clone());
    let timeout = Duration::from_secs(20);
    let reopened = Arc::new(NativeReader::open(
        process.clone(),
        instance.clone(),
        timeout,
    )?);
    let messages = Arc::new(Mutex::new(CodexReader::open(process.clone(), timeout)?));
    let control = Arc::new(Control {
        create: Arc::new(CodexCreateControl::open(
            process,
            instance.clone(),
            timeout,
        )?),
        reader: messages.clone(),
    });
    let reader = Arc::new(OwnerNativeReader {
        control: control.clone(),
        reopened: reopened.clone(),
    });
    let principal = PrincipalId(opened.owner.principal);
    let identity = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: principal.clone(),
        }),
        None,
    );
    let target = serde_json::to_string(&instance)?;
    let grants = vec![Grant {
        principal: principal.clone(),
        resource: PrivateResource::Resource(format!("instance:{target}")),
        action: Action::Write,
    }];
    let policy = Arc::new(OwnerPolicy {
        existing_sessions: Vec::new(),
        principal,
        instance: instance.clone(),
        harness: "codex".into(),
        generation: opened.generation,
        db: opened.database,
        gate: opened.gate,
    });
    let authority = Arc::new(opened.authority);
    let config = herder::application::process_bindings::ProcessRuntimeConfig::from_environment()?;
    let mut deliver = ScopedDeliverApplication::new(
        authority.clone(),
        instance.clone(),
        grants.clone(),
        reader.clone(),
        control.clone(),
        "9999-12-31T23:59:59Z".into(),
    )
    .map_err(|_| "invalid delivery policy")?
    .with_policy(policy.clone());
    if let Some(config) = &config {
        deliver = deliver.with_delivery_keys(Arc::new(
            herder::application::delivery_keys::DeliveryKeyRegistry::new(config.resources.clone())?,
        ));
    }
    let deliver = Arc::new(deliver);
    let create = Arc::new(
        ScopedCreateApplication::new(
            authority.clone(),
            instance.instance_id.clone(),
            grants.clone(),
            control.clone(),
            Arc::new(Ids),
            Arc::new(Ids),
            reader.clone(),
            control.clone(),
            policy.clone(),
            "9999-12-31T23:59:59Z".into(),
        )
        .map_err(|_| "invalid create policy")?,
    );
    let reconciler = Arc::new(
        herder::application::scoped_stop::task_reconcile::ScopedReceiptReconciler::new(
            authority.clone(),
            reader.clone(),
        ),
    );
    let source = Arc::new(DependencySource::new(
        authority.clone(),
        instance.clone(),
        "codex".into(),
        policy.principal.clone(),
        grants.clone(),
        policy.clone(),
        reopened,
    ));
    let handoff = opened.owner.codex_recovery.as_ref().and_then(|profile| profile.legacy_handoff.clone());
    let waits = Arc::new(WaitAutomationApplication::new(
        source.clone(),
        registry,
        deliver.clone(),
        catalog::DeliveryMode::Start,
        reconciler.clone(),
        policy.clone(),
    ).with_recovery_handoff(handoff, control.clone()));
    let autopilot = opened.owner.codex_autopilot.map(|profile| SessionAutopilot::new(
        source.clone(), control.create.share_native_control(), reconciler.clone(),
        policy.clone(), &policy.principal.0, profile,
    ).map(Arc::new)).transpose()?;
    let session_recovery = opened
        .owner
        .codex_recovery
        .filter(|profile| profile.runner == runner)
        .map(|profile| {
            Arc::new(SessionRecovery::new(
                authority.clone(),
                control.create.share_native_control(),
                policy.clone(),
                waits.clone(),
                reconciler.clone(),
                profile,
                RecoveryDiscovery::new(control.clone(), grants.clone()),
            )) as Arc<dyn automation_driver::AutomationTick>
        });
    let resources = match &config {
        Some(config) => Some(Arc::new(
            herder::application::process_resources::ProcessResourceApplication::new(
                config.clone(),
            )?,
        ) as Arc<dyn ApplicationPort>),
        None => None,
    };
    let app = Arc::new(OwnerApp {
        metadata_inventory_home,
        authority: authority.clone(),
        instance: instance.clone(),
        grants: grants.clone(),
        policy: policy.clone(),
        messages,
        create,
        deliver,
        resources,
        interrupt: control.clone(),
        waits: waits.clone(),
        autopilot: autopilot.clone(),
    });
    let server = ScopedTaskServer::new(identity.clone(), grants, authority, app)
        .with_create_policy(policy.clone())
        .with_reconciler(reconciler);
    Ok(super::owner_opencode::BoundOwner {
        adapter_available: true,
        autopilot,
        harness: "codex".into(),
        session_recovery,
        process: None,
        waits,
        source,
        identity: identity.clone(),
        server,
        policy,
        instance,
    })
}

fn codex_process(
    owner: &super::scoped_profile::OwnerProfile,
    instance: &InstanceRef,
) -> Result<CodexInstance, Box<dyn std::error::Error>> {
    let binding = owner
        .ahap_env
        .get("AHAP_CODEX_BIN")
        .zip(owner.ahap_env.get("CODEX_HOME"))
        .zip(owner.ahap_env.get("AHAP_CODEX_CWD"));
    let (executable, code_home, cwd) = match binding {
        Some(((executable, code_home), cwd)) if owner.kind == "codex" => {
            (executable.into(), code_home.into(), cwd.into())
        }
        _ => (
            owner.executable.clone(),
            owner.code_home.clone(),
            owner.cwd.clone(),
        ),
    };
    Ok(CodexInstance {
        instance_id: instance.instance_id.clone(),
        executable,
        code_home,
        cwd,
        socket_path: owner.ahap_env.get("AHAP_CODEX_SOCKET").map(Into::into),
    })
}

pub(super) fn has_native_opencode_binding(owner: &super::scoped_profile::OwnerProfile) -> bool {
    owner.kind == "opencode" && owner.ahap_script.is_none() && owner.ahap_base_url.is_some()
}
