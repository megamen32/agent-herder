//! The browser profile's outbound connection to its Rust owner.
use std::{io, net::SocketAddr, path::Path, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
        protocol::WebSocketConfig,
    },
};

use crate::adapters::cdp::CdpError;

const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone)]
pub(crate) struct ExtensionLink(mpsc::Sender<Command>);

struct Command {
    operation: &'static str,
    args: Value,
    reply: oneshot::Sender<Result<Value, CdpError>>,
}

impl ExtensionLink {
    pub(super) async fn bind(
        address: SocketAddr,
        token_file: &Path,
        provider: &'static str,
    ) -> io::Result<Self> {
        let token_digest = token_digest(token_file)?;
        let listener = TcpListener::bind(address).await?;
        let (sender, receiver) = mpsc::channel(1);
        tokio::spawn(listen(listener, token_digest, provider, receiver));
        Ok(Self(sender))
    }

    pub(super) async fn call(
        &self,
        operation: &'static str,
        args: Value,
    ) -> Result<Value, CdpError> {
        let (reply, result) = oneshot::channel();
        self.0
            .send(Command {
                operation,
                args,
                reply,
            })
            .await
            .map_err(|_| CdpError::Closed)?;
        result.await.map_err(|_| CdpError::Closed)?
    }
}

pub(super) fn listen_address(value: &str) -> Option<SocketAddr> {
    let address: SocketAddr = value.parse().ok()?;
    (address.ip().is_loopback() && address.port() != 0).then_some(address)
}

#[cfg(unix)]
fn token_digest(path: &Path) -> io::Result<[u8; 32]> {
    use std::{
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };

    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid private browser extension token file",
        )
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| invalid())?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    // SAFETY: geteuid reads the caller's effective UID and has no arguments.
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > 130
    {
        return Err(invalid());
    }
    let mut token = String::new();
    file.take(131)
        .read_to_string(&mut token)
        .map_err(|_| invalid())?;
    let token = token.trim_end_matches(['\r', '\n']);
    if !valid_token(token) {
        return Err(invalid());
    }
    Ok(Sha256::digest(token.as_bytes()).into())
}

#[cfg(not(unix))]
fn token_digest(_: &Path) -> io::Result<[u8; 32]> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "browser extension requires a Unix owner",
    ))
}

fn valid_token(token: &str) -> bool {
    (32..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

fn authenticate(
    request: &Request,
    response: Response,
) -> Result<Response, Box<tokio_tungstenite::tungstenite::handshake::server::ErrorResponse>> {
    let extension_origin = request
        .headers()
        .get("origin")
        .and_then(|header| header.to_str().ok())
        .and_then(|origin| origin.strip_prefix("chrome-extension://"))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)));
    if extension_origin
        && request.uri().path() == "/browser-extension"
        && request.uri().query().is_none()
    {
        return Ok(response);
    }
    let mut refusal = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(None);
    *refusal.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
    Err(Box::new(refusal))
}

async fn connect(
    stream: TcpStream,
    expected: &[u8; 32],
    provider: &str,
) -> Option<WebSocketStream<TcpStream>> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(FRAME_LIMIT))
        .max_frame_size(Some(FRAME_LIMIT));
    let mut socket = accept_hdr_async_with_config(
        stream,
        |req: &Request, res: Response| authenticate(req, res).map_err(|res| *res),
        Some(config),
    )
    .await
    .ok()?;
    let frame = socket.next().await?.ok()?;
    let hello: Value = serde_json::from_str(frame.to_text().ok()?).ok()?;
    let token = hello["token"].as_str().filter(|s| valid_token(s))?;
    let digest = Sha256::digest(token.as_bytes());
    let mismatch = digest
        .iter()
        .zip(expected)
        .fold(0, |bits, (a, b)| bits | (a ^ b));
    if mismatch != 0
        || hello["type"] != "hello"
        || hello["version"] != 1
        || hello["provider"] != provider
    {
        return None;
    }
    socket
        .send(Message::Text(
            json!({"type":"ready","version":1}).to_string().into(),
        ))
        .await
        .ok()?;
    Some(socket)
}

async fn listen(
    listener: TcpListener,
    expected: [u8; 32],
    provider: &'static str,
    mut inbox: mpsc::Receiver<Command>,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { return };
                if let Ok(Some(socket)) = timeout(Duration::from_secs(3), connect(stream, &expected, provider)).await {
                    peer(socket, &mut inbox).await;
                }
            }
            command = inbox.recv() => {
                let Some(command) = command else { return };
                let _ = command.reply.send(Err(CdpError::Connect));
            }
        }
    }
}

async fn peer(mut socket: WebSocketStream<TcpStream>, inbox: &mut mpsc::Receiver<Command>) {
    let mut id = 0;
    loop {
        tokio::select! {
            command = inbox.recv() => {
                let Some(command) = command else { return };
                if command.reply.is_closed() { continue; }
                id += 1;
                let response = timeout(RPC_TIMEOUT, exchange(&mut socket, id, command.operation, command.args)).await;
                match response {
                    Ok(Some(result)) => { let _ = command.reply.send(result); }
                    _ => {
                        let _ = command.reply.send(Err(CdpError::OutcomeUnknown { request_id: id }));
                        return;
                    }
                }
            }
            frame = socket.next() => {
                if !frame.is_some_and(|frame| frame.is_ok_and(|frame| heartbeat(&frame))) { return; }
                if socket.flush().await.is_err() { return; }
            }
        }
    }
}

fn heartbeat(frame: &Message) -> bool {
    matches!(frame, Message::Ping(_) | Message::Pong(_))
        || frame
            .to_text()
            .is_ok_and(|text| text == r#"{"type":"heartbeat"}"#)
}

async fn exchange(
    socket: &mut WebSocketStream<TcpStream>,
    id: u64,
    operation: &str,
    args: Value,
) -> Option<Result<Value, CdpError>> {
    let packet = json!({"id":id,"operation":operation,"args":args}).to_string();
    if packet.len() > FRAME_LIMIT {
        return Some(Err(CdpError::Protocol));
    }
    socket.send(Message::Text(packet.into())).await.ok()?;
    loop {
        let frame = socket.next().await?.ok()?;
        if heartbeat(&frame) {
            socket.flush().await.ok()?;
            continue;
        }
        let mut reply: Value = serde_json::from_str(frame.to_text().ok()?).ok()?;
        if reply["id"].as_u64() != Some(id) {
            return None;
        }
        return match reply["ok"].as_bool()? {
            true => reply.get_mut("result").map(|value| Ok(value.take())),
            false => Some(Err(CdpError::Protocol)),
        };
    }
}
