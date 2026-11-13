//! Native MCP stdio entrypoint.
use std::{env, io, sync::Arc};

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_opencode.rs"]
mod owner_opencode;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_multi.rs"]
mod owner_multi;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_reads.rs"]
mod owner_reads;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_registration.rs"]
mod owner_registration;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_launch.rs"]
mod owner_launch;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_policy.rs"]
mod owner_policy;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/native_reader.rs"]
mod native_reader;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/scoped_profile.rs"]
mod scoped_profile;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "herder_native_stdio/owner_enroll.rs"]
mod owner_enroll;

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
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        Some(flag) if flag == "--trusted-owner-profile" => {
            let path = args.next().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--trusted-owner-profile requires a path",
                )
            })?;
            let mut profiles = vec![scoped_profile::open_owner(std::path::Path::new(&path))?];
            while let Some(flag) = args.next() {
                if flag != "--trusted-owner-profile" {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into());
                }
                let path = args.next().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput,
                    "--trusted-owner-profile requires a path"))?;
                profiles.push(scoped_profile::open_owner(std::path::Path::new(&path))?);
            }
            if profiles.len() == 1 {
                owner_launch::serve(profiles.remove(0)).await
            } else {
                owner_multi::serve(profiles).await
            }
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        Some(flag) if flag == "--enroll-existing-owner-profile" => {
            let path = args.next().ok_or("--enroll-existing-owner-profile requires a path")?;
            let selection = args.next().ok_or(
                "existing-session enrollment requires --request-key KEY or --all-approved",
            )?;
            if selection == "--all-approved" {
                if args.next().is_some() {
                    return Err("--all-approved cannot be combined with other enrollment arguments".into());
                }
                let opened = scoped_profile::open_owner(std::path::Path::new(&path))?;
                let stdout = io::stdout();
                owner_enroll::run_all(opened, &mut stdout.lock())
            } else if selection == "--request-key" {
                let key = args.next().ok_or("--request-key requires an exact profile entry key")?
                    .into_string().map_err(|_| "invalid request key encoding")?;
                if args.next().is_some() { return Err("unexpected arguments".into()) }
                let opened = scoped_profile::open_owner(std::path::Path::new(&path))?;
                let receipt = owner_enroll::run(opened, &key)?;
                println!("{}", serde_json::to_string(&receipt)?);
                Ok(())
            } else {
                Err("existing-session enrollment requires --request-key KEY or --all-approved".into())
            }
        }
        Some(flag) if flag == "--config" => {
            let path = args.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "--config requires a path")
            })?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
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
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let _scoped_authority = scoped;
            let server = NativeServer::with_application(Caller::Unknown, application);
            transport::serve_stdio_server(server).await
        }
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: herder_native_stdio [--config PATH [--scoped-profile PATH]] | --trusted-owner-profile PATH ... | --enroll-existing-owner-profile PATH (--request-key KEY | --all-approved)",
        )
        .into()),
    }
}
