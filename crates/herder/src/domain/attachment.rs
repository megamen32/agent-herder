use base64::{Engine, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Leave space for base64, metadata and JSON-RPC framing under AHAP's 4 MiB limit.
pub const MAX_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 16;

/// Matches the web composer's ECMAScript String.trim() check.
pub(crate) fn has_browser_caption(text: &str) -> bool {
    text.chars()
        .any(|c| c != '\u{feff}' && (!c.is_whitespace() || c == '\u{85}'))
}

/// A file transferred inline. Each input supports up to 16 files totalling 2 MiB.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InlineAttachment {
    /// Filename as shown in the chat, without directory components.
    pub name: String,
    /// Media type such as image/png or application/octet-stream.
    pub mime_type: String,
    /// Original bytes in standard padded base64.
    pub data_base64: String,
}

impl std::fmt::Debug for InlineAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InlineAttachment")
            .field("name", &self.name)
            .field("mime_type", &self.mime_type)
            .field("base64_length", &self.data_base64.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentMetadata {
    /// Provider reference, meaningful only in the addressed conversation and message.
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// Some providers mark an asset as an image before its MIME type is known.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub image: bool,
}

fn mime_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'+-.^_`|~".contains(&b))
}

impl InlineAttachment {
    fn decoded_len(&self, remaining: usize) -> Result<usize, &'static str> {
        if self.name.len() > 255
            || self.name.trim().is_empty()
            || matches!(self.name.as_str(), "." | "..")
            || self.name.contains(['/', '\\'])
            || self.name.chars().any(char::is_control)
        {
            return Err("invalid attachment filename");
        }
        if self.mime_type.len() > 255
            || !self
                .mime_type
                .split_once('/')
                .is_some_and(|(top, sub)| mime_token(top) && mime_token(sub))
        {
            return Err("invalid attachment MIME type");
        }
        if self.data_base64.len() > remaining.div_ceil(3) * 4 {
            return Err("attachment byte limit exceeded");
        }
        let bytes = STANDARD
            .decode(&self.data_base64)
            .map_err(|_| "invalid attachment base64")?;
        if bytes.len() > remaining {
            return Err("attachment byte limit exceeded");
        }
        Ok(bytes.len())
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.decoded_len(MAX_ATTACHMENT_BYTES).map(|_| ())
    }
}

pub fn validate_attachments(files: &[InlineAttachment]) -> Result<(), &'static str> {
    if files.len() > MAX_ATTACHMENTS {
        return Err("too many attachments");
    }
    files
        .iter()
        .try_fold(MAX_ATTACHMENT_BYTES, |remaining, file| {
            file.decoded_len(remaining).map(|size| remaining - size)
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(data: &[u8]) -> InlineAttachment {
        InlineAttachment {
            name: "отчёт.bin".into(),
            mime_type: "application/octet-stream".into(),
            data_base64: STANDARD.encode(data),
        }
    }

    #[test]
    fn checks_canonical_bytes_aggregate_budget_and_metadata() {
        let large = file(&vec![0xff; MAX_ATTACHMENT_BYTES]);
        assert!(validate_attachments(&[large.clone(), file(b"")]).is_ok());
        assert!(validate_attachments(&[large, file(&[0])]).is_err());
        assert!(validate_attachments(&vec![file(b""); MAX_ATTACHMENTS + 1]).is_err());
        assert!(
            InlineAttachment {
                data_base64: "a!".into(),
                ..file(b"")
            }
            .validate()
            .is_err()
        );
        assert!(
            InlineAttachment {
                name: "../test".into(),
                ..file(b"")
            }
            .validate()
            .is_err()
        );
        assert!(
            InlineAttachment {
                mime_type: "image/png\r\nx".into(),
                ..file(b"")
            }
            .validate()
            .is_err()
        );
    }
}
