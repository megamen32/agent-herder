//! Standalone, read-only OpenCode v2 adapter over bounded JSONL stdio.
//!
//! This binary is intentionally opt-in: Cargo builds it, but no daemon or
//! system service selects it by default. It owns no OpenCode writes and uses
//! the shared native reader for all API requests.

use herder::{
    adapters::opencode::{
        connection::{OpenCodeAuth, OpenCodeConnection},
        read::OpenCodeSessionReader,
    },
    config::Profile,
    domain::address::{InstanceRef, NodeRef, SessionAddress},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

const USAGE: &str = "usage: herder-opencode-read --endpoint URL --node NODE --instance INSTANCE [--username USER --password PASS]";

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
    let mut reader: Option<OpenCodeSessionReader> = None;

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
        let result = match method {
            "init" => init_reader(&mut reader, &instance, &profile, auth.as_ref()).await,
            "listSessions" => match reader.as_ref() {
                Some(reader) => reader
                    .list_sessions(request_id(&id, method))
                    .await
                    .map(|v| json!(v))
                    .map_err(|e| e.0),
                None => Err("init is required before listSessions".to_owned()),
            },
            "getSession" => match reader.as_ref() {
                Some(reader) => {
                    get_session(reader, &params, &instance, request_id(&id, method)).await
                }
                None => Err("init is required before getSession".to_owned()),
            },
            "getSessionMessages" => match reader.as_ref() {
                Some(reader) => {
                    get_session_messages(reader, &params, &instance, request_id(&id, method)).await
                }
                None => Err("init is required before getSessionMessages".to_owned()),
            },
            _ => Err(format!(
                "unsupported method {method:?}; supported: init, listSessions, getSession, getSessionMessages"
            )),
        };
        write_response(&mut stdout, &id, result)?;
    }
    Ok(())
}

async fn init_reader(
    reader: &mut Option<OpenCodeSessionReader>,
    instance: &InstanceRef,
    profile: &Profile,
    auth: Option<&OpenCodeAuth>,
) -> Result<Value, String> {
    if reader.is_some() {
        return Err("adapter is already initialized".to_owned());
    }
    let connection = OpenCodeConnection::open_read_only(instance.clone(), profile, auth.cloned())
        .await
        .map_err(|e| e.to_string())?;
    let api = connection.api().clone();
    *reader = Some(OpenCodeSessionReader::new(connection));
    Ok(
        json!({"adapter":"rust-opencode-read","harness":"opencode","readOnly":true,"protocol":"v2","routes":{"sessionList":api.has_session_list,"sessionCreate":false,"eventStream":false}}),
    )
}

async fn get_session(
    reader: &OpenCodeSessionReader,
    params: &Value,
    instance: &InstanceRef,
    request_id: String,
) -> Result<Value, String> {
    let address = session_address(params, instance)?;
    reader
        .get_session(&address, request_id)
        .await
        .map(|v| json!(v))
        .map_err(|e| e.0)
}

async fn get_session_messages(
    reader: &OpenCodeSessionReader,
    params: &Value,
    instance: &InstanceRef,
    request_id: String,
) -> Result<Value, String> {
    let address = session_address(params, instance)?;
    reader
        .get_session_messages(&address, request_id)
        .await
        .map(|v| json!(v))
        .map_err(|e| e.0)
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

fn request_id(id: &Value, method: &str) -> String {
    format!(
        "herder-opencode-read-{method}-{}",
        id.as_str().unwrap_or("request")
    )
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
