//! Full Rust OpenCode consumer over bounded JSONL stdio.
//!
//! The command keeps protocol parsing and result projection pure. Native HTTP
//! effects are isolated behind the existing Rust connection, create, read and
//! control ports. Ambiguous mutations are returned as UNKNOWN and never
//! replayed by this process.

use herder::{
    adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        control::{InterruptOutcome, OpenCodeSessionControl},
        create::OpenCodeCreateControl,
        read::OpenCodeSessionReader,
    },
    application::target::{NativeCreateControl, NativeCreateOutcome},
    config::Profile,
    domain::{
        adapter::{DispatchPlan, NativeSessionControl, RequestKey, SendMode},
        address::{InstanceRef, NodeRef, SessionAddress},
    },
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

const USAGE: &str = "usage: herder-opencode --endpoint URL --node NODE --instance INSTANCE [--username USER --password PASS]";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::parse(std::env::args().skip(1))?;
    let instance = InstanceRef {
        node: NodeRef(options.node.clone()),
        instance_id: options.instance.clone(),
    };
    let profile = Profile {
        runtime_cwd: PathBuf::from("/"),
        worktree_root: PathBuf::from("/"),
        endpoint: Some(options.endpoint),
        secret_ref: None,
    };
    let auth = options
        .username
        .zip(options.password)
        .map(|(u, p)| OpenCodeAuth::new(u, p));
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut adapter: Option<Adapter> = None;
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
        let result = dispatch(
            &mut adapter,
            method,
            &params,
            &instance,
            &profile,
            auth.as_ref(),
        )
        .await;
        write_response(&mut stdout, &id, result)?;
    }
    Ok(())
}

struct Adapter {
    reader: OpenCodeSessionReader,
    create: OpenCodeCreateControl,
    control: OpenCodeSessionControl,
}

async fn open_adapter(
    instance: &InstanceRef,
    profile: &Profile,
    auth: Option<&OpenCodeAuth>,
) -> Result<Adapter, String> {
    let connection = OpenCodeConnection::open(instance.clone(), profile, auth.cloned())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Adapter {
        reader: OpenCodeSessionReader::new(connection.clone()),
        create: OpenCodeCreateControl::new(connection.clone()),
        control: OpenCodeSessionControl::new(connection),
    })
}

async fn dispatch(
    adapter: &mut Option<Adapter>,
    method: &str,
    params: &Value,
    instance: &InstanceRef,
    profile: &Profile,
    auth: Option<&OpenCodeAuth>,
) -> Result<Value, String> {
    if method == "init" {
        if adapter.is_some() {
            return Err("adapter is already initialized".into());
        }
        let opened = open_adapter(instance, profile, auth).await?;
        let api = opened.control.connection().api().clone();
        *adapter = Some(opened);
        return Ok(
            json!({"adapter":"rust-opencode","harness":"opencode","readOnly":false,"protocol":"v2","routes":{"sessionList":api.has_session_list,"sessionCreate":api.has_session_create,"eventStream":api.has_event_stream,"interrupt":true}}),
        );
    }
    let adapter = adapter
        .as_mut()
        .ok_or_else(|| "init is required before native operations".to_owned())?;
    let request_id = request_id(params.get("request_id"), method);
    match method {
        "listSessions" => adapter
            .reader
            .list_sessions(request_id)
            .await
            .map(|v| json!(v))
            .map_err(|e| e.0),
        "getSession" => {
            let address = session_address(params, instance)?;
            adapter
                .reader
                .get_session(&address, request_id)
                .await
                .map(|v| json!(v))
                .map_err(|e| e.0)
        }
        "getSessionMessages" => {
            let address = session_address(params, instance)?;
            adapter
                .reader
                .get_session_messages(&address, request_id)
                .await
                .map(|v| json!(v))
                .map_err(|e| e.0)
        }
        "createSession" => {
            let key = params
                .get("request_key")
                .and_then(Value::as_str)
                .ok_or("params.request_key is required")?;
            let specification = params
                .get("specification")
                .and_then(Value::as_str)
                .unwrap_or("");
            match adapter.create.create_once(key, specification).await {
                NativeCreateOutcome::Confirmed {
                    native_session_id,
                    parent_ref,
                    ..
                } => Ok(
                    json!({"outcome":"confirmed","native_session_id":native_session_id,"parent_ref":parent_ref}),
                ),
                NativeCreateOutcome::DefinitelyNotSent { reason } => {
                    Ok(json!({"outcome":"definitely_not_sent","reason":reason}))
                }
                NativeCreateOutcome::Unknown => {
                    Ok(json!({"outcome":"unknown","retry":"forbidden"}))
                }
            }
        }
        "deliver" => {
            let address = session_address(params, instance)?;
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .ok_or("params.message is required")?;
            let key = params
                .get("request_key")
                .and_then(Value::as_str)
                .ok_or("params.request_key is required")?;
            let mode = match params
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("queue")
            {
                "queue" => SendMode::Queue,
                "current" => SendMode::Current,
                "start" => SendMode::Start,
                other => return Err(format!("unsupported delivery mode {other}")),
            };
            let outcome = adapter
                .control
                .submit(
                    DispatchPlan {
                        target: address,
                        mode,
                        expected_turn: params
                            .get("expected_turn")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                    message,
                    &RequestKey(key.to_owned()),
                )
                .await;
            match outcome {
                Ok(admission) => {
                    Ok(json!({"outcome":"confirmed","native_id":admission.receipt.native_id}))
                }
                Err(error) => Ok(
                    json!({"outcome":format_submit_error(&error),"error":error_to_string(&error)}),
                ),
            }
        }
        "interrupt" => {
            let address = session_address(params, instance)?;
            match adapter
                .control
                .interrupt_session(&address, request_id)
                .await
            {
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
            "unsupported method {method:?}; supported: init, listSessions, getSession, getSessionMessages, createSession, deliver, interrupt"
        )),
    }
}

fn session_address(params: &Value, instance: &InstanceRef) -> Result<SessionAddress, String> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "params.id must be a native session ID".to_owned())?;
    Ok(SessionAddress {
        instance: instance.clone(),
        native_session_id: id.to_owned(),
    })
}

fn request_id(value: Option<&Value>, method: &str) -> String {
    format!(
        "herder-opencode-{method}-{}",
        value.and_then(Value::as_str).unwrap_or("request")
    )
}

fn format_submit_error(error: &herder::domain::adapter::SubmitError) -> &'static str {
    match error {
        herder::domain::adapter::SubmitError::DefinitelyNotSent { .. } => "definitely_not_sent",
        herder::domain::adapter::SubmitError::OutcomeUnknown { .. } => "unknown",
        herder::domain::adapter::SubmitError::BrowserOutcomeUnknown(_) => "unknown",
    }
}

fn error_to_string(error: &herder::domain::adapter::SubmitError) -> String {
    format!("{error:?}")
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
    endpoint: String,
    node: String,
    instance: String,
    username: Option<String>,
    password: Option<String>,
}

impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut endpoint = None;
        let mut node = None;
        let mut instance = None;
        let mut username = None;
        let mut password = None;
        while let Some(flag) = args.next() {
            let slot = match flag.as_str() {
                "--endpoint" => &mut endpoint,
                "--node" => &mut node,
                "--instance" => &mut instance,
                "--username" => &mut username,
                "--password" => &mut password,
                _ => return Err(USAGE.to_owned()),
            };
            *slot = Some(args.next().ok_or_else(|| USAGE.to_owned())?);
        }
        Ok(Self {
            endpoint: endpoint.ok_or_else(|| USAGE.to_owned())?,
            node: node.ok_or_else(|| USAGE.to_owned())?,
            instance: instance.ok_or_else(|| USAGE.to_owned())?,
            username,
            password,
        })
    }
}
