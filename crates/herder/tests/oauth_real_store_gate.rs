//! Real existing OAuth store via a private test-process pipe. Not an HTTP transport.
use herder::{
    auth::identity::{Caller, ConnectionIdentity, OAuthAuthority, OAuthPolicy, VerifiedOAuthGrant},
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort, OAuthRequestGate},
    },
};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use std::{
    future::Future,
    io::{BufRead, BufReader, Write},
    pin::Pin,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
struct Store {
    child: Mutex<(Child, ChildStdin, BufReader<ChildStdout>)>,
}
impl Store {
    fn exchange(&self, request: Value) -> Result<Value, ()> {
        let mut p = self.child.lock().map_err(|_| ())?;
        writeln!(p.1, "{request}").map_err(|_| ())?;
        p.1.flush().map_err(|_| ())?;
        let mut line = String::new();
        p.2.read_line(&mut line).map_err(|_| ())?;
        serde_json::from_str(&line).map_err(|_| ())
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        if let Ok(p) = self.child.get_mut() {
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
            let value=self.exchange(json!({"action":"verify","bearer":bearer,"issuer":policy.issuer,"audience":policy.audience,"scope":policy.required_scope}))?;
            if value.is_null() {
                return Ok(None);
            }
            let text = |key: &str| value[key].as_str().map(str::to_owned).ok_or(());
            Ok(Some(VerifiedOAuthGrant {
                subject: text("subject")?,
                issuer: text("issuer")?,
                audience: text("audience")?,
                scopes: value["scopes"]
                    .as_array()
                    .ok_or(())?
                    .iter()
                    .map(|s| s.as_str().map(str::to_owned).ok_or(()))
                    .collect::<Result<_, _>>()?,
                expires_at_ms: value["expires_at_ms"].as_u64().ok_or(())?,
            }))
        })
    }
}
struct App(AtomicUsize);
impl ApplicationPort for App {
    fn call<'a>(
        &'a self,
        id: &'a ConnectionIdentity,
        _request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            let subject = match id.caller() {
                Caller::Principal(p) => p.id.0.clone(),
                _ => panic!("unverified"),
            };
            assert!(id.require_self(None).is_err());
            Some(CallToolResult::structured(json!({"subject":subject})))
        })
    }
}
#[tokio::test]
#[ignore = "requires compiled existing McpOAuthTokenStore and node"]
async fn real_store_revocation_denies_same_gate_before_application() {
    let module = std::env::var("HERDER_OAUTH_STORE_MODULE").expect("path to built existing store");
    let dir = std::env::temp_dir().join(format!(
        "herder-oauth-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oauth_store_fixture.mjs");
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
    let mut first = String::new();
    output.read_line(&mut first).unwrap();
    let token: Value = serde_json::from_str(&first).unwrap();
    let token = token["access"].as_str().unwrap().to_owned();
    let store = Arc::new(Store {
        child: Mutex::new((child, input, output)),
    });
    let app = Arc::new(App(AtomicUsize::new(0)));
    let gate = OAuthRequestGate::new(
        store.clone(),
        OAuthPolicy {
            issuer: "https://test.invalid".into(),
            audience: "https://test.invalid/mcp".into(),
            required_scope: "agent-herder:owner".into(),
        },
        app.clone(),
    );
    let request = || {
        catalog::Request::Session(catalog::Session::Recent {
            session_ref: "test".into(),
            cursor: None,
        })
    };
    let first = gate.call(&token, request()).await;
    assert_eq!(first.structured_content.unwrap()["subject"], "alice");
    assert_eq!(
        store.exchange(json!({"action":"revoke"})).unwrap()["ok"],
        true
    );
    let second = gate.call(&token, request()).await;
    assert_eq!(second.is_error, Some(true));
    let result = second.structured_content.unwrap();
    assert_eq!(result["code"], "unauthorized");
    assert_eq!(result["effect"], "none");
    assert_eq!(app.0.load(Ordering::SeqCst), 1);
    drop(gate);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
