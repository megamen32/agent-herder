//! Pure projection of the latest messages already selected by a native reader.
//!
//! The reader owns recency: this module does not infer ordering from timestamps,
//! turn identifiers, or the position of messages in a transcript.

/// Metadata supplied by the source for one message. Missing metadata stays unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMessage {
    pub text: String,
    pub turn_id: Option<String>,
    /// Source-provided timestamp, preserved without parsing or interpretation.
    pub time: Option<String>,
    /// Whether the source reports the message as incomplete; `None` means unknown.
    pub partial: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMessage {
    pub text: String,
    pub turn_id: Option<String>,
    pub time: Option<String>,
    pub partial: Option<bool>,
}

/// Independent role slots; neither slot implies a reply to the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMessages {
    pub user: Option<RecentMessage>,
    pub assistant: Option<RecentMessage>,
}

impl From<SourceMessage> for RecentMessage {
    fn from(message: SourceMessage) -> Self {
        Self {
            text: message.text,
            turn_id: message.turn_id,
            time: message.time,
            partial: message.partial,
        }
    }
}

/// Normalize source-selected latest messages without I/O or invented ordering.
pub fn normalize_recent(
    latest_user: Option<SourceMessage>,
    latest_assistant: Option<SourceMessage>,
) -> RecentMessages {
    RecentMessages {
        user: latest_user.map(Into::into),
        assistant: latest_assistant.map(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_independent_roles_and_source_metadata_without_reordering() {
        let user = SourceMessage {
            text: "new input".into(),
            turn_id: Some("turn-2".into()),
            time: Some("2026-11-07T12:00:00Z".into()),
            partial: Some(false),
        };
        let assistant = SourceMessage {
            text: "older response".into(),
            turn_id: Some("turn-1".into()),
            time: Some("2026-11-07T11:00:00Z".into()),
            partial: Some(true),
        };
        let result = normalize_recent(Some(user.clone()), Some(assistant.clone()));
        assert_eq!(result.user, Some(user.into()));
        assert_eq!(result.assistant, Some(assistant.into()));
    }

    #[test]
    fn preserves_missing_roles_and_unknown_metadata() {
        let message = SourceMessage {
            text: String::new(),
            turn_id: None,
            time: None,
            partial: None,
        };
        assert_eq!(
            normalize_recent(None, Some(message.clone())),
            RecentMessages {
                user: None,
                assistant: Some(message.into())
            }
        );
        assert_eq!(
            normalize_recent(None, None),
            RecentMessages {
                user: None,
                assistant: None
            }
        );
    }
}
