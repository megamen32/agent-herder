use std::{
    collections::HashSet,
    hash::{BuildHasher, RandomState},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::time::{sleep, timeout};

use super::{CdpError, ChatGptReadError, ChatGptReader, NormalizeError, NormalizedMessage};
use crate::adapters::browser::{
    BrowserActivity, BrowserAttachment, BrowserSubmitError, MAX_ATTACHMENT_BYTES, RecoveryInput,
    validate_attachments,
};

const NATIVE: &str = include_str!("native.js");
const READ: &str = include_str!("read.js");
const COMPOSER: &str = include_str!("composer.js");
const CANCEL: &str = include_str!("cancel.js");
const DOWNLOAD: &str = include_str!("download.js");
const ORIGIN: &str = "https://chatgpt.com";

pub(super) fn native_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn check_id(id: &str) -> Result<(), ChatGptReadError> {
    native_id(id)
        .then_some(())
        .ok_or(ChatGptReadError::InvalidResponse)
}

impl ChatGptReader {
    async fn native(&mut self, op: &str, mut args: Value) -> Result<Value, ChatGptReadError> {
        let operation = match op {
            "list" | "read" | "activity" | "recovery" => READ,
            "cancel" => CANCEL,
            "download" => DOWNLOAD,
            _ => COMPOSER,
        };
        args["op"] = json!(op);
        args["scope"] = json!(&self.account_scope);
        let expression = format!("/* herder.chatgpt.{op} */\n({NATIVE})({operation},\n{args})");
        let mut result = self
            .cdp
            .evaluate(&expression)
            .await
            .map_err(ChatGptReadError::Cdp)?;
        match result["origin"].as_str() {
            Some(ORIGIN) => {}
            Some(_) => return Err(ChatGptReadError::WrongOrigin),
            None => return Err(ChatGptReadError::InvalidResponse),
        }
        if result["error"] == "account" {
            return Err(ChatGptReadError::AccountMismatch);
        }
        match result["scope"].as_str() {
            Some(scope) if scope == self.account_scope => {}
            Some(_) => return Err(ChatGptReadError::AccountMismatch),
            None => return Err(ChatGptReadError::InvalidResponse),
        }
        match result["error"].as_str() {
            None => result
                .get_mut("value")
                .map(Value::take)
                .ok_or(ChatGptReadError::InvalidResponse),
            Some("provider") => Err(ChatGptReadError::ProviderStatus(
                result["status"]
                    .as_u64()
                    .and_then(|s| u16::try_from(s).ok())
                    .ok_or(ChatGptReadError::InvalidResponse)?,
            )),
            Some("identity") => Err(ChatGptReadError::Normalize(
                NormalizeError::ConversationMismatch,
            )),
            Some("mapping") => Err(ChatGptReadError::Normalize(NormalizeError::MissingMapping)),
            Some("missing") => Err(ChatGptReadError::ProviderStatus(404)),
            Some("context_too_large") => {
                Err(ChatGptReadError::Normalize(NormalizeError::ContextTooLarge))
            }
            Some("origin") => Err(ChatGptReadError::WrongOrigin),
            Some(_) => Err(ChatGptReadError::InvalidResponse),
        }
    }

    pub async fn list_native_ids(&mut self, limit: usize) -> Result<Vec<String>, ChatGptReadError> {
        let limit = limit.min(1000);
        let value = self.native("list", json!({"limit": limit})).await?;
        let ids: Vec<String> =
            serde_json::from_value(value).map_err(|_| ChatGptReadError::InvalidResponse)?;
        let mut seen = HashSet::new();
        if ids.len() > limit || ids.iter().any(|id| !native_id(id) || !seen.insert(id)) {
            return Err(ChatGptReadError::InvalidResponse);
        }
        Ok(ids)
    }

    pub async fn read_conversation(
        &mut self,
        id: &str,
    ) -> Result<Vec<NormalizedMessage>, ChatGptReadError> {
        check_id(id)?;
        let mut value = self.native("read", json!({"id": id})).await?;
        if value["id"].as_str() != Some(id) {
            return Err(ChatGptReadError::Normalize(
                NormalizeError::ConversationMismatch,
            ));
        }
        serde_json::from_value(value["messages"].take())
            .map_err(|_| ChatGptReadError::InvalidResponse)
    }

    pub async fn session_activity(
        &mut self,
        id: &str,
    ) -> Result<BrowserActivity, ChatGptReadError> {
        check_id(id)?;
        let value = self.native("activity", json!({"id": id})).await?;
        if value["id"].as_str() != Some(id) {
            return Err(ChatGptReadError::Normalize(
                NormalizeError::ConversationMismatch,
            ));
        }
        match value["activity"].as_str() {
            Some("idle") => Ok(BrowserActivity::Idle),
            Some("busy") => Ok(BrowserActivity::Busy),
            Some("unknown") => Ok(BrowserActivity::Unknown),
            _ => Err(ChatGptReadError::InvalidResponse),
        }
    }

    /// Return an exact, positively failed assistant node and its native user
    /// parent on the current conversation branch. Absence is not inferred.
    pub async fn recovery_boundary(
        &mut self,
        id: &str,
    ) -> Result<Option<Value>, ChatGptReadError> {
        check_id(id)?;
        let value = self.native("recovery", json!({"id": id})).await?;
        if value.is_null() {
            return Ok(None);
        }
        if value["id"].as_str() != Some(id)
            || value["status"].as_str() != Some("failed")
            || value["turnId"].as_str().is_none_or(|s| !native_id(s))
            || value["inputItemId"].as_str().is_none_or(|s| !native_id(s))
        {
            return Err(ChatGptReadError::InvalidResponse);
        }
        Ok(Some(value))
    }

    pub async fn cancel_turn(
        &mut self,
        remote: &str,
        input_message_id: &str,
    ) -> Result<bool, ChatGptReadError> {
        check_id(remote)?;
        check_id(input_message_id)?;
        let value = self
            .native(
                "cancel",
                json!({"id": remote, "inputMessageId": input_message_id}),
            )
            .await?;
        if value["id"].as_str() != Some(remote)
            || value["inputMessageId"].as_str() != Some(input_message_id)
        {
            return Err(ChatGptReadError::InvalidResponse);
        }
        value["stopped"]
            .as_bool()
            .ok_or(ChatGptReadError::InvalidResponse)
    }

    pub async fn read_attachment(
        &mut self,
        remote: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<BrowserAttachment, ChatGptReadError> {
        check_id(remote)?;
        check_id(message_id)?;
        check_id(attachment_id)?;
        let mut value = self.native("download", json!({
            "id": remote, "messageId": message_id, "attachmentId": attachment_id, "maxBytes": MAX_ATTACHMENT_BYTES
        })).await?;
        if value["id"].as_str() != Some(remote)
            || value["messageId"].as_str() != Some(message_id)
            || value["attachmentId"].as_str() != Some(attachment_id)
        {
            return Err(ChatGptReadError::InvalidResponse);
        }
        let file: BrowserAttachment = serde_json::from_value(value["attachment"].take())
            .map_err(|_| ChatGptReadError::InvalidResponse)?;
        file.validate()
            .map_err(|_| ChatGptReadError::InvalidResponse)?;
        Ok(file)
    }

    /// The initial blank target can be navigated once. An attached page
    /// (including an attached blank page) can never be repurposed.
    pub async fn open_conversation(&mut self, id: &str) -> Result<(), ChatGptReadError> {
        check_id(id)?;
        if !self.fresh_blank || !self.cdp.owns_target() {
            return Err(ChatGptReadError::InvalidResponse);
        }
        self.fresh_blank = false;
        match self.native("open", json!({"id": id})).await {
            Ok(Value::Bool(true)) | Err(ChatGptReadError::Cdp(CdpError::Protocol)) => {}
            Ok(_) => return Err(ChatGptReadError::InvalidResponse),
            Err(error) => return Err(error),
        }
        // location.assign can destroy the old evaluation context before
        // Chrome acknowledges it. Only observe the resulting navigation.
        let url = format!("{ORIGIN}/c/{id}");
        timeout(Duration::from_secs(8), async {
            loop {
                match self.cdp.evaluate("location.href").await {
                    Ok(value) if value.as_str() == Some(&url) => break,
                    Ok(value)
                        if matches!(
                            value.as_str(),
                            Some("about:blank" | "https://chatgpt.com/")
                        ) => {}
                    Err(CdpError::Protocol) => {}
                    Err(error) => return Err(ChatGptReadError::Cdp(error)),
                    Ok(_) => return Err(ChatGptReadError::InvalidResponse),
                }
                sleep(Duration::from_millis(100)).await;
            }
            if self.native("opened", json!({"id": id})).await? != true {
                return Err(ChatGptReadError::InvalidResponse);
            }
            Ok(())
        })
        .await
        .map_err(|_| ChatGptReadError::InvalidResponse)?
    }

    pub async fn submit_message(
        &mut self,
        conversation_id: Option<&str>,
        text: &str,
    ) -> Result<(String, String), BrowserSubmitError> {
        self.submit_with_attachments(conversation_id, text, &[])
            .await
    }

    pub async fn submit_with_attachments(
        &mut self,
        conversation_id: Option<&str>,
        text: &str,
        attachments: &[BrowserAttachment],
    ) -> Result<(String, String), BrowserSubmitError> {
        self.submit_guarded(conversation_id, text, attachments, None).await
    }

    pub(crate) async fn submit_guarded(
        &mut self,
        conversation_id: Option<&str>,
        text: &str,
        attachments: &[BrowserAttachment],
        recovery: Option<&RecoveryInput>,
    ) -> Result<(String, String), BrowserSubmitError> {
        use BrowserSubmitError::{BeforeSend, Unknown};
        if (text.trim().is_empty() && attachments.is_empty())
            || text.len() > 16_000
            || conversation_id.is_some_and(|id| !native_id(id))
            || (conversation_id.is_none() && !(self.fresh_blank && self.cdp.owns_target()))
            || (recovery.is_some() && (conversation_id.is_none() || !attachments.is_empty()))
        {
            return Err(BeforeSend);
        }
        validate_attachments(attachments).map_err(|_| BeforeSend)?;
        // Independent readers can share a Chrome target. Bind all stages to
        // this invocation, including two submissions with identical content.
        let ticket = RandomState::new().hash_one(()).to_string();
        let args = json!({"id": conversation_id, "text": text, "ticket": ticket, "recovery": recovery});
        let value = self
            .native("baseline", args.clone())
            .await
            .map_err(|_| BeforeSend)?;
        let before: Vec<String> = serde_json::from_value(value).map_err(|_| BeforeSend)?;
        if before.len() > 180
            || before.iter().any(|id| !native_id(id))
            || (conversation_id.is_none() && !before.is_empty())
        {
            return Err(BeforeSend);
        }
        let mut fill = args.clone();
        fill["attachments"] = json!(attachments);
        match self.native("fill", fill).await {
            Ok(Value::Bool(true)) => {}
            Ok(Value::String(status)) if status == "unknown" => {
                self.fresh_blank = false;
                return Err(Unknown);
            }
            _ => return Err(BeforeSend),
        }
        let fresh = self.fresh_blank;
        self.fresh_blank = false;
        match self.native("click", args).await {
            Ok(Value::Bool(true)) => {}
            Ok(Value::Bool(false))
            | Err(ChatGptReadError::WrongOrigin | ChatGptReadError::AccountMismatch) => {
                self.fresh_blank = fresh;
                return Err(BeforeSend);
            }
            _ => return Err(Unknown),
        }
        // Every remaining operation is read-only, including after an
        // ambiguous acknowledgment. Never issue a second click.
        timeout(Duration::from_secs(10), async {
            let mut observed = conversation_id.map(str::to_owned);
            for attempt in 0..7 {
                if attempt != 0 {
                    sleep(Duration::from_millis(200 * attempt)).await;
                }
                let value = self.native("receipt", json!({
                    "id": conversation_id, "observedId": observed, "before": before, "text": text, "ticket": ticket,
                })).await.map_err(|_| Unknown)?;
                match value.get("id") {
                    Some(Value::String(id))
                        if native_id(id) && observed.as_ref().is_none_or(|old| old == id) =>
                    {
                        observed = Some(id.clone());
                    }
                    Some(Value::Null) if observed.is_none() => {}
                    _ => return Err(Unknown),
                }
                match value.get("messageId") {
                    Some(Value::String(id)) if native_id(id) && !before.contains(id) => {
                        return Ok((observed.ok_or(Unknown)?, id.clone()));
                    }
                    Some(Value::Null) => {}
                    _ => return Err(Unknown),
                }
            }
            Err(Unknown)
        })
        .await
        .unwrap_or(Err(Unknown))
    }
}
