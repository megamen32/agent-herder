//! Darwin supervision uses a private launchd resource coalition. The kernel
//! accounts forks and execs in that scope even after setsid or reparenting.
//! Process enumeration is only an observation/signalling aid, never an empty
//! tree proof. Private libproc APIs are capability checked before any command.
use super::{
    DarwinCoalitionScope, ExecutionState, ExecutionStore, ProcessIdentity, ProcessObservation,
    ProcessTreeScope,
    storage::{FileLock, WORKER_ENVIRONMENT_NAMES, atomic_json, open_private, read_json},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{CStr, c_void},
    fs,
    io::{self, Write},
    mem::{size_of, zeroed},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

const PROC_PIDT_BSDINFOWITHUNIQID: i32 = 18;
const PROC_PIDCOALITIONINFO: i32 = 20;
const SZOMB: u32 = 5;
const MAX_PIDS: usize = 131_072;
const DOMAIN_ENV: &str = "HERDER_EXECUTION_LAUNCHD_DOMAIN";
const LABEL_ENV: &str = "HERDER_EXECUTION_LAUNCHD_LABEL";

// These fixed ABI layouts are defined in Apple's proc_info(_private).h.
// BSD and unique identity are deliberately read in one proc_pidinfo call.
#[repr(C)]
#[derive(Clone, Copy)]
struct BsdInfo {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    reserved: u32,
    comm: [u8; 16],
    name: [u8; 32],
    nfiles: u32,
    pgid: u32,
    pjobc: u32,
    tdev: u32,
    tpgid: u32,
    nice: i32,
    start_sec: u64,
    start_usec: u64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct UniqueInfo {
    executable_uuid: [u8; 16],
    unique_id: u64,
    parent_unique_id: u64,
    idversion: i32,
    original_parent_version: i32,
    reserved: [u64; 2],
}
#[repr(C)]
#[derive(Clone, Copy)]
struct ProcessInfo {
    bsd: BsdInfo,
    unique: UniqueInfo,
}
#[repr(C)]
struct CoalitionInfo {
    ids: [u64; 2],
    reserved: [u64; 3],
}
#[repr(C)]
#[derive(Default)]
struct TaskCounts {
    started: u64,
    exited: u64,
}
impl TaskCounts {
    fn active(&self) -> io::Result<u64> {
        self.started
            .checked_sub(self.exited)
            .ok_or_else(|| io::Error::other("invalid kernel coalition counters"))
    }
}
const _: () = assert!(size_of::<BsdInfo>() == 136);
const _: () = assert!(size_of::<UniqueInfo>() == 56);
const _: () = assert!(size_of::<ProcessInfo>() == 192);
const _: () = assert!(size_of::<CoalitionInfo>() == 40);

#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
    fn proc_listallpids(buffer: *mut c_void, size: i32) -> i32;
}
type UsageFn = unsafe extern "C" fn(u64, *mut c_void, usize) -> i32;
type SignalFn = unsafe extern "C" fn(*const [u32; 8], i32) -> i32;
#[derive(Clone, Copy)]
struct NativeApis {
    usage: UsageFn,
    signal: SignalFn,
}
fn native_apis() -> io::Result<NativeApis> {
    static APIS: OnceLock<Option<NativeApis>> = OnceLock::new();
    let apis = APIS.get_or_init(|| unsafe {
        let usage = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"coalition_info_resource_usage".as_ptr(),
        );
        let signal = libc::dlsym(libc::RTLD_DEFAULT, c"proc_signal_with_audittoken".as_ptr());
        if usage.is_null() || signal.is_null() {
            None
        } else {
            Some(NativeApis {
                usage: std::mem::transmute::<*mut c_void, UsageFn>(usage),
                signal: std::mem::transmute::<*mut c_void, SignalFn>(signal),
            })
        }
    });
    apis.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Darwin coalition accounting and generation-bound signalling APIs are required",
        )
    })
}
fn boot_id() -> io::Result<String> {
    let mut bytes = [0_u8; 128];
    let mut len = bytes.len();
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    if len == 0 || len > bytes.len() {
        return Err(io::Error::other("invalid boot identity"));
    }
    let value = CStr::from_bytes_until_nul(&bytes[..len])
        .map_err(io::Error::other)?
        .to_str()
        .map_err(io::Error::other)?;
    if value.len() != 36 || !value.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(io::Error::other("invalid boot identity"));
    }
    Ok(format!("darwin:{}", value.to_ascii_lowercase()))
}
fn process_info(pid: u32) -> io::Result<ProcessInfo> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
    }
    let mut info: ProcessInfo = unsafe { zeroed() };
    let count = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDT_BSDINFOWITHUNIQID,
            0,
            (&mut info as *mut ProcessInfo).cast(),
            size_of::<ProcessInfo>() as i32,
        )
    };
    if count == 0 {
        let e = io::Error::last_os_error();
        return Err(if e.raw_os_error() == Some(libc::ESRCH) {
            io::Error::new(io::ErrorKind::NotFound, "process absent")
        } else {
            e
        });
    }
    if count != size_of::<ProcessInfo>() as i32 || info.bsd.pid != pid || info.unique.unique_id == 0
    {
        return Err(io::Error::other("unsupported Darwin process identity ABI"));
    }
    Ok(info)
}
fn coalition_id(pid: u32) -> io::Result<u64> {
    let mut info: CoalitionInfo = unsafe { zeroed() };
    let count = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDCOALITIONINFO,
            0,
            (&mut info as *mut CoalitionInfo).cast(),
            size_of::<CoalitionInfo>() as i32,
        )
    };
    if count == 0 {
        return Err(io::Error::last_os_error());
    }
    if count != size_of::<CoalitionInfo>() as i32 || info.ids[0] == 0 {
        return Err(io::Error::other("unsupported Darwin coalition ABI"));
    }
    Ok(info.ids[0])
}
fn task_counts(id: u64) -> io::Result<TaskCounts> {
    let mut counts = TaskCounts::default();
    // The kernel copies MIN(supplied size, current ABI size). Only the original
    // two u64 counters are requested; later kernel struct additions are harmless.
    if unsafe {
        (native_apis()?.usage)(
            id,
            (&mut counts as *mut TaskCounts).cast(),
            size_of::<TaskCounts>(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    counts.active()?;
    Ok(counts)
}
pub fn capture_process(pid: u32, node_ref: &str) -> io::Result<ProcessIdentity> {
    let boot_id = boot_id()?;
    let info = process_info(pid)?;
    Ok(ProcessIdentity {
        node_ref: node_ref.into(),
        boot_id,
        pid,
        start_ticks: info.unique.unique_id,
    })
}
pub fn observe_process(expected: &ProcessIdentity) -> ProcessObservation {
    match boot_id() {
        Ok(current) if current != expected.boot_id => return ProcessObservation::Gone,
        Err(_) => return ProcessObservation::Unknown,
        _ => (),
    }
    match process_info(expected.pid) {
        Ok(info) if info.unique.unique_id != expected.start_ticks || info.bsd.status == SZOMB => {
            ProcessObservation::Gone
        }
        Ok(_) => ProcessObservation::Alive,
        Err(e) if e.kind() == io::ErrorKind::NotFound => ProcessObservation::Gone,
        Err(_) => ProcessObservation::Unknown,
    }
}
pub(crate) fn boot_changed(expected: &str) -> bool {
    boot_id().is_ok_and(|current| current != expected)
}
fn label(execution_ref: &str) -> String {
    format!("com.agentherder.process.{execution_ref}")
}
fn valid_domain(value: &str) -> bool {
    let uid = unsafe { libc::geteuid() };
    value == format!("gui/{uid}") || value == format!("user/{uid}")
}
fn launchctl(args: &[&str]) -> io::Result<Output> {
    let child = Command::new("/bin/launchctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    wait_control(child)
}
fn wait_control(mut child: Child) -> io::Result<Output> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            // This unreaped direct child cannot have its PID reused.
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "launchd control timed out",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn selected_domain() -> io::Result<String> {
    let uid = unsafe { libc::geteuid() };
    for domain in [format!("gui/{uid}"), format!("user/{uid}")] {
        // Avoid piping the whole domain's potentially large, unrelated listing.
        let child = Command::new("/bin/launchctl")
            .args(["print", &domain])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        if wait_control(child)?.status.success() {
            return Ok(domain);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "owned launchd domain unavailable",
    ))
}
fn output_pid(output: &[u8]) -> Option<u32> {
    std::str::from_utf8(output)
        .ok()?
        .lines()
        .find_map(|l| l.trim().strip_prefix("pid = ")?.trim().parse().ok())
}
pub(crate) fn capture_owned_scope(execution_ref: &str) -> io::Result<Option<ProcessTreeScope>> {
    let (Ok(domain), Ok(job_label)) = (std::env::var(DOMAIN_ENV), std::env::var(LABEL_ENV)) else {
        return Ok(None);
    };
    native_apis()?;
    if !valid_domain(&domain)
        || job_label != label(execution_ref)
        || unsafe { libc::getppid() } != 1
    {
        return Err(io::Error::other(
            "worker is not the declared private launchd job",
        ));
    }
    let result = launchctl(&["print", &format!("{domain}/{job_label}")])?;
    if !result.status.success() || output_pid(&result.stdout) != Some(std::process::id()) {
        return Err(io::Error::other(
            "launchd worker identity could not be verified",
        ));
    }
    let id = coalition_id(std::process::id())?;
    if task_counts(id)?.active()? != 1 {
        return Err(io::Error::other(
            "launchd coalition is not initially exclusive",
        ));
    }
    Ok(Some(ProcessTreeScope::DarwinCoalition(
        DarwinCoalitionScope {
            coalition_id: id,
            boot_id: boot_id()?,
            launchd_domain: domain,
            launchd_label: job_label,
        },
    )))
}
fn current_owned_scope(scope: Option<&ProcessTreeScope>) -> io::Result<&DarwinCoalitionScope> {
    let Some(ProcessTreeScope::DarwinCoalition(scope)) = scope else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "private launchd coalition required",
        ));
    };
    if scope.boot_id != boot_id()? || coalition_id(std::process::id())? != scope.coalition_id {
        return Err(io::Error::other("worker coalition identity changed"));
    }
    Ok(scope)
}
pub(crate) fn initialize_supervision(scope: Option<&ProcessTreeScope>) -> io::Result<()> {
    native_apis()?;
    let scope = current_owned_scope(scope)?;
    if task_counts(scope.coalition_id)?.active()? != 1 {
        return Err(io::Error::other(
            "worker coalition contains unrelated tasks",
        ));
    }
    Ok(())
}
pub(crate) struct ReapedChildren {
    pub failed: bool,
    pub none_remaining: bool,
}
pub(crate) fn reap_adopted(scope: Option<&ProcessTreeScope>) -> io::Result<ReapedChildren> {
    let scope = current_owned_scope(scope)?;
    // Darwin reparents orphans to launchd, so only the root Child's exit is
    // available. Atomic resource-coalition counters prove all tasks stopped.
    Ok(ReapedChildren {
        failed: false,
        none_remaining: task_counts(scope.coalition_id)?.active()? == 1,
    })
}
fn all_pids() -> io::Result<Vec<u32>> {
    let estimate = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return Err(io::Error::last_os_error());
    }
    let mut capacity = (estimate as usize).saturating_add(128);
    loop {
        if capacity > MAX_PIDS {
            return Err(io::Error::other("process snapshot exceeds bound"));
        }
        let mut pids = vec![0_i32; capacity];
        let count = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        if count as usize >= capacity {
            capacity = capacity.saturating_mul(2);
            continue;
        }
        pids.truncate(count as usize);
        return Ok(pids
            .into_iter()
            .filter(|p| *p > 0)
            .map(|p| p as u32)
            .collect());
    }
}
pub(crate) fn descendants(worker_pid: u32, node_ref: &str) -> io::Result<Vec<ProcessIdentity>> {
    if worker_pid != std::process::id() {
        return Err(io::Error::other("foreign supervisor"));
    }
    let cid = coalition_id(worker_pid)?;
    let boot = boot_id()?;
    let mut members = Vec::new();
    for pid in all_pids()? {
        if pid == worker_pid || coalition_id(pid).ok() != Some(cid) {
            continue;
        }
        let Ok(info) = process_info(pid) else {
            continue;
        };
        if info.bsd.status == SZOMB || coalition_id(pid).ok() != Some(cid) {
            continue;
        }
        let Ok(check) = process_info(pid) else {
            continue;
        };
        if check.unique.unique_id != info.unique.unique_id {
            continue;
        }
        members.push(ProcessIdentity {
            node_ref: node_ref.into(),
            boot_id: boot.clone(),
            pid,
            start_ticks: info.unique.unique_id,
        });
    }
    Ok(members)
}
fn signal_identity(expected: &ProcessIdentity, cid: u64, signal: i32) -> io::Result<()> {
    if boot_id()? != expected.boot_id {
        return Ok(());
    }
    let info = match process_info(expected.pid) {
        Ok(info) => info,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if info.unique.unique_id != expected.start_ticks || info.bsd.status == SZOMB {
        return Ok(());
    }
    if coalition_id(expected.pid)? != cid || info.bsd.uid != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "process is outside owned coalition or uid",
        ));
    }
    // The kernel looks up pid+pidversion atomically and applies the caller's
    // normal signalling permission. Remaining audit fields confer no authority.
    // An exec may invalidate this generation; ESRCH is safe and the next tick
    // captures its new version while retaining the same unique process ID.
    let mut token = [0_u32; 8];
    token[5] = expected.pid;
    token[7] = info.unique.idversion as u32;
    let error = unsafe { (native_apis()?.signal)(&token, signal) };
    if error == 0 || error == libc::ESRCH {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(error))
    }
}
pub(crate) fn signal_tree(worker_pid: u32, node_ref: &str, signal: i32) -> io::Result<()> {
    let cid = coalition_id(worker_pid)?;
    let members = descendants(worker_pid, node_ref)?;
    for member in members.iter().rev() {
        signal_identity(member, cid, signal)?;
    }
    Ok(())
}
pub(crate) fn scope_proven_empty(scope: &ProcessTreeScope) -> bool {
    let ProcessTreeScope::DarwinCoalition(scope) = scope else {
        return false;
    };
    if boot_changed(&scope.boot_id) {
        return true;
    }
    // Coalition IDs are unique within a boot. The kernel only reaps a
    // terminated coalition after its last task exits, so ESRCH is also proof.
    match task_counts(scope.coalition_id) {
        Ok(counts) => counts.active().is_ok_and(|count| count == 0),
        Err(e) if e.raw_os_error() == Some(libc::ESRCH) => true,
        Err(_) => false,
    }
}
pub(crate) fn completion_evidence() -> &'static str {
    "herder_worker_waitpid_launchd_coalition"
}
pub(crate) fn empty_scope_evidence() -> &'static str {
    "owned_launchd_coalition_empty"
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchIntent {
    version: u32,
    execution_ref: String,
    worker_binary: PathBuf,
    domain: String,
    label: String,
    environment: BTreeMap<String, String>,
}
fn xml(value: &str) -> io::Result<String> {
    if value
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid launchd plist string",
        ));
    }
    Ok(value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;"))
}
fn string(value: &str) -> io::Result<String> {
    Ok(format!("<string>{}</string>", xml(value)?))
}
fn path_string(path: &Path) -> io::Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "launchd paths must be valid UTF-8",
        )
    })
}
fn plist(intent: &LaunchIntent, store: &ExecutionStore, directory: &Path) -> io::Result<Vec<u8>> {
    let arguments = [
        path_string(&intent.worker_binary)?,
        "--store".into(),
        path_string(store.root())?,
        "--execution".into(),
        intent.execution_ref.clone(),
    ];
    let mut value = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>",
    );
    value.push_str(&format!(
        "<key>Label</key>{}<key>ProgramArguments</key><array>",
        string(&intent.label)?
    ));
    for arg in arguments {
        value.push_str(&string(&arg)?);
    }
    value.push_str("</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><true/><key>AbandonProcessGroup</key><true/><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict>");
    for (name, val) in &intent.environment {
        value.push_str(&format!("<key>{}</key>{}", xml(name)?, string(val)?));
    }
    for (name, val) in [(DOMAIN_ENV, &intent.domain), (LABEL_ENV, &intent.label)] {
        value.push_str(&format!("<key>{name}</key>{}", string(val)?));
    }
    value.push_str("</dict>");
    let log = path_string(&directory.join("supervisor.log"))?;
    value.push_str(&format!(
        "<key>StandardOutPath</key>{}<key>StandardErrorPath</key>{}</dict></plist>\n",
        string(&log)?,
        string(&log)?
    ));
    Ok(value.into_bytes())
}
pub(crate) fn launch_worker(
    store: &ExecutionStore,
    execution_ref: &str,
    worker_binary: &Path,
    _launch_guard: &FileLock,
) -> io::Result<()> {
    native_apis()?;
    process_info(std::process::id())?;
    task_counts(coalition_id(std::process::id())?)?;
    let directory = store.execution_directory(execution_ref)?;
    if store.load_record(execution_ref)?.state != ExecutionState::Prepared {
        return Ok(());
    }
    let intent_path = directory.join("launchd.json");
    let intent: LaunchIntent = match read_json(&intent_path) {
        Ok(intent) => intent,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let mut environment = BTreeMap::new();
            for name in WORKER_ENVIRONMENT_NAMES {
                if let Some(value) = std::env::var_os(name) {
                    environment.insert(
                        (*name).into(),
                        value.into_string().map_err(|_| {
                            io::Error::new(
                                io::ErrorKind::InvalidInput,
                                "launchd environment must be UTF-8",
                            )
                        })?,
                    );
                }
            }
            let intent = LaunchIntent {
                version: 1,
                execution_ref: execution_ref.into(),
                worker_binary: worker_binary.into(),
                domain: selected_domain()?,
                label: label(execution_ref),
                environment,
            };
            atomic_json(&intent_path, &intent)?;
            intent
        }
        Err(e) => return Err(e),
    };
    if intent.version != 1
        || intent.execution_ref != execution_ref
        || intent.worker_binary != worker_binary
        || !valid_domain(&intent.domain)
        || intent.label != label(execution_ref)
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "launchd intent does not match execution",
        ));
    }
    let plist_path = directory.join("launchd.plist");
    let bytes = plist(&intent, store, &directory)?;
    let mut file = open_private(&plist_path, true, false)?;
    file.set_len(0)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::File::open(&directory)?.sync_all()?;
    open_private(&directory.join("supervisor.log"), true, true)?;
    let target = format!("{}/{}", intent.domain, intent.label);
    if launchctl(&["print", &target])?.status.success() {
        // A lost bootstrap acknowledgement cannot create or restart another job.
        return Ok(());
    }
    let result = launchctl(&["bootstrap", &intent.domain, &path_string(&plist_path)?])?;
    if !result.status.success() {
        // Bootstrap can lose its acknowledgement after admission. Check the
        // exact durable label, never retry by starting a second direct worker.
        if launchctl(&["print", &target])?.status.success() {
            return Ok(());
        }
        return Err(io::Error::other(
            "launchd did not admit the private execution job",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_generation_cannot_signal_an_owned_child() {
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let info = process_info(child.id()).unwrap();
        let mut token = [0_u32; 8];
        token[5] = child.id();
        token[7] = (info.unique.idversion as u32) ^ 0x0100_0000;
        assert_eq!(
            unsafe { (native_apis().unwrap().signal)(&token, libc::SIGTERM) },
            libc::ESRCH
        );
        assert!(child.try_wait().unwrap().is_none());
        token[7] = info.unique.idversion as u32;
        assert_eq!(
            unsafe { (native_apis().unwrap().signal)(&token, libc::SIGTERM) },
            0
        );
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
    }
}
