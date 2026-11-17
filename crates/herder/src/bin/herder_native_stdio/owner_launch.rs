//! Explicit single-principal local-owner composition. Never used by default.
use super::{native_reader::NativeReader, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    adapters::codex::{connection::CodexInstance, create::CodexCreateControl, read::CodexReader},
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, BoundedNativeInterrupt, InterruptAttempt,
            ScopeGenerationIssuer, ScopedAuthority,
            automation_driver,
            create_prompt::FreshSessionGrantPolicy,
            mcp_create::ScopedCreateApplication,
            mcp_deliver::ScopedDeliverApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_stop::ScopedStopApplication,
            mcp_task_server::ScopedTaskServer,
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
            RequestKey, SessionSnapshot, SubmitError,
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
    io::Read,
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
struct Control(Arc<CodexCreateControl>);
impl BoundedFreshRootCreate for Control {
    fn instance(&self) -> &InstanceRef {
        self.0.native_control().instance()
    }
    fn create_root_bounded(&self, k: &str, s: &str) -> Result<SessionAddress, SubmitError> {
        self.0.create_root_bounded(k, s)
    }
}
impl BoundedNativeHandoff for Control {
    fn submit_bounded(
        &self,
        p: DispatchPlan,
        m: &str,
        k: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        self.0.native_control().submit_bounded(p, m, k)
    }
}
impl BoundedNativeInterrupt for Control {
    fn interrupt_exact(
        &self,
        target: &SessionAddress,
        native_turn_id: &str,
    ) -> InterruptAttempt {
        use herder::adapters::codex::control::InterruptOutcome;
        match self.0.native_control().interrupt_exact(target, native_turn_id) {
            InterruptOutcome::Interrupted => InterruptAttempt::Interrupted,
            InterruptOutcome::DefinitelyNotSent { .. } => InterruptAttempt::DefinitelyNotSent,
            InterruptOutcome::OutcomeUnknown { .. } => InterruptAttempt::OutcomeUnknown,
        }
    }
}
struct OwnerNativeReader {
    control: Arc<Control>,
    reopened: Arc<NativeReader>,
}
impl NativeSessionReader for OwnerNativeReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        let thread = self
            .control
            .0
            .native_control()
            .read_snapshot_thread(target)?;
        Ok(super::native_reader::snapshot_from_metadata(
            target, &thread,
        ))
    }
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        self.reopened.reconcile(receipt).await
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
    instance: InstanceRef,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    messages: Arc<Mutex<CodexReader>>,
    create: Arc<dyn ApplicationPort>,
    deliver: Arc<dyn ApplicationPort>,
    interrupt: Arc<Control>,
    waits: Arc<WaitAutomationApplication>,
}
impl ApplicationPort for OwnerApp {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if matches!(&request, catalog::Request::Create(_)) {
                return self.create.call(identity, request).await;
            }
            if matches!(&request, catalog::Request::Deliver(_)) {
                return self.deliver.call(identity, request).await;
            }
            if let Some(result) = self.waits.call(identity, request.clone()).await {
                return Some(result);
            }
            let session = match &request {
                catalog::Request::Session(catalog::Session::Messages { session_ref, .. })
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
    // Codex profiles may retain an AHAP field for older manifests, but their
    // exact native executable/profile binding is now consumed directly by the
    // Rust app-server adapter. Other harnesses retain their legacy owner port.
    if !has_native_codex_binding(&opened.owner) && opened.owner.ahap_script.is_some() {
        return super::owner_opencode::serve(opened).await;
    }
    let binding = build(opened)?;
    automation_driver::start(vec![binding.driver_owner()])?;
    let service = binding.server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

pub fn build(
    opened: OpenedOwner,
) -> Result<super::owner_opencode::BoundOwner, Box<dyn std::error::Error>> {
    let registry = Arc::new(DependencyRegistry::new());
    let binding = build_with_registry(opened, registry.clone())?;
    registry.configure(vec![binding.source.clone()])?;
    Ok(binding)
}

pub fn build_with_registry(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
) -> Result<super::owner_opencode::BoundOwner, Box<dyn std::error::Error>> {
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let process = codex_process(&opened.owner, &instance)?;
    let timeout = Duration::from_secs(20);
    let reopened = Arc::new(NativeReader::open(
        process.clone(),
        instance.clone(),
        timeout,
    )?);
    let messages = Arc::new(Mutex::new(CodexReader::open(process.clone(), timeout)?));
    let control = Arc::new(Control(Arc::new(CodexCreateControl::open(
        process,
        instance.clone(),
        timeout,
    )?)));
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
    let waits = Arc::new(WaitAutomationApplication::new(
        source.clone(),
        registry,
        deliver.clone(),
        catalog::DeliveryMode::Start,
        reconciler.clone(),
        policy.clone(),
    ));
    let app = Arc::new(OwnerApp {
        instance: instance.clone(),
        grants: grants.clone(),
        policy: policy.clone(),
        messages,
        create,
        deliver,
        interrupt: control.clone(),
        waits: waits.clone(),
    });
    let server = ScopedTaskServer::new(identity.clone(), grants, authority, app)
        .with_create_policy(policy.clone())
        .with_reconciler(reconciler);
    Ok(super::owner_opencode::BoundOwner {
        harness: "codex".into(),
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
    })
}

pub(super) fn has_native_codex_binding(owner: &super::scoped_profile::OwnerProfile) -> bool {
    owner.kind == "codex"
        && ["AHAP_CODEX_BIN", "CODEX_HOME", "AHAP_CODEX_CWD"]
            .iter()
            .all(|name| owner.ahap_env.contains_key(*name))
}
