//! ChatGPT operations on one account and Chrome target, and offline transcript projection.

mod native;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};

use super::browser::{BrowserAttachment, BrowserFile, page::PageConnection};
use super::cdp::{
    CdpConnection, CdpCreateError, CdpError, CdpTargetIdentity, create_page_target_with_origin_port,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct NormalizedMessage {
    pub id: String,
    pub role: Role,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<BrowserFile>,
    pub create_time: Option<f64>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(rename = "completionStatus", skip_serializing_if = "Option::is_none")]
    pub completion_status: Option<String>,
    #[serde(rename = "endTurn", skip_serializing_if = "Option::is_none")]
    pub end_turn: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    MissingConversationId,
    ConversationMismatch,
    MissingMapping,
    ContextTooLarge,
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

/// Authenticated adapter bound to one browser instance, context,
/// and page target. Auth data never leaves the selected Chrome page.
pub struct ChatGptReader {
    cdp: PageConnection,
    account_scope: String,
    fresh_blank: bool,
}

impl ChatGptReader {
    pub(crate) fn from_extension(cdp: PageConnection, scope: &str, fresh_blank: bool) -> Self {
        Self {
            cdp,
            account_scope: scope.to_owned(),
            fresh_blank,
        }
    }

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
            cdp: cdp.into(),
            account_scope: expected_account_scope.to_ascii_lowercase(),
            fresh_blank: true,
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
        if let Err(error) = reader.verify_account_pin().await {
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
        verify_chatgpt_scope(&mut cdp, &expected).await?;
        Ok(Self {
            cdp: cdp.into(),
            account_scope: expected,
            fresh_blank: false,
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
            cdp: cdp.into(),
            account_scope: expected_account_scope.to_ascii_lowercase(),
            fresh_blank: false,
        })
    }

    pub fn identity(&self) -> &CdpTargetIdentity {
        self.cdp.identity()
    }

    pub fn account_scope(&self) -> &str {
        &self.account_scope
    }

    pub(crate) async fn verify_account_pin(&mut self) -> Result<(), ChatGptReadError> {
        let result = self
            .cdp
            .site("account", Value::Null, || {
                CHATGPT_ACCOUNT_SCOPE_EXPRESSION.into()
            })
            .await
            .map_err(ChatGptReadError::Cdp)?;
        check_chatgpt_scope(&result, &self.account_scope)
    }

    pub(crate) fn connection_mut(&mut self) -> &mut PageConnection {
        &mut self.cdp
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
        use crate::adapters::browser::BrowserSubmitError;
        let (conversation_id, input_id) = self
            .submit_message(None, text)
            .await
            .map_err(|error| match error {
                BrowserSubmitError::BeforeSend => ChatGptSendError::Preflight,
                BrowserSubmitError::Unknown => ChatGptSendError::ResponseNotObserved {
                    conversation_id: None,
                },
            })?;
        for _ in 0..30 {
            match self.read_conversation(&conversation_id).await {
                Ok(messages) if response_seen(&messages, &input_id, expected_response_marker) => {
                    return Ok(ChatGptSendReceipt {
                        conversation_id,
                        expected_response_seen: true,
                    });
                }
                Ok(_) | Err(ChatGptReadError::ProviderStatus(404)) => {}
                Err(ChatGptReadError::Cdp(error)) => return Err(ChatGptSendError::Cdp(error)),
                Err(_) => break,
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        Err(ChatGptSendError::ResponseNotObserved {
            conversation_id: Some(conversation_id),
        })
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
    check_chatgpt_scope(&scope, expected_account_scope)
}

fn check_chatgpt_scope(
    scope: &Value,
    expected_account_scope: &str,
) -> Result<(), ChatGptReadError> {
    if scope.get("origin").and_then(Value::as_str) != Some("https://chatgpt.com") {
        return Err(ChatGptReadError::WrongOrigin);
    }
    let expected = expected_account_scope.to_ascii_lowercase();
    if !["scope", "userioScope"].iter().any(|key| scope.get(key).and_then(Value::as_str) == Some(expected.as_str())) {
        return Err(ChatGptReadError::AccountMismatch);
    }
    Ok(())
}

const CHATGPT_ACCOUNT_SCOPE_EXPRESSION: &str = concat!("(", include_str!("account.js"), ")()");

fn response_seen(messages: &[NormalizedMessage], input_id: &str, marker: &str) -> bool {
    let mut turn = messages.iter().skip_while(|m| m.id != input_id || m.role != Role::User);
    turn.next();
    turn.take_while(|m| m.role != Role::User)
        .any(|m| m.role == Role::Assistant && m.text.contains(marker))
}

#[derive(Debug, Deserialize)]
struct Conversation {
    conversation_id: Option<String>,
    current_node: Option<String>,
    mapping: Option<HashMap<String, Node>>,
    messages: Option<Vec<Message>>,
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
    status: Option<String>,
    end_turn: Option<bool>,
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
    is_visually_hidden_from_conversation: Option<bool>,
    attachments: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct Content {
    parts: Option<Vec<Value>>,
    text: Option<String>,
}

fn image_part(part: &Value) -> bool {
    matches!(
        part["content_type"].as_str(),
        Some("image" | "image_asset_pointer")
    )
}

fn part_text(part: &Value) -> &str {
    part.as_str()
        .or_else(|| part["text"].as_str())
        .or_else(|| part["content"].as_str())
        .unwrap_or_else(|| {
            if image_part(part) {
                "[Изображение]"
            } else {
                ""
            }
        })
}

fn project_files(message: &Message) -> Vec<BrowserFile> {
    let mut files = Vec::<BrowserFile>::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut add = |id: &str, raw: &Value, image: bool| {
        if !native::native_id(id) {
            return;
        }
        if let Some(&i) = positions.get(id) {
            files[i].image |= image;
            return;
        }
        let meta = &raw["metadata"];
        let name = [
            &raw["name"],
            &raw["filename"],
            &meta["name"],
            &meta["filename"],
        ]
        .into_iter()
        .find(|v| !v.is_null())
        .map_or(Some(id), Value::as_str);
        let mime = [
            &raw["mimeType"],
            &raw["mime_type"],
            &meta["mimeType"],
            &meta["mime_type"],
        ]
        .into_iter()
        .find(|v| !v.is_null())
        .map_or(Some("application/octet-stream"), Value::as_str);
        let (Some(name), Some(mime)) = (name, mime) else {
            return;
        };
        let metadata = BrowserAttachment {
            name: name.into(),
            mime_type: mime.into(),
            data_base64: String::new(),
        };
        if metadata.validate().is_ok() {
            positions.insert(id.to_owned(), files.len());
            files.push(BrowserFile {
                id: id.into(),
                name: metadata.name,
                mime_type: metadata.mime_type,
                image,
            });
        }
    };
    if let Some(records) = message
        .metadata
        .as_ref()
        .and_then(|m| m.attachments.as_ref())
        .and_then(Value::as_array)
    {
        for raw in records {
            if let Some(id) = raw["id"].as_str().or_else(|| raw["file_id"].as_str()) {
                add(id, raw, false);
            }
        }
    }
    if let Some(parts) = message.content.as_ref().and_then(|c| c.parts.as_ref()) {
        for part in parts.iter().filter(|p| image_part(p)) {
            if let Some(id) = part["asset_pointer"].as_str().and_then(|pointer| {
                pointer
                    .strip_prefix("file-service://")
                    .or_else(|| pointer.strip_prefix("sediment://"))
            }) {
                add(id, part, true);
            }
        }
    }
    files
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
    let newest: Vec<_> = if let Some(messages) = &conversation.messages {
        messages.iter().rev().take(1024).collect()
    } else {
        let mapping = conversation.mapping.as_ref().ok_or(NormalizeError::MissingMapping)?;
        let mut cursor = conversation.current_node.as_deref();
        if cursor.is_none() && !mapping.is_empty() {
            // Older linear fixtures can omit current_node. A fork without
            // a selected tip has no unambiguous current conversation.
            let parents: std::collections::HashSet<_> = mapping.values().filter_map(|n| n.parent.as_deref()).collect();
            let mut leaves = mapping.keys().map(String::as_str).filter(|id| !parents.contains(id));
            cursor = Some(leaves.next().ok_or(NormalizeError::MissingMapping)?);
            if leaves.next().is_some() { return Err(NormalizeError::MissingMapping); }
        }
        let mut messages = Vec::new();
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if seen.len() == 1024 { break; }
            if !seen.insert(id) { return Err(NormalizeError::MissingMapping); }
            let node = mapping.get(id).ok_or(NormalizeError::MissingMapping)?;
            messages.extend(node.message.as_ref());
            cursor = node.parent.as_deref();
        }
        messages
    };
    let mut projected = newest.into_iter().filter_map(project_message).take(180).collect::<Vec<_>>();
    let mut used = 2;
    let budget = 512 * 1024;
    let mut latest = [false; 2];
    let mut keep = vec![false; projected.len()];
    let sizes: Vec<_> = projected.iter().map(|m| serde_json::to_vec(m).map(|v| v.len() + 1)
        .map_err(|_| NormalizeError::MissingMapping)).collect::<Result<_, _>>()?;
    for (index, message) in projected.iter().enumerate() {
        let slot = usize::from(message.role == Role::Assistant);
        if !latest[slot] {
            latest[slot] = true;
            keep[index] = true;
            used += sizes[index];
        }
    }
    if used > budget { return Err(NormalizeError::ContextTooLarge); }
    for (take, size) in keep.iter_mut().zip(sizes) {
        if *take { continue; }
        if used + size > budget { break; }
        used += size;
        *take = true;
    }
    let mut keep = keep.into_iter();
    projected.retain(|_| keep.next() == Some(true));
    projected.reverse();
    Ok(projected)
}

fn project_message(message: &Message) -> Option<NormalizedMessage> {
    let id = message.id.as_ref()?.trim();
    if id.is_empty()
        || message
            .metadata
            .as_ref()
            .and_then(|m| m.is_visually_hidden_from_conversation)
            == Some(true)
    {
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
        .map(|parts| parts.iter().map(part_text).collect::<Vec<_>>().join("\n"))
        .or_else(|| content.and_then(|content| content.text.clone()))
        .unwrap_or_default()
        .trim()
        .to_owned();
    let attachments = project_files(message);
    if text.is_empty() && attachments.is_empty() {
        return None;
    }
    Some(NormalizedMessage {
        id: id.to_owned(),
        role,
        text,
        attachments,
        create_time: message.create_time,
        phase: message.channel.clone(),
        completion_status: message.status.clone(),
        end_turn: message.end_turn,
        model: message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.model_slug.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    const OBSERVED_SHAPE: &str =
        include_str!("../../../../../acceptance/native/chatgpt/conversation.json");

    async fn fake_browser(
        listed_context: &str,
        verified_context: &str,
        inject_unmatched_replies: bool,
        disconnect_on_conversation: bool,
    ) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("ws://{address}/devtools/browser/chatgpt-fixture");
        let listed_context = listed_context.to_owned();
        let verified_context = verified_context.to_owned();
        let fixture = normalize_conversation("chat-fixture-001", OBSERVED_SHAPE).unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let mut requests = Vec::new();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let request: Value = serde_json::from_str(&text).unwrap();
                let id = request.get("id").and_then(Value::as_u64).unwrap();
                let method = request.get("method").and_then(Value::as_str).unwrap();
                requests.push(request.clone());
                let result = match method {
                    "Browser.getVersion" => serde_json::json!({"product":"Chrome/fixture"}),
                    "Target.getTargets" => serde_json::json!({"targetInfos":[
                        {"targetId":"neighbor-target","browserContextId":"neighbor-context","type":"page","url":"https://chatgpt.com/c/neighbor"},
                        {"targetId":"chatgpt-target","browserContextId":listed_context,"type":"page","url":"https://chatgpt.com/c/chat-fixture-001"}
                    ]}),
                    "Target.attachToTarget" => {
                        assert_eq!(
                            request.pointer("/params/targetId").and_then(Value::as_str),
                            Some("chatgpt-target")
                        );
                        assert_eq!(
                            request.pointer("/params/flatten").and_then(Value::as_bool),
                            Some(true)
                        );
                        serde_json::json!({"sessionId":"chatgpt-session"})
                    }
                    "Target.getTargetInfo" => serde_json::json!({"targetInfo":{
                        "targetId":"chatgpt-target","browserContextId":verified_context
                    }}),
                    "Runtime.evaluate" => {
                        let expression = request
                            .pointer("/params/expression")
                            .and_then(Value::as_str)
                            .unwrap();
                        if expression.starts_with("/* herder.chatgpt.read */") {
                            if disconnect_on_conversation {
                                socket.close(None).await.unwrap();
                                break;
                            }
                            serde_json::json!({"result":{"value":{
                                "origin":"https://chatgpt.com","scope":"a".repeat(64),
                                "value":{"id":"chat-fixture-001","messages":fixture}
                            }}})
                        } else {
                            assert!(expression.contains("/api/auth/session"));
                            serde_json::json!({"result":{"value":{
                                "origin":"https://chatgpt.com","scope":"a".repeat(64)
                            }}})
                        }
                    }
                    other => panic!("unexpected CDP method in read-only fixture: {other}"),
                };
                if inject_unmatched_replies {
                    socket
                        .send(Message::Text(
                            serde_json::json!({
                                "method":"Target.targetCreated","params":{}
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                    socket
                        .send(Message::Text(
                            serde_json::json!({
                                "id":id + 1000,"result":{}
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                }
                socket
                    .send(Message::Text(
                        serde_json::json!({"id":id,"result":result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            requests
        });
        (endpoint, task)
    }

    async fn fake_page_that_stalls() -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("ws://{address}/devtools/page/chatgpt-target");
        let task =
            tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                let mut requests = Vec::new();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    let id = request.get("id").and_then(Value::as_u64).unwrap();
                    let method = request
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_owned();
                    requests.push(request);
                    if method == "Target.getTargetInfo" {
                        socket.send(Message::Text(serde_json::json!({
                        "id":id,"result":{"targetInfo":{
                            "targetId":"chatgpt-target","browserContextId":"chatgpt-context"
                        }}
                    }).to_string().into())).await.unwrap();
                    } else if method != "Runtime.evaluate" {
                        panic!("unexpected page CDP method: {method}");
                    }
                    // Deliberately leave Runtime.evaluate unanswered; the client
                    // must time out once and must not retry the read.
                }
                requests
            });
        (endpoint, task)
    }

    fn fake_identity() -> CdpTargetIdentity {
        CdpTargetIdentity {
            node_id: "node-fixture".into(),
            instance_id: "instance-fixture".into(),
            browser_context_id: "chatgpt-context".into(),
            target_id: "chatgpt-target".into(),
        }
    }

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
    fn projects_files_and_pointer_only_images_without_following_text_links() {
        let data = serde_json::json!({"conversation_id":"chat", "messages":[
            {"id":"u", "author":{"role":"user"}, "metadata":{"attachments":[
                {"id":"file-bin", "name":"data.bin", "mimeType":"application/octet-stream"},
                {"id":"../host", "name":"bad", "mimeType":"text/plain"}]}},
            {"id":"a", "author":{"role":"assistant"},
             "metadata":{"attachments":[{"id":"file-image", "name":"render.webp", "mimeType":"image/webp"}]},
             "content":{"parts":[
                {"content_type":"image_asset_pointer", "asset_pointer":"file-service://file-image",
                 "metadata":{"filename":"render.webp", "mime_type":"image/webp"}},
                {"content_type":"image_asset_pointer", "asset_pointer":"sediment://file-unknown"},
                "[report](sandbox:/mnt/data/report.pdf)"]}},
            {"id":"hidden", "author":{"role":"assistant"}, "channel":"analysis",
             "metadata":{"attachments":[{"id":"private"}]}}
        ]});
        let rows = normalize_conversation("chat", &data.to_string()).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].text.is_empty());
        assert_eq!(rows[0].attachments.len(), 1);
        assert_eq!(rows[0].attachments[0].id, "file-bin");
        assert!(!rows[0].attachments[0].image);
        let files = &rows[1].attachments;
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "render.webp");
        assert_eq!(files[0].mime_type, "image/webp");
        assert!(files[0].image);
        assert_eq!(files[1].name, "file-unknown");
        assert_eq!(files[1].mime_type, "application/octet-stream");
        assert!(files[1].image);
    }

    #[test]
    fn rejects_a_payload_for_another_conversation() {
        assert_eq!(
            normalize_conversation("different-chat", OBSERVED_SHAPE),
            Err(NormalizeError::ConversationMismatch)
        );
    }

    #[tokio::test]
    async fn attaches_to_exact_context_and_reads_without_create_or_send() {
        let (endpoint, server) =
            fake_browser("chatgpt-context", "chatgpt-context", true, false).await;
        let mut reader =
            ChatGptReader::attach_via_browser(&endpoint, fake_identity(), &"a".repeat(64), None)
                .await
                .unwrap();
        assert_eq!(reader.identity(), &fake_identity());
        assert_eq!(reader.account_scope(), "a".repeat(64));

        let messages = reader.read_conversation("chat-fixture-001").await.unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].text, "hello\nfrom object part");
        assert_eq!(messages[1].role, Role::Assistant);
        assert_eq!(messages[1].text, "fixture answer");
        reader.close().await;

        let requests = server.await.unwrap();
        let methods = requests
            .iter()
            .filter_map(|request| request.get("method").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(methods.contains(&"Target.attachToTarget"));
        assert_eq!(
            methods
                .iter()
                .filter(|method| **method == "Runtime.evaluate")
                .count(),
            2
        );
        assert!(!methods.iter().any(|method| {
            method.starts_with("DOM.")
                || method.starts_with("Input.")
                || matches!(*method, "Target.createTarget" | "Target.closeTarget")
        }));
        assert!(
            requests
                .iter()
                .filter(|request| request.get("method").and_then(Value::as_str)
                    == Some("Runtime.evaluate"))
                .all(|request| request.get("sessionId").and_then(Value::as_str)
                    == Some("chatgpt-session"))
        );
    }

    #[tokio::test]
    async fn rejects_chatgpt_target_from_another_browser_context_before_page_read() {
        let (endpoint, server) =
            fake_browser("neighbor-context", "neighbor-context", false, false).await;
        let result =
            ChatGptReader::attach_via_browser(&endpoint, fake_identity(), &"a".repeat(64), None)
                .await;
        assert!(matches!(
            result,
            Err(ChatGptReadError::Cdp(CdpError::InvalidIdentity))
        ));
        let requests = server.await.unwrap();
        let methods = requests
            .iter()
            .filter_map(|request| request.get("method").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(!methods.contains(&"Target.attachToTarget"));
        assert!(!methods.contains(&"Runtime.evaluate"));
        assert!(!methods.contains(&"Target.createTarget"));
    }

    #[tokio::test]
    async fn read_disconnect_returns_unknown_without_replaying_conversation_fetch() {
        let (endpoint, server) =
            fake_browser("chatgpt-context", "chatgpt-context", false, true).await;
        let mut reader =
            ChatGptReader::attach_via_browser(&endpoint, fake_identity(), &"a".repeat(64), None)
                .await
                .unwrap();
        let result = reader.read_conversation("chat-fixture-001").await;
        reader.close().await;

        assert!(matches!(
            result,
            Err(ChatGptReadError::Cdp(CdpError::OutcomeUnknown { .. }))
        ));
        let requests = server.await.unwrap();
        let reads = requests
            .iter()
            .filter(|request| {
                request.get("method").and_then(Value::as_str) == Some("Runtime.evaluate")
                    && request
                        .pointer("/params/expression")
                        .and_then(Value::as_str)
                        .is_some_and(|expression| expression.starts_with("/* herder.chatgpt.read */"))
            })
            .count();
        assert_eq!(reads, 1);
        assert!(!requests.iter().any(|request| {
            request.get("method").and_then(Value::as_str) == Some("Target.createTarget")
        }));
    }

    #[tokio::test]
    async fn cdp_timeout_is_bound_to_one_request_id_and_is_not_retried() {
        let (endpoint, server) = fake_page_that_stalls().await;
        let mut connection = CdpConnection::connect_page_with_timeout(
            &endpoint,
            fake_identity(),
            Duration::from_millis(30),
        )
        .await
        .unwrap();
        let result = connection.evaluate("fake read that never returns").await;
        connection.close().await;

        let request_id = match result {
            Err(CdpError::OutcomeUnknown { request_id }) => request_id,
            other => panic!("expected request timeout, got {other:?}"),
        };
        let requests = server.await.unwrap();
        let reads = requests
            .iter()
            .filter(|request| {
                request.get("method").and_then(Value::as_str) == Some("Runtime.evaluate")
            })
            .collect::<Vec<_>>();
        assert_eq!(reads.len(), 1);
        assert_eq!(reads[0].get("id").and_then(Value::as_u64), Some(request_id));
    }
}
