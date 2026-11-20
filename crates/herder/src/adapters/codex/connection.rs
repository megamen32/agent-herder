//! Own one Codex app-server client process for one explicitly addressed instance.
//!
//! `CODEX_HOME` and `cwd` come from the selected instance. This module never
//! falls back to the operator's Codex profile or to another instance.

use std::{
    env,
    ffi::OsString,
    fs, io,
    io::{BufRead, BufReader, Write},
    os::{
        fd::OwnedFd,
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::{SocketAddr, UnixStream},
        },
    },
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc as async_mpsc;
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

const PROXY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexInstance {
    pub instance_id: String,
    pub executable: PathBuf,
    pub code_home: PathBuf,
    pub cwd: PathBuf,
    /// An explicit shared socket from the trusted profile, if configured.
    pub socket_path: Option<PathBuf>,
}

#[derive(Debug)]
pub enum OpenError {
    EmptyInstanceId,
    ExecutableNotAbsolute(PathBuf),
    DirectoryNotAbsolute { name: &'static str, path: PathBuf },
    DirectoryUnavailable { name: &'static str, path: PathBuf },
    Socket { path: PathBuf, source: io::Error },
    Proxy(io::Error),
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
            Self::Socket { path, source } => {
                write!(f, "invalid Codex app-server socket {path:?}: {source}")
            }
            Self::Proxy(error) => write!(f, "Codex app-server proxy failed: {error}"),
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
    outgoing: Option<Outgoing>,
    incoming: Receiver<Result<Value, IncomingError>>,
    next_request_id: u64,
    notifications: Vec<Value>,
}

enum Outgoing {
    Stdio(ChildStdin),
    Proxy(async_mpsc::Sender<ProxyWrite>),
}

struct ProxyWrite {
    text: String,
    deadline: Instant,
    done: mpsc::Sender<io::Result<()>>,
}

impl Outgoing {
    fn send(&mut self, mut text: String, deadline: Option<Instant>) -> io::Result<()> {
        match self {
            Self::Stdio(stdin) => {
                text.push('\n');
                match deadline {
                    Some(deadline) => write_before_deadline(stdin, text.as_bytes(), deadline),
                    None => stdin
                        .write_all(text.as_bytes())
                        .and_then(|()| stdin.flush()),
                }
            }
            Self::Proxy(sender) => {
                let deadline = deadline.unwrap_or_else(|| Instant::now() + PROXY_TIMEOUT);
                if deadline <= Instant::now() {
                    return Err(proxy_timeout());
                }
                let (done, written) = mpsc::channel();
                sender
                    .try_send(ProxyWrite {
                        text,
                        deadline,
                        done,
                    })
                    .map_err(|_| proxy_disconnected())?;
                wait_for_proxy(written, deadline)
            }
        }
    }
}

enum IncomingError {
    Disconnected,
    Read(io::Error),
    Malformed(String),
}

impl CodexConnection {
    /// Start the official CLI for the selected instance, using its configured
    /// shared socket or a private stdio app-server.
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
            .arg("app-server")
            .current_dir(&instance.cwd)
            .env_clear()
            .env("PATH", path)
            .env("HOME", &instance.code_home)
            .env("CODEX_HOME", &instance.code_home)
            .stderr(Stdio::null());

        let proxy_stream = if let Some(path) = &instance.socket_path {
            let socket = resolve_socket(path, unsafe { libc::geteuid() }).map_err(|source| {
                OpenError::Socket {
                    path: path.clone(),
                    source,
                }
            })?;
            // The CLI relays raw bytes. A socket pair provides one duplex
            // WebSocket stream across the proxy's stdin and stdout.
            let (client, proxy) = UnixStream::pair().map_err(OpenError::Proxy)?;
            let proxy_input = proxy.try_clone().map_err(OpenError::Proxy)?;
            command
                .args(["proxy", "--sock"])
                .arg(socket)
                .stdin(OwnedFd::from(proxy_input))
                .stdout(OwnedFd::from(proxy));
            Some(client)
        } else {
            command
                .arg("--stdio")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());
            None
        };

        let mut child = command.spawn().map_err(OpenError::Spawn)?;
        drop(command);
        let (incoming_tx, incoming) = mpsc::channel();
        let outgoing = match proxy_stream {
            Some(stream) => start_proxy(stream, incoming_tx),
            None => start_stdio(&mut child, incoming_tx),
        };
        let outgoing = match outgoing {
            Ok(outgoing) => outgoing,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        Ok(Self {
            instance_id: instance.instance_id,
            code_home: instance.code_home,
            child,
            outgoing: Some(outgoing),
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
        let notification = serde_json::to_string(&json!({
            "method": method,
            "params": params,
        }))
        .map_err(RpcError::Encode)?;
        self.send(notification, None, |source| RpcError::NotificationWrite {
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
        let request = serde_json::to_string(&json!({
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .map_err(RpcError::Encode)?;
        self.send(request, Some(deadline), |source| RpcError::Write {
            request_id,
            source,
        })?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RpcError::Timeout { request_id });
            }
            let response = match self.incoming.recv_timeout(remaining) {
                Ok(Ok(response)) => response,
                Ok(Err(IncomingError::Disconnected)) | Err(RecvTimeoutError::Disconnected) => {
                    self.outgoing.take();
                    return Err(RpcError::Disconnected { request_id });
                }
                Ok(Err(IncomingError::Read(source))) => {
                    self.outgoing.take();
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

    pub(super) fn unavailable(&mut self) -> bool {
        self.outgoing.as_ref().is_none_or(
            |outgoing| matches!(outgoing, Outgoing::Proxy(writes) if writes.is_closed()),
        ) || matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn send(
        &mut self,
        text: String,
        deadline: Option<Instant>,
        error: impl FnOnce(io::Error) -> RpcError,
    ) -> Result<(), RpcError> {
        let outgoing = self.outgoing.as_mut().ok_or(RpcError::NotRunning)?;
        outgoing.send(text, deadline).map_err(|source| {
            // A partial write cannot safely share a stream with a later request.
            self.outgoing.take();
            error(source)
        })
    }
}

fn start_stdio(
    child: &mut Child,
    incoming: mpsc::Sender<Result<Value, IncomingError>>,
) -> Result<Outgoing, OpenError> {
    let stdin = child
        .stdin
        .take()
        .ok_or(OpenError::PipeUnavailable("stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(OpenError::PipeUnavailable("stdout"))?;
    thread::Builder::new()
        .name("codex-app-server-rpc-reader".to_owned())
        .spawn(move || read_responses(stdout, incoming))
        .map_err(OpenError::Spawn)?;
    Ok(Outgoing::Stdio(stdin))
}

fn start_proxy(
    stream: UnixStream,
    incoming: mpsc::Sender<Result<Value, IncomingError>>,
) -> Result<Outgoing, OpenError> {
    stream.set_nonblocking(true).map_err(OpenError::Proxy)?;
    let deadline = Instant::now() + PROXY_TIMEOUT;
    let (ready, connected) = mpsc::channel();
    let (outgoing, writes) = async_mpsc::channel(1);
    thread::Builder::new()
        .name("codex-app-server-proxy".to_owned())
        .spawn(move || {
            let result = (|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                let websocket = runtime.block_on(async {
                    let stream = tokio::net::UnixStream::from_std(stream)?;
                    let (websocket, _) = tokio::time::timeout_at(
                        deadline.into(),
                        tokio_tungstenite::client_async("ws://localhost/rpc", stream),
                    )
                    .await
                    .map_err(|_| proxy_timeout())?
                    .map_err(io::Error::other)?;
                    Ok::<_, io::Error>(websocket)
                })?;
                if ready.send(Ok(())).is_ok() {
                    runtime.block_on(run_proxy(websocket, incoming, writes));
                }
                Ok(())
            })();
            if let Err(error) = result {
                let _ = ready.send(Err(error));
            }
        })
        .map_err(OpenError::Spawn)?;
    wait_for_proxy(connected, deadline).map_err(OpenError::Proxy)?;
    Ok(Outgoing::Proxy(outgoing))
}

async fn run_proxy(
    websocket: WebSocketStream<tokio::net::UnixStream>,
    incoming: mpsc::Sender<Result<Value, IncomingError>>,
    mut writes: async_mpsc::Receiver<ProxyWrite>,
) {
    let (mut sink, mut stream) = websocket.split();
    let read = async {
        while let Some(message) = stream.next().await {
            let result = match message {
                Ok(Message::Text(text)) => serde_json::from_str(&text)
                    .map_err(|error| IncomingError::Malformed(error.to_string())),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                Ok(Message::Close(_)) => break,
                Ok(_) => Err(IncomingError::Malformed("expected WebSocket text".into())),
                Err(error) => Err(IncomingError::Read(io::Error::other(error))),
            };
            let invalid = result.is_err();
            if incoming.send(result).is_err() || invalid {
                break;
            }
        }
    };
    let write = async {
        while let Some(ProxyWrite {
            text,
            deadline,
            done,
        }) = writes.recv().await
        {
            let result = if Instant::now() >= deadline {
                Err(proxy_timeout())
            } else {
                match tokio::time::timeout_at(
                    deadline.into(),
                    sink.send(Message::Text(text.into())),
                )
                .await
                {
                    Ok(result) => result.map_err(io::Error::other),
                    Err(_) => Err(proxy_timeout()),
                }
            };
            let failed = result.is_err();
            if done.send(result).is_err() || failed {
                break;
            }
        }
    };
    tokio::select! {
        () = read => (),
        () = write => (),
    }
}

fn wait_for_proxy(receiver: Receiver<io::Result<()>>, deadline: Instant) -> io::Result<()> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => proxy_timeout(),
            RecvTimeoutError::Disconnected => proxy_disconnected(),
        })?
}

fn proxy_timeout() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "Codex proxy deadline elapsed")
}

fn proxy_disconnected() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "Codex proxy disconnected")
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
        self.outgoing.take();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::read::{CodexReadError, CodexReader};
    use super::*;
    use std::os::unix::{
        fs::{DirBuilderExt, PermissionsExt, symlink},
        net::UnixListener,
    };
    use tokio_tungstenite::tungstenite::{WebSocket, accept};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("hpx-{}-{unique:x}", std::process::id()));
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_owned_sockets_and_rejects_invalid_socket_paths() {
        let TestDirectory(root) = &TestDirectory::new();
        let socket = root.join("socket");
        let _listener = UnixListener::bind(&socket).unwrap();
        let alias = root.join("alias");
        symlink("socket", &alias).unwrap();
        let uid = unsafe { libc::geteuid() };
        assert_eq!(resolve_socket(&socket, uid).unwrap(), socket);
        assert_eq!(resolve_socket(&alias, uid).unwrap(), socket);
        assert_eq!(
            resolve_socket(&alias, uid.wrapping_add(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        let file = root.join("file");
        fs::write(&file, "").unwrap();
        let file_alias = root.join("file-alias");
        symlink(&file, &file_alias).unwrap();
        let dangling = root.join("dangling");
        symlink("missing", &dangling).unwrap();
        let control_character = root.join("bad\ns");
        let _control_listener = UnixListener::bind(&control_character).unwrap();
        let invalid_target = root.join("invalid-target");
        symlink(&control_character, &invalid_target).unwrap();
        for invalid in [
            PathBuf::new(),
            PathBuf::from("relative.sock"),
            root.clone(),
            root.join("../")
                .join(root.file_name().unwrap())
                .join("socket"),
            control_character,
            invalid_target,
            file,
            file_alias,
            dangling,
        ] {
            assert!(resolve_socket(&invalid, uid).is_err(), "{invalid:?}");
        }

        let writable = root.join("writable");
        fs::create_dir(&writable).unwrap();
        fs::set_permissions(&writable, fs::Permissions::from_mode(0o777)).unwrap();
        let untrusted_alias = writable.join("alias");
        symlink(&socket, &untrusted_alias).unwrap();
        assert_eq!(
            resolve_socket(&untrusted_alias, uid).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    fn accept_proxy(listener: &UnixListener) -> WebSocket<UnixStream> {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        accept(stream).unwrap()
    }

    fn rpc(websocket: &mut WebSocket<UnixStream>, method: &str) -> Value {
        let message = websocket.read().unwrap();
        let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(request["method"], method);
        request["id"].clone()
    }

    fn reply(websocket: &mut WebSocket<UnixStream>, id: Value, result: Value) {
        websocket
            .send(Message::text(
                json!({"id": id, "result": result}).to_string(),
            ))
            .unwrap();
    }

    #[test]
    fn proxy_exchanges_native_websocket_rpc_and_fails_closed() {
        let TestDirectory(root) = &TestDirectory::new();
        let socket = root.join("socket");
        let listener = UnixListener::bind(&socket).unwrap();
        let alias = root.join("alias");
        symlink("socket", &alias).unwrap();
        let proxy_fixture = root.join("app-server");
        fs::write(
            &proxy_fixture,
            r#"import os, socket, sys, threading
home = os.environ['CODEX_HOME']
with open(os.path.join(home, 'launches'), 'a') as launches:
    print(' '.join(sys.argv[:3]), file=launches)
assert sys.argv == ['app-server', 'proxy', '--sock', os.path.join(home, 'socket')]
assert os.environ['HOME'] == os.getcwd() == home
assert set(os.environ) <= {'CODEX_HOME', 'HOME', 'PATH', 'LC_CTYPE'}
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect(sys.argv[3])
    def upstream():
        while (data := os.read(0, 65536)):
            peer.sendall(data)
        peer.shutdown(socket.SHUT_WR)
    threading.Thread(target=upstream, daemon=True).start()
    while (data := peer.recv(65536)):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
"#,
        )
        .unwrap();
        // Python reads the fixture as app-server from cwd. A concurrent fork
        // may hold a writable descriptor without affecting the interpreter.
        let _writer = fs::OpenOptions::new()
            .write(true)
            .open(&proxy_fixture)
            .unwrap();

        let (ping_answered, pong) = mpsc::channel();
        let home = root.clone();
        let server = thread::spawn(move || {
            let mut websocket = accept_proxy(&listener);
            let id = rpc(&mut websocket, "initialize");
            reply(&mut websocket, id, json!({"codexHome": home}));
            assert!(rpc(&mut websocket, "initialized").is_null());
            websocket.send(Message::Ping(vec![7].into())).unwrap();
            assert_eq!(websocket.read().unwrap(), Message::Pong(vec![7].into()));
            ping_answered.send(()).unwrap();
            let id = rpc(&mut websocket, "thread/list");
            reply(&mut websocket, json!(999), json!({}));
            reply(
                &mut websocket,
                id,
                json!({"data": [{"id": "fixture-thread"}]}),
            );
            drop(websocket);

            let mut wrong_profile = accept_proxy(&listener);
            let id = rpc(&mut wrong_profile, "initialize");
            reply(
                &mut wrong_profile,
                id,
                json!({"codexHome": home.join("other")}),
            );
        });
        let process = CodexInstance {
            instance_id: "fixture-instance".into(),
            executable: PathBuf::from("/usr/bin/python3"),
            code_home: root.clone(),
            cwd: root.clone(),
            socket_path: Some(alias),
        };
        let timeout = Duration::from_secs(3);
        let mut reader = CodexReader::open(process.clone(), timeout).unwrap();
        assert_eq!(reader.instance_id(), "fixture-instance");
        pong.recv_timeout(timeout).unwrap();
        assert_eq!(
            reader.list_threads(None, 1).unwrap().data[0].id,
            "fixture-thread"
        );
        drop(reader);
        assert!(matches!(
            CodexReader::open(process.clone(), timeout),
            Err(CodexReadError::ProfileMismatch { .. })
        ));
        server.join().unwrap();
        assert!(matches!(
            CodexConnection::open(process),
            Err(OpenError::Proxy(_))
        ));
        assert_eq!(
            fs::read_to_string(root.join("launches")).unwrap(),
            "app-server proxy --sock\n".repeat(3)
        );
    }

    #[test]
    fn stalled_pipe_obeys_request_deadline_and_is_not_reused() {
        let root = std::env::temp_dir().join(format!("herder-stalled-pipe-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        // /bin/sh receives `app-server --stdio` and reads this script from cwd.
        // Executing the system shell avoids executing a recently written inode.
        let script = root.join("app-server");
        fs::write(&script, "exec sleep 2\n").unwrap();
        // Model a concurrent fork retaining the fixture's write descriptor.
        let writer_held_by_fork = fs::OpenOptions::new().write(true).open(&script).unwrap();
        let mut connection = CodexConnection::open(CodexInstance {
            instance_id: "test".into(),
            executable: PathBuf::from("/bin/sh"),
            code_home: root.clone(),
            cwd: root.clone(),
            socket_path: None,
        })
        .unwrap();
        drop(writer_held_by_fork);
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

fn resolve_socket(path: &Path, uid: u32) -> io::Result<PathBuf> {
    validate_socket_path(path)?;
    let configured = fs::symlink_metadata(path)?;
    if !configured.is_symlink() && !configured.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a Unix socket or its alias",
        ));
    }
    if configured.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket path has a different owner",
        ));
    }

    verify_socket_directories(path, uid)?;
    let resolved = path.canonicalize()?;
    if resolved != path {
        validate_socket_path(&resolved)?;
        verify_socket_directories(&resolved, uid)?;
    }
    SocketAddr::from_pathname(&resolved)?;
    let endpoint = fs::symlink_metadata(&resolved)?;
    if !endpoint.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a Unix socket at the resolved path",
        ));
    }
    if endpoint.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "resolved socket has a different owner",
        ));
    }
    Ok(resolved)
}

fn validate_socket_path(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path.components().any(|part| part == Component::ParentDir)
        || path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .any(u8::is_ascii_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected an absolute socket path",
        ));
    }
    Ok(())
}

fn verify_socket_directories(path: &Path, uid: u32) -> io::Result<()> {
    // The CLI connects by pathname. A sticky parent such as /tmp is safe
    // for entries owned by the runtime user or root.
    let trusted_owner = |info: &fs::Metadata| info.uid() == uid || info.uid() == 0;
    for directory in path.ancestors().skip(1) {
        let entry = fs::symlink_metadata(directory)?;
        let owned = trusted_owner(&entry);
        let info = if entry.is_symlink() {
            fs::metadata(directory)?
        } else {
            entry
        };
        if !info.is_dir()
            || !owned
            || !trusted_owner(&info)
            || (info.mode() & 0o022 != 0 && info.mode() & 0o1000 == 0)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "untrusted directory in app-server socket path",
            ));
        }
    }
    Ok(())
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
