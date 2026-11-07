use herder::{
    application::{
        list::{
            CachedSession, ConfiguredListInventory, ConfiguredSourceBinding, InstanceAvailability,
            ListApplication, ListInventoryPort, NativeListObservation, SourceCoverage,
            compose_configured_inventory,
        },
        target::SessionRegistry,
    },
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    config::Config,
    domain::{
        adapter::{SessionActivity, SessionSnapshot},
        address::{Availability, InstanceRef, NodeRef, SessionAddress, SessionRef},
    },
    mcp::{
        catalog::{Request, Sessions},
        transport::ApplicationPort,
    },
    store::Writer,
};
use rusqlite::{Connection, functions::FunctionFlags};
use std::{num::NonZeroUsize, path::PathBuf};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl Fixture {
    fn new() -> Self {
        Self::with_native("native-1")
    }
    fn with_native(native_id: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "herder-list-v2-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        drop(Writer::create_file(&path).unwrap());
        let c = Connection::open(&path).unwrap();
        c.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(2),
        )
        .unwrap();
        c.execute_batch(include_str!("../src/store/migration_v1_v2.sql"))
            .unwrap();
        c.execute(
            "INSERT INTO session_bindings VALUES ('issued-ref','node-a','profile-a',?1)",
            [native_id],
        )
        .unwrap();
        Self(path)
    }
}
fn instance(node: &str, profile: &str) -> InstanceRef {
    InstanceRef {
        node: NodeRef(node.into()),
        instance_id: profile.into(),
    }
}
fn config() -> Config {
    Config::from_json(r#"{"local_node_id":"node-a","nodes":[{"id":"node-a","endpoint":"https://a.invalid","authority":{"principal":"a","secret_ref":null},"instances":[{"id":"profile-a","kind":"open_code","profile":{"runtime_cwd":"/tmp","worktree_root":"/tmp","endpoint":"http://127.0.0.1:1234","secret_ref":null}}]},{"id":"node-b","endpoint":"https://b.invalid","authority":{"principal":"b","secret_ref":null},"instances":[{"id":"profile-b","kind":"open_code","profile":{"runtime_cwd":"/tmp","worktree_root":"/tmp","endpoint":"http://127.0.0.1:1235","secret_ref":null}}]}]}"#).unwrap()
}
fn bindings() -> Vec<ConfiguredSourceBinding> {
    [
        (
            "node-a",
            "profile-a",
            "node-ref-a",
            "instance-ref-a",
            "acl-a",
        ),
        (
            "node-b",
            "profile-b",
            "node-ref-b",
            "instance-ref-b",
            "acl-b",
        ),
    ]
    .into_iter()
    .map(
        |(node, profile, node_ref, instance_ref, acl)| ConfiguredSourceBinding {
            node_ref: node_ref.into(),
            instance_ref: instance_ref.into(),
            instance: instance(node, profile),
            acl_resource: acl.into(),
        },
    )
    .collect()
}
fn record(id: &str) -> CachedSession {
    CachedSession {
        project_ref: Some("untrusted-native-project".into()),
        observed_at: Some("native-read".into()),
        snapshot: SessionSnapshot {
            address: SessionAddress {
                instance: instance("node-a", "profile-a"),
                native_session_id: id.into(),
            },
            human_stop: false,
            activity: SessionActivity::Unknown,
            capabilities: vec![],
        },
    }
}
fn observations() -> Vec<NativeListObservation> {
    vec![
        NativeListObservation {
            availability: InstanceAvailability {
                instance: instance("node-a", "profile-a"),
                availability: Availability::Available,
                observed_at: Some("now".into()),
                coverage: SourceCoverage::Complete,
            },
            sessions: vec![record("native-1"), record("unregistered")],
        },
        NativeListObservation {
            availability: InstanceAvailability {
                instance: instance("node-b", "profile-b"),
                availability: Availability::Unavailable,
                observed_at: Some("now".into()),
                coverage: SourceCoverage::Unknown,
            },
            sessions: vec![],
        },
    ]
}
#[tokio::test]
async fn sqlite_writer_bindings_control_the_native_mcp_list_and_coverage() {
    let fixture = Fixture::new();
    let writer = Writer::open_file(&fixture.0).unwrap();
    let reference = SessionRef("issued-ref".into());
    assert_eq!(
        writer.resolve(&reference).unwrap().unwrap(),
        record("native-1").snapshot.address
    );
    let inventory = compose_configured_inventory(
        &config(),
        &bindings(),
        &observations(),
        &[reference.clone()],
        &writer,
    )
    .unwrap();
    assert_eq!(inventory.records.len(), 1);
    assert_eq!(inventory.records[0].session_ref, reference);
    assert_eq!(inventory.records[0].cached.project_ref, None);
    assert_eq!(
        inventory.sources[0].observation.as_ref().unwrap().coverage,
        SourceCoverage::Incomplete
    );
    assert_eq!(
        inventory.sources[1]
            .observation
            .as_ref()
            .unwrap()
            .availability,
        Availability::Unavailable
    );
    let alice = PrincipalId("alice".into());
    let grants = vec![
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Resource("acl-a".into()),
            action: Action::Read,
        },
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Resource("acl-b".into()),
            action: Action::Read,
        },
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Session(reference.clone()),
            action: Action::Read,
        },
    ];
    let composed = ConfiguredListInventory::new(
        config(),
        bindings(),
        observations(),
        vec![reference.clone()],
        writer,
    );
    let app = ListApplication::new(composed, grants, NonZeroUsize::new(10).unwrap());
    let identity =
        ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal { id: alice }), None);
    let result = app
        .call(
            &identity,
            Request::Sessions(Sessions::List {
                project_ref: None,
                node_ref: None,
                instance_ref: None,
                cursor: None,
            }),
        )
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(result["sessions"][0]["session_ref"], "issued-ref");
    assert!(result["sessions"][0]["project_ref"].is_null());
    assert_eq!(result["sources"][1]["availability"], "unavailable");
    assert_eq!(result["coverage_complete"], false);
    assert!(!result.to_string().contains("unregistered"));
}

#[test]
fn trusted_refresh_changes_future_views_without_changing_old_snapshot() {
    let fixture = Fixture::new();
    let source = ConfiguredListInventory::new(
        config(),
        bindings(),
        observations(),
        vec![SessionRef("issued-ref".into())],
        Writer::open_file(&fixture.0).unwrap(),
    );
    let old = source.snapshot().unwrap();
    let mut updated = observations();
    updated[0].availability.availability = Availability::Unavailable;
    updated[0].availability.coverage = SourceCoverage::Unknown;
    updated[0].sessions.clear();
    source.replace_native_observations(updated).unwrap();
    let current = source.snapshot().unwrap();
    assert_eq!(old.records.len(), 1);
    assert_eq!(
        old.sources[0].observation.as_ref().unwrap().availability,
        Availability::Available
    );
    assert!(current.records.is_empty());
    assert_eq!(
        current.sources[0]
            .observation
            .as_ref()
            .unwrap()
            .availability,
        Availability::Unavailable
    );
    assert_eq!(
        current.sources[0].observation.as_ref().unwrap().coverage,
        SourceCoverage::Unknown
    );
}

#[test]
fn missing_invalid_and_unavailable_bindings_fail_closed() {
    let f = Fixture::new();
    let writer = Writer::open_file(&f.0).unwrap();
    let known = SessionRef("issued-ref".into());
    assert!(matches!(
        compose_configured_inventory(
            &config(),
            &bindings()[..1],
            &observations(),
            &[known.clone()],
            &writer
        ),
        Err("missing_source_binding")
    ));
    assert!(matches!(
        compose_configured_inventory(
            &config(),
            &bindings(),
            &observations(),
            &[SessionRef("absent".into())],
            &writer
        ),
        Err("binding_missing")
    ));
    let v1 = Writer::temporary().unwrap();
    assert!(matches!(
        compose_configured_inventory(&config(), &bindings(), &observations(), &[known], &v1),
        Err("registry_unavailable")
    ));
    assert!(matches!(
        compose_configured_inventory(&config(), &bindings(), &observations(), &[], &writer),
        Err("binding_inventory_unavailable")
    ));
}

#[tokio::test]
#[ignore = "starts isolated OpenCode and a disposable v2 fixture; requires HERDER_TEST_OPENCODE_BIN"]
async fn live_opencode_reader_sqlite_writer_and_mcp_share_the_same_binding() {
    use herder::{
        adapters::opencode::{
            connection::{OpenCodeAuth, OpenCodeConnection},
            read::OpenCodeSessionReader,
        },
        application::list::collect_opencode_list,
        mcp::transport::NativeServer,
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
        dir: PathBuf,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    let dir = std::env::temp_dir().join(format!(
        "herder-list-compose-{}-{}",
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
    let child = Command::new(std::env::var("HERDER_TEST_OPENCODE_BIN").unwrap())
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
    assert!(ready);
    let created: Value = client
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
    let native_id = created["data"]["id"].as_str().unwrap();
    let fixture = Fixture::with_native(native_id); // test-only preseed, not a production issuer
    let mut configuration = config();
    configuration.nodes[0].instances[0].profile.endpoint = Some(base);
    let connection = OpenCodeConnection::open(
        instance("node-a", "profile-a"),
        &configuration.nodes[0].instances[0].profile,
        Some(OpenCodeAuth::new("opencode", "isolated-test-only")),
    )
    .await
    .unwrap();
    let observed = collect_opencode_list(
        &OpenCodeSessionReader::new(connection),
        "native-read".into(),
        "v031c".into(),
    )
    .await;
    assert!(
        observed
            .sessions
            .iter()
            .any(|s| s.snapshot.address.native_session_id == native_id)
    );
    let inventory = ConfiguredListInventory::new(
        configuration,
        bindings(),
        vec![observed],
        vec![SessionRef("issued-ref".into())],
        Writer::open_file(&fixture.0).unwrap(),
    );
    let alice = PrincipalId("alice".into());
    let grants = vec![
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Resource("acl-a".into()),
            action: Action::Read,
        },
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Resource("acl-b".into()),
            action: Action::Read,
        },
        Grant {
            principal: alice.clone(),
            resource: PrivateResource::Session(SessionRef("issued-ref".into())),
            action: Action::Read,
        },
    ];
    let server = NativeServer::with_application(
        Caller::Principal(VerifiedPrincipal { id: alice }),
        Arc::new(ListApplication::new(
            inventory,
            grants,
            NonZeroUsize::new(10).unwrap(),
        )),
    );
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
    assert_eq!(
        result["sessions"][0]["session_ref"], "issued-ref",
        "{response}"
    );
    assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(result["sources"][0]["availability"], "available");
    assert_eq!(result["sources"][0]["coverage"], "incomplete");
    assert_eq!(
        result["missing_sources"][0]["instance_ref"],
        "instance-ref-b"
    );
    assert_eq!(result["coverage_complete"], false);
    assert!(!result.to_string().contains(native_id));
    drop(write);
    drop(lines);
    task.await.unwrap();
}
