//! Native MCP stdio entrypoint.
use std::{env, io, sync::Arc};

use herder::{
    auth::identity::Caller,
    config::Config,
    mcp::transport::{self, ConfigApplication, NativeServer},
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    match args.next() {
        None => transport::serve_stdio().await,
        Some(flag) if flag == "--config" => {
            let path = args.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "--config requires a path")
            })?;
            if args.next().is_some() {
                return Err(
                    io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into(),
                );
            }
            let config = Config::from_json(&std::fs::read_to_string(path)?)?;
            let server = NativeServer::with_application(
                Caller::Unknown,
                Arc::new(ConfigApplication::new(config, Vec::new())),
            );
            transport::serve_stdio_server(server).await
        }
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: herder_native_stdio [--config PATH]",
        )
        .into()),
    }
}
