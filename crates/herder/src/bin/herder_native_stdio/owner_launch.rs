//! Explicit single-principal local-owner composition. Never used by default.
use super::{native_reader::NativeReader, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    adapters::codex::{connection::CodexInstance, create::CodexCreateControl, read::CodexReader},
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, ScopeGenerationIssuer, ScopedAuthority,
            create_prompt::FreshSessionGrantPolicy,
            mcp_create::ScopedCreateApplication,
            mcp_deliver::ScopedDeliverApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_stop::ScopedStopApplication,
            mcp_task_server::ScopedTaskServer,
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
    authority: Arc<ScopedAuthority>,
    instance: InstanceRef,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    reader: Arc<OwnerNativeReader>,
    messages: Arc<Mutex<CodexReader>>,
    control: Arc<Control>,
    create: Arc<dyn ApplicationPort>,
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
                        ScopedStopApplication::new(a, self.instance.clone(), grants)
                            .call(identity, request)
                            .await
                    }
                    Err(_) => None,
                },
                catalog::Request::Deliver(_) => match ScopedDeliverApplication::new(
                    self.authority.clone(),
                    self.instance.clone(),
                    grants,
                    self.reader.clone(),
                    self.control.clone(),
                    "9999-12-31T23:59:59Z".into(),
                ) {
                    Ok(a) => a.call(identity, request).await,
                    Err(_) => None,
                },
                _ => None,
            }
        })
    }
}
pub async fn serve(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    // V1 manifests select the existing TypeScript adapter through AHAP for
    // every harness. The earlier Rust Codex implementation remains preserved
    // for its existing explicit, script-less profiles.
    if opened.owner.ahap_script.is_some() {
        return super::owner_opencode::serve(opened).await;
    }
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let process = CodexInstance {
        instance_id: instance.instance_id.clone(),
        executable: opened.owner.executable,
        code_home: opened.owner.code_home,
        cwd: opened.owner.cwd,
    };
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
        reopened,
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
    let app = Arc::new(OwnerApp {
        authority: authority.clone(),
        instance,
        grants: grants.clone(),
        policy: policy.clone(),
        reader,
        messages,
        control,
        create,
    });
    let server = ScopedTaskServer::new(identity, grants, authority, app)
        .with_create_policy(policy)
        .with_reconciler(reconciler);
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
