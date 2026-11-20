//! The exact existing-session cohort and read fences for a compatibility-owner handoff.
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRecoveryHandoff {
    native_sessions: BTreeSet<String>,
    activation_file: PathBuf,
    human_stops: PathBuf,
    human_requests: PathBuf,
    choices: PathBuf,
    unfinished_sessions: PathBuf,
}

impl LegacyRecoveryHandoff {
    pub(super) fn valid(&self) -> bool {
        !self.native_sessions.is_empty()
            && self.native_sessions.len() <= 128
            && self.native_sessions.iter().all(|id| {
                !id.trim().is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
            })
            && [
                &self.activation_file,
                &self.human_stops,
                &self.human_requests,
                &self.choices,
                &self.unfinished_sessions,
            ]
            .into_iter()
            .all(|path| path.is_absolute())
    }

    pub(super) fn owns(&self, native_id: &str) -> bool {
        self.native_sessions.contains(native_id)
    }

    pub(super) fn released(&self) -> bool {
        private_json::<bool>(&self.activation_file).unwrap_or(false)
    }

    pub(super) fn held(&self, harness: &str, native_id: &str) -> bool {
        // Failure to read any registry means we cannot take over a legacy session.
        !self.released() || self.read_held(harness, native_id).unwrap_or(true)
    }

    fn read_held(&self, harness: &str, native_id: &str) -> io::Result<bool> {
        let holds: Sessions<Hold> = private_json(&self.human_stops)?;
        require_v1(holds.version)?;
        if holds
            .sessions
            .iter()
            .any(|r| r.harness == harness && r.id == native_id && r.active)
        {
            return Ok(true);
        }
        let requests: Requests<HumanRequest> = private_json(&self.human_requests)?;
        require_v1(requests.version)?;
        for request in requests.requests {
            let target = request.target;
            if target.session_id == native_id
                && target
                    .agent
                    .or(target.harness)
                    .as_deref()
                    .unwrap_or("codex")
                    == harness
                && (matches!(request.status.as_str(), "pending" | "resuming")
                    || request.status == "resume_failed"
                        && (request.receipt.as_deref() != Some("agent-resume:native-unavailable")
                            || request.resume_retryable == Some(false)))
            {
                return Ok(true);
            }
        }
        let choices: Requests<Choice> = private_json(&self.choices)?;
        require_v1(choices.version)?;
        if choices.requests.iter().any(|r| {
            r.session_id == native_id
                && r.harness.as_deref().unwrap_or("codex") == harness
                && matches!(
                    r.status.as_str(),
                    "pending"
                        | "claimed"
                        | "dispatching"
                        | "expired-needs-human"
                        | "delivery_unknown"
                )
        }) {
            return Ok(true);
        }
        let previous: Sessions<LegacyAttempt> = private_json(&self.unfinished_sessions)?;
        require_v1(previous.version)?;
        Ok(previous.sessions.iter().any(|r| {
            r.harness == harness
                && r.session_id == native_id
                && (r.delivery_pending
                    || r.state.as_deref() == Some("recovering")
                    || r.admission_phase.as_deref() == Some("accepted_pending")
                    || r.recovery_blocked_reason.is_some()
                    || r.non_retryable_admission
                    || r.quota_recovery.as_ref().is_some_and(|q| {
                        q.state == "dispatching"
                            || q.reason_code.as_deref() == Some("delivery_unknown")
                    }))
        }))
    }
}

pub(super) fn private_json<T: serde::de::DeserializeOwned>(path: &Path) -> io::Result<T> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let state = file.metadata()?;
    if !state.is_file() || state.uid() != unsafe { libc::geteuid() } || state.mode() & 0o022 != 0 {
        return Err(io::Error::other("untrusted recovery state"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(io::Error::other("recovery state exceeds the read bound"));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub(super) fn notice_attempt_held(path: &Path, native_id: &str) -> bool {
    match private_json::<Sessions<AutopilotSession>>(path) {
        Ok(state) => {
            state.version != 1
                || state.sessions.iter().any(|r| {
                    r.harness == "opencode"
                        && r.session_id == native_id
                        && r.notice_attempt.is_some()
                        && !r.enabled
                })
        }
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutopilotSession {
    harness: String,
    session_id: String,
    notice_attempt: Option<serde_json::Value>,
    enabled: bool,
}

fn require_v1(version: u8) -> io::Result<()> {
    if version == 1 {
        Ok(())
    } else {
        Err(io::Error::other("unsupported legacy recovery state"))
    }
}

#[derive(Deserialize)]
struct Sessions<T> {
    version: u8,
    sessions: Vec<T>,
}

#[derive(Deserialize)]
struct Requests<T> {
    version: u8,
    requests: Vec<T>,
}

#[derive(Deserialize)]
struct Hold {
    harness: String,
    id: String,
    active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HumanRequest {
    target: HumanTarget,
    status: String,
    receipt: Option<String>,
    resume_retryable: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HumanTarget {
    agent: Option<String>,
    harness: Option<String>,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    harness: Option<String>,
    session_id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAttempt {
    harness: String,
    session_id: String,
    state: Option<String>,
    #[serde(default)]
    delivery_pending: bool,
    admission_phase: Option<String>,
    recovery_blocked_reason: Option<String>,
    #[serde(default)]
    non_retryable_admission: bool,
    quota_recovery: Option<LegacyQuotaAttempt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyQuotaAttempt {
    state: String,
    reason_code: Option<String>,
}
