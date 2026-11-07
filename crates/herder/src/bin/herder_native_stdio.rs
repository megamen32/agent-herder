//! Native MCP stdio entrypoint.
use std::{env, io, sync::Arc};

#[cfg(target_os = "linux")]
#[path = "herder_native_stdio/owner_launch.rs"]
mod owner_launch;

#[cfg(target_os = "linux")]
#[path = "herder_native_stdio/owner_policy.rs"]
mod owner_policy;

#[cfg(target_os = "linux")]
#[path = "herder_native_stdio/native_reader.rs"]
mod native_reader;

#[cfg(target_os = "linux")]
#[path = "herder_native_stdio/scoped_profile.rs"]
mod scoped_profile;

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
        #[cfg(target_os = "linux")]
        Some(flag) if flag == "--trusted-owner-profile" => {
            let path = args.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--trusted-owner-profile requires a path",
                )
            })?;
            if args.next().is_some() {
                return Err(
                    io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into(),
                );
            }
            owner_launch::serve(scoped_profile::open_owner(std::path::Path::new(&path))?).await
        }
        Some(flag) if flag == "--config" => {
            let path = args.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "--config requires a path")
            })?;
            #[cfg(target_os = "linux")]
            let scoped = match args.next() {
                None => None,
                Some(flag) if flag == "--scoped-profile" => {
                    let profile = args.next().ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "--scoped-profile requires a path",
                        )
                    })?;
                    Some(scoped_profile::open(std::path::Path::new(&profile))?)
                }
                Some(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unexpected arguments",
                    )
                    .into());
                }
            };
            if args.next().is_some() {
                return Err(
                    io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into(),
                );
            }
            let config = Config::from_json(&std::fs::read_to_string(path)?)?;
            let application = Arc::new(ConfigApplication::new(config, Vec::new()));
            // Keep the verified authority alive for the eventual authenticated
            // scoped application. This launcher grants no caller identity.
            #[cfg(target_os = "linux")]
            let _scoped_authority = scoped;
            let server = NativeServer::with_application(Caller::Unknown, application);
            transport::serve_stdio_server(server).await
        }
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: herder_native_stdio [--config PATH [--scoped-profile PATH]]",
        )
        .into()),
    }
}
