//! Direct CDP browser adapter, also available in the packaged native MCP executable.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    herder::adapters::browser::run(std::env::args_os().skip(1)).await
}
