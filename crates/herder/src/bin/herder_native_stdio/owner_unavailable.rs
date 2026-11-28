//! Preserve a configured owner's authority when only its adapter transport is offline.
//! No native capabilities, work admission, or background ticks are synthesized.
use super::{owner_opencode::BoundOwner, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    application::scoped_stop::{
        create_prompt::FreshSessionGrantPolicy,
        mcp_task_server::ScopedTaskServer,
        task_reconcile::TaskReconciler,
        wait_automation::{DependencyRegistry, DependencySource, NativeTurn, NativeTurnReader, WaitAutomationApplication},
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal},
    domain::{adapter::ReadError, address::{InstanceRef, NodeRef, SessionAddress}},
    mcp::{catalog, transport::{ApplicationFuture, ApplicationPort}},
};
use rmcp::model::CallToolResult;
use serde_json::json;
use std::sync::Arc;

/// Only an I/O failure during a verified runner's startup RPC uses this marker.
/// Invalid profiles, mismatched harnesses, and invalid capabilities remain fatal.
#[derive(Debug)]
pub(super) struct AdapterStartupUnavailable;
impl std::fmt::Display for AdapterStartupUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("owner adapter startup transport unavailable")
    }
}
impl std::error::Error for AdapterStartupUnavailable {}

struct UnavailableReader;
impl NativeTurnReader for UnavailableReader {
    fn current_turn(&self, _: &SessionAddress) -> Result<Option<NativeTurn>, ReadError> {
        Err(ReadError("owner adapter unavailable".into()))
    }
}
struct NoReconciliation;
impl TaskReconciler for NoReconciliation {
    fn reconcile(
        &self,
        _: ConnectionIdentity,
        _: Vec<Grant>,
        _: String,
        _: Option<Arc<dyn FreshSessionGrantPolicy + Send + Sync>>,
    ) {}
}
struct RefuseNative {
    principal: PrincipalId,
}
impl ApplicationPort for RefuseNative {
    fn call<'a>(&'a self, identity: &'a ConnectionIdentity, _: catalog::Request) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let authorized = matches!(identity.caller(), Caller::Principal(p) if p.id == self.principal);
            Some(CallToolResult::structured_error(json!({
                "code":if authorized {"owner_adapter_unavailable"} else {"unauthorized"},
                "effect":"none"
            })))
        })
    }
}
struct App {
    policy: Arc<OwnerPolicy>,
    waits: Arc<WaitAutomationApplication>,
    refuse: Arc<RefuseNative>,
}
impl ApplicationPort for App {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if let Some(mut result) = self.policy.discover_instance(identity, &request, None) {
                if result.is_error != Some(true) {
                    if let Some(mut data) = result.structured_content.take() {
                        for field in ["instances"] {
                            if let Some(rows) = data[field].as_array_mut() {
                                for row in rows {
                                    row["availability"] = json!("unavailable");
                                    row["reason"] = json!("adapter_startup_unavailable");
                                }
                            }
                        }
                        return Some(CallToolResult::structured(data));
                    }
                }
                return Some(result);
            }
            if matches!(&request, catalog::Request::Session(catalog::Session::Resolve { .. })) {
                // Canonical owner resolution still includes this profile's pinned
                // authority; being offline never removes it from ambiguity checks.
                return self.waits.call(identity, request).await;
            }
            self.refuse.call(identity, request).await
        })
    }
}

pub(super) fn build(
    opened: OpenedOwner,
    registry: Arc<DependencyRegistry>,
) -> Result<BoundOwner, Box<dyn std::error::Error>> {
    // Offline transport must not suppress validation of static runtime policy.
    herder::application::process_bindings::ProcessRuntimeConfig::from_environment()?;
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node),
        instance_id: opened.owner.instance,
    };
    let harness = opened.owner.kind;
    let principal = PrincipalId(opened.owner.principal);
    let identity = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal { id: principal.clone() }), None,
    );
    let grants = vec![Grant {
        principal: principal.clone(),
        resource: PrivateResource::Resource(format!("instance:{}", serde_json::to_string(&instance)?)),
        action: Action::Write,
    }];
    let policy = Arc::new(OwnerPolicy {
        existing_sessions: opened.owner.existing_sessions,
        principal: principal.clone(),
        instance: instance.clone(),
        harness: harness.clone(),
        generation: opened.generation,
        db: opened.database,
        gate: opened.gate,
    });
    let authority = Arc::new(opened.authority);
    let source = Arc::new(DependencySource::new(
        authority.clone(), instance.clone(), harness.clone(), principal.clone(),
        grants.clone(), policy.clone(), Arc::new(UnavailableReader),
    ));
    let refuse = Arc::new(RefuseNative { principal });
    let waits = Arc::new(WaitAutomationApplication::new(
        source.clone(), registry, refuse.clone(), catalog::DeliveryMode::Queue,
        Arc::new(NoReconciliation), policy.clone(),
    ).with_automatic_continuation(false));
    let app = Arc::new(App { policy: policy.clone(), waits: waits.clone(), refuse });
    let server = ScopedTaskServer::new(identity.clone(), grants, authority, app)
        .with_create_policy(policy.clone());
    Ok(BoundOwner {
        adapter_available: false,
        autopilot: None,
        harness,
        session_recovery: None,
        process: None,
        waits,
        source,
        identity,
        server,
        policy,
        instance,
    })
}
