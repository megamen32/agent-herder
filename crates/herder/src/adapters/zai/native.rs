//! Rust side of the scoped Z.ai page operations and the one-click boundary.

use super::{ZaiReadError, ZaiReader, valid_chat_id};
use crate::adapters::browser::{
    BrowserActivity, BrowserAttachment, BrowserSubmitError, MAX_ATTACHMENT_BYTES,
    validate_attachments,
};
use crate::domain::attachment::has_browser_caption;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const PAGE: &str = include_str!("page.js");
const FILES: &str = include_str!("files.js");
const STOP: &str = include_str!("stop.js");

pub(super) fn expression(op: &str, scope: Option<&str>, args: Value) -> String {
    let args = json!({"op": op, "expected": scope, "args": args, "maxBytes": MAX_ATTACHMENT_BYTES});
    format!("({PAGE})({args}, ({FILES}), ({STOP}))")
}

pub(super) fn verified_scope(value: &Value) -> Result<&str, ZaiReadError> {
    if value.get("origin").and_then(Value::as_str) != Some("https://chat.z.ai") {
        return Err(ZaiReadError::WrongOrigin);
    }
    if let Some(status) = value.get("status") {
        let status = status
            .as_u64()
            .and_then(|s| u16::try_from(s).ok())
            .ok_or(ZaiReadError::InvalidResponse)?;
        if status != 200 {
            return Err(ZaiReadError::ProviderStatus(status));
        }
    }
    match value.get("error").and_then(Value::as_str) {
        Some("account_mismatch" | "account_unverified") => {
            return Err(ZaiReadError::AccountMismatch);
        }
        Some(_) => return Err(ZaiReadError::InvalidResponse),
        None if value.get("error").is_some() => return Err(ZaiReadError::InvalidResponse),
        None => {}
    }
    value
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| {
            scope.len() == 64
                && scope.bytes().all(|b| b.is_ascii_hexdigit())
                && value.get("scope_verified") == Some(&Value::Bool(true))
        })
        .ok_or(ZaiReadError::AccountMismatch)
}

pub(super) fn verify_response(
    value: &Value,
    scope: &str,
    id: Option<&str>,
) -> Result<(), ZaiReadError> {
    if verified_scope(value)? != scope {
        return Err(ZaiReadError::AccountMismatch);
    }
    if let Some(id) = id
        && value.get("chat_id").and_then(Value::as_str) != Some(id)
    {
        return Err(ZaiReadError::InvalidResponse);
    }
    Ok(())
}

pub(super) fn valid_message_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
}

#[derive(Deserialize)]
struct Prepared {
    ticket: String,
}

impl ZaiReader {
    async fn eval_native(
        &mut self,
        op: &str,
        id: Option<&str>,
        params: Value,
    ) -> Result<Value, ZaiReadError> {
        if id.is_some_and(|id| !valid_chat_id(id)) {
            return Err(ZaiReadError::InvalidResponse);
        }
        let expression = expression(
            op,
            Some(&self.account_scope),
            json!({"id": id, "params": params}),
        );
        self.cdp
            .evaluate(&expression)
            .await
            .map_err(ZaiReadError::Cdp)
    }

    pub(super) async fn native_read(
        &mut self,
        op: &str,
        id: Option<&str>,
        params: Value,
    ) -> Result<Value, ZaiReadError> {
        let result = self.eval_native(op, id, params).await?;
        verify_response(&result, &self.account_scope, id)?;
        Ok(result)
    }

    pub async fn session_activity(&mut self, id: &str) -> Result<BrowserActivity, ZaiReadError> {
        let result = self.native_read("activity", Some(id), Value::Null).await?;
        Ok(match result.get("activity").and_then(Value::as_str) {
            Some("idle") => BrowserActivity::Idle,
            Some("busy") => BrowserActivity::Busy,
            _ => BrowserActivity::Unknown,
        })
    }

    pub async fn recovery_boundary(&mut self, id: &str) -> Result<Option<Value>, ZaiReadError> {
        let value = self.native_read("recovery", Some(id), Value::Null).await?;
        if value.is_null() || value["available"] == false {
            return Ok(None);
        }
        if value["chat_id"].as_str() != Some(id)
            || value["status"].as_str() != Some("failed")
            || value["turn_id"].as_str().is_none_or(|s| !valid_message_id(s))
            || value["input_item_id"].as_str().is_none_or(|s| !valid_message_id(s))
        {
            return Err(ZaiReadError::InvalidResponse);
        }
        Ok(Some(value))
    }

    pub async fn cancel_turn(
        &mut self,
        remote: &str,
        input_message_id: &str,
    ) -> Result<bool, ZaiReadError> {
        if !valid_message_id(input_message_id) {
            return Err(ZaiReadError::InvalidResponse);
        }
        let result = self
            .native_read("cancel", Some(remote), json!({"input": input_message_id}))
            .await?;
        if result["input"].as_str() != Some(input_message_id) {
            return Err(ZaiReadError::InvalidResponse);
        }
        result["cancelled"]
            .as_bool()
            .ok_or(ZaiReadError::InvalidResponse)
    }

    pub async fn read_attachment(
        &mut self,
        remote: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<BrowserAttachment, ZaiReadError> {
        if !valid_message_id(message_id) || !valid_message_id(attachment_id) {
            return Err(ZaiReadError::InvalidResponse);
        }
        let mut result = self
            .native_read(
                "attachment",
                Some(remote),
                json!({"message": message_id, "file": attachment_id}),
            )
            .await?;
        if result["message"].as_str() != Some(message_id)
            || result["file"].as_str() != Some(attachment_id)
        {
            return Err(ZaiReadError::InvalidResponse);
        }
        let attachment: BrowserAttachment = serde_json::from_value(result["attachment"].take())
            .map_err(|_| ZaiReadError::InvalidResponse)?;
        attachment
            .validate()
            .map_err(|_| ZaiReadError::InvalidResponse)?;
        Ok(attachment)
    }

    // Only newly owned blank targets can be hydrating. Retry the read-only
    // observation, never a router action, input event or click.
    async fn wait_for_blank(&mut self) -> Result<(), ZaiReadError> {
        let observe = async {
            loop {
                let value = self.native_read("blank", None, Value::Null).await?;
                match value["ready"].as_bool() {
                    Some(true) => return Ok(()),
                    Some(false) => tokio::time::sleep(Duration::from_millis(100)).await,
                    None => return Err(ZaiReadError::InvalidResponse),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(3), observe)
            .await
            .unwrap_or(Err(ZaiReadError::InvalidResponse))
    }

    pub async fn open_conversation(&mut self, id: &str) -> Result<(), ZaiReadError> {
        if !self.cdp.owns_target() || !self.fresh_blank || !valid_chat_id(id) {
            return Err(ZaiReadError::InvalidResponse);
        }
        self.wait_for_blank().await?;
        // A lost router reply can still mean the target has left its blank route.
        self.fresh_blank = false;
        let result = self.native_read("open", Some(id), Value::Null).await?;
        if result.get("path").and_then(Value::as_str) != Some(&format!("/c/{id}")) {
            return Err(ZaiReadError::InvalidResponse);
        }
        Ok(())
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
        self.submit_with_ticket(conversation_id, text, attachments, |_| Ok(()))
            .await
    }

    pub(crate) async fn submit_with_ticket(
        &mut self,
        conversation_id: Option<&str>,
        text: &str,
        attachments: &[BrowserAttachment],
        before_click: impl FnOnce(&str) -> Result<(), BrowserSubmitError>,
    ) -> Result<(String, String), BrowserSubmitError> {
        use BrowserSubmitError::{BeforeSend, Unknown};
        if text.len() > 8_000
            || !has_browser_caption(text)
            || conversation_id.is_none() && !(self.cdp.owns_target() && self.fresh_blank)
        {
            return Err(BeforeSend);
        }
        validate_attachments(attachments).map_err(|_| BeforeSend)?;
        if conversation_id.is_none() {
            self.wait_for_blank().await.map_err(|_| BeforeSend)?;
        }
        let value = self
            .native_read("prepare", conversation_id, Value::Null)
            .await
            .map_err(|_| BeforeSend)?;
        let prepared: Prepared = serde_json::from_value(value).map_err(|_| BeforeSend)?;
        if !valid_message_id(&prepared.ticket) {
            return Err(BeforeSend);
        }
        before_click(&prepared.ticket)?;
        // From dispatch of this evaluation onward only an explicit pre-click refusal
        // is replay-safe. Every subsequent evaluation is read-only.
        self.fresh_blank = false;
        let params = json!({"ticket":prepared.ticket, "text":text, "files":attachments});
        let value = self
            .eval_native("click", conversation_id, params)
            .await
            .map_err(|_| Unknown)?;
        match value.get("clicked").and_then(Value::as_bool) {
            Some(false) => return Err(BeforeSend),
            Some(true) => verify_response(&value, &self.account_scope, conversation_id)
                .map_err(|_| Unknown)?,
            None => return Err(Unknown),
        }
        let readback = async {
            loop {
                if let Some(receipt) = self
                    .read_submission(conversation_id, &prepared.ticket)
                    .await
                    .map_err(|_| Unknown)?
                {
                    return Ok(receipt);
                }
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
        };
        // New chats publish their route asynchronously. Beyond the inline
        // budget a public task read can check the saved ticket on this tab.
        let budget = if conversation_id.is_none() { 30 } else { 12 };
        tokio::time::timeout(Duration::from_secs(budget), readback)
            .await
            .map_err(|_| Unknown)?
    }

    pub(crate) async fn read_submission(
        &mut self,
        conversation_id: Option<&str>,
        ticket: &str,
    ) -> Result<Option<(String, String)>, ZaiReadError> {
        let value = self
            .native_read("receipt", conversation_id, json!({"ticket":ticket}))
            .await?;
        let route = value["chat_id"].as_str();
        if route.is_some_and(|id| !valid_chat_id(id)) {
            return Err(ZaiReadError::InvalidResponse);
        }
        match (route, value["user_message_id"].as_str()) {
            (Some(route), Some(message)) if valid_message_id(message) => {
                Ok(Some((route.to_owned(), message.to_owned())))
            }
            (_, None) if value["pending"] == true => Ok(None),
            _ => Err(ZaiReadError::InvalidResponse),
        }
    }
}
