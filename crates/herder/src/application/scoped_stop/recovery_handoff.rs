//! Owner state and read fences for existing-session recovery.
use crate::{
    adapters::codex::control::CodexControl,
    domain::{adapter::ReadError, address::SessionAddress, recovery::RecoveryControl},
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock},
};

const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRecoveryHandoff {
    #[serde(default, deserialize_with = "explicit_cohort")]
    native_sessions: Option<BTreeSet<String>>,
    #[serde(default, deserialize_with = "explicit_workspaces")]
    workspaces: BTreeSet<WorkspaceChannel>,
    // Wait status receives a clone of this profile before recovery is composed.
    // Both consumers use the same instance-bound reader.
    #[serde(skip)]
    workspace_probe: Arc<OnceLock<Arc<dyn RecoveryWorkspaceProbe>>>,
    #[serde(default)]
    pub(super) instance_wide: bool,
    activation_file: PathBuf,
    human_stops: PathBuf,
    human_requests: PathBuf,
    choices: PathBuf,
    unfinished_sessions: PathBuf,
}

#[derive(Clone, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceChannel {
    cwd: String,
    provider: String,
}

impl WorkspaceChannel {
    fn valid(&self) -> bool {
        super::registration::canonical_nested_workspace_path(&self.cwd).as_deref()
            == Some(&self.cwd)
            && super::session_recovery::route_id(&self.provider)
    }
}

/// Metadata from the same addressed owner. A missing or incomplete observation
/// cannot identify the workspace to the compatibility writer.
pub trait RecoveryWorkspaceProbe: RecoveryControl {
    fn read_workspace(&self, _target: &SessionAddress) -> Result<WorkspaceChannel, ReadError> {
        Err(ReadError("native workspace probe unavailable".into()))
    }
}

impl<T: RecoveryControl + super::session_recovery::RecoveryListing> RecoveryWorkspaceProbe for T {}

impl RecoveryWorkspaceProbe for CodexControl {
    fn read_workspace(&self, target: &SessionAddress) -> Result<WorkspaceChannel, ReadError> {
        let thread = self.read_snapshot_thread(target)?;
        let cwd = thread["cwd"]
            .as_str()
            .ok_or_else(|| ReadError("missing native cwd".into()))?;
        let provider = thread["modelProvider"]
            .as_str()
            .ok_or_else(|| ReadError("missing native provider".into()))?;
        Ok(WorkspaceChannel {
            cwd: cwd.into(),
            provider: provider.into(),
        })
    }
}

fn explicit_workspaces<'de, D: serde::Deserializer<'de>>(
    de: D,
) -> Result<BTreeSet<WorkspaceChannel>, D::Error> {
    use serde::de::Error;
    let entries = Vec::<WorkspaceChannel>::deserialize(de)?;
    if entries.is_empty() {
        return Err(D::Error::custom("empty workspace transfer"));
    }
    let mut workspaces = BTreeSet::new();
    for entry in entries {
        if !entry.valid() || !workspaces.insert(entry) {
            return Err(D::Error::custom("invalid or duplicate workspace channel"));
        }
    }
    Ok(workspaces)
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

    pub(super) fn scans_workspaces(&self) -> bool {
        !self.workspaces.is_empty()
    }

    pub(super) fn valid(&self) -> bool {
        (match &self.native_sessions {
            None => self.instance_wide || self.scans_workspaces(),
            Some(ids) => {
                !self.instance_wide
                    && (1..=128).contains(&ids.len())
                    && ids.iter().all(|id| valid_native_id(id))
            }
        }) && !(self.instance_wide && self.scans_workspaces())
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

    pub(super) fn owns_id(&self, native_id: &str) -> bool {
        valid_native_id(native_id)
            && (self.instance_wide
                || self
                    .native_sessions
                    .as_ref()
                    .is_some_and(|ids| ids.contains(native_id)))
    }

    /// Exact transfers retain their original contract. For a dynamic transfer,
    /// the native channel must match and legacy must have released its attempt.
    pub(super) fn owns(
        &self,
        harness: &str,
        id: &str,
        observe: impl FnOnce() -> Option<WorkspaceChannel>,
    ) -> io::Result<bool> {
        if self.owns_id(id) {
            return Ok(true);
        }
        if harness != "codex" || !self.scans_workspaces() || !valid_native_id(id) {
            return Ok(false);
        }
        let matches = observe()
            .filter(WorkspaceChannel::valid)
            .map(|c| self.workspaces.contains(&c));
        if matches == Some(false) {
            return Ok(false);
        }
        let previous: Sessions<LegacyAttempt> = private_json(&self.unfinished_sessions)?;
        require_v1(previous.version)?;
        if previous
            .sessions
            .iter()
            .any(|r| r.harness == harness && r.session_id == id && r.retains_workspace_session())
        {
            return Ok(false);
        }
        matches.ok_or_else(|| io::Error::other("native recovery workspace unavailable"))
    }

    pub(super) fn bind_workspace_probe(&self, probe: Arc<dyn RecoveryWorkspaceProbe>) {
        if self.scans_workspaces() {
            self.workspace_probe.get_or_init(|| probe);
        }
    }

    pub(super) fn native_channel(
        &self,
        harness: &str,
        target: &SessionAddress,
    ) -> Option<WorkspaceChannel> {
        let probe = self.workspace_probe.get()?;
        if probe.instance() != &target.instance || probe.harness() != harness {
            return None;
        }
        probe.read_workspace(target).ok()
    }

    pub(super) fn owns_native(&self, harness: &str, target: &SessionAddress) -> io::Result<bool> {
        self.owns(harness, &target.native_session_id, || {
            self.native_channel(harness, target)
        })
    }

    pub(super) fn owns_ancestor(&self, harness: &str, target: &SessionAddress, cwd: &str) -> bool {
        self.owns(harness, &target.native_session_id, || {
            self.native_channel(harness, target)
                .filter(|c| c.cwd == cwd)
        })
        .unwrap_or(false)
    }

    pub(super) fn owns_boundary(&self, harness: &str, id: &str, cwd: &str, provider: &str) -> bool {
        self.owns(harness, id, || {
            Some(WorkspaceChannel {
                cwd: cwd.into(),
                provider: provider.into(),
            })
        })
        .unwrap_or(false)
    }

    pub(super) fn released(&self) -> bool {
        private_json::<bool>(&self.activation_file).unwrap_or(false)
    }

    pub(super) fn held(&self, harness: &str, native_id: &str, open_turn: Option<&str>) -> bool {
        // Failure to read any registry means we cannot take over a legacy session.
        !self.released() || self.read_held(harness, native_id, open_turn).unwrap_or(true)
    }

    pub(super) fn legacy_stop_reason(
        &self,
        harness: &str,
        native_id: &str,
    ) -> io::Result<Option<&'static str>> {
        legacy_stop_reason(
            harness,
            native_id,
            &self.human_stops,
            StopCheck::Recovery(None),
        )
    }

    fn read_held(&self, harness: &str, native_id: &str, open_turn: Option<&str>) -> io::Result<bool> {
        if human_held(harness, native_id, &self.human_stops, &self.human_requests, &self.choices, StopCheck::Recovery(open_turn))? {
            return Ok(true);
        }
        let previous: Sessions<LegacyAttempt> = private_json(&self.unfinished_sessions)?;
        require_v1(previous.version)?;
        let dynamic = self.scans_workspaces() && !self.owns_id(native_id);
        Ok(previous.sessions.iter().any(|r| {
            r.harness == harness
                && r.session_id == native_id
                && if dynamic {
                    r.retains_workspace_session()
                } else {
                    r.in_flight()
                }
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

// Recovery reads the native terminal failure. A legacy Codex abort can only
// contradict a projected *unclosed* turn if both refer to that very turn.
#[derive(Clone, Copy)]
enum StopCheck<'a> {
    Recovery(Option<&'a str>),
    Autopilot,
}

fn legacy_stop_reason(
    harness: &str,
    native_id: &str,
    human_stops: &Path,
    check: StopCheck<'_>,
) -> io::Result<Option<&'static str>> {
    let holds: Sessions<Hold> = private_json(human_stops)?;
    require_v1(holds.version)?;
    let mut reason = None;
    for hold in holds.sessions.iter().filter(|hold| {
        hold.harness == harness && hold.id == native_id && hold.active
    }) {
        match hold.reason(check) {
            Some("human_stop_active") => return Ok(Some("human_stop_active")),
            Some(other) => reason = Some(other),
            None => {}
        }
    }
    Ok(reason)
}

fn human_held(
    harness: &str,
    native_id: &str,
    human_stops: &Path,
    human_requests: &Path,
    choice_path: &Path,
    check: StopCheck<'_>,
) -> io::Result<bool> {
    if legacy_stop_reason(harness, native_id, human_stops, check)?.is_some() {
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
    if human_held(harness, native_id, human_stops, human_requests, choices, StopCheck::Autopilot)? {
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
    #[serde(default)]
    stop: Value,
    #[serde(default, rename = "ignoredStopIds")]
    ignored_stop_ids: Vec<String>,
}

impl Hold {
    fn reason(&self, check: StopCheck<'_>) -> Option<&'static str> {
        let id = self.stop["id"].as_str().unwrap_or("");
        let scope_stop = format!("owner-scope-stop:{}:{}", self.harness, self.id);
        if (self.stop["reason"] == "explicit-stop"
            && id.strip_prefix("explicit-stop:").is_some_and(|suffix| !suffix.is_empty()))
            || id == scope_stop
        {
            return Some("human_stop_active");
        }
        // The Node observer records {id: turnId, reason: "interrupted"} for
        // transport events. It can also replace a prior owner command, moving
        // that command's ID into ignoredStopIds without recording a release.
        if self.harness == "codex" && self.stop["reason"] == "interrupted"
            && valid_native_id(id) && self.stop["turnId"].as_str() == Some(id)
            && !self.ignored_stop_ids.iter().any(|old| old.starts_with("explicit-stop:") || old == &scope_stop)
            && matches!(check, StopCheck::Recovery(open_turn) if open_turn != Some(id))
        {
            return None;
        }
        Some("legacy_stop_provenance_unknown")
    }
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
    fn observer_abort_only_fences_an_unclosed_matching_turn() {
        let row = json!({"harness":"codex","id":"chat","active":true,
            "stop":{"id":"one","turnId":"one","reason":"interrupted"}});
        let parse = |row| serde_json::from_value::<Hold>(row).unwrap();
        let abort = parse(row.clone());
        assert!(abort.reason(StopCheck::Recovery(None)).is_none());
        assert!(abort.reason(StopCheck::Recovery(Some("two"))).is_none());
        assert!(abort.reason(StopCheck::Recovery(Some("one"))).is_some());
        assert!(abort.reason(StopCheck::Autopilot).is_some());

        let mut overwritten = row.clone();
        overwritten["ignoredStopIds"] = json!(["explicit-stop:owner"]);
        assert_eq!(
            parse(overwritten).reason(StopCheck::Recovery(None)),
            Some("legacy_stop_provenance_unknown"),
        );
        let mut malformed = row.clone();
        malformed["stop"]["turnId"] = json!("other");
        assert!(parse(malformed).reason(StopCheck::Recovery(None)).is_some());
        let mut explicit = row.clone();
        explicit["stop"] = json!({"id": "explicit-stop:owner", "reason": "explicit-stop"});
        assert_eq!(
            parse(explicit).reason(StopCheck::Recovery(None)),
            Some("human_stop_active"),
        );
        let mut scope = row;
        scope["stop"]["id"] = json!("owner-scope-stop:codex:chat");
        assert_eq!(parse(scope).reason(StopCheck::Recovery(None)), Some("human_stop_active"));
    }

    #[test]
    fn handed_over_workspaces_can_extend_an_existing_exact_cohort() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let unfinished =
            std::env::temp_dir().join(format!("herder-scope-{}-{stamp}", std::process::id()));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&unfinished)
            .unwrap();
        serde_json::to_writer(
            file,
            &json!({"version":1,"sessions":[
                {"harness":"codex","sessionId":"legacy","quotaRecovery":{"state":"waiting"}}
            ]}),
        )
        .unwrap();
        let profile = json!({
            "native_sessions": ["explicit-id"],
            "workspaces": [{"cwd": "/work/handed-over", "provider": "opencodex"}],
            "activation_file": "/activate", "choices": "/choices", "human_stops": "/holds",
            "human_requests": "/requests", "unfinished_sessions": unfinished
        });
        let handoff: LegacyRecoveryHandoff = serde_json::from_value(profile).unwrap();
        assert!(handoff.valid());
        assert!(handoff.owns("codex", "explicit-id", || None).unwrap());
        let owns = |id, cwd, provider| handoff.owns_boundary("codex", id, cwd, provider);
        assert!(owns("future", "/work/handed-over", "opencodex"));
        assert!(!owns("foreign", "/work/handed-over-old", "opencodex"));
        assert!(!owns("nested", "/work/handed-over/nested", "opencodex"));
        assert!(!owns("other-channel", "/work/handed-over", "openai"));
        assert!(!owns("legacy", "/work/handed-over", "opencodex"));
        assert!(!handoff.owns("codex", "legacy", || None).unwrap());
        std::fs::remove_file(unfinished).unwrap();
        assert!(!owns("future", "/work/handed-over", "opencodex"));
    }

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
        assert!(cohort.owns_id("one") && !cohort.owns_id("two"));
        assert!(parse(json!({"instance_wide":true})).unwrap().owns_id("two"));
        let channel = json!({"cwd":"/work/one","provider":"opencodex"});
        let scoped = parse(json!({"workspaces":[channel]})).unwrap();
        assert!(scoped.cohort().is_none() && scoped.scans_workspaces());
        for invalid in [
            json!({}),
            json!({"native_sessions":[]}),
            json!({"instance_wide":false}),
            json!({"instance_wide":"true"}),
            json!({"native_sessions":null, "instance_wide":true}),
            json!({"native_sessions":[], "instance_wide":true}),
            json!({"native_sessions":["one"], "instance_wide":true}),
            json!({"workspaces":[],"native_sessions":["one"]}),
            json!({"workspaces":null,"instance_wide":true}),
            json!({"workspaces":[channel],"instance_wide":true}),
            json!({"workspaces":[channel,channel]}),
            json!({"workspaces":[{"cwd":"work/one","provider":"opencodex"}]}),
            json!({"workspaces":[{"cwd":"/work/../other","provider":"opencodex"}]}),
            json!({"workspaces":[{"cwd":"/work//one","provider":"opencodex"}]}),
            json!({"workspaces":[{"cwd":"/work/one/","provider":"opencodex"}]}),
            json!({"workspaces":[{"cwd":"/work/./one","provider":"opencodex"}]}),
            json!({"workspaces":[{"cwd":"/work/one","provider":"*"}]}),
            json!({"workspaces":[{"cwd":"/work/one"}]}),
        ] {
            assert!(parse(invalid.clone()).is_none(), "{invalid}");
        }
    }
}
