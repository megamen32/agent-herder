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
    pub block_index: u32,
    /// Exact native type label, retained even when the normalized kind is Other.
    pub native_type: String,
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
                block_index: index as u32,
                native_type: raw.native_type,
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
        assert_eq!(blocks[0].block_index, 0);
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
            vec![0, 1, 2]
        );
        assert_eq!(
            blocks[0].source.message_id,
            "msg_1b3a670a9001Z40JO1l9YfPKHo"
        );
        assert_eq!(blocks[0].text.as_deref(), Some("HERDER_TEST_MODEL_OK"));
        assert_eq!(blocks[1].kind, TranscriptBlockKind::Image);
        assert_eq!(blocks[1].text, None);
        assert_eq!(blocks[2].kind, TranscriptBlockKind::Other);
        assert_eq!(blocks[2].native_type, "vendor_block_v7");
        assert_eq!(blocks[2].text, None);
        assert_eq!(blocks[0].source.turn_id, None);
    }

    #[test]
    fn source_ref_round_trips_without_synthesizing_message_identity() {
        let source = source("native-message-001", None);
        let decoded: TranscriptSourceRef =
            serde_json::from_str(&serde_json::to_string(&source).unwrap()).unwrap();
        assert_eq!(decoded, source);
    }
}
