//! Native MCP stdio boundary. The default server has no application attached.
use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc, time::Duration};

use crate::{
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, IdentityError, OAuthAuthority, OAuthPolicy,
        PrivateResource, authenticate_oauth_request,
    },
    config::Config,
    mcp::catalog,
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};

/// The application must authorize each operation and its exact resources using
/// the trusted caller; a verified principal alone is not a grant.
pub type ApplicationFuture<'a> = Pin<Box<dyn Future<Output = Option<CallToolResult>> + Send + 'a>>;
pub trait ApplicationPort: Send + Sync + 'static {
    /// None means this operation has no handler and must have no effect.
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a>;
}

/// Request-scoped gate for a trusted HTTP ingress. The ingress supplies the
/// Bearer value from the current HTTP request, never from MCP metadata.
/// This object stores no credential or identity between calls. The authority
/// must be the owner of the live token store, not another cached copy.
pub struct OAuthRequestGate {
    authority: Arc<dyn OAuthAuthority>,
    policy: OAuthPolicy,
    application: Arc<dyn ApplicationPort>,
}

impl OAuthRequestGate {
    pub fn new(
        authority: Arc<dyn OAuthAuthority>,
        policy: OAuthPolicy,
        application: Arc<dyn ApplicationPort>,
    ) -> Self {
        Self {
            authority,
            policy,
            application,
        }
    }

    pub async fn call(&self, bearer: &str, request: catalog::Request) -> CallToolResult {
        let identity = match authenticate_oauth_request(
            self.authority.as_ref(),
            bearer,
            &self.policy,
        )
        .await
        {
            Ok(identity) => identity,
            Err(_) => {
                return CallToolResult::structured_error(
                    json!({"code":"unauthorized", "effect":"none", "message":"OAuth authority rejected this request"}),
                );
            }
        };
        if matches!(
            &request,
            catalog::Request::Session(catalog::Session::Context { session_ref: None })
        ) {
            return CallToolResult::structured_error(
                json!({"code":"self_binding_required", "effect":"none", "message":"verified self-session binding required"}),
            );
        }
        self.application.call(&identity, request).await.unwrap_or_else(|| CallToolResult::structured_error(json!({"code":"unsupported", "effect":"none", "message":"operation is not connected"})))
    }
}

/// Read-only configuration-backed operations; no native action is attached.
pub struct ConfigApplication {
    config: Config,
    grants: Vec<Grant>,
}

/// Granting read on this exact resource permits listing all configured nodes.
pub const NODE_DISCOVERY_RESOURCE: &str = "herder:discover:nodes";

impl ConfigApplication {
    /// Grants must come from trusted server policy, never client metadata.
    pub fn new(config: Config, grants: Vec<Grant>) -> Self {
        Self { config, grants }
    }
}

impl ApplicationPort for ConfigApplication {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            match request {
                catalog::Request::Discover(catalog::Discover::Nodes {}) => {
                    if identity
                        .authorize(
                            &self.grants,
                            &PrivateResource::Resource(NODE_DISCOVERY_RESOURCE.into()),
                            Action::Read,
                        )
                        .is_err()
                    {
                        return Some(CallToolResult::structured_error(
                            json!({"code":"unauthorized", "effect":"none", "message":"node discovery requires a read grant"}),
                        ));
                    }
                    let nodes: Vec<_> = self
                        .config
                        .nodes
                        .iter()
                        .map(|node| json!({"id": node.id, "endpoint": node.endpoint}))
                        .collect();
                    Some(CallToolResult::structured(json!({"nodes": nodes})))
                }
                _ => None,
            }
        })
    }
}

struct OwnerIsolation {
    slots: Arc<tokio::sync::Semaphore>,
    read_timeout: Duration,
    mutation_timeout: Duration,
    retry_after: std::sync::Mutex<Option<std::time::Instant>>,
}

#[derive(Clone)]
pub struct NativeServer {
    identity: ConnectionIdentity,
    application: Option<Arc<dyn ApplicationPort>>,
    isolation: Option<Arc<OwnerIsolation>>,
    node_slots: Option<Arc<tokio::sync::Semaphore>>,
}

impl Default for NativeServer {
    fn default() -> Self {
        Self {
            identity: ConnectionIdentity::new(Caller::Unknown, None),
            application: None,
            isolation: None,
            node_slots: None,
        }
    }
}

impl NativeServer {
    /// Caller must come from a trusted authentication boundary, never MCP metadata.
    pub fn with_application(caller: Caller, application: Arc<dyn ApplicationPort>) -> Self {
        Self::with_connection_identity(ConnectionIdentity::new(caller, None), application)
    }

    /// The identity is verified externally and belongs only to this connection.
    pub fn with_connection_identity(
        identity: ConnectionIdentity,
        application: Arc<dyn ApplicationPort>,
    ) -> Self {
        Self {
            identity,
            application: Some(application),
            isolation: None,
            node_slots: None,
        }
    }

    /// Each trusted owner gets its own admission limit. Synchronous adapter I/O
    /// must never run on the MCP executor, including a current-thread runtime.
    pub fn with_owner_isolation(mut self) -> Self {
        self.isolation = Some(Arc::new(OwnerIsolation {
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
            retry_after: Default::default(),
            mutation_timeout: Duration::from_secs(135),
            read_timeout: Duration::from_secs(20),
        }));
        self
    }

    pub fn set_node_slots(&mut self, slots: Arc<tokio::sync::Semaphore>) {
        self.node_slots = Some(slots);
    }

    async fn call_application(
        &self,
        application: &Arc<dyn ApplicationPort>,
        request: catalog::Dispatched,
    ) -> Option<CallToolResult> {
        // These owner-policy operations use verified configuration only, so
        // discovery remains available even when this owner's adapter is busy.
        let local_discovery = matches!(
            &request.request,
            catalog::Request::Discover(
                catalog::Discover::Nodes {} | catalog::Discover::Instances { .. }
            )
        );
        let Some(isolation) = self.isolation.as_ref().filter(|_| !local_discovery) else {
            return application.call(&self.identity, request.request).await;
        };
        let read = request.access == catalog::Access::Read;
        if read && isolation.retry_after.lock().unwrap().is_some_and(|t| std::time::Instant::now() < t) {
            return Some(CallToolResult::structured_error(
                json!({"code":"owner_read_cooling_down","effect":"none"}),
            ));
        }
        let node_permit = match self.node_slots.clone().map(|slots| slots.try_acquire_owned()).transpose() {
            Ok(permit) => permit,
            Err(_) => return Some(CallToolResult::structured_error(
                json!({"code":"node_busy","effect":"none"}),
            )),
        };
        let permit = match isolation.slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return Some(CallToolResult::structured_error(
                json!({"code":"owner_busy","effect":"none","message":"This owner has too many active requests"}),
            )),
        };
        let application = application.clone();
        let identity = self.identity.clone();
        let runtime = tokio::runtime::Handle::current();
        let (_read_lifetime, cancelled) = tokio::sync::oneshot::channel::<()>();
        let mut task = tokio::task::spawn_blocking(move || {
            // Keep admission until the actual work ends, even if its caller
            // times out. Dropping a JoinHandle cannot cancel blocking native I/O.
            let _permits = (permit, node_permit);
            runtime.block_on(async {
                let call = application.call(&identity, request.request);
                if read {
                    tokio::select! {
                        biased;
                        _ = cancelled => None,
                        result = call => result,
                    }
                } else {
                    call.await
                }
            })
        });
        let result = if read {
            match tokio::time::timeout(isolation.read_timeout, task).await {
                Ok(result) => result,
                Err(_) => {
                    *isolation.retry_after.lock().unwrap() = Some(std::time::Instant::now() + isolation.read_timeout);
                    return Some(CallToolResult::structured_error(
                        json!({"code":"owner_read_timeout","effect":"none","message":"Owner read exceeded its response deadline"}),
                    ));
                }
            }
        } else {
            // Submitted mutations retain their durable receipt and execution
            // guard until the adapter reports its bounded outcome. Never replay.
            match tokio::time::timeout(isolation.mutation_timeout, &mut task).await {
                Ok(result) => result,
                Err(_) => {
                    task.abort(); // Cancels only work that has not started.
                    return Some(CallToolResult::structured_error(json!({
                        "code":"owner_response_timeout","effect":"unknown","retry":"read_receipt",
                        "message":"Reconcile the original request key with the ledger and native state"
                    })));
                }
            }
        };
        match result {
            Ok(result) => result,
            Err(_) => Some(CallToolResult::structured_error(
                json!({"code":"owner_execution_unavailable","effect":if read {"none"} else {"unknown"},"retryable":false}),
            )),
        }
    }
}

fn check_metadata(ctx: &RequestContext<RoleServer>) -> Result<(), ErrorData> {
    if !ctx
        .meta
        .missing_required_keys(&ProtocolVersion::V_2026_07_28)
        .is_empty()
    {
        return Err(ErrorData::invalid_params(
            "request metadata requires protocolVersion and clientCapabilities",
            None,
        ));
    }
    if ctx.meta.protocol_version() != Some(ProtocolVersion::V_2026_07_28) {
        return Err(ErrorData::invalid_params(
            "unsupported protocol version",
            None,
        ));
    }
    Ok(())
}

fn tools() -> Vec<Tool> {
    catalog::discovery()
        .into_iter()
        .map(|definition| {
            Tool::new(
                definition.name,
                match definition.name {
                    "automation" => "Herder automation. For long commands use create with rule.kind=process_completion and existing resource claim bindings. After durable armed admission, end the agent turn; Herder renews leases and resumes the same session after completion. Inspect or reconcile the returned rule on an uncertain ACK. Do not poll with model turns, replay the command, or use HumanStop as sleep.".to_owned(),
                    "resource" => "Herder canonical resource ownership: register/get/list, claim/renew/release, advisory declarations, and bind an owned claim to a supervised execution. Reuse the same resource identity for a shared device, deployment, workspace or build slot. Use the current claim ID and descriptor revision; unresolved process occupancy remains exclusive.".to_owned(),
                    _ => format!("Herder {} operation", definition.name),
                },
                definition
                    .input_schema
                    .as_object()
                    .expect("catalog schemas are objects")
                    .clone(),
            )
        })
        .collect()
}

impl ServerHandler for NativeServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("agent-herder", env!("CARGO_PKG_VERSION")),
        )
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools().into_iter().find(|tool| tool.name == name)
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        check_metadata(&ctx)?;
        if request.and_then(|p| p.cursor).is_some() {
            return Err(ErrorData::invalid_params("unknown cursor", None));
        }
        let mut result = ListToolsResult::default();
        result.tools = tools();
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        check_metadata(&ctx)?;
        if request.input_responses.is_some() || request.request_state.is_some() {
            return Err(ErrorData::invalid_params(
                "request continuation is unsupported",
                None,
            ));
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        let parsed = catalog::dispatch(&request.name, input)
            .map_err(|_| ErrorData::invalid_params("unknown tool or invalid arguments", None))?;
        if matches!(
            &parsed.request,
            catalog::Request::Session(catalog::Session::Context { session_ref: None })
        ) {
            if let Err(error) = self.identity.require_self(None) {
                let (code, message) = match error {
                    IdentityError::Unauthorized => ("unauthorized", "verified caller required"),
                    IdentityError::SelfBindingRequired => (
                        "self_binding_required",
                        "verified self-session binding required",
                    ),
                    IdentityError::SelfBindingMismatch => (
                        "self_binding_mismatch",
                        "self-session binding does not match caller",
                    ),
                };
                return Ok(CallToolResult::structured_error(
                    json!({"code":code, "effect":"none", "message":message}),
                )
                .into());
            }
        }
        if let Some(application) = &self.application {
            if parsed.access == catalog::Access::Mutate
                && !matches!(self.identity.caller(), Caller::Principal(_))
            {
                return Ok(CallToolResult::structured_error(json!({"code":"unsupported", "effect":"none", "message":"operation is not connected"})).into());
            }
            let read = parsed.access == catalog::Access::Read;
            let result = tokio::select! {
                biased;
                _ = ctx.ct.cancelled(), if read => return Err(ErrorData::internal_error("Read cancelled", None)),
                result = self.call_application(application, parsed) => result,
            };
            if let Some(result) = result {
                return Ok(result.into());
            }
        }
        Ok(CallToolResult::structured_error(
            json!({"code":"unsupported", "effect":"none", "message":"operation is not connected"}),
        )
        .into())
    }
}

pub async fn serve_stdio() -> Result<(), Box<dyn std::error::Error>> {
    serve_stdio_server(NativeServer::default()).await
}

pub async fn serve_stdio_server(server: NativeServer) -> Result<(), Box<dyn std::error::Error>> {
    server
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::auth::identity::{PrincipalId, VerifiedPrincipal};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};


    struct SlowApplication {
        calls: AtomicUsize,
    }
    impl ApplicationPort for SlowApplication {
        fn call<'a>(
            &'a self,
            _: &'a ConnectionIdentity,
            _: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(200));
                Some(CallToolResult::structured(json!({"completed":true})))
            })
        }
    }

    #[tokio::test]
    async fn timed_out_owner_read_keeps_capacity_and_mutations_keep_their_outcome() {
        let concrete = Arc::new(SlowApplication { calls: AtomicUsize::new(0) });
        let app: Arc<dyn ApplicationPort> = concrete.clone();
        let mut server = NativeServer::with_application(Caller::Unknown, app.clone())
            .with_owner_isolation();
        server.isolation = Some(Arc::new(OwnerIsolation {
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
            retry_after: Default::default(),
            mutation_timeout: Duration::from_secs(135),
            read_timeout: Duration::from_millis(20),
        }));
        let read = || catalog::dispatch("discover", json!({"action":"projects"})).unwrap();
        let started = std::time::Instant::now();
        let result = server.call_application(&app, read()).await.unwrap();
        assert_eq!(result.structured_content.unwrap()["code"], "owner_read_timeout");
        assert!(started.elapsed() < Duration::from_millis(150));
        assert_eq!(server.isolation.as_ref().unwrap().slots.available_permits(), 3);
        let result = server.call_application(&app, read()).await.unwrap();
        assert_eq!(result.structured_content.unwrap()["code"], "owner_read_cooling_down");
        assert_eq!(concrete.calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(220)).await;
        let mutation = catalog::dispatch("stop", json!({
            "action":"stop","session_ref":"fixture","request_key":"fixture"
        })).unwrap();
        let result = server.call_application(&app, mutation).await.unwrap();
        assert_eq!(result.structured_content.unwrap()["completed"], true);
        assert_eq!(concrete.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn mutation_deadline_keeps_node_slot_until_worker_finishes() {
        let concrete = Arc::new(SlowApplication { calls: AtomicUsize::new(0) });
        let app: Arc<dyn ApplicationPort> = concrete.clone();
        let mut owner = NativeServer::with_application(Caller::Unknown, app.clone())
            .with_owner_isolation();
        let node = Arc::new(tokio::sync::Semaphore::new(1));
        owner.set_node_slots(node.clone());
        Arc::get_mut(owner.isolation.as_mut().unwrap()).unwrap().mutation_timeout = Duration::from_millis(60);
        let mut sibling = NativeServer::with_application(Caller::Unknown, app.clone()).with_owner_isolation();
        sibling.set_node_slots(node.clone());
        let mutation = catalog::dispatch("stop", json!({
            "action":"stop","session_ref":"fixture","request_key":"fixture"
        })).unwrap();
        let result = owner.call_application(&app, mutation).await.unwrap();
        assert_eq!(result.structured_content.unwrap()["retry"], "read_receipt");
        let read = catalog::dispatch("discover", json!({"action":"projects"})).unwrap();
        let result = sibling.call_application(&app, read).await.unwrap();
        assert_eq!(result.structured_content.unwrap()["code"], "node_busy");
        // The worker returns the slot when the submitted operation finishes.
        let _permit = tokio::time::timeout(Duration::from_secs(2), node.acquire()).await.unwrap().unwrap();
        assert_eq!(concrete.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn configured_nodes_require_verified_principal_and_exact_read_grant() {
        let config = Config::from_json(r#"{"local_node_id":"one","nodes":[{"id":"one","endpoint":"https://one.invalid","authority":{"principal":"one","secret_ref":null},"instances":[]},{"id":"two","endpoint":"https://two.invalid","authority":{"principal":"two","secret_ref":null},"instances":[]}]}"#).unwrap();
        let alice = Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("alice".into()),
        });
        let bob = Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("bob".into()),
        });
        let grant = Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Resource(NODE_DISCOVERY_RESOURCE.into()),
            action: Action::Read,
        };
        let app = ConfigApplication::new(config.clone(), vec![grant.clone()]);
        for caller in [&Caller::Unknown, &Caller::NodeCredential, &bob] {
            let result = app
                .call(
                    &ConnectionIdentity::new(caller.clone(), None),
                    catalog::Request::Discover(catalog::Discover::Nodes {}),
                )
                .await
                .unwrap();
            assert_eq!(result.is_error, Some(true));
            assert!(
                !serde_json::to_string(&result)
                    .unwrap()
                    .contains("one.invalid")
            );
        }
        let no_grant = ConfigApplication::new(config.clone(), vec![]);
        let denied = no_grant
            .call(
                &ConnectionIdentity::new(alice.clone(), None),
                catalog::Request::Discover(catalog::Discover::Nodes {}),
            )
            .await
            .unwrap();
        assert_eq!(denied.is_error, Some(true));
        for wrong in [
            Grant {
                action: Action::Write,
                ..grant.clone()
            },
            Grant {
                resource: PrivateResource::Resource("other".into()),
                ..grant.clone()
            },
        ] {
            let denied = ConfigApplication::new(config.clone(), vec![wrong])
                .call(
                    &ConnectionIdentity::new(alice.clone(), None),
                    catalog::Request::Discover(catalog::Discover::Nodes {}),
                )
                .await
                .unwrap();
            assert_eq!(denied.is_error, Some(true));
        }

        let server = NativeServer::with_application(alice, Arc::new(app));
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "caller":"bob"});
        let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"nodes"}}});
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["nodes"],
            json!([{"id":"one","endpoint":"https://one.invalid"},{"id":"two","endpoint":"https://two.invalid"}])
        );
        drop(write);
        drop(lines);
        task.await.unwrap();
    }

    struct FakeApp(AtomicUsize);
    impl ApplicationPort for FakeApp {
        fn call<'a>(
            &'a self,
            identity: &'a ConnectionIdentity,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                assert_eq!(*identity.caller(), Caller::Unknown);
                if matches!(
                    request,
                    catalog::Request::Discover(catalog::Discover::Instances { .. })
                ) {
                    return None;
                }
                assert!(matches!(
                    request,
                    catalog::Request::Discover(catalog::Discover::Nodes {})
                ));
                self.0.fetch_add(1, Ordering::SeqCst);
                Some(CallToolResult::structured(json!({"fake": "read"})))
            })
        }
    }

    #[tokio::test]
    async fn wire_injected_app_rejects_before_effect() {
        let app = Arc::new(FakeApp(AtomicUsize::new(0)));
        let server = NativeServer::with_application(Caller::Unknown, app.clone());
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "io.modelcontextprotocol/clientInfo":{"name":"admin", "version":"1"}});
        let mut requests = vec![
            json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":meta}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"nodes"}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"nodes","extra":true}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"s","message":"m","mode":"current","request_key":"k"}}}),
        ];
        let mut old = meta.clone();
        old["io.modelcontextprotocol/protocolVersion"] = json!("2025-06-18");
        requests.push(json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":old,"name":"discover","arguments":{"action":"nodes"}}}));
        requests.push(json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"_meta":meta,"name":"discover","arguments":{"action":"instances"}}}));
        for (index, request) in requests.iter().enumerate() {
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let response: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            match index {
                0 => assert!(response.get("result").is_some(), "{response}"),
                1 => assert_eq!(response["result"]["structuredContent"]["fake"], "read"),
                2 | 4 => assert!(response.get("error").is_some(), "{response}"),
                3 => {
                    assert_eq!(response["result"]["isError"], true);
                    assert_eq!(response["result"]["structuredContent"]["effect"], "none");
                }
                5 => {
                    assert_eq!(response["result"]["isError"], true);
                    assert_eq!(
                        response["result"]["structuredContent"]["code"],
                        "unsupported"
                    );
                    assert_eq!(response["result"]["structuredContent"]["effect"], "none");
                }
                _ => unreachable!(),
            }
        }
        assert_eq!(app.0.load(Ordering::SeqCst), 1);
        drop(write);
        drop(lines);
        task.await.unwrap();
    }
}
