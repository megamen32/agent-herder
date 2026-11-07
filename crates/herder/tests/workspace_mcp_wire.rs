use herder::{
    application::workspace::WorkspaceApplication,
    auth::identity::{
        Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
    },
    cli::ownership as offline,
    domain::{
        address::{Authorization, NodeRef},
        resource::{ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope},
    },
    mcp::transport::{ApplicationPort, NativeServer},
    ownership::{
        manifest::{AuthorityRoute, StorageAuthority, StorageId, StorageMarker},
        resource as registry,
    },
};
use rmcp::service::ServiceExt;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    root: PathBuf,
    authority_file: PathBuf,
    authority: StorageAuthority,
    resource: ResourceRef,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-mcp-wire-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("wire-test-storage".into()),
            authority_node: NodeRef("wire-test-node".into()),
            root: root.clone(),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        fs::write(
            root.join("storage.json"),
            serde_json::to_vec(&StorageMarker {
                schema: authority.schema.clone(),
                storage_id: authority.storage_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        let resource = ResourceRef("wire-fixture-resource".into());
        registry::register_or_update(
            &authority,
            ResourceDescriptor::new(
                resource.clone(),
                ResourceScope::Global,
                ResourceKind::Workspace,
                "fixture:wire".into(),
                authority.storage_id.0.clone(),
                None,
                0,
            ),
            Authorization::Authorized,
            None,
        )
        .unwrap();
        let authority_file = root.join("authority.json");
        fs::write(&authority_file, serde_json::to_vec(&authority).unwrap()).unwrap();
        Self {
            root,
            authority_file,
            authority,
            resource,
        }
    }
    fn cli(&self, action: &str, id: &str) -> Value {
        let mut args = vec![
            action.into(),
            "--authority".into(),
            self.authority_file.to_string_lossy().into_owned(),
            "--resource".into(),
            self.resource.0.clone(),
        ];
        if action == "claim" {
            args.extend([
                "--claim-id".into(),
                id.into(),
                "--purpose".into(),
                "wire regression".into(),
            ]);
        }
        offline::execute(&args).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Wire {
    write: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    task: tokio::task::JoinHandle<()>,
}
async fn server(f: &Fixture, principal: &str) -> Wire {
    let identity = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId(principal.into()),
        }),
        None,
    );
    let grant = Grant {
        principal: PrincipalId(principal.into()),
        resource: PrivateResource::Resource(f.resource.0.clone()),
        action: Action::Write,
    };
    let app: Arc<dyn ApplicationPort> =
        Arc::new(WorkspaceApplication::new(f.authority.clone(), vec![grant]));
    let native = NativeServer::with_connection_identity(identity, app);
    let (client, io) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move {
        native.serve(io).await.unwrap().waiting().await.unwrap();
    });
    let (read, write) = tokio::io::split(client);
    Wire {
        write,
        lines: BufReader::new(read).lines(),
        task,
    }
}
async fn call(wire: &mut Wire, id: u64, args: Value) -> Value {
    let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"workspace-wire-test","version":"1"}},"name":"resource","arguments":args}});
    wire.write
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    serde_json::from_str(&wire.lines.next_line().await.unwrap().unwrap()).unwrap()
}
async fn close(wire: Wire) {
    drop(wire.write);
    drop(wire.lines);
    wire.task.await.unwrap();
}

#[tokio::test]
async fn native_tools_call_and_offline_cli_share_claim_owner() {
    let f = Fixture::new();
    let mut alice = server(&f, "alice").await;
    let claim = call(&mut alice, 1, json!({"action":"claim","resource_ref":f.resource,"purpose":"wire owner","request_key":"alice-key"})).await;
    assert_eq!(
        claim["result"]["structuredContent"]["status"], "acquired",
        "{claim}"
    );
    let claim_id = claim["result"]["structuredContent"]["claim_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        f.cli("claim", "123e4567-e89b-42d3-a456-426614174102")["status"],
        "busy"
    );
    close(alice).await;

    let mut bob = server(&f, "bob").await;
    let denied = call(
        &mut bob,
        2,
        json!({"action":"release","resource_ref":f.resource,"claim_id":claim_id}),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true, "{denied}");
    close(bob).await;

    let reopened: StorageAuthority =
        serde_json::from_slice(&fs::read(&f.authority_file).unwrap()).unwrap();
    let current = herder::ownership::claim::read_by_claim_id(
        &reopened,
        &f.resource,
        Authorization::Authorized,
        &claim_id,
    )
    .unwrap();
    assert_eq!(current.unwrap().principal_ref, "alice");
    assert_eq!(f.cli("status", "unused")["status"], "owned");
}
