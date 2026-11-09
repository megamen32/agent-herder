//! Transport regression: explicit session context reaches the authorized
//! application without granting self identity to an account-authenticated call.
use herder::{
    auth::identity::{Caller, ConnectionIdentity, OAuthAuthority, OAuthPolicy, VerifiedOAuthGrant},
    mcp::{
        catalog::{Request, Session},
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

struct Authority {
    revoked: AtomicBool,
}

impl OAuthAuthority for Authority {
    fn verify<'a>(
        &'a self,
        bearer: &'a str,
        policy: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>> {
        Box::pin(async move {
            if bearer != "isolated-test-token" || self.revoked.load(Ordering::SeqCst) {
                return Ok(None);
            }
            Ok(Some(VerifiedOAuthGrant {
                subject: "owner".into(),
                issuer: policy.issuer.clone(),
                audience: policy.audience.clone(),
                scopes: vec![policy.required_scope.clone()],
                expires_at_ms: u64::MAX,
            }))
        })
    }
}

struct ContextApp {
    calls: AtomicUsize,
}

impl ApplicationPort for ContextApp {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Incoming metadata below deliberately claims another principal
            // and conversation. Only verified OAuth evidence reaches this port.
            assert!(matches!(identity.caller(), Caller::Principal(p) if p.id.0 == "owner"));
            assert!(identity.require_self(None).is_err());
            let Request::Session(Session::Context {
                session_ref: Some(session),
            }) = request
            else {
                panic!("transport forwarded a request without an explicit target")
            };
            Some(if session == "session:registered" {
                CallToolResult::structured(json!({
                    "session_ref": session,
                    "is_self": false,
                    "workspace": {"node_ref":"workspace-host","path":"/work/project"}
                }))
            } else {
                CallToolResult::structured_error(json!({"code":"unauthorized","effect":"none"}))
            })
        })
    }
}

struct Server(tokio::task::JoinHandle<()>);

impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn context(client: &reqwest::Client, url: &str, arguments: Value) -> reqwest::Response {
    client
        .post(url)
        .bearer_auth("isolated-test-token")
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{
                "_meta":{
                    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities":{},
                    "io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},
                    "caller":"forged","session_ref":"session:forged"
                },
                "name":"session","arguments":arguments
            }
        }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn explicit_context_preserves_acl_self_boundary_and_per_request_revocation() {
    let authority = Arc::new(Authority {
        revoked: AtomicBool::new(false),
    });
    let app = Arc::new(ContextApp {
        calls: AtomicUsize::new(0),
    });
    let router = herder_http::router(
        authority.clone(),
        OAuthPolicy {
            issuer: "https://fixture.invalid".into(),
            audience: "https://fixture.invalid/mcp".into(),
            required_scope: "owner".into(),
        },
        app.clone(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let implicit = context(&client, &url, json!({"action":"context"})).await;
    assert_eq!(implicit.status(), reqwest::StatusCode::OK);
    let implicit: Value = implicit.json().await.unwrap();
    assert_eq!(
        implicit["result"]["structuredContent"]["code"],
        "self_binding_required"
    );
    assert_eq!(app.calls.load(Ordering::SeqCst), 0);

    let explicit = context(
        &client,
        &url,
        json!({"action":"context","session_ref":"session:registered"}),
    )
    .await;
    assert_eq!(explicit.status(), reqwest::StatusCode::OK);
    assert!(explicit.headers().get("mcp-session-id").is_none());
    let explicit: Value = explicit.json().await.unwrap();
    assert_eq!(
        explicit["result"]["structuredContent"]["session_ref"],
        "session:registered"
    );
    assert_eq!(explicit["result"]["structuredContent"]["is_self"], false);
    assert_eq!(
        explicit["result"]["structuredContent"]["workspace"]["path"],
        "/work/project"
    );
    assert_eq!(app.calls.load(Ordering::SeqCst), 1);

    let foreign = context(
        &client,
        &url,
        json!({"action":"context","session_ref":"session:foreign"}),
    )
    .await;
    assert_eq!(foreign.status(), reqwest::StatusCode::OK);
    let foreign: Value = foreign.json().await.unwrap();
    assert_eq!(
        foreign["result"]["structuredContent"]["code"],
        "unauthorized"
    );
    assert_eq!(app.calls.load(Ordering::SeqCst), 2);

    authority.revoked.store(true, Ordering::SeqCst);
    let revoked = context(
        &client,
        &url,
        json!({"action":"context","session_ref":"session:registered"}),
    )
    .await;
    assert_eq!(revoked.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(app.calls.load(Ordering::SeqCst), 2);
}
