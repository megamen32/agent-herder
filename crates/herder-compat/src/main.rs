//! Compatibility endpoint launcher. The native command is explicit and
//! configured independently of the unchanged downstream MCP client.
use std::env;

use rmcp::{ClientServiceExt, ServiceExt, model::{ClientCapabilities, ClientConfig, Implementation, ProtocolVersion}, service::ClientLifecycleMode, transport::TokioChildProcess};
use tokio::process::Command;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = env::var("HERDER_NATIVE_COMMAND")
        .map_err(|_| "HERDER_NATIVE_COMMAND must name the native Herder MCP executable")?;
    let transport = TokioChildProcess::new(Command::new(command))?;
    let config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::new("herder-compat", env!("CARGO_PKG_VERSION")),
    )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
        ;
    let mut client = config.serve_with_lifecycle(
        transport,
        ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] },
    )
        .await?;
    let native = client.peer().peer_info().ok_or("native endpoint omitted initialize metadata")?;
    if native.protocol_version != ProtocolVersion::V_2026_07_28 {
        return Err(format!("native endpoint negotiated {}, expected {}", native.protocol_version, herder_compat::NATIVE_PROTOCOL).into());
    }
    let server = herder_compat::LegacyEdge::new(client.peer().clone());
    let endpoint = server.serve(rmcp::transport::stdio()).await?;
    let result = endpoint.waiting().await;
    let _ = client.close().await;
    result?;
    Ok(())
}
