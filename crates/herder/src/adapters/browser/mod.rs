//! Native browser harnesses. AHAP owns framing, Herder owns durable delivery,
//! and each site owns its authenticated page operations.
#[cfg(unix)]
mod drafts;
mod extension;
pub(crate) mod page;
#[cfg(unix)]
mod port;
#[cfg(unix)]
mod protocol;
#[cfg(unix)]
mod sessions;

use crate::adapters::cdp::CdpTargetIdentity;
pub use crate::domain::attachment::{
    AttachmentMetadata as BrowserFile, InlineAttachment as BrowserAttachment, MAX_ATTACHMENT_BYTES,
    validate_attachments,
};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

/// After a possibly accepted click only a provider receipt can settle delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserSubmitError {
    BeforeSend,
    Unknown,
}

/// The failed response and its user input on the current conversation branch.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryInput {
    pub turn_id: String,
    pub input_item_id: String,
}

impl RecoveryInput {
    fn valid(&self) -> bool {
        valid_label(&self.turn_id) && valid_label(&self.input_item_id)
            && self.turn_id != self.input_item_id
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserActivity {
    Idle,
    Busy,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    ChatGpt,
    Zai,
}

impl Provider {
    fn requires_attachment_caption(self) -> bool {
        matches!(self, Self::Zai)
    }

    fn name(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt",
            Self::Zai => "zai",
        }
    }

    fn origin(self) -> &'static str {
        match self {
            Self::ChatGpt => "https://chatgpt.com",
            Self::Zai => "https://chat.z.ai",
        }
    }
}

const NATIVE_ENV: [&str; 8] = [
    "AHAP_BROWSER_TRANSPORT",
    "AHAP_BROWSER_CDP_WS_URL",
    "AHAP_BROWSER_CDP_CONTEXT_ID",
    "AHAP_BROWSER_CDP_TARGET_ID",
    "AHAP_BROWSER_ACCOUNT_SCOPE",
    "AHAP_BROWSER_CDP_ORIGIN_PORT",
    "AHAP_BROWSER_EXTENSION_LISTEN",
    "AHAP_BROWSER_EXTENSION_TOKEN_FILE",
];

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_route(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The protected owner profile and standalone runner accept the same binding.
pub fn validate_native_browser_env(env: &BTreeMap<String, String>) -> Result<(), &'static str> {
    let get = |name| env.get(name).map(String::as_str);
    if !get("AHAP_BROWSER_ACCOUNT_SCOPE").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err("invalid native browser account scope");
    }
    if get("AHAP_BROWSER_TRANSPORT") == Some("herder-extension") {
        if env.len() != 4
            || get("AHAP_BROWSER_EXTENSION_LISTEN")
                .and_then(extension::listen_address)
                .is_none()
            || !get("AHAP_BROWSER_EXTENSION_TOKEN_FILE").is_some_and(|s| {
                let path = std::path::Path::new(s);
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| part == std::path::Component::ParentDir)
            })
        {
            return Err("invalid native Herder extension binding");
        }
        return Ok(());
    }
    if get("AHAP_BROWSER_TRANSPORT") != Some("direct-cdp")
        || env.keys().any(|k| !NATIVE_ENV[..6].contains(&k.as_str()))
        || !get("AHAP_BROWSER_CDP_CONTEXT_ID").is_some_and(valid_label)
        || !get("AHAP_BROWSER_CDP_TARGET_ID").is_some_and(valid_label)
    {
        return Err("invalid native browser context or target binding");
    }
    let ws = get("AHAP_BROWSER_CDP_WS_URL").ok_or("missing browser WebSocket URL")?;
    let url = reqwest::Url::parse(ws).map_err(|_| "invalid browser WebSocket URL")?;
    if url.scheme() != "ws"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url
            .path()
            .strip_prefix("/devtools/browser/")
            .is_some_and(valid_route)
    {
        return Err("expected a loopback browser WebSocket endpoint");
    }
    if let Some(port) = get("AHAP_BROWSER_CDP_ORIGIN_PORT")
        && (!port.bytes().all(|b| b.is_ascii_digit()) || !port.parse::<u16>().is_ok_and(|p| p > 0))
    {
        return Err("invalid browser origin port");
    }
    Ok(())
}

struct Config {
    provider: Provider,
    identity: CdpTargetIdentity,
    endpoint: String,
    scope: String,
    origin_port: Option<u16>,
    extension: Option<extension::ExtensionLink>,
    home: PathBuf,
    cwd: PathBuf,
}

impl Config {
    async fn load(
        args: impl Iterator<Item = OsString>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        const USAGE: &str =
            "usage: herder-browser --harness chatgpt|zai --node NODE --instance INSTANCE";
        let mut flags = BTreeMap::new();
        let mut args = args.map(|s| s.into_string().map_err(|_| USAGE));
        while let Some(flag) = args.next() {
            let flag = flag?;
            let value = args.next().ok_or(USAGE)??;
            if !matches!(flag.as_str(), "--harness" | "--node" | "--instance")
                || !valid_label(&value)
                || flags.insert(flag, value).is_some()
            {
                return Err(USAGE.into());
            }
        }
        let provider = match flags.get("--harness").map(String::as_str) {
            Some("chatgpt") => Provider::ChatGpt,
            Some("zai") => Provider::Zai,
            _ => return Err(USAGE.into()),
        };
        let env = NATIVE_ENV
            .iter()
            .filter_map(|&k| std::env::var(k).ok().map(|v| (k.to_owned(), v)))
            .collect();
        validate_native_browser_env(&env)?;
        let (extension, browser_context_id, target_id, endpoint) = if let Some(listen) =
            env.get("AHAP_BROWSER_EXTENSION_LISTEN")
        {
            let address =
                extension::listen_address(listen).ok_or("invalid browser extension listener")?;
            let token_file = std::path::Path::new(&env["AHAP_BROWSER_EXTENSION_TOKEN_FILE"]);
            let link = extension::ExtensionLink::bind(address, token_file, provider.name()).await?;
            (
                Some(link),
                "herder-extension".into(),
                "extension-anchor".into(),
                format!("extension://{listen}"),
            )
        } else {
            (
                None,
                env["AHAP_BROWSER_CDP_CONTEXT_ID"].clone(),
                env["AHAP_BROWSER_CDP_TARGET_ID"].clone(),
                env["AHAP_BROWSER_CDP_WS_URL"].clone(),
            )
        };
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("missing absolute browser owner home")?;
        Ok(Self {
            provider,
            identity: CdpTargetIdentity {
                node_id: flags.remove("--node").ok_or(USAGE)?,
                instance_id: flags.remove("--instance").ok_or(USAGE)?,
                browser_context_id,
                target_id,
            },
            endpoint,
            scope: env["AHAP_BROWSER_ACCOUNT_SCOPE"].clone(),
            origin_port: env
                .get("AHAP_BROWSER_CDP_ORIGIN_PORT")
                .and_then(|s| s.parse().ok()),
            extension,
            home,
            cwd: std::env::current_dir().map_err(|_| "browser owner cwd unavailable")?,
        })
    }
}

#[cfg(unix)]
pub async fn run(args: impl Iterator<Item = OsString>) -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load(args).await?;
    protocol::serve(
        config,
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )
    .await?;
    Ok(())
}

#[cfg(not(unix))]
pub async fn run(_: impl Iterator<Item = OsString>) -> Result<(), Box<dyn std::error::Error>> {
    Err("native browser owner profiles require a Unix draft store".into())
}
