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
    /// Source-reported truncation, independent of partial; unknown stays unknown.
    pub truncated: Option<bool>,
    /// Native message identifier, if supplied by the source.
    pub message_id: Option<String>,
    /// Explicit source reference to the input this message answers.
    pub reply_to_input_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMessage {
    pub text: String,
    pub turn_id: Option<String>,
    pub time: Option<String>,
    pub partial: Option<bool>,
    /// Source-reported truncation, independent of partial; unknown stays unknown.
    pub truncated: Option<bool>,
    /// Native message identifier, if supplied by the source.
    pub message_id: Option<String>,
    /// Explicit source reference to the input this message answers.
    pub reply_to_input_id: Option<String>,
}

/// Independent role slots; neither slot implies a reply to the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMessages {
    pub user: Option<RecentMessage>,
    pub assistant: Option<RecentMessage>,
    /// Relation to the selected user message, known only from explicit source IDs.
    pub assistant_replies_to_user: Option<bool>,
}

impl From<SourceMessage> for RecentMessage {
    fn from(message: SourceMessage) -> Self {
        Self {
            text: message.text,
            turn_id: message.turn_id,
            time: message.time,
            partial: message.partial,
            truncated: message.truncated,
            message_id: message.message_id,
            reply_to_input_id: message.reply_to_input_id,
        }
    }
}

/// Project a source read without turning an unavailable source into an empty history.
/// The reader selects the latest messages and supplies its own error unchanged.
pub fn project_recent<E>(
    source: Result<(Option<SourceMessage>, Option<SourceMessage>), E>,
) -> Result<RecentMessages, E> {
    source.map(|(user, assistant)| normalize_recent(user, assistant))
}

/// Normalize source-selected latest messages without I/O or invented ordering.
pub fn normalize_recent(
    latest_user: Option<SourceMessage>,
    latest_assistant: Option<SourceMessage>,
) -> RecentMessages {
    let assistant_replies_to_user = latest_user
        .as_ref()
        .and_then(|user| user.message_id.as_deref())
        .filter(|id| !id.is_empty())
        .zip(
            latest_assistant
                .as_ref()
                .and_then(|assistant| assistant.reply_to_input_id.as_deref())
                .filter(|id| !id.is_empty()),
        )
        .map(|(user_id, reply_id)| user_id == reply_id);
    RecentMessages {
        assistant_replies_to_user,
        user: latest_user.map(Into::into),
        assistant: latest_assistant.map(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_source_is_not_an_empty_history() {
        let unavailable = project_recent::<&str>(Err("source unavailable"));
        assert_eq!(unavailable, Err("source unavailable"));
        let empty = project_recent::<&str>(Ok((None, None))).unwrap();
        assert_eq!(empty.user, None);
        assert_eq!(empty.assistant, None);
        assert_eq!(empty.assistant_replies_to_user, None);
    }

    #[test]
    fn explicit_source_link_and_truncation_are_preserved() {
        let user = SourceMessage {
            text: "input".into(),
            turn_id: None,
            time: None,
            partial: Some(false),
            truncated: Some(false),
            message_id: Some("u1".into()),
            reply_to_input_id: None,
        };
        let assistant = SourceMessage {
            text: "answer".into(),
            turn_id: None,
            time: None,
            partial: Some(true),
            truncated: Some(true),
            message_id: Some("a1".into()),
            reply_to_input_id: Some("u1".into()),
        };
        let result = project_recent::<&str>(Ok((Some(user), Some(assistant)))).unwrap();
        assert_eq!(result.assistant.as_ref().unwrap().truncated, Some(true));
        assert_eq!(result.assistant.as_ref().unwrap().partial, Some(true));
        assert_eq!(result.assistant_replies_to_user, Some(true));
    }

    #[test]
    fn never_infers_link_from_turn_time_or_absent_ids() {
        let make = |id: Option<&str>, reply: Option<&str>| SourceMessage {
            text: "text".into(),
            turn_id: Some("same".into()),
            time: Some("same".into()),
            partial: None,
            truncated: None,
            message_id: id.map(str::to_owned),
            reply_to_input_id: reply.map(str::to_owned),
        };
        assert_eq!(
            normalize_recent(Some(make(Some("u1"), None)), Some(make(None, Some("u2"))))
                .assistant_replies_to_user,
            Some(false)
        );
        assert_eq!(
            normalize_recent(Some(make(None, None)), Some(make(None, None)))
                .assistant_replies_to_user,
            None
        );
        assert_eq!(
            normalize_recent(Some(make(Some(""), None)), Some(make(None, Some(""))))
                .assistant_replies_to_user,
            None
        );
        assert_eq!(
            normalize_recent(None, Some(make(None, Some("u1")))).assistant_replies_to_user,
            None
        );
        assert_eq!(
            normalize_recent(Some(make(Some("u1"), None)), None).assistant_replies_to_user,
            None
        );
    }

    #[test]
    fn preserves_independent_roles_and_source_metadata_without_reordering() {
        let user = SourceMessage {
            text: "new input".into(),
            turn_id: Some("turn-2".into()),
            time: Some("2026-11-07T12:00:00Z".into()),
            partial: Some(false),
            truncated: None,
            message_id: None,
            reply_to_input_id: None,
        };
        let assistant = SourceMessage {
            text: "older response".into(),
            turn_id: Some("turn-1".into()),
            time: Some("2026-11-07T11:00:00Z".into()),
            partial: Some(true),
            truncated: None,
            message_id: None,
            reply_to_input_id: None,
        };
        let result =
            project_recent::<&str>(Ok((Some(user.clone()), Some(assistant.clone())))).unwrap();
        assert_eq!(result.user, Some(user.into()));
        assert_eq!(result.assistant, Some(assistant.into()));
        assert_eq!(result.assistant_replies_to_user, None);
    }

    #[test]
    fn preserves_missing_roles_and_unknown_metadata() {
        let message = SourceMessage {
            text: String::new(),
            turn_id: None,
            time: None,
            partial: None,
            truncated: None,
            message_id: None,
            reply_to_input_id: None,
        };
        assert_eq!(
            normalize_recent(None, Some(message.clone())),
            RecentMessages {
                user: None,
                assistant: Some(message.into()),
                assistant_replies_to_user: None,
            }
        );
        assert_eq!(
            normalize_recent(None, None),
            RecentMessages {
                user: None,
                assistant: None,
                assistant_replies_to_user: None,
            }
        );
    }
}
