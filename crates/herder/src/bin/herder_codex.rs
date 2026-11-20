//! Full Rust Codex consumer over bounded JSONL stdio.
//!
//! Pure request projection stays separate from the instance-bound app-server
//! effects. Native mutations return explicit UNKNOWN outcomes and this process
//! never retries them.

use herder::{
    adapters::codex::{
        connection::CodexInstance, control::InterruptOutcome, create::CodexCreateControl,
        read::CodexReader,
    },
    application::target::{NativeCreateControl, NativeCreateOutcome},
    domain::{
        adapter::{DispatchPlan, RequestKey, SendMode},
        address::{InstanceRef, NodeRef, SessionAddress},
    },
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Duration,
};

const USAGE: &str = "usage: herder-codex --executable PATH --code-home PATH --cwd PATH --node NODE --instance INSTANCE";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::parse(std::env::args().skip(1))?;
    let instance = InstanceRef {
        node: NodeRef(options.node.clone()),
        instance_id: options.instance.clone(),
    };
    let process = CodexInstance {
        instance_id: options.instance,
        executable: options.executable,
        code_home: options.code_home,
        cwd: options.cwd,
        socket_path: None,
    };
    let timeout = Duration::from_secs(20);
    let mut adapter: Option<Adapter> = None;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_response(
                    &mut stdout,
                    &Value::Null,
                    Err(format!("invalid JSONL request: {error}")),
                )?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = dispatch(&mut adapter, method, &params, &instance, &process, timeout).await;
        write_response(&mut stdout, &id, result)?;
    }
    Ok(())
}

struct Adapter {
    reader: CodexReader,
    create: CodexCreateControl,
}

async fn dispatch(
    adapter: &mut Option<Adapter>,
    method: &str,
    params: &Value,
    instance: &InstanceRef,
    process: &CodexInstance,
    timeout: Duration,
) -> Result<Value, String> {
    if method == "init" {
        if adapter.is_some() {
            return Err("adapter is already initialized".into());
        }
        let reader = CodexReader::open(process.clone(), timeout).map_err(|e| e.to_string())?;
        let create = CodexCreateControl::open(process.clone(), instance.clone(), timeout)
            .map_err(|e| e.to_string())?;
        *adapter = Some(Adapter { reader, create });
        return Ok(
            json!({"adapter":"rust-codex","harness":"codex","readOnly":false,"protocol":"app-server","capabilities":{"create":true,"deliver":true,"read":true,"interrupt":true,"files":true}}),
        );
    }
    let adapter = adapter
        .as_mut()
        .ok_or_else(|| "init is required before native operations".to_owned())?;
    match method {
        "listThreads" => {
            let page = adapter
                .reader
                .list_threads(params.get("cursor").and_then(Value::as_str), limit(params)?)
                .map_err(|e| e.to_string())?;
            Ok(json!(page))
        }
        "getMessages" => {
            let thread_id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("params.id is required")?;
            let direction = params
                .get("sortDirection")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| "sortDirection must be asc or desc")?
                .unwrap_or_default();
            let page = adapter
                .reader
                .list_messages_in_order(
                    thread_id,
                    params.get("cursor").and_then(Value::as_str),
                    limit(params)?,
                    direction,
                )
                .map_err(|e| e.to_string())?;
            Ok(json!(page))
        }
        "createThread" => {
            let request_key = params
                .get("request_key")
                .and_then(Value::as_str)
                .ok_or("params.request_key is required")?;
            match adapter.create.create_once(request_key, "").await {
                NativeCreateOutcome::Confirmed {
                    native_session_id, ..
                } => Ok(json!({"outcome":"confirmed","native_session_id":native_session_id})),
                NativeCreateOutcome::DefinitelyNotSent { reason } => {
                    Ok(json!({"outcome":"definitely_not_sent","reason":reason}))
                }
                NativeCreateOutcome::Unknown => {
                    Ok(json!({"outcome":"unknown","retry":"forbidden"}))
                }
            }
        }
        "deliver" => {
            let target = session_address(params, instance)?;
            let key = params
                .get("request_key")
                .and_then(Value::as_str)
                .ok_or("params.request_key is required")?;
            let message = params.get("message").and_then(Value::as_str).unwrap_or("");
            let input = input_parts(message, params.get("attachments"))?;
            let mode = match params
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("start")
            {
                "start" => SendMode::Start,
                "current" => SendMode::Current,
                "queue" => SendMode::Queue,
                other => return Err(format!("unsupported delivery mode {other}")),
            };
            let plan = DispatchPlan {
                target,
                mode,
                expected_turn: params
                    .get("expected_turn")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            match adapter.create.native_control().submit_bounded_input(
                plan,
                input,
                &RequestKey(key.to_owned()),
            ) {
                Ok(admission) => {
                    Ok(json!({"outcome":"confirmed","native_id":admission.receipt.native_id}))
                }
                Err(error) => {
                    Ok(json!({"outcome":submit_outcome(&error),"error":format!("{error:?}")}))
                }
            }
        }
        "interrupt" | "stop" => {
            let target = session_address(params, instance)?;
            let turn_id = params
                .get("turn_id")
                .and_then(Value::as_str)
                .ok_or("params.turn_id is required")?;
            let outcome = adapter
                .create
                .native_control()
                .interrupt_exact(&target, turn_id);
            match outcome {
                InterruptOutcome::Interrupted => Ok(json!({"outcome":"interrupted"})),
                InterruptOutcome::DefinitelyNotSent { reason } => {
                    Ok(json!({"outcome":"definitely_not_sent","reason":reason}))
                }
                InterruptOutcome::OutcomeUnknown { reason } => {
                    Ok(json!({"outcome":"unknown","retry":"forbidden","reason":reason}))
                }
            }
        }
        _ => Err(format!(
            "unsupported method {method:?}; supported: init, listThreads, getMessages, createThread, deliver, interrupt, stop"
        )),
    }
}

fn input_parts(message: &str, attachments: Option<&Value>) -> Result<Value, String> {
    let mut parts = Vec::new();
    if !message.is_empty() {
        parts.push(json!({"type":"text","text":message}));
    }
    let attachments = match attachments {
        None => &[][..],
        Some(value) => value
            .as_array()
            .ok_or("params.attachments must be an array")?,
    };
    for attachment in attachments {
        let kind = attachment
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("attachment.kind is required")?;
        let path = attachment
            .get("path")
            .and_then(Value::as_str)
            .ok_or("attachment.path is required")?;
        let path = PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err("attachment.path must be an existing absolute file".into());
        }
        if kind == "file" {
            let name = attachment
                .get("file_name")
                .and_then(Value::as_str)
                .ok_or("file attachment.file_name is required")?;
            if name.is_empty() || name.contains('/') || name.contains('\\') {
                return Err("attachment.file_name is invalid".into());
            }
            parts.push(json!({"type":"mention","name":name,"path":path}));
        } else if kind == "image" {
            parts.push(json!({"type":"localImage","path":path}));
        } else {
            return Err(format!("unsupported attachment kind {kind}"));
        }
    }
    if parts.is_empty() {
        return Err("message or at least one attachment is required".into());
    }
    Ok(Value::Array(parts))
}

fn session_address(params: &Value, instance: &InstanceRef) -> Result<SessionAddress, String> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .ok_or("params.id is required")?;
    Ok(SessionAddress {
        instance: instance.clone(),
        native_session_id: id.to_owned(),
    })
}

fn limit(params: &Value) -> Result<u32, String> {
    let value = params.get("limit").and_then(Value::as_u64).unwrap_or(50);
    u32::try_from(value)
        .ok()
        .filter(|value| *value > 0 && *value <= 200)
        .ok_or("limit must be 1..200".into())
}

fn submit_outcome(error: &herder::domain::adapter::SubmitError) -> &'static str {
    match error {
        herder::domain::adapter::SubmitError::DefinitelyNotSent { .. } => "definitely_not_sent",
        _ => "unknown",
    }
}

fn write_response(
    stdout: &mut impl Write,
    id: &Value,
    result: Result<Value, String>,
) -> io::Result<()> {
    let response = match result {
        Ok(result) => json!({"id":id,"result":result}),
        Err(error) => json!({"id":id,"error":{"message":error}}),
    };
    serde_json::to_writer(&mut *stdout, &response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

#[derive(Debug)]
struct Options {
    executable: PathBuf,
    code_home: PathBuf,
    cwd: PathBuf,
    node: String,
    instance: String,
}

impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut executable = None;
        let mut code_home = None;
        let mut cwd = None;
        let mut node = None;
        let mut instance = None;
        while let Some(flag) = args.next() {
            let value = args.next().ok_or_else(|| USAGE.to_owned())?;
            match flag.as_str() {
                "--executable" => executable = Some(value.into()),
                "--code-home" => code_home = Some(value.into()),
                "--cwd" => cwd = Some(value.into()),
                "--node" => node = Some(value),
                "--instance" => instance = Some(value),
                _ => return Err(USAGE.to_owned()),
            }
        }
        Ok(Self {
            executable: executable.ok_or_else(|| USAGE.to_owned())?,
            code_home: code_home.ok_or_else(|| USAGE.to_owned())?,
            cwd: cwd.ok_or_else(|| USAGE.to_owned())?,
            node: node.ok_or_else(|| USAGE.to_owned())?,
            instance: instance.ok_or_else(|| USAGE.to_owned())?,
        })
    }
}
