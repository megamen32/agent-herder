//! Typed projection of Z.ai messages/batch responses into Herder messages.
//!
//! This module performs no network or profile access. The caller supplies the
//! expected chat id and requested message ids; payload identity is checked
//! before messages are returned.

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

use crate::application::recent::{RecentMessages, SourceMessage, normalize_recent};
use crate::domain::{
    address::{InstanceRef, NodeRef, SessionAddress},
    transcript::{
        RawTranscriptBlock, TranscriptPage, TranscriptSourceRef, normalize_transcript_blocks,
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

/// Read-only Z.ai adapter bound to one exact Chrome instance/context/target
/// and the expected hashed Z.ai account scope.
pub struct ZaiReader {
    cdp: CdpConnection,
    account_scope: String,
}

impl ZaiReader {
    pub async fn account_scope_for_target(cdp: &mut CdpConnection) -> Result<String, ZaiReadError> {
        let scope = cdp
            .evaluate(ZAI_ACCOUNT_SCOPE_EXPRESSION)
            .await
            .map_err(ZaiReadError::Cdp)?;
        if scope.get("origin").and_then(Value::as_str) != Some("https://chat.z.ai") {
            return Err(ZaiReadError::WrongOrigin);
        }
        scope
            .get("scope")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
            .ok_or(ZaiReadError::AccountMismatch)
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
        };
        reader.verify_account().await?;
        Ok(reader)
    }

    async fn verify_account(&mut self) -> Result<(), ZaiReadError> {
        let result = self
            .cdp
            .evaluate(ZAI_ACCOUNT_SCOPE_EXPRESSION)
            .await
            .map_err(ZaiReadError::Cdp)?;
        if result.get("origin").and_then(Value::as_str) != Some("https://chat.z.ai") {
            return Err(ZaiReadError::WrongOrigin);
        }
        if result.get("scope").and_then(Value::as_str) != Some(self.account_scope.as_str()) {
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
        self.verify_account().await?;
        let result = self
            .cdp
            .evaluate(ZAI_CHAT_LIST_EXPRESSION)
            .await
            .map_err(ZaiReadError::Cdp)?;
        if result.get("origin").and_then(Value::as_str) != Some("https://chat.z.ai") {
            return Err(ZaiReadError::WrongOrigin);
        }
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        if status != 200 {
            return Err(ZaiReadError::ProviderStatus(status));
        }
        let chats = result.get("chats").ok_or(ZaiReadError::InvalidResponse)?;
        normalize_chat_list(chats).map_err(ZaiReadError::Normalize)
    }

    pub async fn read_chat(
        &mut self,
        chat_id: &str,
    ) -> Result<Vec<NormalizedMessage>, ZaiReadError> {
        if !valid_chat_id(chat_id) {
            return Err(ZaiReadError::InvalidResponse);
        }
        let id = serde_json::to_string(chat_id).map_err(|_| ZaiReadError::InvalidResponse)?;
        let expected_scope = serde_json::to_string(&self.account_scope)
            .map_err(|_| ZaiReadError::InvalidResponse)?;
        let expression = format!(
            r#"(async()=>{{
              if(location.origin!=="https://chat.z.ai")return {{origin:location.origin}};
              const id={id},expected={expected_scope};
              const r=await fetch('/api/v1/chats/'+encodeURIComponent(id),{{credentials:'same-origin',cache:'no-store'}});
              let chat=null;try{{chat=await r.json()}}catch{{}}
              if(!r.ok)return {{origin:location.origin,status:r.status}};
              if(chat?.id!==id||!chat?.user_id)return {{origin:location.origin,error:'identity_mismatch'}};
              const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(chat.user_id)));
              const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
              if(scope!==expected)return {{origin:location.origin,error:'account_mismatch'}};
              const ids=Object.keys(chat.chat?.history?.messages||{{}}).slice(-180);
              const data={{}};
              for(let start=0;start<ids.length;start+=60){{
                const part=ids.slice(start,start+60);
                const batch=await fetch('/api/v1/chats/'+encodeURIComponent(id)+'/messages/batch',{{method:'POST',credentials:'same-origin',headers:{{'content-type':'application/json'}},body:JSON.stringify({{ids:part}})}});
                if(!batch.ok)return {{origin:location.origin,status:batch.status}};
                const value=await batch.json();
                if(value.chat_id!==id||!value.data||typeof value.data!=='object')return {{origin:location.origin,error:'batch_identity_mismatch'}};
                for(const key of part)if(value.data[key])data[key]=value.data[key];
              }}
              return {{origin:location.origin,chat_id:id,data,ids}};
            }})()"#
        );
        let result = self
            .cdp
            .evaluate(&expression)
            .await
            .map_err(ZaiReadError::Cdp)?;
        if result.get("origin").and_then(Value::as_str) != Some("https://chat.z.ai") {
            return Err(ZaiReadError::WrongOrigin);
        }
        if result.get("error").and_then(Value::as_str) == Some("account_mismatch") {
            return Err(ZaiReadError::AccountMismatch);
        }
        if result.get("error").is_some() {
            return Err(ZaiReadError::InvalidResponse);
        }
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        if status != 200 {
            return Err(ZaiReadError::ProviderStatus(status));
        }
        let ids: Vec<String> = result
            .get("ids")
            .and_then(Value::as_array)
            .ok_or(ZaiReadError::InvalidResponse)?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let data = result
            .get("data")
            .cloned()
            .ok_or(ZaiReadError::InvalidResponse)?;
        let batch = serde_json::to_string(&serde_json::json!({"chat_id": chat_id, "data": data}))
            .map_err(|_| ZaiReadError::InvalidResponse)?;
        let requested: Vec<&str> = ids.iter().map(String::as_str).collect();
        normalize_batch(chat_id, &requested, &batch).map_err(ZaiReadError::Normalize)
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
        let messages = self.read_chat(chat_id).await?;
        project_transcript_page(principal_id, &identity, chat_id, &messages)
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
        self.cdp
            .activate_target()
            .await
            .map_err(ZaiSendError::Cdp)?;
        let preflight = self
            .cdp
            .evaluate(ZAI_SEND_PREFLIGHT)
            .await
            .map_err(ZaiSendError::Cdp)?;
        if preflight.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(ZaiSendError::Preflight);
        }
        self.cdp
            .command("DOM.enable", serde_json::json!({}))
            .await
            .map_err(ZaiSendError::Cdp)?;
        let document = self
            .cdp
            .command("DOM.getDocument", serde_json::json!({"depth": 0}))
            .await
            .map_err(ZaiSendError::Cdp)?;
        let root = document
            .pointer("/root/nodeId")
            .and_then(Value::as_u64)
            .ok_or(ZaiSendError::InputNotAccepted)?;
        let query = self
            .cdp
            .command(
                "DOM.querySelector",
                serde_json::json!({"nodeId": root, "selector": ZAI_COMPOSER_SELECTOR}),
            )
            .await
            .map_err(ZaiSendError::Cdp)?;
        let node_id = query
            .get("nodeId")
            .and_then(Value::as_u64)
            .filter(|node| *node != 0)
            .ok_or(ZaiSendError::InputNotAccepted)?;
        self.cdp
            .command("DOM.focus", serde_json::json!({"nodeId": node_id}))
            .await
            .map_err(ZaiSendError::Cdp)?;
        self.cdp
            .command("Input.insertText", serde_json::json!({"text": text}))
            .await
            .map_err(ZaiSendError::Cdp)?;
        let expected_text = serde_json::to_string(text).map_err(|_| ZaiSendError::InvalidInput)?;
        let verify = format!(
            r#"(()=>{{const e=document.querySelector({});const b=document.querySelector('#send-message-button');const events=globalThis.__herderCdpInputEvents||[];const inputSeen=events.some(x=>x.target===e&&x.value==={expected_text});return {{ready:location.origin==="https://chat.z.ai"&&location.pathname==="/"&&!!e&&e.value.trim()==={expected_text}&&inputSeen&&!!b&&!b.disabled&&!([...document.querySelectorAll('button')].some(x=>x.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted')))}}}})()"#,
            serde_json::to_string(ZAI_COMPOSER_SELECTOR).unwrap()
        );
        let verify = self
            .cdp
            .evaluate(&verify)
            .await
            .map_err(ZaiSendError::Cdp)?;
        if verify.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(ZaiSendError::SendNotReady);
        }
        let click = format!(
            r#"(()=>{{if(location.origin!=="https://chat.z.ai"||location.pathname!=="/")return {{clicked:false}};const e=document.querySelector({});const b=document.querySelector('#send-message-button');if(!e||e.value.trim()!=={expected_text}||!b||b.disabled)return {{clicked:false}};b.click();return {{clicked:true}}}})()"#,
            serde_json::to_string(ZAI_COMPOSER_SELECTOR).unwrap()
        );
        let clicked = self.cdp.evaluate(&click).await.map_err(ZaiSendError::Cdp)?;
        if clicked.get("clicked").and_then(Value::as_bool) != Some(true) {
            return Err(ZaiSendError::SendNotReady);
        }
        let marker = expected_response_marker.to_owned();
        let mut chat_id = None;
        for _ in 0..30 {
            let route = self
                .cdp
                .evaluate(
                    "(()=>location.pathname.match(/^\\/c\\/([a-f0-9-]{12,80})$/i)?.[1]||null)()",
                )
                .await
                .map_err(ZaiSendError::Cdp)?;
            if let Some(id) = route.as_str() {
                chat_id = Some(id.to_owned());
                match self.read_chat(id).await {
                    Ok(messages)
                        if messages.iter().any(|message| {
                            message.role == Role::Assistant && message.text.contains(&marker)
                        }) =>
                    {
                        return Ok(ZaiSendReceipt {
                            chat_id: id.to_owned(),
                            expected_response_seen: true,
                        });
                    }
                    Ok(_) | Err(ZaiReadError::ProviderStatus(_)) => {}
                    Err(error) => return Err(ZaiSendError::Read(error)),
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Err(ZaiSendError::ResponseNotObserved { chat_id })
    }

    pub async fn close(self) {
        self.cdp.close().await;
    }

    pub async fn close_created_chat(self) {
        self.cdp.close_created_target().await;
    }
}

const ZAI_ACCOUNT_SCOPE_EXPRESSION: &str = r#"(async()=>{
  if(location.origin!=="https://chat.z.ai")return {origin:location.origin};
  const r=await fetch('/api/v1/chats/?page=1&type=all&channel=zai-web&project_id=',{credentials:'same-origin',cache:'no-store'});
  if(!r.ok)return {origin:location.origin};
  const chats=await r.json();
  if(!Array.isArray(chats)||!chats[0]?.id)return {origin:location.origin};
  const info=await fetch('/api/v1/chats/'+encodeURIComponent(chats[0].id),{credentials:'same-origin',cache:'no-store'});
  if(!info.ok)return {origin:location.origin};
  const chat=await info.json();
  if(!chat?.user_id)return {origin:location.origin};
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(chat.user_id)));
  return {origin:location.origin,scope:[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')};
})()"#;

const ZAI_CHAT_LIST_EXPRESSION: &str = r#"(async()=>{
  if(location.origin!=="https://chat.z.ai")return {origin:location.origin};
  const r=await fetch('/api/v1/chats/?page=1&type=all&channel=zai-web&project_id=',{credentials:'same-origin',cache:'no-store'});
  if(!r.ok)return {origin:location.origin,status:r.status};
  let chats;try{chats=await r.json()}catch{return {origin:location.origin,error:'invalid_json'}};
  if(!Array.isArray(chats))return {origin:location.origin,error:'invalid_list'};
  return {origin:location.origin,chats};
})()"#;

const ZAI_COMPOSER_SELECTOR: &str = r#"textarea[placeholder="Send a Message"]"#;
const ZAI_SEND_PREFLIGHT: &str = r#"(()=>{
  if(!globalThis.__herderCdpInputListener){
    globalThis.__herderCdpInputEvents=[];
    document.addEventListener('input',e=>{if(e.target?.matches?.('textarea[placeholder="Send a Message"]'))globalThis.__herderCdpInputEvents.push({target:e.target,value:e.target.value})},true);
    globalThis.__herderCdpInputListener=true;
  }
  const e=document.querySelector('textarea[placeholder="Send a Message"]');
  const b=document.querySelector('#send-message-button');
  const stop=[...document.querySelectorAll('button')].some(x=>x.getClientRects().length>0&&!!x.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted'));
  return {ready:location.origin==='https://chat.z.ai'&&location.pathname==='/'&&!!e&&e.getClientRects().length>0&&!e.value.trim()&&!document.querySelector('[data-message-author-role="user"]')&&!stop&&!!b};
})()"#;

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
    if batch.chat_id.as_deref() != Some(expected_chat_id) {
        return Err(NormalizeError::ChatMismatch);
    }
    let data = batch.data.ok_or(NormalizeError::InvalidPayload)?;
    Ok(requested_ids
        .iter()
        .filter_map(|id| {
            data.get(*id)
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

fn project_transcript_page(
    principal_id: &str,
    identity: &CdpTargetIdentity,
    chat_id: &str,
    messages: &[NormalizedMessage],
) -> Result<TranscriptPage, ZaiReadError> {
    let address = SessionAddress {
        instance: InstanceRef {
            node: NodeRef(identity.node_id.clone()),
            instance_id: identity.instance_id.clone(),
        },
        native_session_id: chat_id.to_owned(),
    };
    let mut snapshot = Sha256::new();
    snapshot.update(chat_id.as_bytes());
    for message in messages {
        snapshot.update([0]);
        snapshot.update(message.id.as_bytes());
        snapshot.update([0]);
        snapshot.update(match &message.role {
            Role::User => b"user".as_slice(),
            Role::Assistant => b"assistant".as_slice(),
        });
        snapshot.update([0]);
        snapshot.update(message.text.as_bytes());
    }
    let snapshot_hex = snapshot
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let snapshot_id = format!("zai:{snapshot_hex}");
    let blocks = messages
        .iter()
        .flat_map(|message| {
            let source = TranscriptSourceRef {
                session: address.clone(),
                message_id: message.id.clone(),
                turn_id: None,
            };
            let native_type = match &message.role {
                Role::User => "input_text",
                Role::Assistant => "output_text",
            };
            normalize_transcript_blocks(
                &source,
                [RawTranscriptBlock {
                    native_type: native_type.into(),
                    text: Some(message.text.clone()),
                }],
            )
        })
        .collect();
    TranscriptPage::new(principal_id, &snapshot_id, blocks, None, true)
        .map_err(|_| ZaiReadError::InvalidResponse)
}

fn project_message(requested_id: &str, message: &RawMessage) -> Option<NormalizedMessage> {
    let id = message.id.as_deref().unwrap_or(requested_id).trim();
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

    async fn fake_cdp(recheck_scope: Option<String>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("ws://{address}/devtools/page/target-1");
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let attached_scope = "a".repeat(64);
            let mut account_checks = 0;
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
                        let value = if expression.contains("const info=await fetch") {
                            account_checks += 1;
                            let scope = if account_checks == 1 {
                                Some(attached_scope.as_str())
                            } else {
                                recheck_scope.as_deref()
                            };
                            match scope {
                                Some(scope) => serde_json::json!({
                                    "origin":"https://chat.z.ai","scope":scope
                                }),
                                None => serde_json::json!({"origin":"https://chat.z.ai"}),
                            }
                        } else {
                            let scope = recheck_scope.as_deref().unwrap_or(&attached_scope);
                            let prefix = if scope == attached_scope { "a" } else { "b" };
                            serde_json::json!({
                                "origin":"https://chat.z.ai",
                                "chats":[{"id":format!("{prefix}001000000000001")}]
                            })
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
    async fn list_chats_rejects_account_changed_after_attach() {
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
    fn transcript_projection_preserves_chat_message_identity_and_known_limits() {
        let identity = fake_identity();
        let messages = normalize_batch(
            "chat-fixture-z-001",
            &["user-001", "assistant-001"],
            OBSERVED_SHAPE,
        )
        .unwrap();
        let page =
            project_transcript_page("principal-test", &identity, "chat-fixture-z-001", &messages)
                .unwrap();

        assert_eq!(page.blocks.len(), 2);
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
        assert_eq!(page.blocks[0].native_type, "input_text");
        assert_eq!(page.blocks[0].text.as_deref(), Some("question text"));
        assert_eq!(page.blocks[1].source.message_id, "assistant-001");
        assert_eq!(page.blocks[1].native_type, "output_text");
        assert_eq!(page.blocks[1].text.as_deref(), Some("answer\ncontinued"));
        assert_eq!(page.next_cursor, None);
        assert!(page.truncated);
        assert!(page.is_complete());
    }
}
