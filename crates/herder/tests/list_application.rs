use herder::{
    application::list::{
        CachedSession, InstanceAvailability, ListApplication, ListInventory, ListInventoryPort,
        ListRecord, ListSource, SourceCoverage,
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    domain::{
        adapter::{SessionActivity, SessionSnapshot},
        address::{Availability, InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    mcp::{
        catalog::{Request, Sessions},
        transport::{ApplicationPort, NativeServer},
    },
};
use rmcp::ServiceExt;
use serde_json::{Value, json};
use std::{
    num::NonZeroUsize,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture(Arc<AtomicUsize>);
impl ListInventoryPort for Fixture {
    fn snapshot(&self) -> Result<ListInventory, ()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let mut sources = Vec::new();
        let mut records = Vec::new();
        for (node, inst, available) in [
            ("a", "i-a", Some(true)),
            ("b", "i-b", Some(false)),
            ("c", "i-empty", Some(true)),
            ("d", "i-missing", None),
        ] {
            let instance = InstanceRef {
                node: NodeRef(node.into()),
                instance_id: "same".into(),
            };
            sources.push(ListSource {
                node_ref: node.into(),
                instance_ref: inst.into(),
                instance: instance.clone(),
                acl_resource: format!("acl-{inst}"),
                observation: available.map(|ok| InstanceAvailability {
                    instance: instance.clone(),
                    availability: if ok {
                        Availability::Available
                    } else {
                        Availability::Unavailable
                    },
                    observed_at: Some("checked".into()),
                    coverage: if ok {
                        SourceCoverage::Complete
                    } else {
                        SourceCoverage::Unknown
                    },
                }),
            });
            if node == "a" || node == "b" {
                records.push(ListRecord {
                    session_ref: SessionRef(format!("session-{node}")),
                    cached: CachedSession {
                        project_ref: Some(format!("project-{node}/same")),
                        observed_at: Some("cached".into()),
                        snapshot: SessionSnapshot {
                            address: SessionAddress {
                                instance,
                                native_session_id: "same-id".into(),
                            },
                            human_stop: false,
                            activity: SessionActivity::Unknown,
                            capabilities: vec![],
                        },
                    },
                });
            }
        }
        Ok(ListInventory { sources, records })
    }
}
fn principal(name: &str) -> Caller {
    Caller::Principal(VerifiedPrincipal {
        id: PrincipalId(name.into()),
    })
}
fn grants(name: &str) -> Vec<Grant> {
    let id = PrincipalId(name.into());
    ["i-a", "i-b", "i-empty", "i-missing"]
        .into_iter()
        .map(|i| Grant {
            principal: id.clone(),
            resource: PrivateResource::Resource(format!("acl-{i}")),
            action: Action::Read,
        })
        .chain(["session-a", "session-b"].into_iter().map(|i| Grant {
            principal: id.clone(),
            resource: PrivateResource::Session(SessionRef(i.into())),
            action: Action::Read,
        }))
        .collect()
}
fn req(cursor: Option<String>) -> Request {
    Request::Sessions(Sessions::List {
        project_ref: None,
        node_ref: None,
        instance_ref: None,
        cursor,
    })
}

#[tokio::test]
async fn authorized_mcp_list_preserves_coverage_and_cursor_is_private_and_stable() {
    let count = Arc::new(AtomicUsize::new(0));
    let app = Arc::new(ListApplication::new(
        Fixture(count.clone()),
        grants("alice"),
        NonZeroUsize::new(1).unwrap(),
    ));
    let unknown = ConnectionIdentity::new(Caller::Unknown, None);
    let denied = app.call(&unknown, req(None)).await.unwrap();
    assert_eq!(denied.structured_content.unwrap()["code"], "unauthorized");
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let server = NativeServer::with_application(principal("alice"), app.clone());
    let (client, io) = tokio::io::duplex(65536);
    let task =
        tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"caller":"bob"});
    async fn wire(
        write: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
        lines: &mut tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
        request: Value,
    ) -> Value {
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
    }
    let first = wire(&mut write, &mut lines, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":meta,"name":"sessions","arguments":{"action":"list"}}})).await;
    let content = &first["result"]["structuredContent"];
    assert_eq!(content["sessions"][0]["session_ref"], "session-a");
    assert_eq!(content["sources"].as_array().unwrap().len(), 4);
    assert_eq!(content["sources"][1]["availability"], "unavailable");
    assert_eq!(content["sources"][2]["coverage"], "complete");
    assert!(content["sources"][3]["availability"].is_null());
    assert_eq!(
        content["missing_sources"],
        json!([{"node_ref":"d","instance_ref":"i-missing"}])
    );
    assert_eq!(content["coverage_complete"], false);
    let cursor = content["next_cursor"].as_str().unwrap().to_string();
    let bob = ConnectionIdentity::new(principal("bob"), None);
    let rejected = app.call(&bob, req(Some(cursor.clone()))).await.unwrap();
    assert_eq!(rejected.structured_content.unwrap()["code"], "unauthorized");
    let alice = ConnectionIdentity::new(principal("alice"), None);
    let wrong = app
        .call(
            &alice,
            req(Some(format!("{}:999", cursor.split(':').next().unwrap()))),
        )
        .await
        .unwrap();
    assert_eq!(wrong.structured_content.unwrap()["code"], "invalid_cursor");
    let second = wire(&mut write, &mut lines, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"sessions","arguments":{"action":"list","cursor":cursor}}})).await;
    let content2 = &second["result"]["structuredContent"];
    assert_eq!(content2["sessions"][0]["session_ref"], "session-b");
    assert_eq!(content2["sources"], content["sources"]);
    assert_eq!(content2["missing_sources"], content["missing_sources"]);
    assert_eq!(content2["coverage_complete"], false);
    assert!(content2["next_cursor"].is_null());
    let replay = app
        .call(&alice, req(Some(cursor.clone())))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(replay, *content2);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(write);
    drop(lines);
    task.await.unwrap();
}

#[tokio::test]
async fn missing_one_exact_grant_denies_without_partial_leaks() {
    let mut partial = grants("alice");
    partial.retain(|g| g.resource != PrivateResource::Session(SessionRef("session-b".into())));
    let app = ListApplication::new(
        Fixture(Arc::new(AtomicUsize::new(0))),
        partial,
        NonZeroUsize::new(1).unwrap(),
    );
    let result = app
        .call(
            &ConnectionIdentity::new(principal("alice"), None),
            req(None),
        )
        .await
        .unwrap();
    let content = result.structured_content.unwrap();
    assert_eq!(content["code"], "unauthorized");
    assert!(content.get("sessions").is_none());
    let filtered = Request::Sessions(Sessions::List {
        project_ref: Some("project-a/same".into()),
        node_ref: None,
        instance_ref: None,
        cursor: None,
    });
    let result = app
        .call(&ConnectionIdentity::new(principal("alice"), None), filtered)
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(result["code"], "unauthorized");
}

#[tokio::test]
async fn isolated_empty_offline_and_missing_have_distinct_truthful_coverage() {
    let app = ListApplication::new(
        Fixture(Arc::new(AtomicUsize::new(0))),
        grants("alice"),
        NonZeroUsize::new(5).unwrap(),
    );
    let alice = ConnectionIdentity::new(principal("alice"), None);
    for (reference, availability, complete, count) in [
        ("i-empty", Some("available"), true, 0),
        ("i-b", Some("unavailable"), false, 1),
        ("i-missing", None, false, 0),
    ] {
        let request = Request::Sessions(Sessions::List {
            project_ref: None,
            node_ref: None,
            instance_ref: Some(reference.into()),
            cursor: None,
        });
        let result = app
            .call(&alice, request)
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), count);
        assert_eq!(result["coverage_complete"], complete);
        assert_eq!(result["sources"][0]["availability"].as_str(), availability);
    }
}

struct FixedInventory(ListInventory);
impl ListInventoryPort for FixedInventory {
    fn snapshot(&self) -> Result<ListInventory, ()> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
#[ignore = "starts a disposable local OpenCode server; requires HERDER_TEST_OPENCODE_BIN"]
async fn native_opencode_reader_reaches_list_application_over_mcp() {
    use herder::adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        read::OpenCodeSessionReader,
    };
    use herder::config::Profile;
    use std::{
        process::{Child, Command, Stdio},
        time::Duration,
    };
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
    let binary = std::env::var("HERDER_TEST_OPENCODE_BIN").expect("test binary required");
    let dir = std::env::temp_dir().join(format!(
        "herder-list-native-{}-{}",
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
    let _cleanup = Cleanup {
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
    let mut created = Vec::new();
    for _ in 0..2 {
        let value: Value = client
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
        created.push(value["data"]["id"].as_str().unwrap().to_owned());
    }
    let instance = InstanceRef {
        node: NodeRef("test-node".into()),
        instance_id: "test-instance".into(),
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
    let native = reader.list_sessions("v031-native-list").await.unwrap();
    let native_complete = native.next.is_none();
    assert_eq!(native.sessions.len(), 2);
    let records: Vec<_> = native
        .sessions
        .into_iter()
        .map(|s| ListRecord {
            session_ref: SessionRef(format!("opaque-{}", s.address.native_session_id)),
            cached: CachedSession {
                project_ref: Some(s.project_id),
                observed_at: Some("native-read".into()),
                snapshot: SessionSnapshot {
                    address: s.address,
                    human_stop: false,
                    activity: SessionActivity::Unknown,
                    capabilities: vec![],
                },
            },
        })
        .collect();
    let mut allowed = vec![Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Resource("test-instance-acl".into()),
        action: Action::Read,
    }];
    allowed.extend(records.iter().map(|r| Grant {
        principal: PrincipalId("alice".into()),
        resource: PrivateResource::Session(r.session_ref.clone()),
        action: Action::Read,
    }));
    let inventory = ListInventory {
        sources: vec![ListSource {
            node_ref: "test-node-ref".into(),
            instance_ref: "test-instance-ref".into(),
            instance: instance.clone(),
            acl_resource: "test-instance-acl".into(),
            observation: Some(InstanceAvailability {
                instance,
                availability: Availability::Available,
                observed_at: Some("native-read".into()),
                coverage: if native_complete {
                    SourceCoverage::Complete
                } else {
                    SourceCoverage::Incomplete
                },
            }),
        }],
        records,
    };
    let app = Arc::new(ListApplication::new(
        FixedInventory(inventory),
        allowed,
        NonZeroUsize::new(5).unwrap(),
    ));
    let server = NativeServer::with_application(principal("alice"), app);
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
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"sessions","arguments":{"action":"list"}}});
    write
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let response: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    let result = &response["result"]["structuredContent"];
    assert_eq!(result["coverage_complete"], native_complete, "{response}");
    assert_eq!(
        result["sources"][0]["coverage"],
        if native_complete {
            "complete"
        } else {
            "incomplete"
        }
    );
    let refs: Vec<_> = result["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["session_ref"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(refs.len(), 2);
    assert!(
        created
            .iter()
            .all(|id| refs.contains(&format!("opaque-{id}")))
    );
    drop(write);
    drop(lines);
    task.await.unwrap();
}
