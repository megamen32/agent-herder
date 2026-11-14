//! External CLI smoke for the standalone Rust OpenCode read adapter.
//! The test starts a deterministic HTTP fixture, launches the compiled binary,
//! and verifies JSONL readback rather than calling library functions directly.

use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const SESSION_ID: &str = "ses_fixture_001";

struct Fixture {
    endpoint: String,
    paths: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    wake: std::net::SocketAddr,
    task: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let seen = paths.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let task = thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &seen),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            endpoint: format!("http://{address}"),
            paths,
            stop,
            wake: address,
            task: Some(task),
        }
    }

    fn finish(mut self) -> Vec<String> {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.wake);
        self.task.take().unwrap().join().unwrap();
        self.paths.lock().unwrap().clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.wake);
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

fn serve(mut stream: TcpStream, paths: &Arc<Mutex<Vec<String>>>) {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        let count = stream.read(&mut chunk).unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() > 64 * 1024 {
            return;
        }
    }
    let request_line = String::from_utf8_lossy(&bytes)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    paths.lock().unwrap().push(path.clone());
    let body = match path.as_str() {
        "/openapi.json" => r#"{"openapi":"3.1.0","paths":{"/api/session":{"get":{}}}}"#.to_owned(),
        "/api/session" => json!({"data":[session()],"cursor":{"previous":null,"next":null}}).to_string(),
        "/api/session/ses_fixture_001" => session().to_string(),
        "/api/session/ses_fixture_001/message" => json!({"data":[
            {"type":"user","id":"msg_user_001","time":{"created":1700000000000.0},"text":"fixture question"},
            {"type":"assistant","id":"msg_assistant_001","time":{"created":1700000001000.0,"completed":1700000002000.0},"content":[{"type":"text","text":"fixture answer"}]}
        ],"cursor":{"previous":null,"next":null}}).to_string(),
        _ => String::new(),
    };
    let status = if body.is_empty() {
        "404 Not Found"
    } else {
        "200 OK"
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn session() -> Value {
    json!({"id":SESSION_ID,"parentID":null,"projectID":"project-fixture","outcome":null,
        "time":{"created":1700000000000.0,"updated":1700000002000.0,"busy":null,"idle":1700000002000.0,"archived":null},
        "location":{"directory":"/tmp/opencode-fixture"}})
}

#[test]
fn compiled_cli_reads_v2_fixture_over_jsonl_stdio() {
    let fixture = Fixture::start();
    let input = [
        json!({"id":"init-1","method":"init"}),
        json!({"id":"list-1","method":"listSessions"}),
        json!({"id":"session-1","method":"getSession","params":{"id":SESSION_ID}}),
        json!({"id":"messages-1","method":"getSessionMessages","params":{"id":SESSION_ID}}),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";
    let output = Command::new(env!("CARGO_BIN_EXE_herder-opencode-read"))
        .args([
            "--endpoint",
            &fixture.endpoint,
            "--node",
            "fixture-node",
            "--instance",
            "fixture-instance",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
        .tap_stdin(input);
    let output = output.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 4);
    assert_eq!(responses[0]["result"]["protocol"], "v2");
    assert_eq!(responses[0]["result"]["readOnly"], true);
    assert_eq!(
        responses[1]["result"]["sessions"][0]["address"]["native_session_id"],
        SESSION_ID
    );
    assert_eq!(responses[2]["result"]["project_id"], "project-fixture");
    assert_eq!(
        responses[3]["result"]["messages"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        responses[3]["result"]["messages"][1]["text"],
        "fixture answer"
    );
    assert!(
        responses
            .iter()
            .all(|response| response.get("error").is_none()),
        "{responses:?}"
    );
    let paths = fixture.finish();
    assert_eq!(
        paths,
        vec![
            "/openapi.json",
            "/api/session",
            "/api/session/ses_fixture_001",
            "/api/session/ses_fixture_001/message"
        ]
    );
}

trait ChildInput {
    fn tap_stdin(self, input: String) -> std::process::Child;
}

impl ChildInput for std::process::Child {
    fn tap_stdin(mut self, input: String) -> std::process::Child {
        self.stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        self
    }
}
