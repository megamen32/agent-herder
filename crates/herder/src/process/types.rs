use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub principal_ref: String,
    pub session_ref: String,
    pub request_key: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// Absolute persisted deadline. Restarting a worker never extends it.
    pub deadline_unix_ms: Option<u64>,
    #[serde(default = "default_stop_grace")]
    pub stop_grace_ms: u64,
}
pub fn default_stop_grace() -> u64 {
    2_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachRequest {
    pub principal_ref: String,
    pub session_ref: String,
    pub request_key: String,
    /// Must be captured on this exact node, never inferred from a command substring.
    pub process: ProcessIdentity,
    pub deadline_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    content = "request",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ExecutionRequest {
    Start(StartRequest),
    Attach(AttachRequest),
}
impl ExecutionRequest {
    pub fn principal_ref(&self) -> &str {
        match self {
            Self::Start(v) => &v.principal_ref,
            Self::Attach(v) => &v.principal_ref,
        }
    }
    pub fn session_ref(&self) -> &str {
        match self {
            Self::Start(v) => &v.session_ref,
            Self::Attach(v) => &v.session_ref,
        }
    }
    pub fn request_key(&self) -> &str {
        match self {
            Self::Start(v) => &v.request_key,
            Self::Attach(v) => &v.request_key,
        }
    }
    pub fn deadline(&self) -> Option<u64> {
        match self {
            Self::Start(v) => v.deadline_unix_ms,
            Self::Attach(v) => v.deadline_unix_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub node_ref: String,
    pub boot_id: String,
    pub pid: u32,
    /// Kernel birth cookie, scoped to node and boot. Linux uses /proc starttime;
    /// Darwin uses proc_uniqidentifierinfo.p_uniqueid, which survives exec.
    pub start_ticks: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessObservation {
    Alive,
    Gone,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Prepared,
    Starting,
    Running,
    Finished,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionReason {
    Exited,
    Cancelled,
    TimedOut,
    LaunchFailed,
    LeaseLost,
    ObservationLost,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionReceipt {
    pub execution_ref: String,
    pub node_ref: String,
    pub reason: CompletionReason,
    pub started_at_unix_ms: Option<u64>,
    pub finished_at_unix_ms: u64,
    /// Exit status of the originally launched command, not a guess from liveness.
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// An observed descendant exit failed. Darwin cannot reap orphan exits;
    /// its receipt records the command's real exit and a separate empty-tree proof.
    pub descendant_failure: bool,
    /// True only when a kernel scope or subreaper proves the entire tree stopped.
    pub tree_complete: bool,
    pub process_may_be_running: bool,
    pub evidence_source: String,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub detail: Option<String>,
}
impl CompletionReceipt {
    pub fn succeeded(&self) -> bool {
        self.reason == CompletionReason::Exited
            && self.exit_code == Some(0)
            && self.signal.is_none()
            && self.tree_complete
            && !self.descendant_failure
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRecord {
    pub schema_version: u32,
    pub execution_ref: String,
    pub node_ref: String,
    pub principal_ref: String,
    pub session_ref: String,
    pub request_key: String,
    pub payload_hash: String,
    pub request: ExecutionRequest,
    pub state: ExecutionState,
    pub created_at_unix_ms: u64,
    pub started_at_unix_ms: Option<u64>,
    pub heartbeat_at_unix_ms: Option<u64>,
    pub worker: Option<ProcessIdentity>,
    #[serde(default)]
    pub tree_scope: Option<ProcessTreeScope>,
    pub process: Option<ProcessIdentity>,
    pub observed_members: Vec<ProcessIdentity>,
    pub root_exit: Option<ProcessExit>,
    pub receipt: Option<CompletionReceipt>,
    pub finalization_pending: bool,
    pub finalization_error: Option<String>,
    pub observation_detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionObservation {
    Pending,
    ConfirmedLive,
    Terminal,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSnapshot {
    pub record: ExecutionRecord,
    pub observation: ExecutionObservation,
    pub confirmed_live: bool,
    pub worker_lock_held: bool,
}

/// This operation never stops an admitted worker or an attached external process.
#[derive(Debug, Clone)]
pub enum UnlaunchedCancellation {
    Cancelled(ExecutionSnapshot),
    AlreadyTerminal(ExecutionSnapshot),
    NotProven(ExecutionSnapshot),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerBackend {
    Auto,
    Direct,
    SystemdUser,
    LaunchdUser,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProcessTreeScope {
    LinuxCgroup(LinuxCgroupScope),
    DarwinCoalition(DarwinCoalitionScope),
}
/// Keep the original Linux representation readable by existing durable stores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxCgroupScope {
    pub cgroup_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub boot_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DarwinCoalitionScope {
    pub coalition_id: u64,
    pub boot_id: String,
    pub launchd_domain: String,
    pub launchd_label: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerOutcome {
    Completed,
    AlreadyRunning,
    NoReplayUnknown,
}
