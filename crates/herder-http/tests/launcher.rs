use std::{
    net::TcpListener,
    process::{Command, Stdio},
    time::Duration,
};
#[tokio::test]
async fn ordinary_executable_fails_closed_without_authority() {
    let bin = env!("CARGO_BIN_EXE_herder-http");
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = socket.local_addr().unwrap();
    drop(socket);
    let mut child = Command::new(bin)
        .args(["--listen", &addr.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let client = reqwest::Client::new();
    let mut status = None;
    for _ in 0..40 {
        if let Ok(response)=client.post(format!("http://{addr}/mcp")).bearer_auth("forged").header("x-principal","admin").json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"caller":"admin"}}})).send().await {status=Some(response.status());break}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(status, Some(reqwest::StatusCode::UNAUTHORIZED));
    let denied = Command::new(bin)
        .args(["--listen", "0.0.0.0:0"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!denied.success());
}
