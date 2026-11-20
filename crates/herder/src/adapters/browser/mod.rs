//! Native browser harnesses. AHAP owns framing, Herder owns durable delivery,
//! and each site owns its authenticated page operations.
#[cfg(unix)]
mod drafts;
#[cfg(unix)]
mod port;
#[cfg(unix)]
mod protocol;
#[cfg(unix)]
mod sessions;

use crate::adapters::cdp::CdpTargetIdentity;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

/// After a possibly accepted click only a provider receipt can settle delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserSubmitError {
    BeforeSend,
    Unknown,
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

const NATIVE_ENV: [&str; 6] = [
    "AHAP_BROWSER_TRANSPORT",
    "AHAP_BROWSER_CDP_WS_URL",
    "AHAP_BROWSER_CDP_CONTEXT_ID",
    "AHAP_BROWSER_CDP_TARGET_ID",
    "AHAP_BROWSER_ACCOUNT_SCOPE",
    "AHAP_BROWSER_CDP_ORIGIN_PORT",
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
    if env.keys().any(|k| !NATIVE_ENV.contains(&k.as_str()))
        || get("AHAP_BROWSER_TRANSPORT") != Some("direct-cdp")
        || !get("AHAP_BROWSER_CDP_CONTEXT_ID").is_some_and(valid_label)
        || !get("AHAP_BROWSER_CDP_TARGET_ID").is_some_and(valid_label)
        || !get("AHAP_BROWSER_ACCOUNT_SCOPE").is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err("invalid native browser account, context or target binding");
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
    home: PathBuf,
    cwd: PathBuf,
}

impl Config {
    fn load(args: impl Iterator<Item = OsString>) -> Result<Self, &'static str> {
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
                return Err(USAGE);
            }
        }
        let provider = match flags.get("--harness").map(String::as_str) {
            Some("chatgpt") => Provider::ChatGpt,
            Some("zai") => Provider::Zai,
            _ => return Err(USAGE),
        };
        let env = NATIVE_ENV
            .iter()
            .filter_map(|&k| std::env::var(k).ok().map(|v| (k.to_owned(), v)))
            .collect();
        validate_native_browser_env(&env)?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("missing absolute browser owner home")?;
        Ok(Self {
            provider,
            identity: CdpTargetIdentity {
                node_id: flags.remove("--node").ok_or(USAGE)?,
                instance_id: flags.remove("--instance").ok_or(USAGE)?,
                browser_context_id: env["AHAP_BROWSER_CDP_CONTEXT_ID"].clone(),
                target_id: env["AHAP_BROWSER_CDP_TARGET_ID"].clone(),
            },
            endpoint: env["AHAP_BROWSER_CDP_WS_URL"].clone(),
            scope: env["AHAP_BROWSER_ACCOUNT_SCOPE"].clone(),
            origin_port: env
                .get("AHAP_BROWSER_CDP_ORIGIN_PORT")
                .and_then(|s| s.parse().ok()),
            home,
            cwd: std::env::current_dir().map_err(|_| "browser owner cwd unavailable")?,
        })
    }
}

#[cfg(unix)]
pub async fn run(args: impl Iterator<Item = OsString>) -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load(args)?;
    protocol::serve(config, std::io::stdin().lock(), std::io::stdout().lock()).await?;
    Ok(())
}

#[cfg(not(unix))]
pub async fn run(_: impl Iterator<Item = OsString>) -> Result<(), Box<dyn std::error::Error>> {
    Err("native browser owner profiles require a Unix draft store".into())
}
