//! One-shot SDK consumer for an isolated, preprovisioned owner profile.
//! A create result or timeout must never be retried with this or another key.
use rmcp::{
    ClientServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientConfig, GetTaskParams,
        Implementation, ProtocolVersion, TaskPayload,
    },
    service::ClientLifecycleMode,
    transport::TokioChildProcess,
};
use serde_json::{Value, json};
use std::{fs::OpenOptions, io::Write, time::Duration};
use tokio::process::Command;

async fn connect(
    binary: &str,
    profile: &str,
) -> Result<rmcp::service::RunningService<rmcp::RoleClient, ClientConfig>, Box<dyn std::error::Error>>
{
    let mut command = Command::new(binary);
    command.arg("--trusted-owner-profile").arg(profile);
    let transport = TokioChildProcess::new(command)?;
    let config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::new("herder-owner-proof", "1"),
    )
    .with_protocol_version(ProtocolVersion::V_2026_07_28);
    Ok(config
        .serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await?)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 4 && args[1] == "--preflight" {
        let client = connect(&args[2], &args[3]).await?;
        let tools = client.peer().list_tools(None).await?;
        if !["create", "deliver", "session"]
            .iter()
            .all(|name| tools.tools.iter().any(|t| &t.name == name))
        {
            return Err("required tools absent".into());
        }
        let arguments = json!({"action":"context"}).as_object().unwrap().clone();
        let result = client
            .peer()
            .call_tool(CallToolRequestParams::new("session").with_arguments(arguments))
            .await?;
        if result
            .structured_content
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            != Some("self_binding_required")
        {
            return Err("trusted owner unexpectedly has a verified self binding".into());
        }
        println!("SDK_PREFLIGHT tools=ok self=unknown no_effect=true");
        client.cancel().await?;
        return Ok(());
    }
    if args.len() != 6 {
        return Err("usage: owner_probe BINARY PROFILE INSTANCE MARKER RECEIPT_PATH".into());
    }
    let mut receipt = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[5])?;
    writeln!(
        receipt,
        "{}",
        json!({"marker":args[4],"phase":"prepared_no_replay"})
    )?;
    receipt.sync_all()?;
    let client = connect(&args[1], &args[2]).await?;
    let arguments=json!({"action":"create","instance_ref":args[3],"prompt":args[4],"request_key":format!("owner-proof:{}",args[4])}).as_object().unwrap().clone();
    let result = client
        .peer()
        .call_tool_once(CallToolRequestParams::new("create").with_arguments(arguments))
        .await?;
    let task = match result {
        CallToolResponse::Task(t) => t.task.task_id,
        other => {
            return Err(format!("create did not return task; outcome unknown: {other:?}").into());
        }
    };
    writeln!(
        receipt,
        "{}",
        json!({"task_id":task,"marker":args[4],"phase":"admitted"})
    )?;
    receipt.sync_all()?;
    println!("{}", json!({"task_id":task,"phase":"admitted"}));
    let mut terminal: Option<Value> = None;
    for _ in 0..90 {
        let task_result = client
            .peer()
            .get_task(GetTaskParams::new(task.clone()))
            .await?;
        if let TaskPayload::Completed { result } = task_result.task.payload {
            terminal = Some(Value::Object(result));
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let terminal =
        terminal.ok_or("task did not reach terminal state; outcome unknown, do not replay")?;
    let session = terminal
        .pointer("/structuredContent/create/session_ref")
        .and_then(Value::as_str)
        .ok_or("terminal task omitted session ref")?
        .to_owned();
    if terminal
        .pointer("/structuredContent/prompt/outcome")
        .and_then(Value::as_str)
        != Some("confirmed")
    {
        return Err(format!("terminal prompt not confirmed: {terminal}").into());
    }
    client.cancel().await?;
    let reopened = connect(&args[1], &args[2]).await?;
    let reread = reopened
        .peer()
        .get_task(GetTaskParams::new(task.clone()))
        .await?;
    if !matches!(reread.task.payload, TaskPayload::Completed { .. }) {
        return Err("reopened task not terminal".into());
    }
    let arguments = json!({"action":"messages","session_ref":session})
        .as_object()
        .unwrap()
        .clone();
    let messages = reopened
        .peer()
        .call_tool(CallToolRequestParams::new("session").with_arguments(arguments))
        .await?;
    let body = messages
        .structured_content
        .ok_or("missing messages content")?;
    if !body.to_string().contains(&args[4]) {
        return Err("exact input absent from readback".into());
    }
    println!(
        "{}",
        json!({"scope":"rmcp SDK to native Herder owner stdio; isolated Codex","task_id":task,"session_ref":session,"task_reopen":"terminal","input_readback":"confirmed"})
    );
    reopened.cancel().await?;
    Ok(())
}
