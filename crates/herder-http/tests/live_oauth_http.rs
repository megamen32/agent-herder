//! Isolated real store + isolated native OpenCode + streamable HTTP proof.
use herder::{
    adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        read::OpenCodeSessionReader,
    },
    application::recent::OpenCodeRecentApplication,
    auth::identity::{
        Action, Grant, OAuthAuthority, OAuthPolicy, PrincipalId, PrivateResource,
        VerifiedOAuthGrant,
    },
    config::Profile,
    domain::address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    io::{BufRead, BufReader, Write},
    pin::Pin,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
struct Store(Arc<Mutex<(Child, ChildStdin, BufReader<ChildStdout>)>>);
impl Store {
    fn exchange(&self, v: Value) -> Result<Value, ()> {
        exchange(&self.0, v)
    }
}
fn exchange(
    channel: &Mutex<(Child, ChildStdin, BufReader<ChildStdout>)>,
    v: Value,
) -> Result<Value, ()> {
    let mut p = channel.lock().map_err(|_| ())?;
    writeln!(p.1, "{v}").map_err(|_| ())?;
    p.1.flush().map_err(|_| ())?;
    let mut line = String::new();
    p.2.read_line(&mut line).map_err(|_| ())?;
    serde_json::from_str(&line).map_err(|_| ())
}
impl Drop for Store {
    fn drop(&mut self) {
        if let Ok(mut p) = self.0.lock() {
            let _ = p.0.kill();
            let _ = p.0.wait();
        }
    }
}
impl OAuthAuthority for Store {
    fn verify<'a>(
        &'a self,
        bearer: &'a str,
        policy: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>> {
        Box::pin(async move {
            let channel = self.0.clone();
            let request = json!({"action":"verify","bearer":bearer,"issuer":policy.issuer,"audience":policy.audience,"scope":policy.required_scope});
            let v = tokio::task::spawn_blocking(move || exchange(&channel, request))
                .await
                .map_err(|_| ())??;
            if v.is_null() {
                return Ok(None);
            }
            let s = |k: &str| v[k].as_str().map(str::to_owned).ok_or(());
            Ok(Some(VerifiedOAuthGrant {
                subject: s("subject")?,
                issuer: s("issuer")?,
                audience: s("audience")?,
                scopes: v["scopes"]
                    .as_array()
                    .ok_or(())?
                    .iter()
                    .map(|x| x.as_str().map(str::to_owned).ok_or(()))
                    .collect::<Result<_, _>>()?,
                expires_at_ms: v["expires_at_ms"].as_u64().ok_or(())?,
            }))
        })
    }
}
struct Fixture {
    child: Child,
    dir: std::path::PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
#[tokio::test]
#[ignore = "requires existing built OAuth store and OpenCode executables"]
async fn real_store_http_recent_and_revoke_same_http_connection() {
    let module = std::env::var("HERDER_OAUTH_STORE_MODULE").unwrap();
    let opencode = std::env::var("HERDER_TEST_OPENCODE_BIN").unwrap();
    let dir = std::env::temp_dir().join(format!(
        "herder-http-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let child = Command::new(opencode)
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &dir)
        .env("XDG_CONFIG_HOME", dir.join("config"))
        .env("XDG_DATA_HOME", dir.join("data"))
        .env("XDG_STATE_HOME", dir.join("state"))
        .env("XDG_CACHE_HOME", dir.join("cache"))
        .env("OPENCODE_SERVER_PASSWORD", "fixture-only")
        .env("OPENCODE_PASSWORD", "fixture-only")
        .current_dir(&dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut fixture = Fixture {
        child,
        dir: dir.clone(),
    };
    let native = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..100 {
        if client
            .get(format!("{native}/openapi.json"))
            .basic_auth("opencode", Some("fixture-only"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await
    }
    assert!(ready);
    let created: Value = client
        .post(format!("{native}/api/session"))
        .basic_auth("opencode", Some("fixture-only"))
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let native_id = created["data"]["id"].as_str().unwrap().to_string();
    let instance = InstanceRef {
        node: NodeRef("test-node".into()),
        instance_id: "fixture".into(),
    };
    let profile = Profile {
        runtime_cwd: dir.clone(),
        worktree_root: dir.clone(),
        endpoint: Some(native),
        secret_ref: None,
    };
    let reader = OpenCodeSessionReader::new(
        OpenCodeConnection::open(
            instance.clone(),
            &profile,
            Some(OpenCodeAuth::new("opencode", "fixture-only")),
        )
        .await
        .unwrap(),
    );
    let target = SessionRef("target-a".into());
    let app = Arc::new(
        OpenCodeRecentApplication::new(
            reader,
            target.clone(),
            SessionAddress {
                instance,
                native_session_id: native_id,
            },
            vec![Grant {
                principal: PrincipalId("alice".into()),
                resource: PrivateResource::Session(target),
                action: Action::Read,
            }],
        )
        .unwrap(),
    );
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../herder/tests/oauth_store_fixture.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .arg(module)
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let token: Value = serde_json::from_str(&line).unwrap();
    let token = token["access"].as_str().unwrap().to_owned();
    let store = Arc::new(Store(Arc::new(Mutex::new((child, input, output)))));
    let policy = OAuthPolicy {
        issuer: "https://test.invalid".into(),
        audience: "https://test.invalid/mcp".into(),
        required_scope: "agent-herder:owner".into(),
    };
    let peers = Arc::new(Mutex::new(Vec::<std::net::SocketAddr>::new()));
    let observed = peers.clone();
    let router = herder_http::router(store.clone(), policy, app).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let observed = observed.clone();
            async move {
                let peer = request
                    .extensions()
                    .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                    .unwrap()
                    .0;
                observed.lock().unwrap().push(peer);
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let http_client = reqwest::Client::builder().http1_only().build().unwrap();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"},"caller":"forged"});
    let recent = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"recent","session_ref":"target-a"}}});
    let response = http_client
        .post(&url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&recent)
        .send()
        .await
        .unwrap();
    if response.status() != 200 {
        panic!(
            "HTTP {}: {}",
            response.status(),
            response.text().await.unwrap()
        );
    }
    assert!(response.headers().get("mcp-session-id").is_none());
    let text = response.text().await.unwrap();
    let body: Value = serde_json::from_str(
        text.lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap_or(&text),
    )
    .unwrap_or_else(|_| panic!("invalid response: {text}"));
    assert_eq!(
        body["result"]["structuredContent"]["session_ref"], "target-a",
        "{body}"
    );
    assert_eq!(body["result"]["structuredContent"]["user"], Value::Null);
    let foreign = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"recent","session_ref":"other-target"}}});
    let denied = http_client
        .post(&url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&foreign)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 200);
    let denied: Value = denied.json().await.unwrap();
    assert_eq!(
        denied["result"]["structuredContent"]["code"],
        "unauthorized"
    );
    assert_eq!(denied["result"]["structuredContent"]["effect"], "none");
    assert_eq!(
        store.exchange(json!({"action":"revoke"})).unwrap()["ok"],
        true
    );
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    let response = http_client
        .post(&url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&recent)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let _ = response.bytes().await.unwrap();
    let authority_pid = store.0.lock().unwrap().0.id().to_string();
    assert!(
        Command::new("kill")
            .args(["-STOP", &authority_pid])
            .status()
            .unwrap()
            .success()
    );
    let started = std::time::Instant::now();
    let stalled_response = http_client
        .post(&url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&recent)
        .send()
        .await;
    let continued = Command::new("kill")
        .args(["-CONT", &authority_pid])
        .status()
        .unwrap()
        .success();
    assert!(continued);
    let stalled_response = stalled_response.unwrap();
    assert_eq!(stalled_response.status(), 401);
    let _ = stalled_response.bytes().await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(7),
        "authority timeout was not bounded"
    );
    {
        let mut authority = store.0.lock().unwrap();
        authority.0.kill().unwrap();
        authority.0.wait().unwrap();
    }
    let response = http_client
        .post(&url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "session")
        .json(&recent)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let observed = peers.lock().unwrap();
    assert_eq!(observed.len(), 5);
    assert!(
        observed.iter().all(|peer| peer == &observed[0]),
        "HTTP connection was not reused"
    );
    server.abort();
    drop(store);
}
