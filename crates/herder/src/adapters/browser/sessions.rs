use super::{
    BrowserActivity, BrowserAttachment, BrowserSubmitError, Config, Provider, RecoveryInput,
    drafts::{Draft, DraftState, DraftStore},
    port::Page,
    protocol::RpcError,
    valid_route,
};
use serde_json::{Value, json};
use std::collections::HashSet;

enum SessionId<'a> {
    Remote(&'a str),
    Draft(String),
}

impl Provider {
    fn parse_id(self, id: &str) -> Result<SessionId<'_>, RpcError> {
        let native = if let Some((harness, native)) = id.split_once("::") {
            if harness != self.name() {
                return Err(RpcError::Identity);
            }
            native
        } else {
            id
        };
        if let Some(suffix) = native
            .strip_prefix("draft%3A")
            .or_else(|| native.strip_prefix("draft:"))
            && valid_route(suffix)
        {
            return Ok(SessionId::Draft(format!("draft:{suffix}")));
        }
        let route = match self {
            Self::ChatGpt => native,
            Self::Zai => native
                .strip_prefix("route%3A")
                .or_else(|| native.strip_prefix("route:"))
                .unwrap_or(native),
        };
        if valid_route(route) {
            Ok(SessionId::Remote(route))
        } else {
            Err(RpcError::Invalid)
        }
    }

    fn public_route(self, remote: &str) -> String {
        match self {
            Self::ChatGpt => format!("chatgpt::{remote}"),
            Self::Zai => format!("zai::route%3A{remote}"),
        }
    }

    fn public_draft(self, draft: &Draft) -> String {
        format!("{}::{}", self.name(), draft.id.replacen(':', "%3A", 1))
    }
}

fn session(
    config: &Config,
    id: &str,
    title: &str,
    activity: BrowserActivity,
    remote: Option<&str>,
) -> Value {
    let status = match activity {
        BrowserActivity::Idle => "idle",
        BrowserActivity::Busy => "running",
        BrowserActivity::Unknown => "unknown",
    };
    let mut meta =
        json!({"pendingRemoteCreation":remote.is_none(),"browserProvider":config.provider.name()});
    if let Some(route) = remote {
        meta["sourceRoute"] = json!(format!("{}/c/{route}", config.provider.origin()));
    }
    json!({"id":id,"harness":config.provider.name(),"title":title,"cwd":config.cwd,
        "hostId":config.identity.node_id,"status":status,"needsPermission":false,
        "meta":meta})
}

fn local_activity(draft: &Draft) -> BrowserActivity {
    if matches!(draft.state, DraftState::Pending) {
        BrowserActivity::Idle
    } else {
        BrowserActivity::Unknown
    }
}

fn stored_error(error: std::io::Error) -> RpcError {
    match error.kind() {
        std::io::ErrorKind::NotFound => RpcError::Missing,
        _ => RpcError::Unavailable,
    }
}

/// One persistent read connection and at most one additional write connection.
/// Created conversations retain their native route in the existing draft store.
pub(super) struct Sessions {
    anchor: Page,
    writer: Option<(String, Page)>,
    drafts: DraftStore,
}

impl Sessions {
    pub(super) async fn open(config: &Config) -> Result<Self, RpcError> {
        let anchor = Page::anchor(config).await?;
        let drafts = DraftStore::new(
            &config.home,
            config.provider.name(),
            &config.scope,
            &config.endpoint,
            &config.identity.node_id,
            &config.identity.instance_id,
            &config.identity.browser_context_id,
        );
        Ok(Self {
            anchor,
            drafts,
            writer: None,
        })
    }

    pub(super) async fn close(self) {
        if let Some((_, page)) = self.writer {
            page.release().await;
        }
        self.anchor.close_created().await;
    }

    async fn release_writer(&mut self) {
        if let Some((_, page)) = self.writer.take() {
            page.release().await;
        }
    }

    pub(super) async fn create(&mut self, config: &Config, title: &str) -> Result<Value, RpcError> {
        self.anchor.verify_scope(config).await?;
        let draft = self.drafts.create(title).map_err(stored_error)?;
        Ok(session(
            config,
            &config.provider.public_draft(&draft),
            &draft.title,
            BrowserActivity::Idle,
            None,
        ))
    }

    pub(super) async fn list(&mut self, config: &Config, limit: usize) -> Result<Value, RpcError> {
        let native = self.anchor.list(limit).await?;
        let drafts = self.drafts.list().map_err(stored_error)?;
        let bound: HashSet<_> = drafts
            .iter()
            .filter_map(|d| d.remote_id.as_deref())
            .collect();
        let local = drafts.iter().map(|d| {
            session(
                config,
                &config.provider.public_draft(d),
                &d.title,
                local_activity(d),
                d.remote_id.as_deref(),
            )
        });
        let remote = native
            .iter()
            .filter(|id| valid_route(id) && !bound.contains(id.as_str()))
            .map(|id| {
                session(
                    config,
                    &config.provider.public_route(id),
                    id,
                    BrowserActivity::Unknown,
                    Some(id),
                )
            });
        Ok(Value::Array(local.chain(remote).take(limit).collect()))
    }

    async fn activity(
        &mut self,
        config: &Config,
        id: &str,
        target: Option<&str>,
    ) -> Result<BrowserActivity, RpcError> {
        if let Some((route, page)) = &mut self.writer
            && route == id
        {
            match page.activity(id).await {
                Err(RpcError::Unavailable) => self.release_writer().await,
                result => return result,
            }
        }
        let status = self.anchor.activity(id).await?;
        if status == BrowserActivity::Unknown
            && let Some(target) = target.filter(|t| *t != self.anchor.target())
            && let Ok(mut page) = Page::attach(config, target).await
            && page.on_route(config.provider, id).await?
        {
            let observed = page.activity(id).await?;
            self.release_writer().await;
            self.writer = Some((id.to_owned(), page));
            return Ok(observed);
        }
        Ok(status)
    }

    pub(super) async fn get(&mut self, config: &Config, id: &str) -> Result<Value, RpcError> {
        match config.provider.parse_id(id)? {
            SessionId::Remote(remote) => {
                let activity = self.activity(config, remote, None).await?;
                Ok(session(config, id, remote, activity, Some(remote)))
            }
            SessionId::Draft(key) => {
                self.anchor.verify_scope(config).await?;
                let draft = self.drafts.get(&key).map_err(stored_error)?;
                let activity = match &draft.remote_id {
                    Some(remote) => {
                        self.activity(config, remote, draft.target_id.as_deref())
                            .await?
                    }
                    None => local_activity(&draft),
                };
                Ok(session(
                    config,
                    id,
                    &draft.title,
                    activity,
                    draft.remote_id.as_deref(),
                ))
            }
        }
    }

    pub(super) async fn messages(
        &mut self,
        config: &Config,
        id: &str,
        limit: usize,
    ) -> Result<Value, RpcError> {
        match config.provider.parse_id(id)? {
            SessionId::Remote(remote) => self.anchor.messages(remote, id, limit).await,
            SessionId::Draft(key) => {
                let draft = self.drafts.get(&key).map_err(stored_error)?;
                if let Some(remote) = &draft.remote_id {
                    return self.anchor.messages(remote, id, limit).await;
                }
                self.anchor.verify_scope(config).await?;
                match draft.state {
                    DraftState::Pending => Ok(json!([])),
                    _ => Err(RpcError::Unavailable),
                }
            }
        }
    }

    pub(super) async fn recovery_boundary(
        &mut self,
        config: &Config,
        id: &str,
    ) -> Result<Value, RpcError> {
        let draft;
        let remote = match config.provider.parse_id(id)? {
            SessionId::Remote(remote) => remote,
            SessionId::Draft(key) => {
                self.anchor.verify_scope(config).await?;
                draft = self.drafts.get(&key).map_err(stored_error)?;
                let (DraftState::Admitted, Some(remote)) = (draft.state, draft.remote_id.as_deref()) else {
                    return Ok(Value::Null);
                };
                remote
            }
        };
        let mut value = self.anchor.recovery_boundary(remote).await?;
        if value.is_null() {
            return Ok(value);
        }
        let messages = self.anchor.messages(remote, id, 200).await?;
        let input = value["inputItemId"].as_str().ok_or(RpcError::Unavailable)?;
        let exact_parent = messages.as_array().is_some_and(|rows| {
            rows.iter().any(|row| {
                row["id"].as_str() == Some(input) && row["role"].as_str() == Some("user")
            })
        });
        if !exact_parent {
            return Err(RpcError::Unavailable);
        }
        value["id"] = json!(id);
        Ok(value)
    }

    /// Only the first send has a private tab, a pre-click ticket and a reserved
    /// draft. Check the requested key before attaching to that tab.
    pub(super) async fn zai_receipt_messages(
        &mut self,
        config: &Config,
        id: &str,
        input: &str,
        limit: usize,
    ) -> Result<Value, RpcError> {
        let SessionId::Draft(key) = config.provider.parse_id(id)? else {
            return Ok(json!([]));
        };
        let draft = self.drafts.get(&key).map_err(stored_error)?;
        let Some(attempt) = draft.zai_attempt.filter(|a| a.matches(input)) else {
            return Ok(json!([]));
        };
        self.anchor.verify_scope(config).await?;
        let (remote, message) = match (draft.remote_id, draft.first_message) {
            (Some(remote), Some(message)) => (remote, message),
            (None, None) if matches!(draft.state, DraftState::Sending | DraftState::Uncertain) => {
                let Page::Zai(mut page) = Page::attach(config, &attempt.target).await? else {
                    return Err(RpcError::Identity);
                };
                let Some((remote, message)) = page.read_submission(None, &attempt.ticket).await?
                else {
                    return Ok(json!([]));
                };
                self.drafts
                    .bind(&key, &remote, &message, &attempt.target)
                    .map_err(stored_error)?;
                (remote, message)
            }
            _ => return Err(RpcError::Unavailable),
        };
        let mut rows = self.anchor.messages(&remote, id, limit).await?;
        let matched = rows.as_array_mut().ok_or(RpcError::Unavailable)?;
        matched.retain(|row| {
            row["role"] == "user"
                && row["sessionId"] == id
                && row["id"] == message
                && row["nativeMessageId"] == message
        });
        if let [row] = matched.as_mut_slice() {
            row["inputId"] = json!(input);
        } else {
            matched.clear();
        }
        Ok(rows)
    }

    pub(super) async fn chatgpt_receipt_messages(
        &mut self,
        id: &str,
        input: &str,
    ) -> Result<Value, RpcError> {
        let Some((remote, _)) = self.bound_route(Provider::ChatGpt, id)? else {
            return Ok(json!([]));
        };
        let Page::ChatGpt(page) = &mut self.anchor else {
            return Err(RpcError::Identity);
        };
        let Some(message) = page.recovery_receipt(&remote, input).await? else {
            return Ok(json!([]));
        };
        Ok(
            json!([{"id":message,"nativeMessageId":message,"role":"user",
            "sessionId":id,"inputId":input}]),
        )
    }

    /// A pending draft has no provider conversation. An unsettled draft cannot
    /// be inferred from the current tab, even when it happens to be busy.
    fn bound_route(
        &self,
        provider: Provider,
        id: &str,
    ) -> Result<Option<(String, Option<String>)>, RpcError> {
        match provider.parse_id(id)? {
            SessionId::Remote(remote) => Ok(Some((remote.to_owned(), None))),
            SessionId::Draft(key) => {
                let draft = self.drafts.get(&key).map_err(stored_error)?;
                match (draft.state, draft.remote_id) {
                    (DraftState::Pending, None) => Ok(None),
                    (DraftState::Admitted, Some(remote)) => Ok(Some((remote, draft.target_id))),
                    _ => Err(RpcError::Unavailable),
                }
            }
        }
    }

    pub(super) async fn attachment(
        &mut self,
        config: &Config,
        id: &str,
        message: &str,
        file: &str,
    ) -> Result<BrowserAttachment, RpcError> {
        let (remote, _) = self
            .bound_route(config.provider, id)?
            .ok_or(RpcError::Missing)?;
        self.anchor.attachment(&remote, message, file).await
    }

    pub(super) async fn cancel(
        &mut self,
        config: &Config,
        id: &str,
        input: &str,
    ) -> Result<bool, RpcError> {
        self.anchor.verify_scope(config).await?;
        let Some((remote, saved_target)) = self.bound_route(config.provider, id)? else {
            return Ok(false);
        };
        if let Some((route, page)) = &mut self.writer
            && route == &remote
        {
            match page.on_route(config.provider, &remote).await {
                Ok(true) => return page.cancel(&remote, input).await,
                Ok(false) | Err(RpcError::Unavailable) => self.release_writer().await,
                Err(error) => return Err(error),
            }
        }
        if let Some(target) = saved_target.filter(|t| t != self.anchor.target())
            && let Ok(mut page) = Page::attach(config, &target).await
            && page.on_route(config.provider, &remote).await?
        {
            let result = page.cancel(&remote, input).await;
            page.release().await;
            return result;
        }
        if self.anchor.on_route(config.provider, &remote).await? {
            return self.anchor.cancel(&remote, input).await;
        }
        let target = self.anchor.existing_target(config, &remote).await?;
        let mut page = Page::attach(config, &target).await?;
        let result = page.cancel(&remote, input).await;
        page.release().await;
        result
    }

    /// Never navigate a pinned or reattached tab. Only a newly created private
    /// working tab can be opened on an off-screen conversation.
    async fn writer_for(
        &mut self,
        config: &Config,
        remote: &str,
        target: Option<&str>,
    ) -> Result<&mut Page, RpcError> {
        if let Some((route, page)) = &mut self.writer
            && route == remote
        {
            match page.on_route(config.provider, remote).await {
                Ok(true) => {
                    return self
                        .writer
                        .as_mut()
                        .map(|(_, page)| page)
                        .ok_or(RpcError::Unavailable);
                }
                Ok(false) | Err(RpcError::Unavailable) => self.release_writer().await,
                Err(error) => return Err(error),
            }
        }
        if self.anchor.on_route(config.provider, remote).await? {
            return Ok(&mut self.anchor);
        }
        let mut page = None;
        if let Some(target) = target.filter(|t| *t != self.anchor.target())
            && let Ok(mut attached) = Page::attach(config, target).await
            && attached.on_route(config.provider, remote).await?
        {
            page = Some(attached);
        }
        let page = match page {
            Some(page) => page,
            None => {
                let mut fresh = Page::create(config).await?;
                if let Err(error) = fresh.open_conversation(remote).await {
                    fresh.close_created().await;
                    return Err(error);
                }
                fresh
            }
        };
        self.release_writer().await;
        Ok(&mut self.writer.insert((remote.to_owned(), page)).1)
    }

    async fn first(
        &mut self,
        config: &Config,
        key: &str,
        input: &str,
        text: &str,
        files: &[BrowserAttachment],
    ) -> Result<String, BrowserSubmitError> {
        use BrowserSubmitError::{BeforeSend, Unknown};
        // A reserved draft stays uncertain across a crash or a missing receipt.
        self.drafts.begin(key).map_err(|_| Unknown)?;
        let mut fresh = match Page::create(config).await {
            Ok(page) => page,
            Err(_) => {
                self.drafts.reset(key).map_err(|_| Unknown)?;
                return Err(BeforeSend);
            }
        };
        let submitted = match &mut fresh {
            Page::Zai(page) => {
                let target = page.identity().target_id.clone();
                page.submit_with_ticket(None, text, files, |ticket| {
                    self.drafts
                        .arm_zai(key, input, &target, ticket)
                        .map_err(|_| BeforeSend)
                })
                .await
            }
            page => page.submit(None, text, files, None, input).await,
        };
        match submitted {
            Ok((remote, message)) if valid_route(&remote) && super::valid_label(&message) => {
                self.drafts
                    .bind(key, &remote, &message, fresh.target())
                    .map_err(|_| Unknown)?;
                self.release_writer().await;
                self.writer = Some((remote, fresh));
                Ok(message)
            }
            Err(BeforeSend) => {
                fresh.close_created().await;
                self.drafts.reset(key).map_err(|_| Unknown)?;
                Err(BeforeSend)
            }
            _ => {
                let _ = self.drafts.uncertain(key);
                Err(Unknown)
            }
        }
    }

    pub(super) async fn send(
        &mut self,
        config: &Config,
        id: &str,
        input: &str,
        text: &str,
        files: &[BrowserAttachment],
        recovery: Option<&RecoveryInput>,
    ) -> Result<String, BrowserSubmitError> {
        use BrowserSubmitError::{BeforeSend, Unknown};
        if recovery.is_some() && !config.provider.supports_guarded_recovery() {
            return Err(BeforeSend);
        }
        let session = config.provider.parse_id(id).map_err(|_| BeforeSend)?;
        self.anchor
            .verify_scope(config)
            .await
            .map_err(|_| BeforeSend)?;
        let draft;
        let (remote, target) = match session {
            SessionId::Remote(remote) => (remote, None),
            SessionId::Draft(key) => {
                draft = self.drafts.get(&key).map_err(|_| BeforeSend)?;
                match (&draft.state, draft.remote_id.as_deref()) {
                    (DraftState::Pending, None) if recovery.is_none() => {
                        return self.first(config, &key, input, text, files).await;
                    }
                    (DraftState::Admitted, Some(remote)) => (remote, draft.target_id.as_deref()),
                    _ if recovery.is_some() => return Err(BeforeSend),
                    _ => return Err(Unknown),
                }
            }
        };
        let writer = self
            .writer_for(config, remote, target)
            .await
            .map_err(|_| BeforeSend)?;
        let (confirmed, message) = writer
            .submit(Some(remote), text, files, recovery, input)
            .await?;
        if confirmed != remote || !super::valid_label(&message) {
            return Err(Unknown);
        }
        Ok(message)
    }
}
