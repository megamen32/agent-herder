//! Live isolated OpenCode proof. Run explicitly with HERDER_TEST_OPENCODE_BIN set.
use herder::{
    adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        read::OpenCodeSessionReader,
    },
    application::recent::OpenCodeRecentApplication,
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    config::Profile,
    domain::address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    mcp::{
        catalog,
        transport::{ApplicationPort, NativeServer},
    },
};
use rmcp::ServiceExt;
use serde_json::{Value, json};
use std::{
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Cleanup {
    child: Child,
    dir: std::path::PathBuf,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
#[ignore = "starts an isolated local OpenCode instance; requires HERDER_TEST_OPENCODE_BIN"]
async fn native_recent_wire_enforces_acl_and_instance() {
    let binary = std::env::var("HERDER_TEST_OPENCODE_BIN").expect("explicit test binary");
    let dir = std::env::temp_dir().join(format!(
        "herder-read-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    let child = Command::new(binary)
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
        .env("OPENCODE_PASSWORD", "isolated-test-only")
        .env("OPENCODE_SERVER_PASSWORD", "isolated-test-only")
        .current_dir(&dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut cleanup = Cleanup {
        child,
        dir: dir.clone(),
    };
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..100 {
        if client
            .get(format!("{base}/openapi.json"))
            .basic_auth("opencode", Some("isolated-test-only"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ready, "isolated OpenCode did not become ready");
    let create: Value = client
        .post(format!("{base}/api/session"))
        .basic_auth("opencode", Some("isolated-test-only"))
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let session = create["data"]["id"]
        .as_str()
        .expect("native session id")
        .to_owned();
    let instance = InstanceRef {
        node: NodeRef("test-node".into()),
        instance_id: "isolated-a".into(),
    };
    let profile = Profile {
        runtime_cwd: dir.clone(),
        worktree_root: dir.clone(),
        endpoint: Some(base),
        secret_ref: None,
    };
    let reader = OpenCodeSessionReader::new(
        OpenCodeConnection::open(
            instance.clone(),
            &profile,
            Some(OpenCodeAuth::new("opencode", "isolated-test-only")),
        )
        .await
        .unwrap(),
    );
    let target = SessionAddress {
        instance: instance.clone(),
        native_session_id: session,
    };
    let target_ref = SessionRef("opaque-a".into());
    let grant = Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(target_ref.clone()),
        action: Action::Read,
    };
    let other = SessionAddress {
        instance: InstanceRef {
            node: instance.node.clone(),
            instance_id: "isolated-b".into(),
        },
        native_session_id: target.native_session_id.clone(),
    };
    assert!(
        OpenCodeRecentApplication::new(
            reader.clone(),
            target_ref.clone(),
            other,
            vec![grant.clone()]
        )
        .is_err()
    );
    let app =
        Arc::new(OpenCodeRecentApplication::new(reader, target_ref, target, vec![grant]).unwrap());
    let bob = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("bob".into()),
        }),
        None,
    );
    let denied = app
        .call(
            &bob,
            catalog::Request::Session(catalog::Session::Recent {
                session_ref: "opaque-a".into(),
                cursor: None,
            }),
        )
        .await
        .unwrap();
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(denied.structured_content.unwrap()["code"], "unauthorized");
    let alice = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("alice".into()),
        }),
        None,
    );
    let server = NativeServer::with_connection_identity(alice, app);
    let (client_io, server_io) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move {
        server
            .serve(server_io)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let (read, mut write) = tokio::io::split(client_io);
    let mut lines = BufReader::new(read).lines();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"caller":"forged"});
    for (id, target) in [(1, "opaque-a"), (2, "opaque-b")] {
        let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":{"action":"recent","session_ref":target}}});
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        if id == 1 {
            assert_eq!(
                response["result"]["structuredContent"]["session_ref"], "opaque-a",
                "{response}"
            );
            assert_eq!(response["result"]["structuredContent"]["user"], Value::Null);
            assert_eq!(
                response["result"]["structuredContent"]["assistant"],
                Value::Null
            );
            // After successful native read, stop the source: denied requests must
            // still be rejected before attempting native network I/O.
            cleanup.child.kill().unwrap();
            cleanup.child.wait().unwrap();
        } else {
            assert_eq!(
                response["result"]["structuredContent"]["code"], "unauthorized",
                "{response}"
            );
            assert_eq!(response["result"]["structuredContent"]["effect"], "none");
        }
    }
    drop(write);
    drop(lines);
    task.await.unwrap();
}
