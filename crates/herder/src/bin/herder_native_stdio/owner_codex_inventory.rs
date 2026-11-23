//! Metadata inventory is an opt-in of one trusted native Codex profile.
//! Descriptive thread IDs never create a registration, grant, or delivery target.
use super::owner_policy::OwnerPolicy;
use herder::{
    adapters::codex::{
        inventory::{list_metadata, unindexed_ids},
        read::CodexReader,
    },
    auth::identity::{Caller, ConnectionIdentity},
};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use std::{path::Path, sync::Mutex};

fn error(code: &str) -> CallToolResult {
    CallToolResult::structured_error(json!({"code":code,"effect":"none"}))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn list(
    identity: &ConnectionIdentity,
    policy: &OwnerPolicy,
    home: Option<&Path>,
    reader: &Mutex<CodexReader>,
    node: &str,
    instance: &str,
    cwd: Option<&str>,
    cursor: Option<&str>,
    limit: Option<u32>,
    updated_since_ms: Option<i64>,
    archived: Option<bool>,
) -> CallToolResult {
    if !matches!(identity.caller(), Caller::Principal(p) if p.id == policy.principal) {
        return error("unauthorized");
    }
    if policy.harness != "codex"
        || policy.instance.node.0 != node
        || policy.instance.instance_id != instance
    {
        return error("owner_profile_mismatch");
    }
    let Some(home) = home else {
        return error("metadata_inventory_not_enabled");
    };
    let limit = limit.unwrap_or(100);
    if updated_since_ms.is_some_and(|t| t < 0)
        || !(1..=200).contains(&limit)
        || cwd.is_some_and(|v| !Path::new(v).is_absolute() || v.len() > 4096 || v.contains('\0'))
    {
        return error("invalid_inventory_filter");
    }
    let mut result = match list_metadata(
        home,
        cursor,
        limit as usize,
        cwd,
        updated_since_ms,
        archived,
    ) {
        Ok(page) => page,
        Err(code) => return error(&code),
    };
    result["node_ref"] = json!(node);
    result["instance_ref"] = json!(instance);
    if cursor.is_none() {
        let live = reader
            .try_lock()
            .ok()
            .map(|mut reader| reader.inventory_runtime(cwd));
        let (mut rows, observed) = live.unwrap_or_default();
        let ids = rows
            .iter()
            .filter_map(|v| v["native_session_id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let known = unindexed_ids(home, &ids).ok();
        for row in &mut rows {
            row["persisted"] = known
                .as_ref()
                .map(|missing| {
                    json!(
                        !missing
                            .iter()
                            .any(|id| row["native_session_id"].as_str() == Some(id.as_str()))
                    )
                })
                .unwrap_or(Value::Null);
        }
        result["runtime"] = json!({"sessions":rows,"complete":observed && known.is_some(),"source":"shared_codex_controller","scope":"loaded_threads_in_cwd"});
    }
    CallToolResult::structured(result)
}
