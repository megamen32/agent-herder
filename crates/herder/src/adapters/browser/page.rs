use super::extension::ExtensionLink;
use crate::adapters::cdp::{CdpConnection, CdpError, CdpTargetIdentity, CdpTargetInfo};
use serde_json::{Value, json};

const TAB_PREFIX: &str = "extension-tab-";

pub(crate) enum PageConnection {
    Direct(CdpConnection),
    Extension {
        link: ExtensionLink,
        identity: CdpTargetIdentity,
        tab: Option<u64>,
        created: bool,
    },
}

impl From<CdpConnection> for PageConnection {
    fn from(connection: CdpConnection) -> Self {
        Self::Direct(connection)
    }
}

impl PageConnection {
    pub(super) fn anchor(link: ExtensionLink, identity: CdpTargetIdentity) -> Self {
        Self::Extension {
            link,
            identity,
            tab: None,
            created: false,
        }
    }

    pub(super) async fn claim(
        link: ExtensionLink,
        mut identity: CdpTargetIdentity,
        target: Option<&str>,
    ) -> Result<Self, CdpError> {
        let (tab, created) = match target {
            Some(target) => (
                target
                    .strip_prefix(TAB_PREFIX)
                    .and_then(|tab| tab.parse::<u64>().ok())
                    .ok_or(CdpError::InvalidIdentity)?,
                false,
            ),
            None => {
                let tab = link.call("create", Value::Null).await?;
                (tab.as_u64().ok_or(CdpError::Protocol)?, true)
            }
        };
        identity.target_id = format!("{TAB_PREFIX}{tab}");
        Ok(Self::Extension {
            link,
            identity,
            tab: Some(tab),
            created,
        })
    }

    pub(crate) fn identity(&self) -> &CdpTargetIdentity {
        match self {
            Self::Direct(connection) => connection.identity(),
            Self::Extension { identity, .. } => identity,
        }
    }

    pub(crate) fn owns_target(&self) -> bool {
        match self {
            Self::Direct(connection) => connection.owns_target(),
            Self::Extension { created, .. } => *created,
        }
    }

    pub(crate) fn is_extension(&self) -> bool {
        matches!(self, Self::Extension { .. })
    }

    pub(crate) async fn site(
        &mut self,
        operation: &str,
        params: Value,
        direct_expression: impl FnOnce() -> String,
    ) -> Result<Value, CdpError> {
        match self {
            Self::Direct(connection) => connection.evaluate(&direct_expression()).await,
            Self::Extension { link, tab, .. } => {
                link.call("site", json!({"tab":tab,"op":operation,"params":params}))
                    .await
            }
        }
    }

    pub(super) async fn location(&mut self) -> Result<Value, CdpError> {
        match self {
            Self::Direct(connection) => {
                connection
                    .evaluate(
                        "({origin:location.origin,path:location.pathname,href:location.href})",
                    )
                    .await
            }
            Self::Extension { link, tab, .. } => link.call("location", json!({"tab":tab})).await,
        }
    }

    pub(crate) async fn href(&mut self) -> Result<Value, CdpError> {
        match self {
            Self::Direct(connection) => connection.evaluate("location.href").await,
            _ => Ok(self.location().await?["href"].clone()),
        }
    }

    pub(crate) async fn wait_for_origin(&mut self, origin: &str) -> Result<bool, CdpError> {
        match self {
            Self::Direct(connection) => connection.wait_for_origin(origin).await,
            Self::Extension { .. } => Ok(self.location().await?["origin"] == origin),
        }
    }

    pub(super) async fn list_targets(&mut self) -> Result<Vec<CdpTargetInfo>, CdpError> {
        match self {
            Self::Direct(connection) => connection.list_targets().await,
            Self::Extension { link, identity, .. } => {
                let tabs = link.call("list", Value::Null).await?;
                tabs.as_array()
                    .ok_or(CdpError::Protocol)?
                    .iter()
                    .map(|tab| {
                        let id = tab["id"].as_u64().ok_or(CdpError::Protocol)?;
                        let url = tab["url"].as_str().ok_or(CdpError::Protocol)?;
                        Ok(CdpTargetInfo {
                            target_id: format!("{TAB_PREFIX}{id}"),
                            browser_context_id: Some(identity.browser_context_id.clone()),
                            target_type: "page".into(),
                            url: url.into(),
                        })
                    })
                    .collect()
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn evaluate(&mut self, expression: &str) -> Result<Value, CdpError> {
        match self {
            Self::Direct(connection) => connection.evaluate(expression).await,
            Self::Extension { .. } => Err(CdpError::Protocol),
        }
    }

    pub(crate) async fn close(self) {
        if let Self::Direct(connection) = self {
            connection.close().await;
        }
    }

    pub(crate) async fn close_created_target(self) {
        match self {
            Self::Direct(connection) => connection.close_created_target().await,
            Self::Extension {
                link,
                tab: Some(tab),
                created: true,
                ..
            } => {
                let _ = link.call("close", json!({"tab":tab})).await;
            }
            Self::Extension { .. } => {}
        }
    }
}
