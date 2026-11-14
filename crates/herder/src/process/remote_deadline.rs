//! Per-execution deadline companion, independent of the controller and command
//! worker. It is a transient unit of the existing worker binary, not a daemon.
use super::{remote::*, remote_endpoint::origin, storage::{atomic_json, lock, read_json}, *};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::PathBuf, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeadlineState {
    version: u8,
    handle: RemoteHandle,
    scope: LinuxCgroupScope,
    worker: PathBuf,
    worker_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    state_digest: String,
    watchdog: ProcessIdentity,
}

pub(crate) fn boot_millis() -> io::Result<u64> {
    #[cfg(target_os = "linux")]
    {
        let mut now: libc::timespec = unsafe { std::mem::zeroed() };
        if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if now.tv_sec < 0 || now.tv_nsec < 0 { return Err(invalid("remote_clock_invalid")); }
        Ok(now.tv_sec as u64 * 1000 + now.tv_nsec as u64 / 1_000_000)
    }
    #[cfg(not(target_os = "linux"))]
    { Err(unsupported("remote_independent_deadline_unavailable")) }
}

pub(crate) fn check_capability(config: &RemoteEndpointConfig) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let runtime = PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }));
        if config.deadline_capability != RemoteDeadlineCapability::LinuxBootWatchdogV1
            || !std::path::Path::new("/usr/bin/systemd-run").is_file()
            || !runtime.join("bus").exists()
            || !fs::metadata(&runtime).is_ok_and(|m| m.uid() == unsafe { libc::geteuid() })
            || !std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").is_file() {
            return Err(unsupported("remote_independent_deadline_unavailable"));
        }
        boot_millis()?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = config; Err(unsupported("remote_independent_deadline_unavailable")) }
}

/// Called after entering the private command unit and before argv spawn. Local
/// executions have no origin and retain their existing launch behavior.
pub(crate) fn admit(store: &ExecutionStore, record: &ExecutionRecord) -> io::Result<()> {
    let Some(origin) = origin(store, record)? else { return Ok(()); };
    origin.config.validate()?;
    check_capability(&origin.config)?;
    let dir = store.execution_directory(&record.execution_ref)?;
    let permit: StartPermit = read_json(&dir.join("remote-start-permit.json"))?;
    let boot = capture_process(std::process::id(), store.node_ref())?.boot_id;
    permit.validate(&boot, boot_millis()?, origin.handle.deadline_boot_ms)?;
    if boot != origin.handle.boot_id { return Err(invalid("remote_boot_changed")); }
    let Some(ProcessTreeScope::LinuxCgroup(scope)) = &record.tree_scope else {
        return Err(unsupported("remote_private_cgroup_unavailable"));
    };
    let desired = DeadlineState { version: 1, handle: origin.handle, scope: scope.clone(),
        worker: origin.config.worker, worker_sha256: origin.config.worker_sha256 };
    // Open a pinned cgroup directory and cgroup.kill before starting any argv.
    // A read-only cgroup or delegated path mismatch is an admission failure.
    #[cfg(target_os = "linux")]
    let _kill = open_kill(&desired)?;
    let state_path = dir.join("remote-deadline.json");
    match read_json::<DeadlineState>(&state_path) {
        Ok(previous) if previous == desired => (),
        Ok(_) => return Err(invalid("remote_deadline_identity_changed")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => atomic_json(&state_path, &desired)?,
        Err(e) => return Err(e),
    }
    #[cfg(target_os = "linux")]
    launch_watchdog(store, &desired)?;
    let digest = hash_json(&desired)?;
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(ready) = read_json::<Ready>(&dir.join("remote-deadline-ready.json")) {
            if ready.state_digest == digest && ready.watchdog.node_ref == store.node_ref()
                && ready.watchdog.boot_id == desired.handle.boot_id
                && observe_process(&ready.watchdog) == ProcessObservation::Alive
                && super::storage::lock_is_held(&dir.join("remote-deadline.lock"))? {
                // A delayed unit does not renew the authorization or deadline.
                permit.validate(&boot, boot_millis()?, desired.handle.deadline_boot_ms)?;
                return Ok(());
            }
        }
        if std::time::Instant::now() >= until { return Err(unsupported("remote_deadline_ack_unavailable")); }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn spawn_cutoff(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<Option<u64>>{
    let Some(origin)=origin(store,record)? else{return Ok(None)};
    let permit:StartPermit=read_json(&store.execution_directory(&record.execution_ref)?.join("remote-start-permit.json"))?;
    Ok(Some(permit.expires_boot_ms.min(origin.handle.deadline_boot_ms)))
}

/// Additional native backstop. The absolute BOOTTIME companion remains the
/// deadline proof, since RuntimeMaxSec starts when systemd activates the unit.
pub(crate) fn runtime_limit(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<Option<u64>>{
    let Some(origin)=origin(store,record)? else{return Ok(None)};
    let remaining=origin.handle.deadline_boot_ms.saturating_sub(boot_millis()?);
    if remaining==0{return Err(invalid("remote_deadline_elapsed_before_unit"))}
    Ok(Some(remaining))
}

#[cfg(target_os = "linux")]
fn launch_watchdog(store: &ExecutionStore, state: &DeadlineState) -> io::Result<()> {
    use std::process::{Command, Stdio};
    verify_pinned_file(&state.worker, &state.worker_sha256, false)?;
    let runtime = PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }));
    let log = super::storage::open_private(&store.execution_directory(&state.handle.execution_ref)?
        .join("deadline-supervisor.log"), true, true)?;
    let mut child = Command::new("/usr/bin/systemd-run")
        .env_clear().env("XDG_RUNTIME_DIR", &runtime)
        .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={}/bus", runtime.display()))
        .args(["--user", "--quiet", "--collect", "--no-block"])
        .arg(format!("--unit=herder-deadline-{}.service", state.handle.execution_ref))
        .args(["--property=Type=exec", "--property=Restart=on-failure", "--property=RestartSec=100ms",
            "--property=StartLimitIntervalSec=0", "--property=KillMode=control-group"])
        .arg("--").arg(&state.worker).arg("--deadline-watchdog")
        .arg("--store").arg(store.root()).arg("--execution").arg(&state.handle.execution_ref)
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone()?)).stderr(Stdio::from(log)).spawn()?;
    let limit = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(result) = child.try_wait()? {
            return if result.success() { Ok(()) } else { Err(unsupported("remote_deadline_unit_rejected")) };
        }
        if std::time::Instant::now() >= limit {
            let _ = child.kill(); let _ = child.wait();
            return Err(unsupported("remote_deadline_unit_ack_missing"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn open_kill(state: &DeadlineState) -> io::Result<fs::File> {
    use std::{ffi::CString, os::{fd::{AsRawFd, FromRawFd}, unix::fs::{MetadataExt, OpenOptionsExt}}};
    let path = &state.scope.cgroup_path;
    let unit = format!("herder-process-{}.service", state.handle.execution_ref);
    if !path.starts_with("/sys/fs/cgroup") || path.file_name().and_then(|v| v.to_str()) != Some(&unit)
        || state.scope.boot_id != state.handle.boot_id
        || capture_process(std::process::id(), &state.handle.executor_node_ref)?.boot_id != state.handle.boot_id {
        return Err(invalid("remote_cgroup_identity_mismatch"));
    }
    absolute(path)?;
    let directory = fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    let m = directory.metadata()?;
    let root = fs::metadata("/sys/fs/cgroup")?;
    if !m.is_dir() || (m.dev(), m.ino()) != (state.scope.device, state.scope.inode) || m.dev() != root.dev() {
        return Err(invalid("remote_cgroup_identity_mismatch"));
    }
    let name = CString::new("cgroup.kill").expect("literal");
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

/// Restart=on-failure reruns only this observer, with the same immutable cutoff.
/// It never launches or resumes the command, renews a claim, or sends a message.
pub fn run_deadline_watchdog(store: &ExecutionStore, execution_ref: &str) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let dir = store.execution_directory(execution_ref)?;
        let Some(_gate) = lock(&dir.join("remote-deadline.lock"), false)? else { return Ok(()); };
        let state: DeadlineState = read_json(&dir.join("remote-deadline.json"))?;
        let record = store.load_record(execution_ref)?;
        let origin = origin(store, &record)?.ok_or_else(|| invalid("remote_origin_missing"))?;
        if state.version != 1 || state.handle != origin.handle || state.handle.execution_ref != execution_ref
            || state.worker != origin.config.worker || state.worker_sha256 != origin.config.worker_sha256 {
            return Err(invalid("remote_deadline_identity_changed"));
        }
        verify_pinned_file(&state.worker, &state.worker_sha256, false)?;
        if std::env::current_exe()?.canonicalize()? != state.worker { return Err(invalid("remote_worker_identity_mismatch")); }
        let expected = format!("herder-deadline-{execution_ref}.service");
        let cgroup = fs::read_to_string("/proc/self/cgroup")?;
        if !cgroup.lines().filter_map(|v| v.strip_prefix("0::"))
            .any(|v| PathBuf::from(v).file_name().and_then(|n| n.to_str()) == Some(expected.as_str())) {
            return Err(invalid("remote_deadline_unit_identity_mismatch"));
        }
        let scope = ProcessTreeScope::LinuxCgroup(state.scope.clone());
        if platform::scope_proven_empty(&scope) { return Ok(()); }
        let mut kill = open_kill(&state)?;
        atomic_json(&dir.join("remote-deadline-ready.json"), &Ready {
            state_digest: hash_json(&state)?, watchdog: capture_process(std::process::id(), store.node_ref())?,
        })?;
        loop {
            // Only the immutable, exact whole-tree receipt disarms a live scope.
            // A worker exit, cancellation request, lost lock or controller ACK is
            // insufficient. Empty cgroup/reboot is already kernel terminal proof.
            if let Ok(receipt) = read_json::<CompletionReceipt>(&dir.join("receipt.json")) {
                if receipt.execution_ref == execution_ref && receipt.node_ref == store.node_ref()
                    && receipt.tree_complete && !receipt.process_may_be_running { return Ok(()); }
            }
            if platform::scope_proven_empty(&scope) { return Ok(()); }
            if boot_millis()? >= state.handle.deadline_boot_ms {
                kill.write_all(b"1\n")?;
                atomic_json(&dir.join("remote-deadline-fired.json"), &serde_json::json!({
                    "version":1,"handle":state.handle,"scope":state.scope,
                    "observed_boot_ms":boot_millis()?,"evidence":"pinned_cgroup_kill"}))?;
                // Do not equate a successful write with stopped descendants.
                // Retain the independent observer until the kernel says empty.
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = (store, execution_ref); Err(unsupported("remote_independent_deadline_unavailable")) }
}
