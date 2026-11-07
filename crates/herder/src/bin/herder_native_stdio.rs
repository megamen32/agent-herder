//! Native MCP stdio entrypoint; no live operations are connected.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    herder::mcp::transport::serve_stdio().await
}
