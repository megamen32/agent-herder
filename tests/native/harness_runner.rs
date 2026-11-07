//! Fixture smoke for the public MCP binary. This is not an E001/E002 native test.
//! Run via launch.py so the model endpoint and profile are isolated.
//! Build with `cargo build --manifest-path tests/native/Cargo.toml` and
//! `cargo build --manifest-path crates/herder/Cargo.toml --bin herder_native_stdio`;
//! pass the absolute runner and server paths to `python3 tests/native/launch.py --`.
use serde_json::{Value, json};
use std::{
    env,
    error::Error,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let binary = env::args_os()
        .nth(1)
        .ok_or("expected absolute path to herder_native_stdio")?;
    if !std::path::Path::new(&binary).is_absolute() {
        return Err("MCP binary path must be absolute".into());
    }
    let base = env::var("HERDER_TEST_MODEL_BASE_URL")?;
    let authority = base
        .strip_prefix("http://127.0.0.1:")
        .and_then(|s| s.strip_suffix("/v1"))
        .ok_or("fixture endpoint must be loopback /v1")?;
    let port: u16 = authority.parse()?;
    if port == 0 {
        return Err("invalid fixture port".into());
    }
    // Independently check the shared model fixture; no claim that MCP calls it.
    let mut http = TcpStream::connect(("127.0.0.1", port))?;
    http.set_read_timeout(Some(Duration::from_secs(5)))?;
    http.write_all(b"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut response = String::new();
    http.read_to_string(&mut response)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("invalid model response")?;
    if !headers.starts_with("HTTP/1.1 200 ")
        || serde_json::from_str::<Value>(body)?["data"][0]["id"] != "herder-test"
    {
        return Err("unexpected model fixture response".into());
    }

    let mut server = Server(
        Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?,
    );
    let mut input = server.0.stdin.take().ok_or("missing stdin")?;
    let output = server.0.stdout.take().ok_or("missing stdout")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "io.modelcontextprotocol/clientInfo":{"name":"native-harness-runner","version":"1"}});
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":meta}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":meta}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"deliver","arguments":{"action":"session","session_ref":"fixture-only","message":"fixture-only","mode":"current","request_key":"fixture-only"}}}),
    ];
    for (i, request) in requests.iter().enumerate() {
        writeln!(input, "{request}")?;
        input.flush()?;
        let line = rx.recv_timeout(Duration::from_secs(10))??;
        let value: Value = serde_json::from_str(&line)?;
        if value["id"] != (i + 1) || !value["error"].is_null() {
            return Err(format!("unexpected MCP response: {value}").into());
        }
        match i {
            0 if value["result"]["supportedVersions"] == json!(["2026-07-28"]) => (),
            1 if value["result"]["tools"]
                .as_array()
                .is_some_and(|t| t.iter().any(|tool| tool["name"] == "deliver")) =>
            {
                ()
            }
            2 if value["result"]["isError"] == true
                && value["result"]["structuredContent"]["code"] == "unsupported"
                && value["result"]["structuredContent"]["effect"] == "none" =>
            {
                ()
            }
            _ => return Err(format!("unexpected MCP result: {value}").into()),
        }
    }
    drop(input);
    let status = server.0.wait()?;
    if !status.success() {
        return Err(format!("MCP server exited: {status}").into());
    }
    println!(
        "fixture model=herder-test; public Rust MCP discovery/tools=ok; deliver=unsupported effect=none; E001/E002 not executed"
    );
    Ok(())
}
