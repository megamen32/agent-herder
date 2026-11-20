//! Native Z.ai operations on one scoped Chrome CDP connection.

#[cfg(test)]
mod chrome_tests;
mod native;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

use crate::application::recent::{RecentMessages, SourceMessage, normalize_recent};
use crate::domain::{
    address::{InstanceRef, NodeRef, SessionAddress},
    transcript::{
        RawTranscriptBlock, TranscriptBlock, TranscriptBlockKind, TranscriptPage,
        TranscriptSourceRef, normalize_transcript_blocks,
    },
};

use super::cdp::{
    CdpConnection, CdpCreateError, CdpError, CdpTargetIdentity, create_page_target_with_origin_port,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedMessage {
    pub id: String,
    pub role: Role,
    pub text: String,
    /// Provider timestamp kept in its original numeric unit.
    pub timestamp: Option<u64>,
    pub model: Option<String>,
}

/// Stable address returned by Z.ai's first native chat-list page.
/// The adapter exposes only the provider chat ID because other list fields
/// have not been captured in the accepted provider evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaiChatRef {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    InvalidPayload,
    ChatMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZaiReadError {
    Cdp(CdpError),
    TargetCreate(CdpCreateError),
    WrongOrigin,
    AccountMismatch,
    ProviderStatus(u16),
    InvalidResponse,
    Normalize(NormalizeError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZaiSendError {
    Cdp(CdpError),
    Read(ZaiReadError),
    Preflight,
    InputNotAccepted,
    SendNotReady,
    InvalidInput,
    ResponseNotObserved { chat_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaiSendReceipt {
    pub chat_id: String,
    pub expected_response_seen: bool,
}

/// Z.ai adapter bound to one exact Chrome instance/context/target
/// and the expected hashed Z.ai account scope.
pub struct ZaiReader {
    cdp: CdpConnection,
    account_scope: String,
    fresh_blank: bool,
}

impl ZaiReader {
    pub async fn account_scope_for_target(cdp: &mut CdpConnection) -> Result<String, ZaiReadError> {
        let value = cdp
            .evaluate(&native::expression("account", None, Value::Null))
            .await
            .map_err(ZaiReadError::Cdp)?;
        Ok(native::verified_scope(&value)?.to_ascii_lowercase())
    }

    pub(crate) fn connection_mut(&mut self) -> &mut CdpConnection {
        &mut self.cdp
    }

    pub async fn create_new_chat(
        browser_websocket_endpoint: &str,
        node_id: &str,
        instance_id: &str,
        browser_context_id: &str,
        expected_account_scope: &str,
        origin_port: Option<u16>,
    ) -> Result<Self, ZaiReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ZaiReadError::AccountMismatch);
        }
        let cdp = create_page_target_with_origin_port(
            browser_websocket_endpoint,
            "https://chat.z.ai",
            node_id,
            instance_id,
            browser_context_id,
            origin_port,
        )
        .await
        .map_err(ZaiReadError::TargetCreate)?;
        let mut reader = Self {
            cdp,
            account_scope: expected_account_scope.to_ascii_lowercase(),
            fresh_blank: true,
        };
        match reader.cdp.wait_for_origin("https://chat.z.ai").await {
            Ok(true) => {}
            Ok(false) => {
                reader.cdp.close_created_target().await;
                return Err(ZaiReadError::WrongOrigin);
            }
            Err(error) => {
                reader.cdp.close_created_target().await;
                return Err(ZaiReadError::Cdp(error));
            }
        }
        if let Err(error) = reader.verify_account().await {
            reader.cdp.close_created_target().await;
            return Err(error);
        }
        Ok(reader)
    }

    pub async fn attach(
        endpoint: &str,
        identity: CdpTargetIdentity,
        expected_account_scope: &str,
    ) -> Result<Self, ZaiReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ZaiReadError::AccountMismatch);
        }
        let mut reader = Self {
            cdp: CdpConnection::connect_page(endpoint, identity)
                .await
                .map_err(ZaiReadError::Cdp)?,
            account_scope: expected_account_scope.to_ascii_lowercase(),
            fresh_blank: false,
        };
        reader.verify_account().await?;
        Ok(reader)
    }

    pub async fn attach_via_browser(
        browser_websocket_endpoint: &str,
        identity: CdpTargetIdentity,
        expected_account_scope: &str,
        origin_port: Option<u16>,
    ) -> Result<Self, ZaiReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ZaiReadError::AccountMismatch);
        }
        let mut cdp = match origin_port {
            Some(port) => {
                CdpConnection::connect_browser_with_origin_port(
                    browser_websocket_endpoint,
                    &identity.node_id,
                    &identity.instance_id,
                    port,
                )
                .await
            }
            None => {
                CdpConnection::connect_browser(
                    browser_websocket_endpoint,
                    &identity.node_id,
                    &identity.instance_id,
                )
                .await
            }
        }
        .map_err(ZaiReadError::Cdp)?;
        cdp.attach_target(&identity.target_id, &identity.browser_context_id)
            .await
            .map_err(ZaiReadError::Cdp)?;
        let mut reader = Self {
            cdp,
            account_scope: expected_account_scope.to_ascii_lowercase(),
            fresh_blank: false,
        };
        reader.verify_account().await?;
        Ok(reader)
    }

    async fn verify_account(&mut self) -> Result<(), ZaiReadError> {
        if Self::account_scope_for_target(&mut self.cdp).await? != self.account_scope {
            return Err(ZaiReadError::AccountMismatch);
        }
        Ok(())
    }

    pub fn identity(&self) -> &CdpTargetIdentity {
        self.cdp.identity()
    }

    /// Read Z.ai's first chat-list page for the account already verified by
    /// this reader. The observed API is page based; this method does not claim
    /// that later pages are absent.
    pub async fn list_chats(&mut self) -> Result<Vec<ZaiChatRef>, ZaiReadError> {
        self.list_page(None).await
    }

    pub async fn list_native_ids(&mut self, limit: usize) -> Result<Vec<String>, ZaiReadError> {
        Ok(self
            .list_page(Some(limit.min(180)))
            .await?
            .into_iter()
            .map(|chat| chat.id)
            .collect())
    }

    async fn list_page(
        &mut self,
        native_limit: Option<usize>,
    ) -> Result<Vec<ZaiChatRef>, ZaiReadError> {
        let account = serde_json::json!(self.account_scope);
        let list = ZAI_CHAT_LIST_EXPRESSION
            .replace("__EXPECTED_SCOPE__", &account.to_string())
            .replace(
                "/* authenticateEmpty */",
                if native_limit.is_some() {
                    "true"
                } else {
                    "false"
                },
            );
        // The list operation already proves the owner of its own page. Only IDs
        // cross CDP, including when a provider adds fields such as chat titles.
        let limit = native_limit.unwrap_or(u32::MAX as usize);
        let expression = format!(
            "(async()=>{{const r=await {list}; if(Array.isArray(r.chats)) r.chats=r.chats.slice(0,{limit}).map(row=>({{id:row?.id}})); return r}})()"
        );
        let result = self
            .cdp
            .evaluate(&expression)
            .await
            .map_err(ZaiReadError::Cdp)?;
        native::verify_response(&result, &self.account_scope, None)?;
        let chats = result.get("chats").ok_or(ZaiReadError::InvalidResponse)?;
        if !chats.as_array().is_some_and(|rows| rows.len() <= limit) {
            return Err(ZaiReadError::InvalidResponse);
        }
        normalize_chat_list(chats).map_err(ZaiReadError::Normalize)
    }

    pub async fn read_chat(
        &mut self,
        chat_id: &str,
    ) -> Result<Vec<NormalizedMessage>, ZaiReadError> {
        let (ids, batch) = self.read_chat_batch(chat_id).await?;
        project_batch(chat_id, ids.iter().map(String::as_str), batch)
            .map_err(ZaiReadError::Normalize)
    }

    async fn read_chat_batch(
        &mut self,
        chat_id: &str,
    ) -> Result<(Vec<String>, Batch), ZaiReadError> {
        let value = self.native_read("read", Some(chat_id), Value::Null).await?;
        #[derive(Deserialize)]
        struct Readback {
            ids: Vec<String>,
            #[serde(flatten)]
            batch: Batch,
        }
        let result: Readback =
            serde_json::from_value(value).map_err(|_| ZaiReadError::InvalidResponse)?;
        let data = result
            .batch
            .data
            .as_ref()
            .ok_or(ZaiReadError::InvalidResponse)?;
        let ids: std::collections::HashSet<_> = result.ids.iter().collect();
        if result.ids.len() > 180
            || ids.len() != result.ids.len()
            || ids.iter().any(|id| !native::valid_message_id(id))
            || data
                .iter()
                .any(|(id, row)| !ids.contains(id) || row.id.as_ref() != Some(id))
        {
            return Err(ZaiReadError::InvalidResponse);
        }
        Ok((result.ids, result.batch))
    }

    /// Project the newest user and assistant records from one explicitly
    /// addressed native chat. Z.ai's captured response has stable message IDs
    /// and timestamps, but no observed turn or reply reference fields, so
    /// those remain unknown in the shared projection.
    pub async fn recent_messages(&mut self, chat_id: &str) -> Result<RecentMessages, ZaiReadError> {
        let messages = self.read_chat(chat_id).await?;
        Ok(project_recent_messages(&messages))
    }

    /// Read the currently observed Z.ai batch window into the shared transcript
    /// shape. Z.ai's captured route exposes neither a native continuation cursor
    /// nor a completeness signal, so the returned page is explicitly truncated.
    pub async fn transcript_page(
        &mut self,
        principal_id: &str,
        chat_id: &str,
    ) -> Result<TranscriptPage, ZaiReadError> {
        if principal_id.trim().is_empty() {
            return Err(ZaiReadError::InvalidResponse);
        }
        let identity = self.cdp.identity().clone();
        let account_scope = self.account_scope.clone();
        let (ids, batch) = self.read_chat_batch(chat_id).await?;
        project_transcript_page(
            principal_id,
            &account_scope,
            &identity,
            chat_id,
            &ids,
            &batch,
        )
    }

    /// Send exactly one first prompt in a fresh target and prove its reply by
    /// reading the same provider chat. Never retries an uncertain send.
    pub async fn send_first_message(
        &mut self,
        text: &str,
        expected_response_marker: &str,
    ) -> Result<ZaiSendReceipt, ZaiSendError> {
        if text.trim().is_empty()
            || text.len() > 8_000
            || expected_response_marker.trim().is_empty()
        {
            return Err(ZaiSendError::InvalidInput);
        }
        let (chat_id, _) = self
            .submit_message(None, text)
            .await
            .map_err(|error| match error {
                crate::adapters::browser::BrowserSubmitError::BeforeSend => ZaiSendError::Preflight,
                crate::adapters::browser::BrowserSubmitError::Unknown => {
                    ZaiSendError::ResponseNotObserved { chat_id: None }
                }
            })?;
        for _ in 0..30 {
            match self.read_chat(&chat_id).await {
                Ok(messages)
                    if messages.iter().any(|message| {
                        message.role == Role::Assistant
                            && message.text.contains(expected_response_marker)
                    }) =>
                {
                    return Ok(ZaiSendReceipt {
                        chat_id,
                        expected_response_seen: true,
                    });
                }
                Ok(_) | Err(ZaiReadError::ProviderStatus(_)) => {}
                Err(error) => return Err(ZaiSendError::Read(error)),
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Err(ZaiSendError::ResponseNotObserved {
            chat_id: Some(chat_id),
        })
    }

    pub async fn close(self) {
        self.cdp.close().await;
    }

    pub async fn close_created_chat(self) {
        self.cdp.close_created_target().await;
    }
}

const ZAI_CHAT_LIST_EXPRESSION: &str = r#"(async(authenticateEmpty = false)=>{
  if(location.origin!=="https://chat.z.ai")return {origin:location.origin};
  const expected=__EXPECTED_SCOPE__;
  const options={credentials:'same-origin',cache:'no-store',mode:'same-origin',redirect:'error'};
  const r=await fetch('/api/v1/chats/?page=1&type=all&channel=zai-web&project_id=',options);
  if(!r.ok)return {origin:location.origin,status:r.status};
  let chats;try{chats=await r.json()}catch{return {origin:location.origin,error:'invalid_json'}};
  if(!Array.isArray(chats))return {origin:location.origin,error:'invalid_list'};
  const unverified={origin:location.origin,error:'account_unverified'};
  const empty=chats.length===0, first=chats[0]?.id;
  if(empty ? !authenticateEmpty : typeof first!=='string')return unverified;
  const proof=await fetch(empty ? '/api/v1/auths/' : '/api/v1/chats/'+encodeURIComponent(first),options);
  if(!proof.ok)return empty ? {origin:location.origin,status:proof.status} : unverified;
  let record;try{record=await proof.json()}catch{return unverified};
  const owner=empty ? record?.id : record?.user_id;
  if(empty ? typeof owner!=='string'||!owner.trim() : record?.id!==first||!owner)return unverified;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(owner)));
  const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(scope!==expected)return {origin:location.origin,error:'account_mismatch',scope,scope_verified:true};
  return {origin:location.origin,chats,scope,scope_verified:true};
})(/* authenticateEmpty */)"#;

#[derive(Debug, Deserialize)]
struct Batch {
    chat_id: Option<String>,
    data: Option<HashMap<String, RawMessage>>,
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    id: Option<String>,
    role: Option<String>,
    content: Option<Value>,
    content_blocks: Option<Vec<ContentBlock>>,
    created_at: Option<Value>,
    timestamp: Option<Value>,
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    content: Option<String>,
}

/// Validate the chat and preserve caller supplied message ordering.
/// Unknown roles, absent requested messages and empty text are omitted.
pub fn normalize_batch(
    expected_chat_id: &str,
    requested_ids: &[&str],
    input: &str,
) -> Result<Vec<NormalizedMessage>, NormalizeError> {
    let batch: Batch = serde_json::from_str(input).map_err(|_| NormalizeError::InvalidPayload)?;
    project_batch(expected_chat_id, requested_ids.iter().copied(), batch)
}

fn project_batch<'a>(
    expected_chat_id: &str,
    requested_ids: impl Iterator<Item = &'a str>,
    batch: Batch,
) -> Result<Vec<NormalizedMessage>, NormalizeError> {
    if batch.chat_id.as_deref() != Some(expected_chat_id) {
        return Err(NormalizeError::ChatMismatch);
    }
    let data = batch.data.ok_or(NormalizeError::InvalidPayload)?;
    Ok(requested_ids
        .filter_map(|id| {
            data.get(id)
                .and_then(|message| project_message(id, message))
        })
        .collect())
}

/// Project stable provider IDs from the observed list array, rejecting
/// malformed entries and duplicates instead of returning ambiguous addresses.
pub fn normalize_chat_list(input: &Value) -> Result<Vec<ZaiChatRef>, NormalizeError> {
    let values = input.as_array().ok_or(NormalizeError::InvalidPayload)?;
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    let mut chats = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_chat_id(id))
            .ok_or(NormalizeError::InvalidPayload)?;
        if !seen.insert(id) {
            return Err(NormalizeError::InvalidPayload);
        }
        chats.push(ZaiChatRef { id: id.to_owned() });
    }
    Ok(chats)
}

fn valid_chat_id(chat_id: &str) -> bool {
    chat_id.len() >= 12
        && chat_id.len() <= 80
        && chat_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn latest_source_message(messages: &[NormalizedMessage], role: Role) -> Option<SourceMessage> {
    messages.iter().rev().find_map(|message| {
        (message.role == role).then(|| SourceMessage {
            text: message.text.clone(),
            turn_id: None,
            time: message.timestamp.map(|timestamp| timestamp.to_string()),
            partial: None,
            truncated: None,
            message_id: Some(message.id.clone()),
            reply_to_input_id: None,
        })
    })
}

fn project_recent_messages(messages: &[NormalizedMessage]) -> RecentMessages {
    normalize_recent(
        latest_source_message(messages, Role::User),
        latest_source_message(messages, Role::Assistant),
    )
}

fn update_snapshot_field(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
}

fn project_transcript_page(
    principal_id: &str,
    account_scope: &str,
    identity: &CdpTargetIdentity,
    chat_id: &str,
    ordered_ids: &[String],
    batch: &Batch,
) -> Result<TranscriptPage, ZaiReadError> {
    let address = SessionAddress {
        instance: InstanceRef {
            node: NodeRef(identity.node_id.clone()),
            instance_id: identity.instance_id.clone(),
        },
        native_session_id: chat_id.to_owned(),
    };
    let mut snapshot = Sha256::new();
    update_snapshot_field(&mut snapshot, b"agent-herder/zai-transcript/v1");
    update_snapshot_field(&mut snapshot, principal_id.as_bytes());
    update_snapshot_field(&mut snapshot, account_scope.as_bytes());
    update_snapshot_field(&mut snapshot, identity.node_id.as_bytes());
    update_snapshot_field(&mut snapshot, identity.instance_id.as_bytes());
    update_snapshot_field(&mut snapshot, chat_id.as_bytes());
    let data = batch.data.as_ref().ok_or(ZaiReadError::InvalidResponse)?;
    let mut blocks = Vec::new();
    for message_id in ordered_ids {
        update_snapshot_field(&mut snapshot, message_id.as_bytes());
        let Some(message) = data.get(message_id) else {
            update_snapshot_field(&mut snapshot, b"missing-message");
            continue;
        };
        update_snapshot_field(
            &mut snapshot,
            message.id.as_deref().unwrap_or_default().as_bytes(),
        );
        let role = message.role.as_deref().unwrap_or_default();
        update_snapshot_field(&mut snapshot, role.as_bytes());
        if let Some(content) = message.content.as_ref() {
            update_snapshot_field(&mut snapshot, b"untyped-content");
            update_snapshot_field(&mut snapshot, content.to_string().as_bytes());
        }
        if let Some(native_blocks) = message.content_blocks.as_ref() {
            for (index, native_block) in native_blocks.iter().enumerate() {
                update_snapshot_field(&mut snapshot, &(index as u64).to_be_bytes());
                update_snapshot_field(
                    &mut snapshot,
                    native_block.kind.as_deref().unwrap_or_default().as_bytes(),
                );
                update_snapshot_field(
                    &mut snapshot,
                    native_block
                        .content
                        .as_deref()
                        .unwrap_or_default()
                        .as_bytes(),
                );
            }
        }
        if message.id.as_deref() != Some(message_id.as_str()) {
            continue;
        }
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let source = TranscriptSourceRef {
            session: address.clone(),
            message_id: message_id.clone(),
            turn_id: None,
        };
        if let Some(native_blocks) = message
            .content_blocks
            .as_deref()
            .filter(|native_blocks| !native_blocks.is_empty())
        {
            for (index, native_block) in native_blocks.iter().enumerate() {
                let Some(native_type) =
                    native_block.kind.as_deref().filter(|kind| !kind.is_empty())
                else {
                    continue;
                };
                let mut normalized = normalize_transcript_blocks(
                    &source,
                    [RawTranscriptBlock {
                        native_type: native_type.to_owned(),
                        text: native_block.content.clone(),
                    }],
                );
                if let Some(block) = normalized.first_mut() {
                    block.block_index = Some(index as u32);
                }
                blocks.extend(normalized);
            }
        } else if let Some(text) = message.content.as_ref().and_then(Value::as_str) {
            blocks.push(TranscriptBlock {
                kind: TranscriptBlockKind::Text,
                text: Some(text.to_owned()),
                source,
                block_index: None,
                native_type: None,
                source_field: Some("content".into()),
            });
        }
    }
    let snapshot_hex = snapshot
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let snapshot_id = format!("zai:{snapshot_hex}");
    TranscriptPage::new(principal_id, &snapshot_id, blocks, None, true)
        .map_err(|_| ZaiReadError::InvalidResponse)
}

fn project_message(requested_id: &str, message: &RawMessage) -> Option<NormalizedMessage> {
    let id = message.id.as_deref()?;
    if id.is_empty() || id != requested_id {
        return None;
    }
    let role = match message.role.as_deref()? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => return None,
    };
    let text = message
        .content
        .as_ref()
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            message.content_blocks.as_ref().map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| matches!(block.kind.as_deref(), Some("text" | "markdown")))
                    .filter_map(|block| block.content.as_deref())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        })
        .unwrap_or_default()
        .trim()
        .to_owned();
    if text.is_empty() {
        return None;
    }
    let timestamp = message
        .created_at
        .as_ref()
        .and_then(Value::as_u64)
        .or_else(|| message.timestamp.as_ref().and_then(Value::as_u64));
    Some(NormalizedMessage {
        id: id.to_owned(),
        role,
        text,
        timestamp,
        model: message.model.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    const OBSERVED_SHAPE: &str =
        include_str!("../../../../../acceptance/native/z-ai/messages-batch.json");
    const CHAT_LIST_SHAPE: &str =
        include_str!("../../../../../acceptance/native/z-ai/chat-list.json");
    const RECENT_TWO_CHATS: &str =
        include_str!("../../../../../acceptance/native/z-ai/recent-two-chats.json");

    async fn fake_cdp(listed_scope: Option<String>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("ws://{address}/devtools/page/target-1");
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let attached_scope = "a".repeat(64);
            let mut account_checked = false;
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                let id = request.get("id").and_then(Value::as_u64).unwrap();
                let method = request.get("method").and_then(Value::as_str).unwrap();
                let result = match method {
                    "Target.getTargetInfo" => serde_json::json!({"targetInfo":{
                        "targetId":"target-1","browserContextId":"context-1"
                    }}),
                    "Runtime.evaluate" => {
                        let expression = request
                            .pointer("/params/expression")
                            .and_then(Value::as_str)
                            .unwrap();
                        let value = if expression.contains(r#""op":"account""#) {
                            assert!(!account_checked, "list performs its own account proof");
                            account_checked = true;
                            serde_json::json!({"origin":"https://chat.z.ai", "scope": attached_scope, "scope_verified":true})
                        } else if expression.contains("scope_verified:true") {
                            match listed_scope.as_deref() {
                                Some(scope) => {
                                    let prefix = if scope == attached_scope { "a" } else { "b" };
                                    serde_json::json!({
                                        "origin":"https://chat.z.ai",
                                        "scope":scope,
                                        "scope_verified":true,
                                        "chats":[{"id":format!("{prefix}001000000000001")}]
                                    })
                                }
                                None => serde_json::json!({
                                    "origin":"https://chat.z.ai",
                                    "error":"account_unverified"
                                }),
                            }
                        } else {
                            panic!("unexpected page operation");
                        };
                        serde_json::json!({"result":{"value":value}})
                    }
                    _ => panic!("unexpected fake CDP method: {method}"),
                };
                let response = serde_json::json!({"id":id,"result":result});
                socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .unwrap();
            }
        });
        (endpoint, task)
    }

    fn fake_identity() -> CdpTargetIdentity {
        CdpTargetIdentity {
            node_id: "node-1".into(),
            instance_id: "instance-1".into(),
            browser_context_id: "context-1".into(),
            target_id: "target-1".into(),
        }
    }

    #[test]
    fn validates_chat_and_preserves_requested_order_and_text_blocks() {
        let messages = normalize_batch(
            "chat-fixture-z-001",
            &["user-001", "assistant-001"],
            OBSERVED_SHAPE,
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].text, "question text");
        assert_eq!(messages[1].role, Role::Assistant);
        assert_eq!(messages[1].text, "answer\ncontinued");
        assert_eq!(messages[1].timestamp, Some(1_794_052_801));
        assert_eq!(messages[1].model.as_deref(), Some("fixture-model"));
    }

    #[test]
    fn rejects_a_batch_for_another_chat() {
        assert_eq!(
            normalize_batch("different-chat", &["user-001"], OBSERVED_SHAPE),
            Err(NormalizeError::ChatMismatch)
        );
    }

    #[test]
    fn projects_stable_chat_ids_from_native_list() {
        let list: Value = serde_json::from_str(CHAT_LIST_SHAPE).unwrap();
        let chats = normalize_chat_list(&list).unwrap();
        assert_eq!(
            chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["c001000000000001", "c002000000000002"]
        );
    }

    #[test]
    fn rejects_malformed_or_duplicate_chat_ids() {
        assert_eq!(
            normalize_chat_list(&serde_json::json!([
                {"id":"c001000000000001"},
                {"id":"c001000000000001"}
            ])),
            Err(NormalizeError::InvalidPayload)
        );
        assert_eq!(
            normalize_chat_list(&serde_json::json!([{"id":"not/a/native-id"}])),
            Err(NormalizeError::InvalidPayload)
        );
    }

    #[test]
    fn recent_projection_keeps_message_ids_and_leaves_unobserved_refs_unknown() {
        let messages = normalize_batch(
            "chat-fixture-z-001",
            &["user-001", "assistant-001"],
            OBSERVED_SHAPE,
        )
        .unwrap();
        let recent = project_recent_messages(&messages);
        let user = recent.user.unwrap();
        let assistant = recent.assistant.unwrap();
        assert_eq!(user.message_id.as_deref(), Some("user-001"));
        assert_eq!(assistant.message_id.as_deref(), Some("assistant-001"));
        assert_eq!(user.turn_id, None);
        assert_eq!(assistant.turn_id, None);
        assert_eq!(assistant.reply_to_input_id, None);
        assert_eq!(recent.assistant_replies_to_user, None);
        assert_eq!(assistant.partial, None);
    }

    #[test]
    fn two_native_chats_keep_role_slots_and_message_ids_isolated() {
        let chats: Value = serde_json::from_str(RECENT_TWO_CHATS).unwrap();
        let chats = chats.as_array().unwrap();
        assert_eq!(chats.len(), 2);
        for chat in chats {
            let chat_id = chat.get("chat_id").and_then(Value::as_str).unwrap();
            let data = chat.get("data").unwrap();
            let requested: Vec<&str> = data
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            let batch = serde_json::to_string(&serde_json::json!({
                "chat_id": chat_id,
                "data": data
            }))
            .unwrap();
            let messages = normalize_batch(chat_id, &requested, &batch).unwrap();
            let recent = project_recent_messages(&messages);
            let user = recent.user.unwrap();
            let assistant = recent.assistant.unwrap();
            assert!(user.message_id.as_deref().unwrap().starts_with(chat_id));
            assert!(
                assistant
                    .message_id
                    .as_deref()
                    .unwrap()
                    .starts_with(chat_id)
            );
            assert_eq!(user.turn_id, None);
            assert_eq!(assistant.turn_id, None);
            assert_eq!(assistant.reply_to_input_id, None);
            assert_eq!(user.partial, None);
            assert_eq!(assistant.partial, None);
            assert_eq!(assistant.truncated, None);
            assert_eq!(recent.assistant_replies_to_user, None);
        }
    }

    #[tokio::test]
    async fn list_chats_rejects_account_changed_between_preflight_and_list_result() {
        let (endpoint, server) = fake_cdp(Some("b".repeat(64))).await;
        let mut reader = ZaiReader::attach(&endpoint, fake_identity(), &"a".repeat(64))
            .await
            .unwrap();
        let result = reader.list_chats().await;
        reader.close().await;
        server.await.unwrap();
        assert_eq!(result, Err(ZaiReadError::AccountMismatch));
    }

    #[tokio::test]
    async fn list_chats_allows_the_same_verified_account() {
        let (endpoint, server) = fake_cdp(Some("a".repeat(64))).await;
        let mut reader = ZaiReader::attach(&endpoint, fake_identity(), &"a".repeat(64))
            .await
            .unwrap();
        let result = reader.list_chats().await;
        reader.close().await;
        server.await.unwrap();
        assert_eq!(result.unwrap()[0].id, "a001000000000001");
    }

    #[tokio::test]
    async fn list_chats_fails_closed_when_account_identity_is_unavailable() {
        let (endpoint, server) = fake_cdp(None).await;
        let mut reader = ZaiReader::attach(&endpoint, fake_identity(), &"a".repeat(64))
            .await
            .unwrap();
        let result = reader.list_chats().await;
        reader.close().await;
        server.await.unwrap();
        assert_eq!(result, Err(ZaiReadError::AccountMismatch));
    }

    #[test]
    fn transcript_projection_preserves_native_block_types_indices_and_known_limits() {
        let identity = fake_identity();
        let batch: Batch = serde_json::from_str(OBSERVED_SHAPE).unwrap();
        let ids = vec!["user-001".to_owned(), "assistant-001".to_owned()];
        let account_scope = "account-scope-a".repeat(4);
        let page = project_transcript_page(
            "principal-test",
            &account_scope,
            &identity,
            "chat-fixture-z-001",
            &ids,
            &batch,
        )
        .unwrap();

        assert_eq!(page.blocks.len(), 4);
        assert_eq!(
            page.blocks[0].source.session.native_session_id,
            "chat-fixture-z-001"
        );
        assert_eq!(page.blocks[0].source.session.instance.node.0, "node-1");
        assert_eq!(
            page.blocks[0].source.session.instance.instance_id,
            "instance-1"
        );
        assert_eq!(page.blocks[0].source.message_id, "user-001");
        assert_eq!(page.blocks[0].kind, TranscriptBlockKind::Text);
        assert_eq!(page.blocks[0].native_type, None);
        assert_eq!(page.blocks[0].source_field.as_deref(), Some("content"));
        assert_eq!(page.blocks[0].block_index, None);
        assert_eq!(page.blocks[0].text.as_deref(), Some(" question text "));
        assert_eq!(page.blocks[1].source.message_id, "assistant-001");
        assert_eq!(page.blocks[1].native_type.as_deref(), Some("markdown"));
        assert_eq!(page.blocks[1].source_field, None);
        assert_eq!(page.blocks[1].block_index, Some(0));
        assert_eq!(page.blocks[1].text.as_deref(), Some("answer"));
        assert_eq!(page.blocks[2].source.message_id, "assistant-001");
        assert_eq!(page.blocks[2].native_type.as_deref(), Some("image"));
        assert_eq!(page.blocks[2].block_index, Some(1));
        assert_eq!(page.blocks[2].text, None);
        assert_eq!(page.blocks[3].source.message_id, "assistant-001");
        assert_eq!(page.blocks[3].native_type.as_deref(), Some("text"));
        assert_eq!(page.blocks[3].block_index, Some(2));
        assert_eq!(page.blocks[3].text.as_deref(), Some("continued"));
        assert_eq!(page.next_cursor, None);
        assert!(page.truncated);
        assert!(page.is_complete());
    }

    #[test]
    fn transcript_snapshot_binds_full_session_account_and_principal() {
        let identity = fake_identity();
        let batch: Batch = serde_json::from_str(OBSERVED_SHAPE).unwrap();
        let ids = vec!["user-001".to_owned(), "assistant-001".to_owned()];
        let account_scope = "account-scope-a".repeat(4);
        let page = project_transcript_page(
            "principal-test",
            &account_scope,
            &identity,
            "chat-fixture-z-001",
            &ids,
            &batch,
        )
        .unwrap();
        let other_node = CdpTargetIdentity {
            node_id: "node-2".into(),
            ..identity.clone()
        };
        let other_instance = CdpTargetIdentity {
            instance_id: "instance-2".into(),
            ..identity.clone()
        };
        let other_account = "account-scope-b".repeat(4);
        let other_principal = "principal-other";
        let snapshot_for = |principal: &str, account: &str, target: &CdpTargetIdentity| {
            project_transcript_page(
                principal,
                account,
                target,
                "chat-fixture-z-001",
                &ids,
                &batch,
            )
            .unwrap()
            .snapshot_id
        };
        assert_ne!(
            page.snapshot_id,
            snapshot_for("principal-test", &account_scope, &other_node)
        );
        assert_ne!(
            page.snapshot_id,
            snapshot_for("principal-test", &account_scope, &other_instance)
        );
        assert_ne!(
            page.snapshot_id,
            snapshot_for("principal-test", &other_account, &identity)
        );
        assert_ne!(
            page.snapshot_id,
            snapshot_for(other_principal, &account_scope, &identity)
        );
    }

    #[test]
    fn snapshot_fields_are_length_delimited_even_when_values_contain_nul() {
        let mut left = Sha256::new();
        update_snapshot_field(&mut left, b"a\0b");
        update_snapshot_field(&mut left, b"c");
        let mut right = Sha256::new();
        update_snapshot_field(&mut right, b"a");
        update_snapshot_field(&mut right, b"b\0c");
        assert_ne!(left.finalize(), right.finalize());
    }
}
