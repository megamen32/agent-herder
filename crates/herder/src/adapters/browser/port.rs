use super::{
    BrowserActivity, BrowserAttachment, BrowserFile, BrowserSubmitError, Config, Provider,
    protocol::RpcError,
};
use crate::adapters::{
    cdp::CdpConnection,
    chatgpt::{ChatGptReadError, ChatGptReader, Role as ChatGptRole},
    zai::{Role as ZaiRole, ZaiReadError, ZaiReader},
};
use serde_json::{Value, json};

pub(super) enum Page {
    ChatGpt(ChatGptReader),
    Zai(ZaiReader),
}

impl From<ChatGptReadError> for RpcError {
    fn from(value: ChatGptReadError) -> Self {
        match value {
            ChatGptReadError::ProviderStatus(404) => Self::Missing,
            ChatGptReadError::AccountMismatch | ChatGptReadError::WrongOrigin => Self::Identity,
            _ => Self::Unavailable,
        }
    }
}

impl From<ZaiReadError> for RpcError {
    fn from(value: ZaiReadError) -> Self {
        match value {
            ZaiReadError::ProviderStatus(404) => Self::Missing,
            ZaiReadError::AccountMismatch | ZaiReadError::WrongOrigin => Self::Identity,
            _ => Self::Unavailable,
        }
    }
}

impl Page {
    pub(super) async fn attach(config: &Config, target: &str) -> Result<Self, RpcError> {
        let mut identity = config.identity.clone();
        identity.target_id = target.to_owned();
        let url = &config.endpoint;
        let scope = &config.scope;
        let port = config.origin_port;
        Ok(match config.provider {
            Provider::ChatGpt => {
                Self::ChatGpt(ChatGptReader::attach_via_browser(url, identity, scope, port).await?)
            }
            Provider::Zai => {
                Self::Zai(ZaiReader::attach_via_browser(url, identity, scope, port).await?)
            }
        })
    }

    pub(super) async fn create(config: &Config) -> Result<Self, RpcError> {
        let i = &config.identity;
        let url = &config.endpoint;
        let scope = &config.scope;
        let port = config.origin_port;
        Ok(match config.provider {
            Provider::ChatGpt => Self::ChatGpt(
                ChatGptReader::create_new_chat(
                    url,
                    &i.node_id,
                    &i.instance_id,
                    &i.browser_context_id,
                    scope,
                    port,
                )
                .await?,
            ),
            Provider::Zai => Self::Zai(
                ZaiReader::create_new_chat(
                    url,
                    &i.node_id,
                    &i.instance_id,
                    &i.browser_context_id,
                    scope,
                    port,
                )
                .await?,
            ),
        })
    }

    pub(super) fn target(&self) -> &str {
        match self {
            Self::ChatGpt(page) => &page.identity().target_id,
            Self::Zai(page) => &page.identity().target_id,
        }
    }

    fn connection(&mut self) -> &mut CdpConnection {
        match self {
            Self::ChatGpt(page) => page.connection_mut(),
            Self::Zai(page) => page.connection_mut(),
        }
    }

    pub(super) async fn verify_scope(&mut self, config: &Config) -> Result<(), RpcError> {
        let observed = match self {
            Self::ChatGpt(page) => {
                ChatGptReader::account_scope_for_target(page.connection_mut()).await?
            }
            Self::Zai(page) => ZaiReader::account_scope_for_target(page.connection_mut()).await?,
        };
        if observed == config.scope {
            Ok(())
        } else {
            Err(RpcError::Identity)
        }
    }

    pub(super) async fn on_route(
        &mut self,
        provider: Provider,
        id: &str,
    ) -> Result<bool, RpcError> {
        let location = self
            .connection()
            .evaluate("({origin:location.origin,path:location.pathname})")
            .await
            .map_err(|_| RpcError::Unavailable)?;
        if location["origin"].as_str() != Some(provider.origin()) {
            return Err(RpcError::Identity);
        }
        Ok(location["path"]
            .as_str()
            .and_then(|path| path.strip_prefix("/c/"))
            == Some(id))
    }

    /// Recover a pre-existing chat tab after the subprocess restarts. Never
    /// navigate a tab for cancellation or choose between duplicate chat tabs.
    pub(super) async fn existing_target(
        &mut self,
        config: &Config,
        remote: &str,
    ) -> Result<String, RpcError> {
        let route = format!("/c/{remote}");
        let targets = self
            .connection()
            .list_targets()
            .await
            .map_err(|_| RpcError::Unavailable)?;
        let mut matches = targets.into_iter().filter(|t| {
            t.target_type == "page"
                && t.browser_context_id.as_deref() == Some(&config.identity.browser_context_id)
                && reqwest::Url::parse(&t.url).is_ok_and(|u| {
                    u.origin().ascii_serialization() == config.provider.origin()
                        && u.path() == route
                })
        });
        let target = matches.next().ok_or(RpcError::Unavailable)?;
        if matches.next().is_some() {
            return Err(RpcError::Unavailable);
        }
        Ok(target.target_id)
    }

    pub(super) async fn open_conversation(&mut self, id: &str) -> Result<(), RpcError> {
        match self {
            Self::ChatGpt(page) => Ok(page.open_conversation(id).await?),
            Self::Zai(page) => Ok(page.open_conversation(id).await?),
        }
    }

    pub(super) async fn close_created(self) {
        match self {
            Self::ChatGpt(page) => page.close_created_chat().await,
            Self::Zai(page) => page.close_created_chat().await,
        }
    }

    pub(super) async fn list(&mut self, limit: usize) -> Result<Vec<String>, RpcError> {
        match self {
            Self::ChatGpt(page) => Ok(page.list_native_ids(limit).await?),
            Self::Zai(page) => Ok(page.list_native_ids(limit).await?),
        }
    }

    pub(super) async fn activity(&mut self, id: &str) -> Result<BrowserActivity, RpcError> {
        match self {
            Self::ChatGpt(page) => Ok(page.session_activity(id).await?),
            Self::Zai(page) => Ok(page.session_activity(id).await?),
        }
    }

    pub(super) async fn messages(
        &mut self,
        remote: &str,
        session: &str,
        limit: usize,
    ) -> Result<Value, RpcError> {
        let rows = match self {
            Self::ChatGpt(page) => {
                let rows = page.read_conversation(remote).await?;
                let skip = rows.len().saturating_sub(limit);
                rows.into_iter()
                    .skip(skip)
                    .map(|m| {
                        let role = match m.role {
                            ChatGptRole::User => "user",
                            ChatGptRole::Assistant => "assistant",
                        };
                        let mut row = message(session, m.id, role, m.text, m.model, m.attachments);
                        if let Some(t) = m.create_time.and_then(|s| {
                            chrono::DateTime::from_timestamp_millis((s * 1000.0) as i64)
                        }) {
                            row["timestamp"] = json!(t.to_rfc3339());
                        }
                        row
                    })
                    .collect()
            }
            Self::Zai(page) => {
                let rows = page.read_chat(remote).await?;
                let skip = rows.len().saturating_sub(limit);
                rows.into_iter()
                    .skip(skip)
                    .map(|m| {
                        let role = match m.role {
                            ZaiRole::User => "user",
                            ZaiRole::Assistant => "assistant",
                        };
                        let mut row = message(session, m.id, role, m.text, m.model, m.attachments);
                        if let Some(t) = m.timestamp {
                            row["nativeTimestamp"] = json!(t);
                        }
                        row
                    })
                    .collect()
            }
        };
        Ok(Value::Array(rows))
    }

    pub(super) async fn submit(
        &mut self,
        remote: Option<&str>,
        text: &str,
        files: &[BrowserAttachment],
    ) -> Result<(String, String), BrowserSubmitError> {
        match self {
            Self::ChatGpt(page) => page.submit_with_attachments(remote, text, files).await,
            Self::Zai(page) => page.submit_with_attachments(remote, text, files).await,
        }
    }

    pub(super) async fn cancel(&mut self, remote: &str, input: &str) -> Result<bool, RpcError> {
        match self {
            Self::ChatGpt(page) => Ok(page.cancel_turn(remote, input).await?),
            Self::Zai(page) => Ok(page.cancel_turn(remote, input).await?),
        }
    }

    pub(super) async fn attachment(
        &mut self,
        remote: &str,
        message: &str,
        attachment: &str,
    ) -> Result<BrowserAttachment, RpcError> {
        match self {
            Self::ChatGpt(page) => Ok(page.read_attachment(remote, message, attachment).await?),
            Self::Zai(page) => Ok(page.read_attachment(remote, message, attachment).await?),
        }
    }
}

fn message(
    session: &str,
    id: String,
    role: &str,
    text: String,
    model: Option<String>,
    files: Vec<BrowserFile>,
) -> Value {
    let parts: Vec<_> = (!text.is_empty())
        .then(|| json!({"type":"text","text":text}))
        .into_iter()
        .chain(files.into_iter().map(|file| {
            json!({
            "type": if file.image || file.mime_type.starts_with("image/") { "image" } else { "file" },
                "attachment_id":file.id,"name":file.name,"mime_type":file.mime_type
            })
        }))
        .collect();
    let mut row = json!({"id":id,"nativeMessageId":id,"role":role,"sessionId":session,
        "text":text,"parts":parts});
    if let Some(model) = model {
        row["model"] = Value::String(model);
    }
    row
}
