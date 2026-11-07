//! Typed projection of Z.ai messages/batch responses into Herder messages.
//!
//! This module performs no network or profile access. The caller supplies the
//! expected chat id and requested message ids; payload identity is checked
//! before messages are returned.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    InvalidPayload,
    ChatMismatch,
}

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
        .filter_map(|id| data.get(*id).and_then(|message| project_message(id, message)))
        .collect())
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

    const OBSERVED_SHAPE: &str =
        include_str!("../../../../../acceptance/native/z-ai/messages-batch.json");

    #[test]
    fn validates_chat_and_preserves_requested_order_and_text_blocks() {
        let messages = normalize_batch("chat-fixture-z-001", &["user-001", "assistant-001"], OBSERVED_SHAPE)
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
}
