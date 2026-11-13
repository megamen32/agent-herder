use super::{linux, types::*, unix_millis};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone)]
pub struct ExecutionStore {
    root: PathBuf,
    node_ref: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreMetadata {
    schema_version: u32,
    node_ref: String,
}

pub(crate) struct FileLock {
    file: File,
}
impl Drop for FileLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn execution_ref_for(principal_ref: &str, session_ref: &str, request_key: &str) -> String {
    let mut h = Sha256::new();
    for part in [principal_ref, session_ref, request_key] {
        h.update((part.len() as u64).to_be_bytes());
        h.update(part.as_bytes());
    }
    format!("exec-{}", hex(&h.finalize()))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}
fn conflict(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::AlreadyExists, message.into())
}
fn check_string(value: &str, name: &str) -> io::Result<()> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        Err(invalid(format!("invalid {name}")))
    } else {
        Ok(())
    }
}
fn verify_directory(path: &Path) -> io::Result<()> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "execution directory must be owned and not group/world writable",
        ));
    }
    Ok(())
}
fn create_directory(path: &Path) -> io::Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    verify_directory(path)
}
pub(crate) fn open_private(path: &Path, create: bool, append: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .append(append)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    verify_private_file(&file, false)?;
    Ok(file)
}
fn verify_private_file(file: &File, allow_unlinked_snapshot: bool) -> io::Result<()> {
    let m = file.metadata()?;
    if !m.is_file()
        || m.nlink() > 1
        || (!allow_unlinked_snapshot && m.nlink() == 0)
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "execution file must be private, singly linked and owned",
        ));
    }
    Ok(())
}
pub(crate) fn lock(path: &Path, blocking: bool) -> io::Result<Option<FileLock>> {
    let f = open_private(path, true, false)?;
    let flags = libc::LOCK_EX | if blocking { 0 } else { libc::LOCK_NB };
    if unsafe { libc::flock(f.as_raw_fd(), flags) } != 0 {
        let e = io::Error::last_os_error();
        if !blocking && matches!(e.raw_os_error(), Some(libc::EWOULDBLOCK)) {
            return Ok(None);
        }
        return Err(e);
    }
    let actual = fs::symlink_metadata(path)?;
    let pinned = f.metadata()?;
    if actual.dev() != pinned.dev() || actual.ino() != pinned.ino() {
        return Err(io::Error::other("execution lock identity changed"));
    }
    Ok(Some(FileLock { file: f }))
}
fn lock_is_held(path: &Path) -> io::Result<bool> {
    let f = match open_private(path, false, false) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        unsafe {
            libc::flock(f.as_raw_fd(), libc::LOCK_UN);
        }
        Ok(false)
    } else {
        let e = io::Error::last_os_error();
        if matches!(e.raw_os_error(), Some(libc::EWOULDBLOCK)) {
            Ok(true)
        } else {
            Err(e)
        }
    }
}
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<T> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    // Atomic rename can unlink this already-open immutable snapshot between
    // open and fstat. It remains valid to read; writable/lock files require one
    // link, and hard-linked files are always rejected.
    verify_private_file(&f, true)?;
    if f.metadata()?.len() > 2 * 1024 * 1024 {
        return Err(invalid("execution record too large"));
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
pub(crate) fn atomic_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("missing parent directory"))?;
    verify_directory(parent)?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| invalid("invalid filename"))?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| io::Error::other("clock unavailable"))?
        .as_nanos();
    let tmp = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), unique));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&tmp)?;
    let result = (|| {
        serde_json::to_writer(&mut f, value).map_err(io::Error::other)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

impl ExecutionStore {
    pub fn open(root: impl AsRef<Path>, node_ref: impl Into<String>) -> io::Result<Self> {
        let root = root.as_ref();
        if !root.is_absolute() {
            return Err(invalid("execution store path must be absolute"));
        }
        let node_ref = node_ref.into();
        check_string(&node_ref, "node_ref")?;
        if !root.exists() {
            DirBuilder::new().recursive(true).mode(0o700).create(root)?;
        }
        verify_directory(root)?;
        let root = root.canonicalize()?;
        let _gate = lock(&root.join("store.lock"), true)?.expect("blocking lock");
        let metadata_path = root.join("store.json");
        match read_json::<StoreMetadata>(&metadata_path) {
            Ok(v) if v.schema_version == 1 && v.node_ref == node_ref => (),
            Ok(_) => return Err(conflict("execution store node or schema mismatch")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                atomic_json(
                    &metadata_path,
                    &StoreMetadata {
                        schema_version: 1,
                        node_ref: node_ref.clone(),
                    },
                )?;
            }
            Err(e) => return Err(e),
        }
        Ok(Self { root, node_ref })
    }
    pub fn from_existing_root(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref();
        if !root.is_absolute() {
            return Err(invalid("execution store path must be absolute"));
        }
        verify_directory(root)?;
        let root = root.canonicalize()?;
        let metadata: StoreMetadata = read_json(&root.join("store.json"))?;
        if metadata.schema_version != 1 {
            return Err(invalid("unsupported execution store schema"));
        }
        check_string(&metadata.node_ref, "node_ref")?;
        Ok(Self {
            root,
            node_ref: metadata.node_ref,
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn node_ref(&self) -> &str {
        &self.node_ref
    }
    pub fn execution_directory(&self, execution_ref: &str) -> io::Result<PathBuf> {
        let suffix = execution_ref
            .strip_prefix("exec-")
            .ok_or_else(|| invalid("invalid execution_ref"))?;
        if suffix.len() != 64
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(invalid("invalid execution_ref"));
        }
        Ok(self.root.join(execution_ref))
    }
    fn validate_request(&self, mut request: ExecutionRequest) -> io::Result<ExecutionRequest> {
        check_string(request.principal_ref(), "principal_ref")?;
        check_string(request.session_ref(), "session_ref")?;
        check_string(request.request_key(), "request_key")?;
        match &mut request {
            ExecutionRequest::Start(r) => {
                if r.argv.is_empty()
                    || r.argv.len() > 256
                    || r.argv[0].is_empty()
                    || r.argv.iter().any(|v| v.contains('\0'))
                    || r.argv.iter().map(String::len).sum::<usize>() > 128 * 1024
                {
                    return Err(invalid("invalid command argv"));
                }
                if !r.cwd.is_absolute() {
                    return Err(invalid("command cwd must be absolute"));
                }
                r.cwd = r.cwd.canonicalize()?;
                if !r.cwd.is_dir() {
                    return Err(invalid("command cwd is not a directory"));
                }
                if r.stop_grace_ms > 300_000 {
                    return Err(invalid("stop grace exceeds five minutes"));
                }
            }
            ExecutionRequest::Attach(r) => {
                if r.process.node_ref != self.node_ref
                    || r.process.pid == 0
                    || r.process.start_ticks == 0
                {
                    return Err(invalid(
                        "attach process identity does not belong to this node",
                    ));
                }
                check_string(&r.process.boot_id, "boot_id")?;
            }
        }
        Ok(request)
    }
    pub fn prepare_start(&self, request: StartRequest) -> io::Result<ExecutionRecord> {
        self.prepare(ExecutionRequest::Start(request))
    }
    pub fn prepare_attach(&self, request: AttachRequest) -> io::Result<ExecutionRecord> {
        self.prepare(ExecutionRequest::Attach(request))
    }
    fn prepare(&self, request: ExecutionRequest) -> io::Result<ExecutionRecord> {
        let request = self.validate_request(request)?;
        let execution_ref = execution_ref_for(
            request.principal_ref(),
            request.session_ref(),
            request.request_key(),
        );
        let payload_hash = hex(&Sha256::digest(
            serde_json::to_vec(&request).map_err(io::Error::other)?,
        ));
        let dir = self.execution_directory(&execution_ref)?;
        create_directory(&dir)?;
        File::open(&self.root)?.sync_all()?;
        let _gate = lock(&dir.join("record.lock"), true)?.expect("blocking lock");
        let path = dir.join("record.json");
        match read_json::<ExecutionRecord>(&path) {
            Ok(record) => {
                self.validate_record(&record, &execution_ref)?;
                if record.payload_hash != payload_hash {
                    return Err(conflict(
                        "request_key reused with different execution parameters",
                    ));
                }
                return Ok(record);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let record = ExecutionRecord {
            schema_version: 1,
            execution_ref,
            node_ref: self.node_ref.clone(),
            principal_ref: request.principal_ref().into(),
            session_ref: request.session_ref().into(),
            request_key: request.request_key().into(),
            payload_hash,
            request,
            state: ExecutionState::Prepared,
            created_at_unix_ms: unix_millis()?,
            started_at_unix_ms: None,
            heartbeat_at_unix_ms: None,
            worker: None,
            tree_scope: None,
            process: None,
            observed_members: Vec::new(),
            root_exit: None,
            receipt: None,
            finalization_pending: false,
            finalization_error: None,
            observation_detail: None,
        };
        atomic_json(&path, &record)?;
        Ok(record)
    }
    fn validate_record(&self, record: &ExecutionRecord, expected: &str) -> io::Result<()> {
        if record.schema_version != 1
            || record.node_ref != self.node_ref
            || record.execution_ref != expected
            || execution_ref_for(
                &record.principal_ref,
                &record.session_ref,
                &record.request_key,
            ) != expected
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "execution record identity mismatch",
            ));
        }
        let digest = hex(&Sha256::digest(
            serde_json::to_vec(&record.request).map_err(io::Error::other)?,
        ));
        if digest != record.payload_hash
            || record.request.principal_ref() != record.principal_ref
            || record.request.session_ref() != record.session_ref
            || record.request.request_key() != record.request_key
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "execution request integrity mismatch",
            ));
        }
        Ok(())
    }
    pub(crate) fn load_record(&self, execution_ref: &str) -> io::Result<ExecutionRecord> {
        let dir = self.execution_directory(execution_ref)?;
        verify_directory(&dir)?;
        let mut record: ExecutionRecord = read_json(&dir.join("record.json"))?;
        self.validate_record(&record, execution_ref)?;
        // Receipt is persisted before the record update. Recover that crash window.
        if record.receipt.is_none() {
            match read_json::<CompletionReceipt>(&dir.join("receipt.json")) {
                Ok(receipt) => {
                    if receipt.execution_ref != execution_ref || receipt.node_ref != self.node_ref {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "completion receipt identity mismatch",
                        ));
                    }
                    record.state = if receipt.tree_complete {
                        ExecutionState::Finished
                    } else {
                        ExecutionState::Unknown
                    };
                    record.receipt = Some(receipt);
                    record.finalization_pending = true;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        Ok(record)
    }
    pub(crate) fn save_record(&self, record: &ExecutionRecord) -> io::Result<()> {
        self.validate_record(record, &record.execution_ref)?;
        let dir = self.execution_directory(&record.execution_ref)?;
        let _gate = lock(&dir.join("record.lock"), true)?.expect("blocking lock");
        atomic_json(&dir.join("record.json"), record)
    }
    pub fn start(
        &self,
        request: StartRequest,
        worker_binary: &Path,
    ) -> io::Result<ExecutionSnapshot> {
        let record = self.prepare_start(request)?;
        self.launch_prepared(&record.execution_ref, worker_binary)
    }
    pub fn attach(
        &self,
        request: AttachRequest,
        worker_binary: &Path,
    ) -> io::Result<ExecutionSnapshot> {
        let record = self.prepare_attach(request)?;
        self.launch_prepared(&record.execution_ref, worker_binary)
    }
    pub fn launch_prepared(
        &self,
        execution_ref: &str,
        worker_binary: &Path,
    ) -> io::Result<ExecutionSnapshot> {
        self.launch_prepared_with_backend(execution_ref, worker_binary, WorkerBackend::Auto)
    }
    pub fn launch_prepared_with_backend(
        &self,
        execution_ref: &str,
        worker_binary: &Path,
        backend: WorkerBackend,
    ) -> io::Result<ExecutionSnapshot> {
        let record = self.load_record(execution_ref)?;
        if record.state != ExecutionState::Prepared
            && !(record.receipt.is_some() && record.finalization_pending)
        {
            return self.reconcile(execution_ref);
        }
        if !worker_binary.is_absolute() {
            return Err(invalid(
                "worker executable must be an absolute configured path",
            ));
        }
        let worker_binary = worker_binary.canonicalize()?;
        if !worker_binary.is_file() {
            return Err(invalid("worker executable is not a file"));
        }
        let dir = self.execution_directory(execution_ref)?;
        let log = open_private(&dir.join("supervisor.log"), true, true)?;
        let user_runtime = PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }));
        let systemd_available = Path::new("/usr/bin/systemd-run").is_file()
            && fs::metadata(&user_runtime).is_ok_and(|m| m.uid() == unsafe { libc::geteuid() })
            && user_runtime.join("bus").exists();
        if backend == WorkerBackend::SystemdUser && !systemd_available {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "owned systemd user manager unavailable",
            ));
        }
        let use_systemd = backend != WorkerBackend::Direct && systemd_available;
        let environment_names = [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "HERDER_PROCESS_CONFIG",
        ];
        let mut command = if use_systemd {
            let mut c = Command::new("/usr/bin/systemd-run");
            c.args(["--user", "--quiet", "--collect", "--no-block"])
                .arg(format!("--unit=herder-process-{execution_ref}.service"))
                .args([
                    "--property=Type=exec",
                    "--property=KillMode=control-group",
                    "--property=Restart=no",
                ])
                .arg(format!(
                    "--property=StandardOutput=append:{}",
                    dir.join("supervisor.log").display()
                ))
                .arg(format!(
                    "--property=StandardError=append:{}",
                    dir.join("supervisor.log").display()
                ));
            for name in environment_names {
                if let Some(value) = std::env::var_os(name) {
                    let mut assignment = std::ffi::OsString::from(format!("--setenv={name}="));
                    assignment.push(value);
                    c.arg(assignment);
                }
            }
            c.arg("--").arg(&worker_binary);
            c.env("XDG_RUNTIME_DIR", &user_runtime).env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/bus", user_runtime.display()),
            );
            c
        } else {
            let mut c = Command::new(&worker_binary);
            c.env_clear();
            for name in environment_names {
                if let Some(value) = std::env::var_os(name) {
                    c.env(name, value);
                }
            }
            c
        };
        command
            .arg("--store")
            .arg(&self.root)
            .arg("--execution")
            .arg(execution_ref)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut worker = command.spawn()?;
        // Do not retain the MCP request or leave a zombie if this control plane lives.
        let _ = std::thread::Builder::new()
            .name("herder-execution-reaper".into())
            .spawn(move || {
                let _ = worker.wait();
            });
        self.status(execution_ref)
    }
    pub fn status(&self, execution_ref: &str) -> io::Result<ExecutionSnapshot> {
        let record = self.load_record(execution_ref)?;
        let dir = self.execution_directory(execution_ref)?;
        let worker_lock_held = lock_is_held(&dir.join("worker.lock"))?;
        let fresh = record
            .heartbeat_at_unix_ms
            .is_some_and(|v| unix_millis().is_ok_and(|now| now >= v && now - v <= 5_000));
        let worker_alive = record
            .worker
            .as_ref()
            .is_some_and(|v| linux::observe_process(v) == ProcessObservation::Alive);
        let members_alive = record
            .process
            .as_ref()
            .is_some_and(|v| linux::observe_process(v) == ProcessObservation::Alive)
            || record
                .observed_members
                .iter()
                .any(|v| linux::observe_process(v) == ProcessObservation::Alive);
        let confirmed_live = record.state == ExecutionState::Running
            && record.receipt.is_none()
            && worker_lock_held
            && worker_alive
            && fresh
            && members_alive;
        let observation = if record.receipt.is_some() {
            ExecutionObservation::Terminal
        } else if confirmed_live {
            ExecutionObservation::ConfirmedLive
        } else if record.state == ExecutionState::Prepared
            || (record.state == ExecutionState::Starting && worker_lock_held && worker_alive)
        {
            ExecutionObservation::Pending
        } else {
            ExecutionObservation::Unknown
        };
        Ok(ExecutionSnapshot {
            record,
            observation,
            confirmed_live,
            worker_lock_held,
        })
    }
    /// Reconciliation never launches work. A lost supervisor preserves uncertainty.
    pub fn reconcile(&self, execution_ref: &str) -> io::Result<ExecutionSnapshot> {
        let mut snapshot = self.status(execution_ref)?;
        if matches!(
            snapshot.record.state,
            ExecutionState::Running | ExecutionState::Starting | ExecutionState::Unknown
        ) && snapshot.record.receipt.is_none()
            && !snapshot.worker_lock_held
        {
            // The worker can be between acquiring its lock and updating the record.
            // Only a definitely absent original identity permits this transition.
            let gone = snapshot
                .record
                .worker
                .as_ref()
                .is_some_and(|p| linux::observe_process(p) == ProcessObservation::Gone);
            if gone {
                let supervised = matches!(snapshot.record.request, ExecutionRequest::Start(_));
                let rebooted = snapshot
                    .record
                    .worker
                    .as_ref()
                    .is_some_and(|p| linux::boot_changed(&p.boot_id));
                let empty_scope = snapshot
                    .record
                    .tree_scope
                    .as_ref()
                    .is_some_and(linux::scope_proven_empty);
                if supervised && (rebooted || empty_scope) {
                    let dir = self.execution_directory(execution_ref)?;
                    let receipt = CompletionReceipt {
                        execution_ref: execution_ref.into(), node_ref: self.node_ref.clone(),
                        reason: CompletionReason::ObservationLost,
                        started_at_unix_ms: snapshot.record.started_at_unix_ms,
                        finished_at_unix_ms: unix_millis()?, exit_code: None, signal: None,
                        descendant_failure: false, tree_complete: true, process_may_be_running: false,
                        evidence_source: if rebooted { "node_boot_changed" } else { "owned_cgroup_empty" }.into(),
                        stdout_path: dir.join("stdout.log"), stderr_path: dir.join("stderr.log"),
                        detail: Some("supervisor result was lost; local execution scope is proven empty, exit status remains unknown".into()),
                    };
                    self.finish(&mut snapshot.record, receipt)?;
                    snapshot.observation = ExecutionObservation::Terminal;
                } else {
                    snapshot.record.state = ExecutionState::Unknown;
                    snapshot.record.observation_detail = Some("supervisor lost; checked boot/process identities and cgroup evidence; execution is never replayed and its tree may still exist".into());
                    self.save_record(&snapshot.record)?;
                    snapshot.observation = ExecutionObservation::Unknown;
                }
                snapshot.confirmed_live = false;
            }
        }
        Ok(snapshot)
    }
    /// Cancel only a tree this worker launched. PID-only attachment cannot prove tree ownership.
    /// A controller may recover idempotent terminal hooks without launching a
    /// worker. Acknowledge only the exact immutable receipt under the record gate.
    pub fn acknowledge_finalization(
        &self,
        execution_ref: &str,
        receipt: &CompletionReceipt,
    ) -> io::Result<()> {
        let dir = self.execution_directory(execution_ref)?;
        let _gate = lock(&dir.join("record.lock"), true)?.expect("blocking lock");
        let durable: CompletionReceipt = read_json(&dir.join("receipt.json"))?;
        if durable != *receipt
            || durable.execution_ref != execution_ref
            || durable.node_ref != self.node_ref
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "finalization receipt does not match durable evidence",
            ));
        }
        let mut record = self.load_record(execution_ref)?;
        if record.receipt.as_ref() != Some(&durable) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "record receipt does not match durable evidence",
            ));
        }
        record.finalization_pending = false;
        record.finalization_error = None;
        atomic_json(&dir.join("record.json"), &record)
    }

    pub fn cancel(&self, execution_ref: &str) -> io::Result<ExecutionSnapshot> {
        let record = self.load_record(execution_ref)?;
        if matches!(record.request, ExecutionRequest::Attach(_)) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "PID-only attachment cannot cancel an unowned process tree",
            ));
        }
        if record.receipt.is_none() {
            let dir = self.execution_directory(execution_ref)?;
            let _gate = lock(&dir.join("cancel.lock"), true)?.expect("blocking lock");
            let path = dir.join("cancel.json");
            if !path.exists() {
                atomic_json(
                    &path,
                    &serde_json::json!({"requested_at_unix_ms":unix_millis()?}),
                )?;
            }
        }
        self.status(execution_ref)
    }
    pub(crate) fn cancellation_requested(&self, execution_ref: &str) -> io::Result<bool> {
        let path = self.execution_directory(execution_ref)?.join("cancel.json");
        match read_json::<serde_json::Value>(&path) {
            Ok(v) if v["requested_at_unix_ms"].is_u64() => Ok(true),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid cancellation record",
            )),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub(crate) fn finish(
        &self,
        record: &mut ExecutionRecord,
        receipt: CompletionReceipt,
    ) -> io::Result<()> {
        let dir = self.execution_directory(&record.execution_ref)?;
        let _gate = lock(&dir.join("record.lock"), true)?.expect("blocking lock");
        let receipt_path = dir.join("receipt.json");
        let durable = match read_json::<CompletionReceipt>(&receipt_path) {
            Ok(existing) => existing,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                atomic_json(&receipt_path, &receipt)?;
                receipt
            }
            Err(e) => return Err(e),
        };
        if durable.execution_ref != record.execution_ref || durable.node_ref != self.node_ref {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "completion receipt identity mismatch",
            ));
        }
        record.state = if durable.tree_complete {
            ExecutionState::Finished
        } else {
            ExecutionState::Unknown
        };
        record.receipt = Some(durable);
        record.finalization_pending = true;
        atomic_json(&dir.join("record.json"), record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_record_keeps_an_open_private_snapshot_valid() {
        let dir = std::env::temp_dir().join(format!(
            "herder-snapshot-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        create_directory(&dir).unwrap();
        let path = dir.join("record.json");
        atomic_json(&path, &serde_json::json!({"generation": 1})).unwrap();
        let mut snapshot = OpenOptions::new().read(true).open(&path).unwrap();
        atomic_json(&path, &serde_json::json!({"generation": 2})).unwrap();
        assert_eq!(snapshot.metadata().unwrap().nlink(), 0);
        verify_private_file(&snapshot, true).unwrap();
        assert!(verify_private_file(&snapshot, false).is_err());
        let mut old = String::new();
        snapshot.read_to_string(&mut old).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&old).unwrap()["generation"],
            1
        );
        assert_eq!(
            read_json::<serde_json::Value>(&path).unwrap()["generation"],
            2
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
