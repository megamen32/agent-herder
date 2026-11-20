//! External smoke for the full Rust Codex consumer.
//!
//! The fixture is deliberately deterministic. It verifies the JSONL boundary,
//! native input projection for an attachment, exact interrupt routing, and
//! serialized history without contacting a real model.

use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

fn fixture_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "herder-codex-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn fixture_script() -> &'static str {
    r##"#!/usr/bin/python3
import json
import os
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"codexHome": os.path.realpath(os.environ["CODEX_HOME"])}
    elif method == "thread/list":
        result = {"data": [{"id": "thread-existing", "cwd": "/fixture", "status": {"type": "idle"}}]}
    elif method == "thread/items/list":
        p = request["params"]
        if p["sortDirection"] == "desc":
            assert p["threadId"] == "thread-existing" and p["limit"] == 100
            end = {"older /+": 105, "oldest": 5}[p["cursor"]] if p.get("cursor") else 205
            start = max(0, end - 100)
            result = {"data": [{"turnId": "turn-existing", "item": {"type": "agentMessage", "id": str(i), "text": str(i)}} for i in reversed(range(start, end))],
                      "nextCursor": {105: "older /+", 5: "oldest", 0: None}[start], "backwardsCursor": "native-reverse"}
        else:
            assert p["sortDirection"] == "asc" and p["limit"] == 10
            result = {"data": [
                {"turnId": "turn-existing", "item": {"type": "userMessage", "id": "item-user", "content": [{"type": "text", "text": "hello"}]}},
                {"turnId": "turn-existing", "item": {"type": "agentMessage", "id": "item-assistant", "text": "world"}},
            ]}
    elif method == "thread/start":
        result = {"thread": {"id": "thread-created"}}
    elif method == "turn/start":
        with open(os.path.join(os.environ["CODEX_HOME"], "turn-start.json"), "w") as log:
            json.dump(request["params"], log)
        result = {"turn": {"id": "turn-started"}}
    elif method == "thread/turns/list":
        result = {"data": [{"id": "turn-started", "status": "inProgress"}]}
    elif method == "turn/interrupt":
        with open(os.path.join(os.environ["CODEX_HOME"], "interrupt.json"), "w") as log:
            json.dump(request["params"], log)
        result = {}
    else:
        result = {}
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
"##
}

fn run_cli(root: &PathBuf, attachment: &PathBuf) -> (Vec<Value>, std::process::ExitStatus) {
    let home = root.join("home");
    let cwd = root.join("cwd");
    let executable = root.join("fixture-codex");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    fs::write(&executable, fixture_script()).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

    let requests = [
        json!({"id":"init","method":"init"}),
        json!({"id":"list","method":"listThreads","params":{"limit":10}}),
        json!({"id":"messages","method":"getMessages","params":{"id":"thread-existing","limit":10}}),
        json!({"id":"create","method":"createThread","params":{"request_key":"create-1"}}),
        json!({"id":"deliver","method":"deliver","params":{"id":"thread-created","message":"read it","request_key":"deliver-1","attachments":[{"kind":"file","file_name":"notes.txt","path":attachment}]}}),
        json!({"id":"stop","method":"stop","params":{"id":"thread-created","turn_id":"turn-started"}}),
        json!({"id":"latest","method":"getMessages","params":{"id":"thread-existing","sortDirection":"desc","limit":100}}),
        json!({"id":"older","method":"getMessages","params":{"id":"thread-existing","sortDirection":"desc","limit":100,"cursor":"older /+"}}),
        json!({"id":"oldest","method":"getMessages","params":{"id":"thread-existing","sortDirection":"desc","limit":100,"cursor":"oldest"}}),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let mut child = Command::new(env!("CARGO_BIN_EXE_herder-codex"))
        .args([
            "--executable",
            executable.to_str().unwrap(),
            "--code-home",
            home.to_str().unwrap(),
            "--cwd",
            cwd.to_str().unwrap(),
            "--node",
            "fixture-node",
            "--instance",
            "fixture-instance",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    (responses, output.status)
}

#[test]
fn compiled_cli_runs_full_codex_consumer_surface() {
    let root = fixture_root();
    fs::create_dir_all(&root).unwrap();
    let attachment = root.join("notes.txt");
    fs::write(&attachment, "fixture attachment").unwrap();
    let (responses, status) = run_cli(&root, &attachment);
    assert!(status.success());
    assert_eq!(responses.len(), 9);
    for (index, first, count, next) in [
        (6, 204, 100, Some("older /+")),
        (7, 104, 100, Some("oldest")),
        (8, 4, 5, None),
    ] {
        let page = &responses[index]["result"];
        assert_eq!(page["data"].as_array().unwrap().len(), count);
        assert_eq!(page["data"][0]["id"], first.to_string());
        assert_eq!(page["next_cursor"], json!(next));
        assert_eq!(page["backwards_cursor"], "native-reverse");
    }
    assert_eq!(responses[0]["result"]["readOnly"], false);
    assert_eq!(responses[0]["result"]["capabilities"]["files"], true);
    assert_eq!(responses[1]["result"]["data"][0]["id"], "thread-existing");
    assert_eq!(responses[2]["result"]["data"][1]["role"], "assistant");
    assert_eq!(responses[3]["result"]["outcome"], "confirmed");
    assert_eq!(
        responses[3]["result"]["native_session_id"],
        "thread-created"
    );
    assert_eq!(responses[4]["result"]["outcome"], "confirmed");
    assert_eq!(responses[4]["result"]["native_id"], "turn-started");
    assert_eq!(responses[5]["result"]["outcome"], "interrupted");

    let turn_start: Value =
        serde_json::from_str(&fs::read_to_string(root.join("home/turn-start.json")).unwrap())
            .unwrap();
    assert_eq!(turn_start["input"][1]["type"], "mention");
    assert_eq!(turn_start["input"][1]["name"], "notes.txt");
    assert_eq!(turn_start["input"][1]["path"], attachment.to_str().unwrap());
    let interrupt: Value =
        serde_json::from_str(&fs::read_to_string(root.join("home/interrupt.json")).unwrap())
            .unwrap();
    assert_eq!(
        interrupt,
        json!({"threadId":"thread-created","turnId":"turn-started"})
    );
    let _ = fs::remove_dir_all(root);
}
