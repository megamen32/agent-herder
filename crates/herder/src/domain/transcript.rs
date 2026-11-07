//! Lossless provenance for normalized, user-visible transcript blocks.
//!
//! This module is a pure projection: callers classify native block kinds, and
//! each projected block retains its exact session/message/block location.
use serde::{Deserialize, Serialize};

use super::address::SessionAddress;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptSourceRef {
    pub session: SessionAddress,
    pub message_id: String,
    /// Preserved only when the native source supplied it.
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptBlockKind {
    Text,
    Image,
    Audio,
    ToolCall,
    ToolResult,
    Reasoning,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptBlock {
    pub kind: TranscriptBlockKind,
    /// Text is populated only for explicitly classified text blocks.
    pub text: Option<String>,
    pub source: TranscriptSourceRef,
    /// Index in a native block array, absent for a message-level field.
    pub block_index: Option<u32>,
    /// Exact native type label, absent when the provider supplied none.
    pub native_type: Option<String>,
    /// Native message field, such as `content`, when this was not an array block.
    pub source_field: Option<String>,
}

/// Pagination cursor bound to trusted caller identity and one immutable snapshot.
/// The native cursor remains opaque; its contents are never parsed or rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoundTranscriptCursor {
    pub principal_id: String,
    pub snapshot_id: String,
    pub native_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorBindingError {
    EmptyPrincipal,
    EmptySnapshot,
    PrincipalMismatch,
    SnapshotMismatch,
    EmptyNativeCursor,
}

impl BoundTranscriptCursor {
    /// Bind a native cursor using principal identity from the trusted auth boundary
    /// and a stable snapshot identifier produced by the transcript reader.
    pub fn bind(
        principal_id: &str,
        snapshot_id: &str,
        native_cursor: Option<String>,
    ) -> Result<Self, CursorBindingError> {
        if principal_id.is_empty() {
            return Err(CursorBindingError::EmptyPrincipal);
        }
        if snapshot_id.is_empty() {
            return Err(CursorBindingError::EmptySnapshot);
        }
        if native_cursor.as_deref() == Some("") {
            return Err(CursorBindingError::EmptyNativeCursor);
        }
        Ok(Self {
            principal_id: principal_id.into(),
            snapshot_id: snapshot_id.into(),
            native_cursor,
        })
    }

    /// Validate the cursor against the authenticated principal and current snapshot.
    pub fn validate(
        &self,
        principal_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<&str>, CursorBindingError> {
        if self.principal_id != principal_id {
            return Err(CursorBindingError::PrincipalMismatch);
        }
        if self.snapshot_id != snapshot_id {
            return Err(CursorBindingError::SnapshotMismatch);
        }
        Ok(self.native_cursor.as_deref())
    }
}

/// One page within a fixed transcript snapshot. `next_cursor == None` is the
/// terminal page; truncation is preserved separately from page completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptPage {
    pub snapshot_id: String,
    pub blocks: Vec<TranscriptBlock>,
    pub next_cursor: Option<BoundTranscriptCursor>,
    pub truncated: bool,
}

impl TranscriptPage {
    pub fn new(
        principal_id: &str,
        snapshot_id: &str,
        blocks: Vec<TranscriptBlock>,
        native_next_cursor: Option<String>,
        truncated: bool,
    ) -> Result<Self, CursorBindingError> {
        if snapshot_id.is_empty() {
            return Err(CursorBindingError::EmptySnapshot);
        }
        let next_cursor = native_next_cursor
            .map(|cursor| BoundTranscriptCursor::bind(principal_id, snapshot_id, Some(cursor)))
            .transpose()?;
        Ok(Self {
            snapshot_id: snapshot_id.into(),
            blocks,
            next_cursor,
            truncated,
        })
    }

    pub fn is_complete(&self) -> bool {
        self.next_cursor.is_none()
    }

    pub fn native_cursor_for(
        &self,
        principal_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<&str>, CursorBindingError> {
        if self.snapshot_id != snapshot_id {
            return Err(CursorBindingError::SnapshotMismatch);
        }
        self.next_cursor
            .as_ref()
            .map(|cursor| cursor.validate(principal_id, snapshot_id))
            .transpose()
            .map(Option::flatten)
    }
}

/// Input to the projection after a harness reader has decoded native blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTranscriptBlock {
    pub native_type: String,
    /// Content exposed as text by the native decoder, if any.
    pub text: Option<String>,
}

/// Project decoded native blocks in source order without inventing identifiers.
pub fn normalize_transcript_blocks(
    source: &TranscriptSourceRef,
    blocks: impl IntoIterator<Item = RawTranscriptBlock>,
) -> Vec<TranscriptBlock> {
    blocks
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let kind = match raw.native_type.as_str() {
                "text" | "markdown" | "input_text" | "output_text" | "inputText" | "outputText" => {
                    TranscriptBlockKind::Text
                }
                "image" | "input_image" | "output_image" => TranscriptBlockKind::Image,
                "audio" | "input_audio" | "output_audio" => TranscriptBlockKind::Audio,
                "tool_call" | "toolCall" | "tool_use" => TranscriptBlockKind::ToolCall,
                "tool_result" | "toolResult" | "tool_output" => TranscriptBlockKind::ToolResult,
                "reasoning" | "thinking" => TranscriptBlockKind::Reasoning,
                _ => TranscriptBlockKind::Other,
            };
            let text = matches!(kind, TranscriptBlockKind::Text)
                .then_some(raw.text)
                .flatten();
            TranscriptBlock {
                kind,
                text,
                source: source.clone(),
                block_index: Some(index as u32),
                native_type: Some(raw.native_type),
                source_field: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::{InstanceRef, NodeRef};

    fn source(message_id: &str, turn_id: Option<&str>) -> TranscriptSourceRef {
        TranscriptSourceRef {
            session: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("fixture-node".into()),
                    instance_id: "fixture-instance".into(),
                },
                native_session_id: "ses_e4c5afe46ffegA4WFmXjGvF9xS".into(),
            },
            message_id: message_id.into(),
            turn_id: turn_id.map(str::to_owned),
        }
    }

    #[test]
    fn plain_message_content_retains_text_without_fabricated_block_metadata() {
        let raw = serde_json::json!({"kind":"text","text":"hello", "source":source("msg",None), "block_index":null,"native_type":null,"source_field":"content"});
        let block: TranscriptBlock =
            serde_json::from_value(raw.clone()).expect("plain message field must be representable");
        assert_eq!(serde_json::to_value(block).unwrap(), raw);
    }

    #[test]
    fn opencode_native_message_id_is_preserved_per_block() {
        let blocks = normalize_transcript_blocks(
            &source("msg_1b3a66ec3001qxRDmdN2DXIlDE", None),
            [RawTranscriptBlock {
                native_type: "text".into(),
                text: Some(r#""V061B unique input id v061b-input-20261107-5e7429b5: reply with the exact marker only""#.into()),
            }],
        );
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, TranscriptBlockKind::Text);
        assert_eq!(
            blocks[0].text.as_deref(),
            Some(
                r#""V061B unique input id v061b-input-20261107-5e7429b5: reply with the exact marker only""#
            )
        );
        assert_eq!(
            blocks[0].source.message_id,
            "msg_1b3a66ec3001qxRDmdN2DXIlDE"
        );
        assert_eq!(blocks[0].source.turn_id, None);
        assert_eq!(blocks[0].block_index, Some(0));
    }

    #[test]
    fn opencode_native_blocks_keep_order_and_do_not_infer_turn_refs() {
        let blocks = normalize_transcript_blocks(
            &source("msg_1b3a670a9001Z40JO1l9YfPKHo", None),
            [
                RawTranscriptBlock {
                    native_type: "text".into(),
                    text: Some("HERDER_TEST_MODEL_OK".into()),
                },
                RawTranscriptBlock {
                    native_type: "image".into(),
                    text: Some("not exposed".into()),
                },
                RawTranscriptBlock {
                    native_type: "vendor_block_v7".into(),
                    text: Some("opaque".into()),
                },
            ],
        );
        assert_eq!(
            blocks.iter().map(|b| b.block_index).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2)]
        );
        assert_eq!(
            blocks[0].source.message_id,
            "msg_1b3a670a9001Z40JO1l9YfPKHo"
        );
        assert_eq!(blocks[0].text.as_deref(), Some("HERDER_TEST_MODEL_OK"));
        assert_eq!(blocks[1].kind, TranscriptBlockKind::Image);
        assert_eq!(blocks[1].text, None);
        assert_eq!(blocks[2].kind, TranscriptBlockKind::Other);
        assert_eq!(blocks[2].native_type.as_deref(), Some("vendor_block_v7"));
        assert_eq!(blocks[2].text, None);
        assert_eq!(blocks[0].source.turn_id, None);
    }

    #[test]
    fn bound_cursor_round_trips_and_rejects_other_principal_or_snapshot() {
        let cursor = BoundTranscriptCursor::bind(
            "principal-alice",
            "snapshot-2026-11-07T08:00Z",
            Some("opaque-native-cursor".into()),
        )
        .unwrap();
        let encoded = serde_json::to_string(&cursor).unwrap();
        let decoded: BoundTranscriptCursor = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            decoded.validate("principal-alice", "snapshot-2026-11-07T08:00Z"),
            Ok(Some("opaque-native-cursor"))
        );
        assert_eq!(
            decoded.validate("principal-bob", "snapshot-2026-11-07T08:00Z"),
            Err(CursorBindingError::PrincipalMismatch)
        );
        assert_eq!(
            decoded.validate("principal-alice", "snapshot-next"),
            Err(CursorBindingError::SnapshotMismatch)
        );
    }

    #[test]
    fn cursor_binding_requires_nonempty_verified_context() {
        assert_eq!(
            BoundTranscriptCursor::bind("", "snapshot", None),
            Err(CursorBindingError::EmptyPrincipal)
        );
        assert_eq!(
            BoundTranscriptCursor::bind("principal", "", None),
            Err(CursorBindingError::EmptySnapshot)
        );
        assert_eq!(
            BoundTranscriptCursor::bind("principal", "snapshot", Some(String::new())),
            Err(CursorBindingError::EmptyNativeCursor)
        );
    }

    #[test]
    fn codex_native_fixture_ids_and_turn_are_preserved_without_reply_inference() {
        let mut user_source = source(
            "01a1b3a1-b343-7640-9ace-e878747ae1da",
            Some("01a1b3a1-b2aa-7512-a959-b40be3fabdce"),
        );
        user_source.session.native_session_id = "01a1b3a1-b283-7b40-bb72-83d7f28155aa".into();
        let user = normalize_transcript_blocks(
            &user_source,
            [RawTranscriptBlock {
                native_type: "text".into(),
                text: Some("HERDER_V052B_INPUT_b59ee6a20e8348f4aebcda762a81144b".into()),
            }],
        );
        let mut assistant_source =
            source("msg_test_1", Some("01a1b3a1-b2aa-7512-a959-b40be3fabdce"));
        assistant_source.session.native_session_id = user_source.session.native_session_id.clone();
        let assistant = normalize_transcript_blocks(
            &assistant_source,
            [RawTranscriptBlock {
                native_type: "output_text".into(),
                text: Some("HERDER_TEST_MODEL_OK".into()),
            }],
        );
        assert_eq!(
            user[0].source.message_id,
            "01a1b3a1-b343-7640-9ace-e878747ae1da"
        );
        assert_eq!(assistant[0].source.message_id, "msg_test_1");
        assert_eq!(user[0].source.turn_id, assistant[0].source.turn_id);
        assert_eq!(
            user[0].text.as_deref(),
            Some("HERDER_V052B_INPUT_b59ee6a20e8348f4aebcda762a81144b")
        );
        assert_eq!(assistant[0].text.as_deref(), Some("HERDER_TEST_MODEL_OK"));
    }

    #[test]
    fn final_page_has_no_cursor_and_preserves_truncation_independently() {
        let partial = TranscriptPage::new(
            "alice",
            "snap-1",
            vec![],
            Some("native-page-2".into()),
            true,
        )
        .unwrap();
        assert!(!partial.is_complete());
        assert!(partial.truncated);
        assert_eq!(
            partial.native_cursor_for("alice", "snap-1"),
            Ok(Some("native-page-2"))
        );
        assert_eq!(
            partial.native_cursor_for("bob", "snap-1"),
            Err(CursorBindingError::PrincipalMismatch)
        );
        assert_eq!(
            partial.native_cursor_for("alice", "snap-2"),
            Err(CursorBindingError::SnapshotMismatch)
        );
        let final_page = TranscriptPage::new("alice", "snap-1", vec![], None, true).unwrap();
        assert!(final_page.is_complete());
        assert!(final_page.truncated);
        assert_eq!(final_page.native_cursor_for("alice", "snap-1"), Ok(None));
    }

    #[test]
    fn source_ref_round_trips_without_synthesizing_message_identity() {
        let source = source("native-message-001", None);
        let decoded: TranscriptSourceRef =
            serde_json::from_str(&serde_json::to_string(&source).unwrap()).unwrap();
        assert_eq!(decoded, source);
    }
}
