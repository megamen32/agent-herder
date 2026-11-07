//! Own one Codex app-server process for one explicitly addressed instance.
//!
//! `CODEX_HOME` and `cwd` come from the selected instance. This module never
//! falls back to the operator's Codex profile or to another instance.

use std::{
    env,
    ffi::OsString,
    fs, io,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexInstance {
    pub instance_id: String,
    pub executable: PathBuf,
    pub code_home: PathBuf,
    pub cwd: PathBuf,
}

#[derive(Debug)]
pub enum OpenError {
    EmptyInstanceId,
    ExecutableNotAbsolute(PathBuf),
    DirectoryNotAbsolute { name: &'static str, path: PathBuf },
    DirectoryUnavailable { name: &'static str, path: PathBuf },
    Spawn(io::Error),
    PipeUnavailable(&'static str),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyInstanceId => write!(f, "Codex instance ID is empty"),
            Self::ExecutableNotAbsolute(path) => {
                write!(
                    f,
                    "Codex executable path must be absolute: {}",
                    path.display()
                )
            }
            Self::DirectoryNotAbsolute { name, path } => {
                write!(f, "Codex {name} path must be absolute: {}", path.display())
            }
            Self::DirectoryUnavailable { name, path } => {
                write!(
                    f,
                    "Codex {name} directory is unavailable: {}",
                    path.display()
                )
            }
            Self::Spawn(error) => write!(f, "could not start Codex app-server: {error}"),
            Self::PipeUnavailable(name) => write!(f, "Codex app-server {name} pipe unavailable"),
        }
    }
}

impl std::error::Error for OpenError {}

#[derive(Debug)]
pub enum RpcError {
    NotRunning,
    RequestIdExhausted,
    Process(io::Error),
    Disconnected {
        request_id: u64,
    },
    Read {
        request_id: u64,
        source: io::Error,
    },
    Encode(serde_json::Error),
    /// A write can fail after some bytes reached the child. Never replay it.
    Write {
        request_id: u64,
        source: io::Error,
    },
    /// A one-way notification write can be partial; do not replay blindly.
    NotificationWrite {
        method: String,
        source: io::Error,
    },
    MalformedResponse {
        request_id: u64,
        reason: String,
    },
    /// The request was sent, but no matching response arrived before the deadline.
    Timeout {
        request_id: u64,
    },
    Remote {
        request_id: u64,
        code: Option<i64>,
        message: String,
    },
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning => write!(f, "Codex app-server is not running; request was not sent"),
            Self::RequestIdExhausted => write!(f, "Codex app-server request ID sequence exhausted"),
            Self::Process(error) => write!(f, "Codex app-server process check failed: {error}"),
            Self::Disconnected { request_id } => write!(
                f,
                "Codex app-server disconnected after request {request_id}; outcome may be unknown"
            ),
            Self::Read { request_id, source } => write!(
                f,
                "could not read response for Codex request {request_id}; outcome may be unknown: {source}"
            ),
            Self::Encode(error) => write!(f, "could not encode Codex app-server request: {error}"),
            Self::Write { request_id, source } => write!(
                f,
                "could not finish writing Codex request {request_id}; outcome may be unknown: {source}"
            ),
            Self::NotificationWrite { method, source } => write!(
                f,
                "could not finish writing Codex notification {method}; outcome may be unknown: {source}"
            ),
            Self::MalformedResponse { request_id, reason } => write!(
                f,
                "malformed response for Codex request {request_id}; outcome may be unknown: {reason}"
            ),
            Self::Timeout { request_id } => write!(
                f,
                "Codex app-server request {request_id} timed out; outcome may be unknown"
            ),
            Self::Remote {
                request_id,
                code,
                message,
            } => write!(
                f,
                "Codex app-server RPC error for request {request_id}, code {code:?}: {message}"
            ),
        }
    }
}

impl std::error::Error for RpcError {}

/// One process, its request-ID sequence, reader, and unsolicited events.
pub struct CodexConnection {
    instance_id: String,
    code_home: PathBuf,
    child: Child,
    stdin: Option<ChildStdin>,
    incoming: Receiver<Result<Value, IncomingError>>,
    next_request_id: u64,
    notifications: Vec<Value>,
}

enum IncomingError {
    Disconnected,
    Read(io::Error),
    Malformed(String),
}

impl CodexConnection {
    /// Start the official app-server for exactly `instance`; no shared profile
    /// or inherited provider credentials are used.
    pub fn open(instance: CodexInstance) -> Result<Self, OpenError> {
        if instance.instance_id.trim().is_empty() {
            return Err(OpenError::EmptyInstanceId);
        }
        if !instance.executable.is_absolute() {
            return Err(OpenError::ExecutableNotAbsolute(instance.executable));
        }
        require_directory("CODEX_HOME", &instance.code_home)?;
        require_directory("working directory", &instance.cwd)?;

        let path = env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
        let mut command = Command::new(&instance.executable);
        command
            .args(["app-server", "--stdio"])
            .current_dir(&instance.cwd)
            .env_clear()
            .env("PATH", path)
            .env("HOME", &instance.code_home)
            .env("CODEX_HOME", &instance.code_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = command.spawn().map_err(OpenError::Spawn)?;
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenError::PipeUnavailable("stdin"));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenError::PipeUnavailable("stdout"));
            }
        };
        let (incoming_tx, incoming) = mpsc::channel();
        if let Err(error) = thread::Builder::new()
            .name("codex-app-server-rpc-reader".to_owned())
            .spawn(move || read_responses(stdout, incoming_tx))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(OpenError::Spawn(error));
        }

        Ok(Self {
            instance_id: instance.instance_id,
            code_home: instance.code_home,
            child,
            stdin: Some(stdin),
            incoming,
            next_request_id: 1,
            notifications: Vec::new(),
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn code_home(&self) -> &Path {
        &self.code_home
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    /// Send a one-way app-server notification such as `initialized`.
    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), RpcError> {
        if self.child.try_wait().map_err(RpcError::Process)?.is_some() {
            return Err(RpcError::NotRunning);
        }
        let mut notification = serde_json::to_vec(&json!({
            "method": method,
            "params": params,
        }))
        .map_err(RpcError::Encode)?;
        notification.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or(RpcError::NotRunning)?;
        stdin
            .write_all(&notification)
            .and_then(|()| stdin.flush())
            .map_err(|source| RpcError::NotificationWrite {
                method: method.to_owned(),
                source,
            })
    }

    /// Send one request and return only the response with this request's ID.
    /// A timeout or write failure is never retried; callers reconcile the
    /// native effect before deciding what to do next.
    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        if self.child.try_wait().map_err(RpcError::Process)?.is_some() {
            return Err(RpcError::NotRunning);
        }
        let request_id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(RpcError::RequestIdExhausted)?;
        let mut request = serde_json::to_vec(&json!({
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .map_err(RpcError::Encode)?;
        request.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or(RpcError::NotRunning)?;
        if let Err(source) = write_before_deadline(stdin, &request, deadline) {
            // A partial JSON record cannot safely share a stream with a later request.
            self.stdin.take();
            return Err(RpcError::Write { request_id, source });
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RpcError::Timeout { request_id });
            }
            let response = match self.incoming.recv_timeout(remaining) {
                Ok(Ok(response)) => response,
                Ok(Err(IncomingError::Disconnected)) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(RpcError::Disconnected { request_id });
                }
                Ok(Err(IncomingError::Read(source))) => {
                    return Err(RpcError::Read { request_id, source });
                }
                Ok(Err(IncomingError::Malformed(reason))) => {
                    return Err(RpcError::MalformedResponse { request_id, reason });
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(RpcError::Timeout { request_id });
                }
            };
            if response.get("id") == Some(&json!(request_id)) {
                if let Some(error) = response.get("error") {
                    return Err(RpcError::Remote {
                        request_id,
                        code: error.get("code").and_then(Value::as_i64),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unspecified RPC error")
                            .to_owned(),
                    });
                }
                return response.get("result").cloned().ok_or_else(|| {
                    RpcError::MalformedResponse {
                        request_id,
                        reason: "missing result".into(),
                    }
                });
            }
            if response.get("method").and_then(Value::as_str).is_some() {
                self.notifications.push(response);
            }
            // A late response for a timed-out request, or an unrelated ID,
            // is discarded. It can never satisfy this request.
        }
    }

    pub fn take_notifications(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.notifications)
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
}

#[cfg(unix)]
fn write_before_deadline(
    stdin: &mut ChildStdin,
    bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd = stdin.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut remaining_bytes = bytes;
        while !remaining_bytes.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Codex pipe write deadline",
                ));
            }
            let millis = remaining
                .as_millis()
                .saturating_add(1)
                .min(i32::MAX as u128) as i32;
            let mut pfd = libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut pfd, 1, millis) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 {
                continue;
            }
            match stdin.write(remaining_bytes) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "Codex pipe closed",
                    ));
                }
                Ok(written) => remaining_bytes = &remaining_bytes[written..],
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })();
    let restored = unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
    if restored < 0 && result.is_ok() {
        return Err(io::Error::last_os_error());
    }
    result
}

impl Drop for CodexConnection {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.stdin.take();
    }
}

#[cfg(all(test, unix))]
mod deadline_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn stalled_pipe_obeys_request_deadline_and_is_not_reused() {
        let root = std::env::temp_dir().join(format!("herder-stalled-pipe-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("fake-codex");
        fs::write(&executable, "#!/bin/sh\nexec sleep 2\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut connection = CodexConnection::open(CodexInstance {
            instance_id: "test".into(),
            executable,
            code_home: root.clone(),
            cwd: root.clone(),
        })
        .unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let first = connection.request(
                "turn/start",
                json!({"input": "x".repeat(1024 * 1024)}),
                Duration::from_millis(100),
            );
            let second = connection.request("turn/start", json!({}), Duration::from_millis(100));
            tx.send((first, second)).unwrap();
        });
        let (first, second) = rx
            .recv_timeout(Duration::from_millis(700))
            .expect("pipe write exceeded deadline");
        assert!(first.is_err());
        assert!(
            matches!(second, Err(RpcError::NotRunning)),
            "broken stream must not be reused: {second:?}"
        );
        let _ = fs::remove_dir_all(root);
    }
}

fn read_responses(stdout: impl io::Read, sender: mpsc::Sender<Result<Value, IncomingError>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = sender.send(Err(IncomingError::Disconnected));
                return;
            }
            Ok(_) => match serde_json::from_str(&line) {
                Ok(response) => {
                    if sender.send(Ok(response)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(IncomingError::Malformed(error.to_string())));
                    return;
                }
            },
            Err(error) => {
                let _ = sender.send(Err(IncomingError::Read(error)));
                return;
            }
        }
    }
}

fn require_directory(name: &'static str, path: &Path) -> Result<(), OpenError> {
    if !path.is_absolute() {
        return Err(OpenError::DirectoryNotAbsolute {
            name,
            path: path.to_path_buf(),
        });
    }
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(OpenError::DirectoryUnavailable {
            name,
            path: path.to_path_buf(),
        });
    }
    Ok(())
}
