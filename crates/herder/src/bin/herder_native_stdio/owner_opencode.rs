//! Trusted owner composition for one pinned legacy adapter AHAP subprocess.
use super::{owner_launch::Ids, owner_policy::OwnerPolicy, scoped_profile::OpenedOwner};
use herder::{
    adapters::{
        ahap::{AhapClient, AhapConfig},
        ahap_opencode::{AhapOpenCode, AhapPortPolicy},
    },
    application::scoped_stop::{
        ScopedAuthority,
        create_prompt::FreshSessionGrantPolicy,
        mcp_create::ScopedCreateApplication,
        mcp_deliver::ScopedDeliverApplication,
        mcp_read::{ScopedMessageReader, ScopedReadApplication},
        mcp_stop::ScopedStopApplication,
        mcp_task_server::ScopedTaskServer,
        task_reconcile::ScopedReceiptReconciler,
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
    instance: InstanceRef,
    harness: String,
    grants: Vec<Grant>,
    policy: Arc<OwnerPolicy>,
    adapter: Arc<AhapOpenCode>,
    create: Arc<dyn ApplicationPort>,
    deliver: Arc<dyn ApplicationPort>,
}
impl ApplicationPort for App {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if matches!(&request, catalog::Request::Discover(catalog::Discover::Nodes {} | catalog::Discover::Instances { .. })) {
                if !matches!(identity.caller(), Caller::Principal(p) if p.id == self.policy.principal) {
                    return Some(rmcp::model::CallToolResult::structured_error(
                        serde_json::json!({"code":"unauthorized","effect":"none","message":"Use the configured owner identity to discover this instance."})));
                }
                let value = match &request {
                    catalog::Request::Discover(catalog::Discover::Nodes {}) => serde_json::json!({
                        "nodes":[{"node_ref":self.instance.node.0}],"scope":"configured_owner_instance","complete":true}),
                    catalog::Request::Discover(catalog::Discover::Instances { node_ref }) => {
                        let rows = if node_ref.as_ref().is_none_or(|n| n == &self.instance.node.0) {
                            vec![serde_json::json!({"instance_ref":self.instance.instance_id,"node_ref":self.instance.node.0,
                                "harness":self.harness,"capabilities":self.adapter.capabilities()})]
                        } else { vec![] };
                        serde_json::json!({"instances":rows,"scope":"configured_owner_instance","complete":true})
                    },
                    _ => unreachable!(),
                };
                return Some(rmcp::model::CallToolResult::structured(value));
            }
            if let Some(result) = super::owner_reads::call(identity, &request,
                &self.adapter, &self.policy, &self.instance).await {
                return Some(result);
            }
            if matches!(&request, catalog::Request::Create(_)) {
                return self.create.call(identity, request).await;
            }
            if matches!(&request, catalog::Request::Deliver(_)) {
                return self.deliver.call(identity, request).await;
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
pub async fn serve(opened: OpenedOwner) -> Result<(), Box<dyn std::error::Error>> {
    let instance = InstanceRef {
        node: NodeRef(opened.owner.node.clone()),
        instance_id: opened.owner.instance.clone(),
    };
    let script = opened
        .owner
        .ahap_script
        .ok_or("missing trusted AHAP script")?;
    let harness = opened.owner.kind.clone();
    let mut env = vec![
        (
            "HOME".into(),
            opened.owner.code_home.to_string_lossy().into_owned(),
        ),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    if let Some(endpoint) = opened.owner.ahap_base_url {
        env.push(("AHAP_OPENCODE_BASE_URL".into(), endpoint));
    }
    env.extend(opened.owner.ahap_env);
    if harness == "opencode" && !env.iter().any(|(name, _)| name == "AHAP_OPENCODE_PASSWORD")
        && let Some(password) = std::env::var_os("AHAP_OPENCODE_PASSWORD") {
        env.push((
            "AHAP_OPENCODE_PASSWORD".into(),
            password
                .into_string()
                .map_err(|_| "invalid password encoding")?,
        ));
    }
    let client = AhapClient::open(AhapConfig {
        instance_id: instance.instance_id.clone(),
        harness: harness.clone(),
        executable: opened.owner.executable,
        args: vec![script.to_string_lossy().into_owned()],
        cwd: opened.owner.cwd.clone(),
        env,
        timeout: Duration::from_secs(20),
    })
    .map_err(|_| "AHAP initialization failed")?;
    let delivery_mode = if harness == "opencode"
        && client.capabilities().get("nativeProtocol").and_then(serde_json::Value::as_str) != Some("v2") {
        SendMode::Start
    } else { SendMode::Queue };
    let adapter = Arc::new(
        AhapOpenCode::new_with_policy(
            Arc::new(client),
            instance.clone(),
            opened.owner.cwd,
            "Herder".into(),
            AhapPortPolicy { harness: harness.clone(), initial_delivery_mode: delivery_mode },
        )
        .map_err(|_| "AHAP capabilities invalid")?,
    );
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
        principal,
        instance: instance.clone(),
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
    let deliver = Arc::new(
        ScopedDeliverApplication::new(authority.clone(), instance.clone(), grants.clone(),
            adapter.clone(), adapter.clone(), "9999-12-31T23:59:59Z".into())
            .map_err(|_| "invalid delivery policy")?
            .with_delivery_mode(delivery_mode).map_err(|_| "unsupported delivery mode")?
            .with_policy(policy.clone()),
    );
    let app = Arc::new(App {
        instance,
        harness,
        grants: grants.clone(),
        policy: policy.clone(),
        adapter: adapter.clone(),
        create,
        deliver,
    });
    let reconciler = Arc::new(ScopedReceiptReconciler::new(authority.clone(), adapter));
    let server = ScopedTaskServer::new(identity, grants, authority, app)
        .with_create_policy(policy)
        .with_reconciler(reconciler);
    server
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
