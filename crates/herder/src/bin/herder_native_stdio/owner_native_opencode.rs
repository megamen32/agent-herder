//! Trusted Rust owner composition for one native OpenCode HTTP instance.
//!
//! The adapter ports remain asynchronous. The scoped application boundary is
//! synchronous for bounded native admission, so this module creates one fresh
//! runtime per bounded call and keeps all retry/no-replay decisions in the
//! existing Rust application layer.

use super::{owner_opencode::BoundOwner, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        control::{InterruptOutcome, OpenCodeSessionControl},
        create::OpenCodeCreateControl,
        read::{OpenCodeSessionMessages, OpenCodeSessionReader},
    },
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, BoundedNativeInterrupt, InterruptAttempt,
            ScopedAuthority,
            automation_driver::AutomationOwner,
            create_prompt::FreshSessionGrantPolicy,
            mcp_create::ScopedCreateApplication,
            mcp_deliver::ScopedDeliverApplication,
            mcp_read::{ScopedMessageReader, ScopedReadApplication},
            mcp_stop::ScopedStopApplication,
            mcp_task_server::ScopedTaskServer,
            task_reconcile::ScopedReceiptReconciler,
            wait_automation::{DependencyRegistry, DependencySource, WaitAutomationApplication},
        },
        target::{NativeCreateControl, NativeCreateOutcome},
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    config::Profile,
    domain::{
        adapter::{
            Admission, NativeReceipt, NativeSessionControl, NativeSessionReader, Observation,
            ReadError, RequestKey, SendMode, SessionActivity, SessionSnapshot,
        },
        address::{
            Authorization, Availability, Capability, CapabilityVersion, InstanceRef, NodeRef,
            SessionAddress, SessionRef, Support,
        },
    },
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::ServiceExt;
use serde_json::json;
use std::{
    future::Future,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct NativeControl {
    create: OpenCodeCreateControl,
    control: OpenCodeSessionControl,
}

impl NativeControl {
    fn block<T>(&self, future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("native OpenCode runtime")
            .block_on(future)
    }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("native OpenCode runtime")
        .block_on(future)
}

fn thread_block_on<T: Send>(future: impl Future<Output = T> + Send) -> T {
    std::thread::scope(|scope| {
        scope.spawn(|| block_on(future)).join().expect("native OpenCode I/O thread")
    })
}

impl BoundedNativeHandoff for NativeControl {
    fn submit_bounded(
        &self,
        plan: herder::domain::adapter::DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, herder::domain::adapter::SubmitError> {
        // Scoped delivery invokes this synchronous handoff inside its snapshot runtime.
        thread_block_on(self.control.submit(plan, message, key))
    }
}

impl BoundedFreshRootCreate for NativeControl {
    fn instance(&self) -> &InstanceRef {
        self.create.instance()
    }

    fn create_root_bounded(
        &self,
        request_key: &str,
        specification: &str,
    ) -> Result<SessionAddress, herder::domain::adapter::SubmitError> {
        match self.block(self.create.create_once(request_key, specification)) {
            NativeCreateOutcome::Confirmed {
                instance,
                native_session_id,
                ..
            } => Ok(SessionAddress {
                instance,
                native_session_id,
            }),
            NativeCreateOutcome::DefinitelyNotSent { reason } => {
                Err(herder::domain::adapter::SubmitError::DefinitelyNotSent { reason })
            }
            NativeCreateOutcome::Unknown => {
                Err(herder::domain::adapter::SubmitError::OutcomeUnknown {
                    receipt: None,
                    reason: "OpenCode create outcome is unknown".into(),
                })
            }
        }
    }
}

impl BoundedNativeInterrupt for NativeControl {
    fn interrupt_exact(&self, target: &SessionAddress, native_turn_id: &str) -> InterruptAttempt {
        match self.block(
            self.control
                .interrupt_session(target, native_turn_id.to_owned()),
        ) {
            InterruptOutcome::Interrupted => InterruptAttempt::Interrupted,
            InterruptOutcome::DefinitelyNotSent { .. } => InterruptAttempt::DefinitelyNotSent,
            InterruptOutcome::OutcomeUnknown { .. } => InterruptAttempt::OutcomeUnknown,
        }
    }
}

#[derive(Clone)]
struct NativeReader {
    reader: OpenCodeSessionReader,
}

impl NativeReader {
    fn capability(name: &str, supported: Support) -> Capability {
        Capability {
            name: name.into(),
            version: CapabilityVersion {
                adapter_version: "rust-opencode".into(),
                capability_version: "1".into(),
            },
            supported,
            available: Availability::Available,
            authorized: Authorization::Authorized,
        }
    }

    async fn messages(
        &self,
        target: &SessionAddress,
    ) -> Result<OpenCodeSessionMessages, ReadError> {
        self.reader
            .get_session_messages(target, "herder-owner-messages")
            .await
            .map_err(|error| ReadError(error.0))
    }
}

impl NativeSessionReader for NativeReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        let session = self
            .reader
            .get_session(target, "herder-owner-snapshot")
            .await
            .map_err(|error| ReadError(error.0))?;
        let activity = if session.time.busy.is_some() {
            SessionActivity::Busy {
                turn_id: "opencode-active".into(),
            }
        } else if session.time.idle.is_some() {
            SessionActivity::Idle
        } else {
            SessionActivity::Unknown
        };
        Ok(SessionSnapshot {
            address: target.clone(),
            human_stop: false,
            activity,
            capabilities: vec![
                Self::capability("deliver.current", Support::Unsupported),
                Self::capability("deliver.queue", Support::Supported),
                Self::capability("deliver.start", Support::Unsupported),
            ],
        })
    }

    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError> {
        let messages = self.messages(&receipt.target).await?;
        let found = messages.messages.iter().any(|message| match message {
            herder::adapters::opencode::read::OpenCodeMessage { id, .. } => {
                id == &receipt.native_id
            }
        });
        Ok(if found {
            Observation::Confirmed {
                receipt: receipt.clone(),
            }
        } else {
            Observation::Unknown {
                receipt: receipt.clone(),
            }
        })
    }
}

impl herder::application::scoped_stop::wait_automation::NativeTurnReader for NativeReader {
    fn current_turn(
        &self,
        target: &SessionAddress,
    ) -> Result<Option<herder::application::scoped_stop::NativeTurn>, ReadError> {
        let reader = self.reader.clone();
        let target = target.clone();
        let session = thread_block_on(async move {
            reader.get_session(&target, "herder-owner-turn").await
        })
            .map_err(|error| ReadError(error.0))?;
        Ok(session
            .time
            .busy
            .map(|_| herder::application::scoped_stop::NativeTurn {
                turn_id: "opencode-active".into(),
                status: herder::application::scoped_stop::NativeTurnStatus::Running,
            }))
    }
}

struct MessageReader(Arc<Mutex<NativeReader>>);

impl ScopedMessageReader for MessageReader {
    fn read_messages(&mut self, target: &SessionAddress) -> Result<serde_json::Value, ()> {
        let reader = self.0.lock().map_err(|_| ())?.clone();
        let target = target.clone();
        let messages = thread_block_on(async move { reader.messages(&target).await }).map_err(|_| ())?;
        Ok(json!({
            "messages": messages.messages,
            "next_cursor": messages.next,
            "complete": messages.next.is_none(),
        }))
    }
}

struct OwnerApp {
    instance: InstanceRef,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    messages: Arc<Mutex<NativeReader>>,
    create: Arc<dyn ApplicationPort>,
    deliver: Arc<dyn ApplicationPort>,
    interrupt: Arc<NativeControl>,
    waits: Arc<WaitAutomationApplication>,
}

impl ApplicationPort for OwnerApp {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if let Some(result) = self.policy.discover_instance(identity, &request, None) {
                return Some(result);
            }
            if matches!(&request, catalog::Request::Create(_)) {
                return self.create.call(identity, request).await;
            }
            if let catalog::Request::Deliver(operation) = request {
                return super::owner_opencode::deliver_to_owner(
                    identity, operation, &self.policy, SendMode::Queue, &self.waits, self.deliver.as_ref(),
                ).await;
            }
            if let Some(result) = self.waits.call(identity, request.clone()).await {
                return Some(result);
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
                    json!({"code":"unauthorized","effect":"none"}),
                ));
            };
            let mut grants = self.grants.clone();
            for action in [Action::Read, Action::Write] {
                let grant = match action {
                    Action::Read => {
                        self.policy
                            .session_read_grant(&principal.id, &self.instance, &session)
                    }
                    Action::Write => {
                        self.policy
                            .session_write_grant(&principal.id, &self.instance, &session)
                    }
                    Action::Subscribe => Ok(None),
                };
                match grant {
                    Ok(Some(grant)) => grants.push(grant),
                    Ok(None) => {}
                    Err(_) => {
                        return Some(rmcp::model::CallToolResult::structured_error(
                            json!({"code":"policy_unavailable","effect":"none"}),
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
                catalog::Request::Session(_) => match authority() {
                    Ok(authority) => {
                        ScopedReadApplication::new(
                            authority,
                            self.instance.clone(),
                            grants,
                            MessageReader(self.messages.clone()),
                        )
                        .call(identity, request)
                        .await
                    }
                    Err(_) => None,
                },
                catalog::Request::Stop(_) => match authority() {
                    Ok(authority) => {
                        ScopedStopApplication::new_with_interrupt(
                            authority,
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

pub async fn build(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
) -> Result<BoundOwner, Box<dyn std::error::Error>> {
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let profile = Profile {
        runtime_cwd: opened.owner.cwd.clone(),
        worktree_root: opened.owner.cwd.clone(),
        endpoint: opened.owner.ahap_base_url.clone(),
        secret_ref: None,
    };
    let password = opened.owner.ahap_env.get("AHAP_OPENCODE_PASSWORD").cloned();
    let username = opened
        .owner
        .ahap_env
        .get("OPENCODE_SERVER_USERNAME")
        .cloned()
        .unwrap_or_else(|| "opencode".into());
    let auth = password.map(|password| OpenCodeAuth::new(username, password));
    let connection = OpenCodeConnection::open(instance.clone(), &profile, auth).await?;
    let reader = Arc::new(NativeReader {
        reader: OpenCodeSessionReader::new(connection.clone()),
    });
    let control = Arc::new(NativeControl {
        create: OpenCodeCreateControl::new(connection.clone()),
        control: OpenCodeSessionControl::new(connection),
    });
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
        existing_sessions: Vec::new(),
        principal,
        instance: instance.clone(),
        harness: "opencode".into(),
        generation: opened.generation,
        db: opened.database,
        gate: opened.gate,
    });
    let authority = Arc::new(opened.authority);
    let reader_for_delivery = reader.clone();
    let deliver = Arc::new(
        ScopedDeliverApplication::new(
            authority.clone(),
            instance.clone(),
            grants.clone(),
            reader_for_delivery,
            control.clone(),
            "9999-12-31T23:59:59Z".into(),
        )
        .map_err(|_| "invalid OpenCode delivery policy")?
        .with_delivery_mode(SendMode::Queue)
        .map_err(|_| "invalid OpenCode delivery mode")?
        .with_policy(policy.clone())
        .with_automatic_continuation(false),
    );
    let create = Arc::new(
        ScopedCreateApplication::new(
            authority.clone(),
            instance.instance_id.clone(),
            grants.clone(),
            control.clone(),
            Arc::new(super::owner_launch::Ids),
            Arc::new(super::owner_launch::Ids),
            reader.clone(),
            control.clone(),
            policy.clone(),
            "9999-12-31T23:59:59Z".into(),
        )
        .map_err(|_| "invalid OpenCode create policy")?,
    );
    let reconciler = Arc::new(ScopedReceiptReconciler::new(
        authority.clone(),
        reader.clone(),
    ));
    let source = Arc::new(DependencySource::new(
        authority.clone(),
        instance.clone(),
        "opencode".into(),
        policy.principal.clone(),
        grants.clone(),
        policy.clone(),
        reader.clone(),
    ));
    let waits = Arc::new(
        WaitAutomationApplication::new(
            source.clone(),
            registry,
            deliver.clone(),
            catalog::DeliveryMode::Queue,
            reconciler.clone(),
            policy.clone(),
        )
        .with_automatic_continuation(false),
    );
    let messages = Arc::new(Mutex::new((*reader).clone()));
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
    Ok(BoundOwner {
        harness: "opencode".into(),
        process: None,
        waits,
        source,
        identity,
        server,
        policy,
        instance,
    })
}

pub async fn serve(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    let registry = Arc::new(DependencyRegistry::new());
    let binding = build(opened, registry.clone()).await?;
    registry.configure(vec![binding.source.clone()])?;
    herder::application::scoped_stop::automation_driver::start(vec![AutomationOwner::new(
        binding.identity.clone(),
        vec![binding.waits.clone()],
    )])?;
    binding
        .server
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
