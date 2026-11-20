//! Rust side of the scoped Z.ai page operations and the one-click boundary.

use super::{ZaiReadError, ZaiReader, valid_chat_id};
use crate::adapters::browser::{BrowserActivity, BrowserSubmitError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const PAGE: &str = include_str!("page.js");

pub(super) fn expression(op: &str, scope: Option<&str>, args: Value) -> String {
    let args = json!({"op": op, "expected": scope, "args": args});
    format!("({PAGE})({args})")
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
        use BrowserSubmitError::{BeforeSend, Unknown};
        if text.trim().is_empty()
            || text.len() > 8_000
            || conversation_id.is_none() && !(self.cdp.owns_target() && self.fresh_blank)
        {
            return Err(BeforeSend);
        }
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
        // From dispatch of this evaluation onward only an explicit pre-click refusal
        // is replay-safe. Every subsequent evaluation is read-only.
        self.fresh_blank = false;
        let params = json!({"ticket":prepared.ticket, "text":text});
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
        let mut chat_id = conversation_id.map(str::to_owned);
        // The page retains the pre-click ID fingerprint and the set of already
        // listed chats. Only the bounded receipt and its exact IDs cross CDP.
        let readback = async {
            loop {
                let value = self
                    .native_read(
                        "receipt",
                        chat_id.as_deref(),
                        json!({"ticket":prepared.ticket, "text":text}),
                    )
                    .await
                    .map_err(|_| Unknown)?;
                if let Some(id) = value.get("chat_id").and_then(Value::as_str) {
                    if !valid_chat_id(id) {
                        return Err(Unknown);
                    }
                    chat_id = Some(id.to_owned());
                }
                if let Some(id) = value.get("user_message_id").and_then(Value::as_str) {
                    if !valid_message_id(id) {
                        return Err(Unknown);
                    }
                    return Ok((chat_id.ok_or(Unknown)?, id.to_owned()));
                }
                if value.get("pending").and_then(Value::as_bool) != Some(true) {
                    return Err(Unknown);
                }
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(12), readback)
            .await
            .map_err(|_| Unknown)?
    }
}
