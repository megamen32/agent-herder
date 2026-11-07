//! Typed projection of a ChatGPT conversation payload into Herder messages.
//!
//! This module performs no I/O and makes no claim that the caller is
//! authenticated. The expected conversation id must come from the selected
//! instance/profile adapter and is checked before any message is returned.

use serde::Deserialize;
use std::collections::HashMap;

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
