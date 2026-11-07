//! An explicit, existing ZCode supervisor instance connection.
//!
//! This adapter never starts a process or falls back to another profile. The
//! supervisor owns the short-lived host capability and the authenticated
//! loopback WebSocket.
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderValue},
    redirect::Policy,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header::HeaderName},
};

use crate::domain::address::InstanceRef;

const IO_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_STATUS_BYTES: u64 = 64 * 1024;
const MAX_TOKEN_BYTES: u64 = 4 * 1024;
const MAX_CAPABILITY_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZcodeConnectionState {
    Connected,
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ZcodeConnectionError {
    InvalidInstance,
    ProfileUnavailable,
    ServerUnavailable,
    CapabilityUnavailable,
    ProtocolError,
    TimedOut,
    OutcomeUnknown,
    RemoteRpcError(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ZcodeRpcResponse {
    pub request_id: u64,
    pub message_type: u64,
    pub payload: Value,
}

/// One configured ZCode profile. Its filesystem root is never inferred from
/// HOME, the current directory, or another registered instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZcodeInstance {
    pub reference: InstanceRef,
    pub server_root: PathBuf,
}

impl ZcodeInstance {
    pub fn new(reference: InstanceRef, server_root: PathBuf) -> Result<Self, ZcodeConnectionError> {
        if reference.instance_id.trim().is_empty()
            || reference.node.0.trim().is_empty()
            || !server_root.is_absolute()
        {
            return Err(ZcodeConnectionError::InvalidInstance);
        }
        Ok(Self {
            reference,
            server_root,
        })
    }
}

pub struct ZcodeConnection {
    instance: ZcodeInstance,
    socket: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    state: ZcodeConnectionState,
    next_request_id: u64,
}

impl ZcodeConnection {
    /// Attach to precisely the supplied supervisor root. No child process is
    /// spawned and no user/session input is sent by this operation.
    pub async fn open(instance: ZcodeInstance) -> Result<Self, ZcodeConnectionError> {
        let run_root = instance.server_root.join("run");
        let status_path = run_root.join("status.json");
        let token_path = run_root.join("ingress-token");
        let status: ServerStatus = serde_json::from_slice(&read_bounded_regular_file(
            &status_path,
            MAX_STATUS_BYTES,
            false,
        )?)
        .map_err(|_| ZcodeConnectionError::ProtocolError)?;
        if status.state != "ready"
            || status.host != IpAddr::V4(Ipv4Addr::LOCALHOST)
            || status.port == 0
        {
            return Err(ZcodeConnectionError::ServerUnavailable);
        }
        let token_bytes = read_bounded_regular_file(&token_path, MAX_TOKEN_BYTES, true)?;
        let token = std::str::from_utf8(&token_bytes)
            .map_err(|_| ZcodeConnectionError::ProtocolError)?
            .trim();
        if token.is_empty() {
            return Err(ZcodeConnectionError::ProfileUnavailable);
        }

        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(IO_TIMEOUT)
            .timeout(IO_TIMEOUT)
            .build()
            .map_err(|_| ZcodeConnectionError::ProtocolError)?;
        let capability_response = timeout(
            IO_TIMEOUT,
            client
                .post(format!(
                    "http://127.0.0.1:{}/api/rpc-host-capability",
                    status.port
                ))
                .bearer_auth(token)
                .send(),
        )
        .await
        .map_err(|_| ZcodeConnectionError::TimedOut)?
        .map_err(|_| ZcodeConnectionError::CapabilityUnavailable)?;
        if capability_response.status() != reqwest::StatusCode::OK {
            return Err(ZcodeConnectionError::CapabilityUnavailable);
        }
        let body = timeout(IO_TIMEOUT, capability_response.bytes())
            .await
            .map_err(|_| ZcodeConnectionError::TimedOut)?
            .map_err(|_| ZcodeConnectionError::CapabilityUnavailable)?;
        if body.len() > MAX_CAPABILITY_BYTES {
            return Err(ZcodeConnectionError::ProtocolError);
        }
        let capability: HostCapability =
            serde_json::from_slice(&body).map_err(|_| ZcodeConnectionError::ProtocolError)?;
        if capability.capability.trim().is_empty() {
            return Err(ZcodeConnectionError::ProtocolError);
        }

        let mut request = format!("ws://127.0.0.1:{}/ws/host", status.port)
            .into_client_request()
            .map_err(|_| ZcodeConnectionError::ProtocolError)?;
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| ZcodeConnectionError::ProtocolError)?,
        );
        request.headers_mut().insert(
            HeaderName::from_static("x-zcode-rpc-host-capability"),
            HeaderValue::from_str(&capability.capability)
                .map_err(|_| ZcodeConnectionError::ProtocolError)?,
        );
        let (socket, _) = timeout(IO_TIMEOUT, connect_async(request))
            .await
            .map_err(|_| ZcodeConnectionError::TimedOut)?
            .map_err(|_| ZcodeConnectionError::ServerUnavailable)?;

        let mut socket = socket;
        timeout(IO_TIMEOUT, async {
            loop {
                let message = socket
                    .next()
                    .await
                    .ok_or(ZcodeConnectionError::ServerUnavailable)?
                    .map_err(|_| ZcodeConnectionError::ServerUnavailable)?;
                if let Message::Binary(bytes) = message {
                    let (header, _) = decode_frame(&bytes)?;
                    if header.first().and_then(Value::as_u64) == Some(200) {
                        return Ok::<(), ZcodeConnectionError>(());
                    }
                }
            }
        })
        .await
        .map_err(|_| ZcodeConnectionError::TimedOut)??;

        Ok(Self {
            instance,
            socket: Some(socket),
            state: ZcodeConnectionState::Connected,
            next_request_id: 1,
        })
    }

    pub fn instance(&self) -> &ZcodeInstance {
        &self.instance
    }

    pub fn state(&self) -> ZcodeConnectionState {
        self.state
    }

    /// ZCode owns the server process; this connection owns only its socket.
    pub const fn owned_process_id(&self) -> Option<u32> {
        None
    }

    /// Send one native RPC and return only its matching response. A timeout or
    /// disconnect after send is outcome-unknown; callers must not replay it.
    pub async fn request(
        &mut self,
        channel: &str,
        method: &str,
        args: Value,
        deadline: Duration,
    ) -> Result<ZcodeRpcResponse, ZcodeConnectionError> {
        if self.state != ZcodeConnectionState::Connected {
            return Err(ZcodeConnectionError::ServerUnavailable);
        }
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        let frame = encode_request(request_id, channel, method, args)?;
        let socket = self
            .socket
            .as_mut()
            .ok_or(ZcodeConnectionError::ServerUnavailable)?;
        timeout(deadline, socket.send(Message::Binary(frame.into())))
            .await
            .map_err(|_| ZcodeConnectionError::OutcomeUnknown)?
            .map_err(|_| ZcodeConnectionError::OutcomeUnknown)?;

        timeout(deadline, async {
            loop {
                let socket = self
                    .socket
                    .as_mut()
                    .ok_or(ZcodeConnectionError::OutcomeUnknown)?;
                let message = socket
                    .next()
                    .await
                    .ok_or(ZcodeConnectionError::OutcomeUnknown)?
                    .map_err(|_| ZcodeConnectionError::OutcomeUnknown)?;
                if let Message::Binary(bytes) = message {
                    let (header, payload) = decode_frame(&bytes)?;
                    let Some(message_type) = header.first().and_then(Value::as_u64) else {
                        return Err(ZcodeConnectionError::ProtocolError);
                    };
                    if message_type == 200 {
                        continue;
                    }
                    let Some(response_id) = header.get(1).and_then(Value::as_u64) else {
                        return Err(ZcodeConnectionError::ProtocolError);
                    };
                    if response_id != request_id {
                        continue;
                    }
                    return match message_type {
                        201 => Ok(ZcodeRpcResponse {
                            request_id,
                            message_type,
                            payload,
                        }),
                        202 | 203 => Err(ZcodeConnectionError::RemoteRpcError(
                            payload
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("native RPC rejected")
                                .to_owned(),
                        )),
                        _ => Err(ZcodeConnectionError::ProtocolError),
                    };
                }
                if matches!(message, Message::Close(_)) {
                    return Err(ZcodeConnectionError::OutcomeUnknown);
                }
            }
        })
        .await
        .map_err(|_| ZcodeConnectionError::OutcomeUnknown)?
    }

    /// Close only this WebSocket. The supervisor and other profiles remain up.
    pub async fn close(&mut self) -> Result<(), ZcodeConnectionError> {
        let Some(mut socket) = self.socket.take() else {
            self.state = ZcodeConnectionState::Closed;
            return Ok(());
        };
        self.state = ZcodeConnectionState::Closed;
        timeout(IO_TIMEOUT, socket.close(None))
            .await
            .map_err(|_| ZcodeConnectionError::TimedOut)?
            .map_err(|_| ZcodeConnectionError::ServerUnavailable)
    }
}

const PROTOCOL_HEADER_SIZE: usize = 13;

fn encode_request(
    request_id: u64,
    channel: &str,
    method: &str,
    args: Value,
) -> Result<Vec<u8>, ZcodeConnectionError> {
    let mut body = encode_value(&Value::Array(vec![
        Value::from(100),
        Value::from(request_id),
        Value::String(channel.to_owned()),
        Value::String(method.to_owned()),
    ]))?;
    body.extend(encode_value(&args)?);
    let mut frame = vec![0; PROTOCOL_HEADER_SIZE];
    frame[0] = 1;
    frame[9..13].copy_from_slice(
        &u32::try_from(body.len())
            .map_err(|_| ZcodeConnectionError::ProtocolError)?
            .to_be_bytes(),
    );
    frame.extend(body);
    Ok(frame)
}

fn encode_value(value: &Value) -> Result<Vec<u8>, ZcodeConnectionError> {
    match value {
        Value::Array(values) => {
            let mut out = vec![4];
            encode_varint(values.len() as u64, &mut out);
            for value in values {
                out.extend(encode_value(value)?);
            }
            Ok(out)
        }
        Value::String(value) => {
            let mut out = vec![1];
            encode_varint(value.len() as u64, &mut out);
            out.extend(value.as_bytes());
            Ok(out)
        }
        Value::Number(value) if value.as_u64().is_some() => {
            let mut out = vec![6];
            encode_varint(value.as_u64().unwrap_or_default(), &mut out);
            Ok(out)
        }
        _ => {
            let bytes =
                serde_json::to_vec(value).map_err(|_| ZcodeConnectionError::ProtocolError)?;
            let mut out = vec![5];
            encode_varint(bytes.len() as u64, &mut out);
            out.extend(bytes);
            Ok(out)
        }
    }
}

fn encode_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn decode_frame(frame: &[u8]) -> Result<(Vec<Value>, Value), ZcodeConnectionError> {
    if frame.len() < PROTOCOL_HEADER_SIZE || frame[0] != 1 {
        return Err(ZcodeConnectionError::ProtocolError);
    }
    let body_len = u32::from_be_bytes(
        frame[9..13]
            .try_into()
            .map_err(|_| ZcodeConnectionError::ProtocolError)?,
    ) as usize;
    if frame.len() != PROTOCOL_HEADER_SIZE + body_len {
        return Err(ZcodeConnectionError::ProtocolError);
    }
    let mut cursor = PROTOCOL_HEADER_SIZE;
    let header = decode_value(frame, &mut cursor)?
        .as_array()
        .cloned()
        .ok_or(ZcodeConnectionError::ProtocolError)?;
    let payload = decode_value(frame, &mut cursor)?;
    if cursor != frame.len() {
        return Err(ZcodeConnectionError::ProtocolError);
    }
    Ok((header, payload))
}

fn decode_value(frame: &[u8], cursor: &mut usize) -> Result<Value, ZcodeConnectionError> {
    let kind = *frame
        .get(*cursor)
        .ok_or(ZcodeConnectionError::ProtocolError)?;
    *cursor += 1;
    match kind {
        0 => Ok(Value::Null),
        1 | 5 | 6 | 4 => {
            let length = decode_varint(frame, cursor)?;
            match kind {
                1 => {
                    let bytes = take_bytes(frame, cursor, length)?;
                    String::from_utf8(bytes.to_vec())
                        .map(Value::String)
                        .map_err(|_| ZcodeConnectionError::ProtocolError)
                }
                5 => serde_json::from_slice(take_bytes(frame, cursor, length)?)
                    .map_err(|_| ZcodeConnectionError::ProtocolError),
                6 => Ok(Value::from(length)),
                4 => {
                    if length > 4096 {
                        return Err(ZcodeConnectionError::ProtocolError);
                    }
                    let mut values = Vec::with_capacity(length as usize);
                    for _ in 0..length {
                        values.push(decode_value(frame, cursor)?);
                    }
                    Ok(Value::Array(values))
                }
                _ => unreachable!(),
            }
        }
        _ => Err(ZcodeConnectionError::ProtocolError),
    }
}

fn decode_varint(frame: &[u8], cursor: &mut usize) -> Result<u64, ZcodeConnectionError> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *frame
            .get(*cursor)
            .ok_or(ZcodeConnectionError::ProtocolError)?;
        *cursor += 1;
        value |= u64::from(byte & 0x7f)
            .checked_shl(shift)
            .ok_or(ZcodeConnectionError::ProtocolError)?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        if shift >= 64 {
            return Err(ZcodeConnectionError::ProtocolError);
        }
    }
}

fn take_bytes<'a>(
    frame: &'a [u8],
    cursor: &mut usize,
    length: u64,
) -> Result<&'a [u8], ZcodeConnectionError> {
    let length = usize::try_from(length).map_err(|_| ZcodeConnectionError::ProtocolError)?;
    let end = cursor
        .checked_add(length)
        .ok_or(ZcodeConnectionError::ProtocolError)?;
    let bytes = frame
        .get(*cursor..end)
        .ok_or(ZcodeConnectionError::ProtocolError)?;
    *cursor = end;
    Ok(bytes)
}

#[derive(Deserialize)]
struct ServerStatus {
    state: String,
    host: IpAddr,
    port: u16,
}

#[derive(Deserialize)]
struct HostCapability {
    capability: String,
}

fn read_bounded_regular_file(
    path: &Path,
    max_bytes: u64,
    require_private: bool,
) -> Result<Vec<u8>, ZcodeConnectionError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ZcodeConnectionError::ProfileUnavailable)?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(ZcodeConnectionError::ProtocolError);
    }
    #[cfg(unix)]
    if require_private {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ZcodeConnectionError::ProfileUnavailable);
        }
    }
    let bytes = fs::read(path).map_err(|_| ZcodeConnectionError::ProfileUnavailable)?;
    if bytes.len() as u64 > max_bytes {
        return Err(ZcodeConnectionError::ProtocolError);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::NodeRef;

    #[test]
    fn instance_requires_absolute_profile_and_explicit_identity() {
        let valid = InstanceRef {
            node: NodeRef("local".into()),
            instance_id: "profile-a".into(),
        };
        assert!(ZcodeInstance::new(valid.clone(), PathBuf::from("relative")).is_err());
        assert!(
            ZcodeInstance::new(
                InstanceRef {
                    instance_id: " ".into(),
                    ..valid.clone()
                },
                PathBuf::from("/srv/zcode-a"),
            )
            .is_err()
        );
        assert_eq!(
            ZcodeInstance::new(valid, PathBuf::from("/srv/zcode-a"))
                .unwrap()
                .server_root,
            PathBuf::from("/srv/zcode-a")
        );
    }
}
