use super::{Result, digest};
use crate::application::scoped_stop::recovery_handoff::{
    automation_disarm_held, private_json, read_automation_holds,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutopilotProfile {
    state_dir: PathBuf,
    policy_file: Option<PathBuf>,
    holds: Holds,
    pub(super) judge: super::judge::JudgeConfig,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Holds {
    human_stops: PathBuf,
    human_requests: PathBuf,
    choices: PathBuf,
    unfinished_sessions: PathBuf,
}

fn keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}

/// Validate the persisted v1 switch before honoring a personal override. An absent
/// harness array is the earlier Codex-only format. A valid personal switch wins
/// even when the global enabled flag is false.
fn llm_policy(v: &Value) -> bool {
    if !keys(
        v,
        &[
            "schemaVersion",
            "enabled",
            "harnesses",
            "scope",
            "maxContinuationsPerSession",
            "timeout",
            "card",
            "judgeMode",
        ],
    ) || v["schemaVersion"] != 1
        || !v["enabled"].is_boolean()
        || v.get("judgeMode").is_some_and(|m| m != "llm")
        || v.get("harnesses").is_some_and(|h| {
            !h.as_array().is_some_and(|a| {
                a.iter().all(|entry| {
                    matches!(
                        entry.as_str(),
                        Some(
                            "codex"
                                | "opencode"
                                | "claude"
                                | "hermes"
                                | "zcode"
                                | "chatgpt"
                                | "zai"
                        )
                    )
                })
            })
        })
    {
        return false;
    }
    let scope = &v["scope"];
    let scope_valid = match scope["mode"].as_str() {
        Some("all_ingress") => keys(scope, &["mode"]),
        Some("allowlist") => {
            keys(scope, &["mode", "selectors"])
                && scope["selectors"].as_array().is_some_and(|rows| {
                    rows.iter().all(|s| {
                        keys(
                            s,
                            &["harness", "sessionId", "conversationId", "cwd", "ingressId"],
                        ) && s["harness"] == "codex"
                            && s["ingressId"] == "codex-stop-hook-v1"
                            && s["sessionId"]
                                .as_str()
                                .is_some_and(|id| !id.trim().is_empty() && id.len() <= 512)
                            && s["conversationId"] == s["sessionId"]
                            && s["cwd"]
                                .as_str()
                                .is_some_and(|cwd| Path::new(cwd).is_absolute())
                    })
                })
        }
        _ => false,
    };
    let timeout = &v["timeout"];
    let card = &v["card"];
    let fields = [
        "includeUserMessage",
        "includeAssistantMessage",
        "includeReason",
    ];
    scope_valid
        && keys(timeout, &["mode", "delayMs"])
        && matches!(timeout["mode"].as_str(), Some("auto_continue" | "hold"))
        && timeout["delayMs"]
            .as_u64()
            .is_some_and(|ms| ms <= 604_800_000)
        && keys(card, &fields)
        && fields.iter().all(|k| card[*k].is_boolean())
        && v["maxContinuationsPerSession"]
            .as_u64()
            .is_some_and(|n| n <= 100)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PolicyVersion {
    session_update: String,
    policy_revision: String,
    pub limit: u64,
}

impl AutopilotProfile {
    pub fn valid(&self) -> bool {
        let h = &self.holds;
        [
            &self.state_dir,
            &h.human_stops,
            &h.human_requests,
            &h.choices,
            &h.unfinished_sessions,
        ]
        .into_iter()
        .all(|p| p.is_absolute())
            && self.policy_file.as_ref().is_none_or(|p| p.is_absolute())
            && self.judge.valid()
    }

    pub(super) fn policy(&self, id: &str, cwd: &str) -> Result<PolicyVersion> {
        let unavailable = "personal_policy_required";
        let state: Value =
            private_json(&self.state_dir.join("sessions.json")).map_err(|_| unavailable)?;
        if state["version"] != 1 || !Path::new(cwd).is_absolute() {
            return Err(unavailable);
        }
        let mut rows = state["sessions"]
            .as_array()
            .ok_or(unavailable)?
            .iter()
            .filter(|r| r["harness"] == "codex" && r["sessionId"] == *id);
        let row = rows.next().ok_or(unavailable)?;
        if rows.next().is_some()
            || row["cwd"] != cwd
            || row["enabled"] != true
            || row["executor"] != "rust"
            || !row["noticeIncident"].is_null()
            || !row["noticeAttempt"].is_null()
        {
            return Err(unavailable);
        }
        let updated = row["updatedAt"].as_str().ok_or(unavailable)?;
        chrono::DateTime::parse_from_rfc3339(updated).map_err(|_| unavailable)?;
        let goal_key = digest(format!("codex\0{id}\0{cwd}").as_bytes());
        match private_json::<Value>(
            &self
                .state_dir
                .join("goals")
                .join(format!("{goal_key}.json")),
        ) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            // Full-goal sessions have their own control epoch, stop and completion tickets.
            _ => return Err("full_goal_session"),
        }
        let path = self
            .policy_file
            .clone()
            .unwrap_or_else(|| self.state_dir.join("autopilot-policy.json"));
        let (revision, limit) = match private_json::<Value>(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => ("legacy".into(), 3),
            Ok(file)
                if keys(&file, &["schemaVersion", "revision", "updatedAt", "policy"])
                    && file["schemaVersion"] == 1
                    && llm_policy(&file["policy"])
                    && file["updatedAt"]
                        .as_str()
                        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()) =>
            {
                let rev = file["revision"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or(unavailable)?;
                let limit = file["policy"]["maxContinuationsPerSession"]
                    .as_u64()
                    .ok_or(unavailable)?;
                (rev.to_owned(), limit)
            }
            _ => return Err(unavailable),
        };
        Ok(PolicyVersion {
            session_update: updated.to_owned(),
            policy_revision: revision,
            limit,
        })
    }

    pub(super) fn clear(&self, id: &str, cwd: &str) -> bool {
        let h = &self.holds;
        matches!(
            read_automation_holds(
                "codex",
                id,
                &h.human_stops,
                &h.human_requests,
                &h.choices,
                &h.unfinished_sessions
            ),
            Ok(false)
        ) && !automation_disarm_held(&self.state_dir, "codex", Path::new(cwd))
    }
}
