use super::{ProcessIdentity, ProcessObservation};
use std::{
    collections::BTreeSet,
    fs, io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};

struct ProcStat {
    start_ticks: u64,
    state: char,
}
fn boot_id() -> io::Result<String> {
    let v = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if v.is_empty() {
        return Err(io::Error::other("kernel boot identity unavailable"));
    }
    Ok(v)
}
fn proc_stat(pid: u32) -> io::Result<ProcStat> {
    if pid == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
    }
    let raw = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let tail = raw
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::other("invalid proc stat"))?
        .1;
    let fields: Vec<&str> = tail.split_whitespace().collect();
    let state = fields
        .first()
        .and_then(|v| v.chars().next())
        .ok_or_else(|| io::Error::other("missing process state"))?;
    let start_ticks = fields
        .get(19)
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| io::Error::other("missing process birth identity"))?;
    Ok(ProcStat { state, start_ticks })
}
pub fn capture_process(pid: u32, node_ref: &str) -> io::Result<ProcessIdentity> {
    let boot = boot_id()?;
    let stat = proc_stat(pid)?;
    Ok(ProcessIdentity {
        node_ref: node_ref.into(),
        boot_id: boot,
        pid,
        start_ticks: stat.start_ticks,
    })
}
pub fn observe_process(expected: &ProcessIdentity) -> ProcessObservation {
    match boot_id() {
        Ok(boot) if boot != expected.boot_id => return ProcessObservation::Gone,
        Err(_) => return ProcessObservation::Unknown,
        _ => (),
    }
    match proc_stat(expected.pid) {
        Ok(stat)
            if stat.start_ticks != expected.start_ticks
                || matches!(stat.state, 'Z' | 'X' | 'x') =>
        {
            ProcessObservation::Gone
        }
        Ok(_) => ProcessObservation::Alive,
        Err(e) if e.kind() == io::ErrorKind::NotFound => ProcessObservation::Gone,
        Err(_) => ProcessObservation::Unknown,
    }
}
pub(crate) fn initialize_supervision(_scope: Option<&super::ProcessTreeScope>) -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn direct_children(pid: u32) -> io::Result<Vec<u32>> {
    let raw = fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))?;
    raw.split_whitespace()
        .map(|v| v.parse::<u32>().map_err(io::Error::other))
        .collect()
}
pub(crate) fn descendants(worker_pid: u32, node_ref: &str) -> io::Result<Vec<ProcessIdentity>> {
    let mut pending = vec![worker_pid];
    let mut seen = BTreeSet::from([worker_pid]);
    let mut result = Vec::new();
    while let Some(parent) = pending.pop() {
        let children = match direct_children(parent) {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound && parent != worker_pid => continue,
            Err(e) => return Err(e),
        };
        for pid in children {
            if !seen.insert(pid) {
                continue;
            }
            match capture_process(pid, node_ref) {
                Ok(identity) => {
                    result.push(identity);
                    pending.push(pid);
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
    }
    Ok(result)
}
/// Linux pidfds close the PID-reuse race between identity validation and signal.
fn signal_identity(expected: &ProcessIdentity, signal: i32) -> io::Result<()> {
    if observe_process(expected) == ProcessObservation::Gone {
        return Ok(());
    }
    let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, expected.pid as libc::pid_t, 0) };
    if raw_fd == -1 {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(e)
        };
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw_fd as i32) };
    let actual = match capture_process(expected.pid, &expected.node_ref) {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if actual != *expected {
        return Err(io::Error::other("process identity changed before signal"));
    }
    let rc = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if rc == -1 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::ESRCH) {
            return Err(e);
        }
    }
    Ok(())
}
/// Only descendants of this dedicated worker are ever signalled.
pub(crate) fn signal_tree(worker_pid: u32, node_ref: &str, signal: i32) -> io::Result<()> {
    let members = descendants(worker_pid, node_ref)?;
    for member in members.iter().rev() {
        signal_identity(member, signal)?;
    }
    Ok(())
}
/// Call only after the original Child handle recorded its own exit status.
pub(crate) struct ReapedChildren {
    pub failed: bool,
    pub none_remaining: bool,
}
pub(crate) fn reap_adopted(_scope: Option<&super::ProcessTreeScope>) -> io::Result<ReapedChildren> {
    let mut failed = false;
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if result > 0 {
            failed |= !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0;
        } else if result == 0 {
            return Ok(ReapedChildren {
                failed,
                none_remaining: false,
            });
        } else {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::ECHILD) => {
                    return Ok(ReapedChildren {
                        failed,
                        none_remaining: true,
                    });
                }
                Some(libc::EINTR) => continue,
                _ => return Err(e),
            }
        }
    }
}

pub(crate) fn boot_changed(expected: &str) -> bool {
    boot_id().is_ok_and(|current| current != expected)
}
/// Accept only the private transient unit named for this execution, never the
/// control-plane service's shared cgroup.
pub(crate) fn capture_owned_scope(
    execution_ref: &str,
) -> io::Result<Option<super::ProcessTreeScope>> {
    use std::os::unix::fs::MetadataExt;
    let unit = format!("herder-process-{execution_ref}.service");
    let contents = fs::read_to_string("/proc/self/cgroup")?;
    let Some(relative) = contents.lines().find_map(|v| v.strip_prefix("0::")) else {
        return Ok(None);
    };
    let relative = std::path::Path::new(relative);
    if relative.file_name().and_then(|v| v.to_str()) != Some(unit.as_str()) {
        return Ok(None);
    }
    if !relative.is_absolute()
        || relative
            .components()
            .any(|v| matches!(v, std::path::Component::ParentDir))
    {
        return Err(io::Error::other("invalid kernel cgroup path"));
    }
    let path = std::path::Path::new("/sys/fs/cgroup")
        .join(relative.strip_prefix("/").map_err(io::Error::other)?);
    let m = fs::metadata(&path)?;
    if !m.is_dir() {
        return Err(io::Error::other("execution cgroup is not a directory"));
    }
    Ok(Some(super::ProcessTreeScope::LinuxCgroup(
        super::LinuxCgroupScope {
            cgroup_path: path,
            device: m.dev(),
            inode: m.ino(),
            boot_id: boot_id()?,
        },
    )))
}
pub(crate) fn scope_proven_empty(scope: &super::ProcessTreeScope) -> bool {
    use std::os::unix::fs::MetadataExt;
    let super::ProcessTreeScope::LinuxCgroup(scope) = scope else {
        return false;
    };
    if boot_changed(&scope.boot_id) {
        return true;
    }
    if !scope.cgroup_path.starts_with("/sys/fs/cgroup")
        || !fs::metadata("/sys/fs/cgroup").is_ok_and(|m| m.dev() == scope.device)
        || !std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").is_file()
    {
        return false;
    }
    match fs::metadata(&scope.cgroup_path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Ok(m) if m.dev() == scope.device && m.ino() == scope.inode => {
            fs::read_to_string(scope.cgroup_path.join("cgroup.events")).is_ok_and(|s| {
                s.lines()
                    .any(|line| line.split_whitespace().collect::<Vec<_>>() == ["populated", "0"])
            })
        }
        _ => false,
    }
}

pub(crate) fn completion_evidence() -> &'static str {
    "herder_worker_waitpid_subreaper"
}
pub(crate) fn empty_scope_evidence() -> &'static str {
    "owned_cgroup_empty"
}
