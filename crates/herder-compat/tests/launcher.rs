#![cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};
use rmcp::{ServiceExt, model::{ClientCapabilities, ClientConfig, Implementation, ProtocolVersion}, transport::TokioChildProcess};
use tokio::process::Command;

#[tokio::test]
async fn trusted_launcher_arguments_reach_native_process_verbatim() {
    let root = std::env::temp_dir().join(format!("herder-compat-argv-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let script = root.join("native-launcher");
    // Whitespace and shell syntax remain one literal argv element.
    let profile = root.join("profile with spaces $(never-execute).json");
    fs::write(&script, "#!/bin/sh\n[ \"$#\" = 2 ] || exit 31\n[ \"$1\" = --trusted-owner-profile ] || exit 32\n[ \"$2\" = \"$EXPECTED_PROFILE\" ] || exit 33\nexec \"$NATIVE_FIXTURE\"\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_herder-compat"));
    command.env("HERDER_NATIVE_COMMAND", &script)
        .env("EXPECTED_PROFILE", &profile)
        .env("NATIVE_FIXTURE", env!("CARGO_BIN_EXE_compat-native-fixture"))
        .args([std::ffi::OsStr::new("--trusted-owner-profile"), profile.as_os_str()]);
    let config = ClientConfig::new(ClientCapabilities::default(), Implementation::new("legacy-sdk", "test"))
        .with_protocol_version(ProtocolVersion::V_2025_06_18);
    let connected = tokio::time::timeout(std::time::Duration::from_secs(5),
        config.serve(TokioChildProcess::new(command).unwrap())).await;
    fs::remove_dir_all(root).unwrap();
    let client = connected.expect("bounded handshake").expect("native received trusted argv");
    assert!(client.peer().list_tools(None).await.unwrap().tools.iter().any(|t| t.name == "compat_task"));
    client.cancel().await.unwrap();
}
