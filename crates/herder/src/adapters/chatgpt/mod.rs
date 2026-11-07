//! Typed projection of a ChatGPT conversation payload into Herder messages.
//!
//! This module performs no I/O and makes no claim that the caller is
//! authenticated. The expected conversation id must come from the selected
//! instance/profile adapter and is checked before any message is returned.

use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, time::Duration};

use super::cdp::{
    CdpConnection, CdpCreateError, CdpError, CdpTargetIdentity, create_page_target_with_origin_port,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct NormalizedMessage {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub create_time: Option<f64>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    MissingConversationId,
    ConversationMismatch,
    MissingMapping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatGptReadError {
    Cdp(CdpError),
    TargetCreate(CdpCreateError),
    WrongOrigin,
    AccountMismatch,
    ProviderStatus(u16),
    InvalidResponse,
    Normalize(NormalizeError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatGptSendError {
    Cdp(CdpError),
    Preflight,
    InputNotAccepted,
    SendNotReady,
    InvalidInput,
    ResponseNotObserved { conversation_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatGptSendReceipt {
    pub conversation_id: String,
    pub expected_response_seen: bool,
}

/// Authenticated read-only adapter bound to one browser instance, context,
/// and page target. Auth data never leaves the selected Chrome page.
pub struct ChatGptReader {
    cdp: CdpConnection,
    account_scope: String,
}

impl ChatGptReader {
    pub async fn account_scope_for_target(
        cdp: &mut CdpConnection,
    ) -> Result<String, ChatGptReadError> {
        let scope = cdp
            .evaluate(CHATGPT_ACCOUNT_SCOPE_EXPRESSION)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        if scope.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") {
            return Err(ChatGptReadError::WrongOrigin);
        }
        scope
            .get("scope")
            .and_then(Value::as_str)
            .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_ascii_lowercase)
            .ok_or(ChatGptReadError::AccountMismatch)
    }

    pub async fn create_new_chat(
        browser_websocket_endpoint: &str,
        node_id: &str,
        instance_id: &str,
        browser_context_id: &str,
        expected_account_scope: &str,
        origin_port: Option<u16>,
    ) -> Result<Self, ChatGptReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ChatGptReadError::AccountMismatch);
        }
        let cdp = create_page_target_with_origin_port(
            browser_websocket_endpoint,
            "https://chatgpt.com",
            node_id,
            instance_id,
            browser_context_id,
            origin_port,
        )
        .await
        .map_err(ChatGptReadError::TargetCreate)?;
        let mut reader = Self {
            cdp,
            account_scope: expected_account_scope.to_ascii_lowercase(),
        };
        match reader.cdp.wait_for_origin("https://chatgpt.com").await {
            Ok(true) => {}
            Ok(false) => {
                reader.cdp.close_created_target().await;
                return Err(ChatGptReadError::WrongOrigin);
            }
            Err(error) => {
                reader.cdp.close_created_target().await;
                return Err(ChatGptReadError::Cdp(error));
            }
        }
        let scope = reader.cdp.evaluate(CHATGPT_ACCOUNT_SCOPE_EXPRESSION).await;
        let verified = match scope {
            Ok(scope)
                if scope.get("origin").and_then(Value::as_str) == Some("https://chatgpt.com")
                    && scope.get("scope").and_then(Value::as_str)
                        == Some(reader.account_scope.as_str()) =>
            {
                Ok(())
            }
            Ok(scope)
                if scope.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") =>
            {
                Err(ChatGptReadError::WrongOrigin)
            }
            Ok(_) => Err(ChatGptReadError::AccountMismatch),
            Err(error) => Err(ChatGptReadError::Cdp(error)),
        };
        if let Err(error) = verified {
            reader.cdp.close_created_target().await;
            return Err(error);
        }
        Ok(reader)
    }

    pub async fn attach(
        endpoint: &str,
        identity: CdpTargetIdentity,
        expected_account_scope: &str,
    ) -> Result<Self, ChatGptReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ChatGptReadError::AccountMismatch);
        }
        let mut cdp = CdpConnection::connect_page(endpoint, identity)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        let expected = expected_account_scope.to_ascii_lowercase();
        let scope = cdp
            .evaluate(CHATGPT_ACCOUNT_SCOPE_EXPRESSION)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        let actual = scope.get("scope").and_then(Value::as_str);
        if scope.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") {
            return Err(ChatGptReadError::WrongOrigin);
        }
        if actual != Some(expected.as_str()) {
            return Err(ChatGptReadError::AccountMismatch);
        }
        Ok(Self {
            cdp,
            account_scope: expected,
        })
    }

    pub async fn attach_via_browser(
        browser_websocket_endpoint: &str,
        identity: CdpTargetIdentity,
        expected_account_scope: &str,
        origin_port: Option<u16>,
    ) -> Result<Self, ChatGptReadError> {
        if expected_account_scope.len() != 64
            || !expected_account_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ChatGptReadError::AccountMismatch);
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
        .map_err(ChatGptReadError::Cdp)?;
        cdp.attach_target(&identity.target_id, &identity.browser_context_id)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        verify_chatgpt_scope(&mut cdp, expected_account_scope).await?;
        Ok(Self {
            cdp,
            account_scope: expected_account_scope.to_ascii_lowercase(),
        })
    }

    pub fn identity(&self) -> &CdpTargetIdentity {
        self.cdp.identity()
    }

    pub fn account_scope(&self) -> &str {
        &self.account_scope
    }

    pub async fn read_conversation(
        &mut self,
        conversation_id: &str,
    ) -> Result<Vec<NormalizedMessage>, ChatGptReadError> {
        if conversation_id.is_empty()
            || conversation_id.len() > 128
            || !conversation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ChatGptReadError::InvalidResponse);
        }
        let id = serde_json::to_string(conversation_id)
            .map_err(|_| ChatGptReadError::InvalidResponse)?;
        let expression = format!(
            "(async()=>{{if(location.origin!==\"https://chatgpt.com\")return {{origin:location.origin}};const id={id};const r=await fetch('/backend-api/conversation/'+encodeURIComponent(id),{{credentials:'same-origin',cache:'no-store'}});let payload=null;try{{payload=await r.json()}}catch{{}}return {{origin:location.origin,status:r.status,payload}}}})()"
        );
        let result = self
            .cdp
            .evaluate(&expression)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        if result.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") {
            return Err(ChatGptReadError::WrongOrigin);
        }
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(0) as u16;
        if status != 200 {
            return Err(ChatGptReadError::ProviderStatus(status));
        }
        let payload = result
            .get("payload")
            .ok_or(ChatGptReadError::InvalidResponse)?;
        let payload =
            serde_json::to_string(payload).map_err(|_| ChatGptReadError::InvalidResponse)?;
        normalize_conversation(conversation_id, &payload).map_err(ChatGptReadError::Normalize)
    }

    /// Send exactly one harmless first prompt into a fresh task-owned chat.
    /// Every post-input uncertainty is returned to the caller; this method
    /// never retries a possibly accepted action.
    pub async fn send_first_message(
        &mut self,
        text: &str,
        expected_response_marker: &str,
    ) -> Result<ChatGptSendReceipt, ChatGptSendError> {
        if text.trim().is_empty()
            || text.len() > 8_000
            || expected_response_marker.trim().is_empty()
        {
            return Err(ChatGptSendError::InvalidInput);
        }
        self.cdp
            .activate_target()
            .await
            .map_err(ChatGptSendError::Cdp)?;
        let preflight = self
            .cdp
            .evaluate(CHATGPT_SEND_PREFLIGHT)
            .await
            .map_err(ChatGptSendError::Cdp)?;
        if preflight.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(ChatGptSendError::Preflight);
        }
        self.cdp
            .command("DOM.enable", serde_json::json!({}))
            .await
            .map_err(ChatGptSendError::Cdp)?;
        let document = self
            .cdp
            .command("DOM.getDocument", serde_json::json!({"depth": 0}))
            .await
            .map_err(ChatGptSendError::Cdp)?;
        let root = document
            .pointer("/root/nodeId")
            .and_then(Value::as_u64)
            .ok_or(ChatGptSendError::InputNotAccepted)?;
        let query = self
            .cdp
            .command(
                "DOM.querySelector",
                serde_json::json!({"nodeId": root, "selector": CHATGPT_COMPOSER_SELECTOR}),
            )
            .await
            .map_err(ChatGptSendError::Cdp)?;
        let node_id = query
            .get("nodeId")
            .and_then(Value::as_u64)
            .filter(|node| *node != 0)
            .ok_or(ChatGptSendError::InputNotAccepted)?;
        self.cdp
            .command("DOM.focus", serde_json::json!({"nodeId": node_id}))
            .await
            .map_err(ChatGptSendError::Cdp)?;
        self.cdp
            .command("Input.insertText", serde_json::json!({"text": text}))
            .await
            .map_err(ChatGptSendError::Cdp)?;
        let expected_text =
            serde_json::to_string(text).map_err(|_| ChatGptSendError::InvalidInput)?;
        let verify = format!(
            r#"(()=>{{const e=document.querySelector({});const f=e?.closest('form');const b=f?.querySelector('button[type="submit"],button[data-testid="send-button"]');const events=globalThis.__herderCdpInputEvents||[];const inputSeen=events.some(x=>x.target===e&&x.value==={expected_text});return {{ready:location.origin==="https://chatgpt.com"&&location.pathname==="/"&&!!e&&e.innerText.trim()==={expected_text}&&inputSeen&&!!b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'&&!(f&&f.querySelector('[data-testid="stop-button"]'))}}}})()"#,
            serde_json::to_string(CHATGPT_COMPOSER_SELECTOR).unwrap()
        );
        let verify = self
            .cdp
            .evaluate(&verify)
            .await
            .map_err(ChatGptSendError::Cdp)?;
        if verify.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(ChatGptSendError::SendNotReady);
        }
        let click = format!(
            r#"(()=>{{if(location.origin!=="https://chatgpt.com"||location.pathname!=="/")return {{clicked:false}};const e=document.querySelector({});const f=e?.closest('form');const b=f?.querySelector('button[type="submit"],button[data-testid="send-button"]');if(!e||e.innerText.trim()!=={expected_text}||!b||b.disabled||b.getAttribute('aria-disabled')==='true')return {{clicked:false}};b.click();return {{clicked:true}}}})()"#,
            serde_json::to_string(CHATGPT_COMPOSER_SELECTOR).unwrap()
        );
        let clicked = self
            .cdp
            .evaluate(&click)
            .await
            .map_err(ChatGptSendError::Cdp)?;
        if clicked.get("clicked").and_then(Value::as_bool) != Some(true) {
            return Err(ChatGptSendError::SendNotReady);
        }
        let marker = serde_json::to_string(expected_response_marker)
            .map_err(|_| ChatGptSendError::InvalidInput)?;
        for _ in 0..90 {
            let observed = self
                .cdp
                .evaluate(&format!(
                    r#"(()=>{{const id=location.pathname.match(/^\/c\/([a-f0-9-]{{12,80}})$/i)?.[1];const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].map(e=>(e.innerText||e.textContent||'').trim()).filter(Boolean);return {{id,matched:a.some(t=>t.includes({marker}))}}}})()"#
                ))
                .await
                .map_err(ChatGptSendError::Cdp)?;
            if let Some(id) = observed.get("id").and_then(Value::as_str) {
                if observed.get("matched").and_then(Value::as_bool) == Some(true) {
                    return Ok(ChatGptSendReceipt {
                        conversation_id: id.to_owned(),
                        expected_response_seen: true,
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let conversation_id = self
            .cdp
            .evaluate("(()=>location.pathname.match(/^\\/c\\/([a-f0-9-]{12,80})$/i)?.[1]||null)()")
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned));
        Err(ChatGptSendError::ResponseNotObserved { conversation_id })
    }

    pub async fn close(self) {
        self.cdp.close().await;
    }

    pub async fn close_created_chat(self) {
        self.cdp.close_created_target().await;
    }
}

async fn verify_chatgpt_scope(
    cdp: &mut CdpConnection,
    expected_account_scope: &str,
) -> Result<(), ChatGptReadError> {
    let scope = cdp
        .evaluate(CHATGPT_ACCOUNT_SCOPE_EXPRESSION)
        .await
        .map_err(ChatGptReadError::Cdp)?;
    if scope.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") {
        return Err(ChatGptReadError::WrongOrigin);
    }
    let expected = expected_account_scope.to_ascii_lowercase();
    if scope.get("scope").and_then(Value::as_str) != Some(expected.as_str()) {
        return Err(ChatGptReadError::AccountMismatch);
    }
    Ok(())
}

const CHATGPT_ACCOUNT_SCOPE_EXPRESSION: &str = r#"(async()=>{
  if(location.origin!=="https://chatgpt.com")return {origin:location.origin};
  const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
  if(!r.ok)return {origin:location.origin};
  const s=await r.json();
  const id=s&&s.account&&s.account.id;
  if(typeof id!=="string"||!id)return {origin:location.origin};
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));
  return {origin:location.origin,scope:[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')};
})()"#;

const CHATGPT_COMPOSER_SELECTOR: &str =
    r#"div[contenteditable="true"][role="textbox"][data-composer-markdown]"#;

const CHATGPT_SEND_PREFLIGHT: &str = r#"(()=>{
  if(!globalThis.__herderCdpInputListener){
    globalThis.__herderCdpInputEvents=[];
    document.addEventListener('input',e=>{if(e.target?.matches?.('div[contenteditable="true"][role="textbox"][data-composer-markdown]'))globalThis.__herderCdpInputEvents.push({target:e.target,value:e.target.innerText||e.target.textContent||''})},true);
    globalThis.__herderCdpInputListener=true;
  }
  const e=document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
  const f=e?.closest('form');
  const visible=n=>!!n&&n.getClientRects().length>0;
  const buttons=[...(f?.querySelectorAll('button')||[])].filter(visible);
  const send=buttons.filter(b=>b.type==='submit'||b.getAttribute('data-testid')==='send-button'||/^(Send message|Send prompt|Отправить сообщение)$/i.test(b.getAttribute('aria-label')||''));
  const stop=buttons.some(b=>b.getAttribute('data-testid')==='stop-button'||/^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(b.getAttribute('aria-label')||''));
  return {ready:location.origin==='https://chatgpt.com'&&location.pathname==='/'&&!!e&&visible(e)&&!(e.innerText||e.textContent||'').trim()&&!document.querySelector('[data-message-author-role="user"]')&&!stop&&send.length===1&&!send[0].disabled};
})()"#;

#[derive(Debug, Deserialize)]
struct Conversation {
    conversation_id: Option<String>,
    current_node: Option<String>,
    mapping: Option<HashMap<String, Node>>,
}

#[derive(Debug, Deserialize)]
struct Node {
    parent: Option<String>,
    message: Option<Message>,
}

#[derive(Debug, Deserialize)]
struct Message {
    id: Option<String>,
    author: Option<Author>,
    recipient: Option<String>,
    channel: Option<String>,
    create_time: Option<f64>,
    metadata: Option<Metadata>,
    content: Option<Content>,
}

#[derive(Debug, Deserialize)]
struct Author {
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Metadata {
    model_slug: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Content {
    parts: Option<Vec<Part>>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Part {
    Text(String),
    Object { text: Option<String> },
}

impl Part {
    fn text(&self) -> &str {
        match self {
            Self::Text(text) => text,
            Self::Object { text: Some(text) } => text,
            Self::Object { text: None } => "",
        }
    }
}

/// Validate identity and project only the selected conversation branch.
/// Assistant analysis/tool messages are excluded; source ordering is retained.
pub fn normalize_conversation(
    expected_id: &str,
    input: &str,
) -> Result<Vec<NormalizedMessage>, NormalizeError> {
    let conversation: Conversation =
        serde_json::from_str(input).map_err(|_| NormalizeError::MissingMapping)?;
    let actual_id = conversation
        .conversation_id
        .as_deref()
        .ok_or(NormalizeError::MissingConversationId)?;
    if actual_id != expected_id {
        return Err(NormalizeError::ConversationMismatch);
    }
    let mapping = conversation.mapping.ok_or(NormalizeError::MissingMapping)?;

    let mut nodes: Vec<&Node> = Vec::new();
    if let Some(current) = conversation.current_node.as_deref() {
        let mut cursor = Some(current);
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if !seen.insert(id) {
                break;
            }
            let Some(node) = mapping.get(id) else { break };
            nodes.push(node);
            cursor = node.parent.as_deref();
        }
        nodes.reverse();
    } else {
        nodes.extend(mapping.values());
        nodes.sort_by(|a, b| {
            a.message
                .as_ref()
                .and_then(|m| m.create_time)
                .partial_cmp(&b.message.as_ref().and_then(|m| m.create_time))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    Ok(nodes
        .into_iter()
        .filter_map(|node| node.message.as_ref())
        .filter_map(project_message)
        .collect())
}

fn project_message(message: &Message) -> Option<NormalizedMessage> {
    let id = message.id.as_ref()?.trim();
    if id.is_empty() {
        return None;
    }
    let role = match message.author.as_ref()?.role.as_deref()? {
        "user" => Role::User,
        "assistant" => {
            if message
                .channel
                .as_deref()
                .is_some_and(|channel| !matches!(channel, "final" | "commentary"))
                || message
                    .recipient
                    .as_deref()
                    .is_some_and(|recipient| recipient != "all")
            {
                return None;
            }
            Role::Assistant
        }
        _ => return None,
    };
    let content = message.content.as_ref();
    let text = content
        .and_then(|content| content.parts.as_ref())
        .map(|parts| parts.iter().map(Part::text).collect::<Vec<_>>().join("\n"))
        .or_else(|| content.and_then(|content| content.text.clone()))
        .unwrap_or_default()
        .trim()
        .to_owned();
    if text.is_empty() {
        return None;
    }
    Some(NormalizedMessage {
        id: id.to_owned(),
        role,
        text,
        create_time: message.create_time,
        model: message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.model_slug.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OBSERVED_SHAPE: &str =
        include_str!("../../../../../acceptance/native/chatgpt/conversation.json");

    #[test]
    fn follows_current_branch_and_filters_internal_assistant_messages() {
        let messages = normalize_conversation("chat-fixture-001", OBSERVED_SHAPE).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].text, "hello\nfrom object part");
        assert_eq!(messages[1].role, Role::Assistant);
        assert_eq!(messages[1].text, "fixture answer");
        assert_eq!(messages[1].model.as_deref(), Some("fixture-model"));
    }

    #[test]
    fn rejects_a_payload_for_another_conversation() {
        assert_eq!(
            normalize_conversation("different-chat", OBSERVED_SHAPE),
            Err(NormalizeError::ConversationMismatch)
        );
    }
}
