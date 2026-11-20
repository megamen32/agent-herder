//! Owner state and read fences for existing-session recovery.
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRecoveryHandoff {
    #[serde(default, deserialize_with = "explicit_cohort")]
    native_sessions: Option<BTreeSet<String>>,
    #[serde(default)]
    pub(super) instance_wide: bool,
    activation_file: PathBuf,
    human_stops: PathBuf,
    human_requests: PathBuf,
    choices: PathBuf,
    unfinished_sessions: PathBuf,
}

fn explicit_cohort<'de, D: serde::Deserializer<'de>>(
    de: D,
) -> Result<Option<BTreeSet<String>>, D::Error> {
    // A missing cohort selects the explicit scope. JSON null is not a cohort.
    BTreeSet::deserialize(de).map(Some)
}

fn valid_native_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}

impl LegacyRecoveryHandoff {
    pub(super) fn cohort(&self) -> Option<&BTreeSet<String>> {
        self.native_sessions.as_ref()
    }

    pub(super) fn valid(&self) -> bool {
        (match &self.native_sessions {
            None => self.instance_wide,
            Some(ids) => !self.instance_wide && (1..=128).contains(&ids.len())
                && ids.iter().all(|id| valid_native_id(id)),
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
        valid_native_id(native_id)
            && (self.instance_wide
                || self
                    .native_sessions
                    .as_ref()
                    .is_some_and(|ids| ids.contains(native_id)))
    }

    pub(super) fn released(&self) -> bool {
        private_json::<bool>(&self.activation_file).unwrap_or(false)
    }

    pub(super) fn held(&self, harness: &str, native_id: &str) -> bool {
        // Failure to read any registry means we cannot take over a legacy session.
        !self.released() || self.read_held(harness, native_id).unwrap_or(true)
    }

    fn read_held(&self, harness: &str, native_id: &str) -> io::Result<bool> {
        if human_held(harness, native_id, &self.human_stops, &self.human_requests, &self.choices)? {
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

pub(super) fn automation_disarm_held(state_dir: &Path, harness: &str, cwd: &Path) -> bool {
    match private_json::<Value>(&state_dir.join("automation-disarm.json")) {
        Ok(document) => disarm_decision(document, harness, cwd).unwrap_or(true),
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisarmRecord {
    scope: String,
    forbidden: bool,
    #[serde(default)]
    work_keys: Vec<String>,
}

#[derive(Deserialize)]
struct ScopedDisarm {
    records: Vec<DisarmRecord>,
    // Validate the v2 mirror's shape. Only records make decisions.
    #[serde(default, rename = "blockedWorkKeys")]
    _blocked_work_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlatDisarm {
    disarmed: bool,
    #[serde(default)]
    blocked_work_keys: Vec<String>,
}

fn disarm_decision(document: Value, harness: &str, cwd: &Path) -> io::Result<bool> {
    let records = match document.get("version").and_then(Value::as_u64) {
        Some(2)
            if document["records"]
                .as_array()
                .is_some_and(|records| records.iter().all(Value::is_object)) =>
        {
            serde_json::from_value::<ScopedDisarm>(document)
                .map_err(io::Error::other)?
                .records
        }
        Some(1) => {
            let flat: FlatDisarm = serde_json::from_value(document).map_err(io::Error::other)?;
            let mut records = vec![DisarmRecord {
                scope: "*".into(),
                forbidden: flat.disarmed,
                work_keys: Vec::new(),
            }];
            for key in flat.blocked_work_keys {
                let scope = WorkKey::parse(&key)?.directory.unwrap_or("*").to_owned();
                records.push(DisarmRecord {
                    scope,
                    forbidden: true,
                    work_keys: vec![key],
                });
            }
            records
        }
        _ => return Err(io::Error::other("unsupported automation disarm state")),
    };
    if records.is_empty() {
        return Ok(false);
    }
    let cwd = disarm_path(cwd)?;
    let mut decision = None;
    for record in records {
        let depth = if record.scope == "*" {
            0
        } else {
            let path = disarm_path(Path::new(&record.scope))?;
            if !cwd.starts_with(&path) {
                continue;
            }
            path.components().count()
        };
        let keyed = !record.work_keys.is_empty();
        // A permission applies to its scope. Named prohibitions only apply
        // when at least one named work could be this native session.
        if record.forbidden && keyed {
            let mut matches = false;
            for key in record.work_keys {
                if WorkKey::parse(&key)?.may_cover(harness, &cwd)? {
                    matches = true;
                    break;
                }
            }
            if !matches {
                continue;
            }
        }
        // Deeper scopes win, then keyed records. Equal-scope conflicts after
        // resolving aliases are held when both decisions could apply.
        decision = decision.max(Some((depth, keyed, record.forbidden)));
    }
    Ok(decision.is_some_and(|(_, _, forbidden)| forbidden))
}

struct WorkKey<'a> {
    harness: Option<&'a str>,
    directory: Option<&'a str>,
}

impl<'a> WorkKey<'a> {
    fn parse(key: &'a str) -> io::Result<Self> {
        let mut parts = key.split('\0');
        let (harness, directory) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some("project"), Some(project), None, None) if !project.is_empty() => (None, project),
            (Some(harness), Some(cwd), Some(_), None) if !harness.is_empty() => {
                (Some(harness), cwd)
            }
            _ => return Err(io::Error::other("invalid automation disarm work key")),
        };
        Ok(Self {
            harness,
            directory: Path::new(directory).is_absolute().then_some(directory),
        })
    }

    fn may_cover(&self, harness: &str, cwd: &Path) -> io::Result<bool> {
        if self.harness.is_some_and(|expected| expected != harness) {
            return Ok(false);
        }
        let Some(directory) = self.directory else {
            // A name-only project key has no proven path beyond its record scope.
            return Ok(true);
        };
        let directory = disarm_path(Path::new(directory))?;
        // The boundary proves harness and cwd, but carries no logical name.
        Ok(if self.harness.is_some() {
            cwd == directory
        } else {
            cwd.starts_with(&directory)
        })
    }
}

fn disarm_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::other("automation disarm scope must be absolute"));
    }
    match path.canonicalize() {
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                && !path.components().any(|part| part == Component::ParentDir) =>
        {
            // A future directory can still have an existing aliased parent.
            for parent in path.ancestors().skip(1) {
                match parent.canonicalize() {
                    Ok(parent_real) => {
                        let suffix = path.strip_prefix(parent).map_err(io::Error::other)?;
                        return Ok(parent_real.join(suffix));
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(error)
        }
        result => result,
    }
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

fn human_held(
    harness: &str,
    native_id: &str,
    human_stops: &Path,
    human_requests: &Path,
    choice_path: &Path,
) -> io::Result<bool> {
    let holds: Sessions<Hold> = private_json(human_stops)?;
    require_v1(holds.version)?;
    if holds
        .sessions
        .iter()
        .any(|r| r.harness == harness && r.id == native_id && r.active)
    {
        return Ok(true);
    }
    let requests: Requests<HumanRequest> = private_json(human_requests)?;
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
    let choices: Requests<Choice> = private_json(choice_path)?;
    require_v1(choices.version)?;
    Ok(choices.requests.iter().any(|r| {
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
    }))
}

pub(super) fn read_automation_holds(
    harness: &str,
    native_id: &str,
    human_stops: &Path,
    human_requests: &Path,
    choices: &Path,
    unfinished_sessions: &Path,
) -> io::Result<bool> {
    if human_held(harness, native_id, human_stops, human_requests, choices)? {
        return Ok(true);
    }
    let previous: Sessions<LegacyAttempt> = private_json(unfinished_sessions)?;
    require_v1(previous.version)?;
    Ok(previous.sessions.iter().any(|r| {
        r.harness == harness && r.session_id == native_id && r.retains_workspace_session()
    }))
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

impl LegacyAttempt {
    fn retains_workspace_session(&self) -> bool {
        self.quota_recovery.is_some() || self.in_flight()
    }

    fn in_flight(&self) -> bool {
        self.delivery_pending
            || self.state.as_deref() == Some("recovering")
            || self.admission_phase.as_deref() == Some("accepted_pending")
            || self.recovery_blocked_reason.is_some()
            || self.non_retryable_admission
            || self.quota_recovery.as_ref().is_some_and(|q| {
                q.state == "dispatching" || q.reason_code.as_deref() == Some("delivery_unknown")
            })
    }
}

#[cfg(test)]
mod handoff_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_requires_an_explicit_unambiguous_instance_scope() {
        let parse = |scope: Value| {
            let mut profile = json!({"activation_file":"/activate", "choices":"/choices",
                "human_stops":"/holds", "human_requests":"/requests", "unfinished_sessions":"/unfinished"});
            profile
                .as_object_mut()
                .unwrap()
                .extend(scope.as_object().unwrap().clone());
            serde_json::from_value::<LegacyRecoveryHandoff>(profile)
                .ok()
                .filter(LegacyRecoveryHandoff::valid)
        };
        let cohort = parse(json!({"native_sessions":["one"]})).unwrap();
        assert!(cohort.owns("one") && !cohort.owns("two"));
        assert!(parse(json!({"instance_wide":true})).unwrap().owns("two"));
        for invalid in [
            json!({}),
            json!({"native_sessions":[]}),
            json!({"instance_wide":false}),
            json!({"instance_wide":"true"}),
            json!({"native_sessions":null, "instance_wide":true}),
            json!({"native_sessions":[], "instance_wide":true}),
            json!({"native_sessions":["one"], "instance_wide":true}),
        ] {
            assert!(parse(invalid.clone()).is_none(), "{invalid}");
        }
    }
}
