//! Trusted local launch profile for an already provisioned scoped authority.
//! Opening does not migrate, create a database, or authorize an MCP caller.
use herder::{
    application::{scoped_stop::ScopedAuthority, target_gate::acquire_pinned},
    store::Writer,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    database: PathBuf,
    gate: PathBuf,
    generation: String,
    #[serde(default)]
    owner: Option<OwnerProfile>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerProfile {
    pub principal: String,
    pub node: String,
    pub instance: String,
    pub executable: PathBuf,
    pub code_home: PathBuf,
    pub cwd: PathBuf,
    #[serde(default = "codex_kind")]
    pub kind: String,
    #[serde(default)]
    pub ahap_script: Option<PathBuf>,
    #[serde(default)]
    pub ahap_base_url: Option<String>,
    #[serde(default)]
    pub ahap_env: BTreeMap<String, String>,
    #[serde(default)]
    pub existing_sessions: Vec<herder::application::scoped_stop::enroll::ExistingSessionApproval>,
}

/// Only adapter configuration crosses the process boundary. Process loader,
/// identity and HOME variables are set by the composition, never this map.
fn allowed_adapter_env(kind: &str, name: &str) -> bool {
    match kind {
        "opencode" => matches!(name, "AHAP_OPENCODE_PASSWORD" | "AHAP_OPENCODE_MODEL" | "OPENCODE_SERVER_USERNAME"),
        "codex" => matches!(name, "AHAP_CODEX_SOCKET" | "AHAP_CODEX_BIN" | "AHAP_CODEX_CWD" | "AHAP_CODEX_MODEL" | "CODEX_HOME" | "AGENT_HERDER_WORKLOAD_ISOLATION"),
        "zcode" => matches!(name, "AHAP_ZCODE_SERVER_NODE" | "AHAP_ZCODE_SERVER_ENTRY" | "AHAP_ZCODE_CWD" | "AHAP_ZCODE_TRANSPORT" | "AHAP_ZCODE_CREATE_MODEL"),
        "chatgpt" | "zai" => matches!(name,
            "AHAP_BROWSER_TRANSPORT" | "AHAP_BROWSER_PAGE_ID" | "AHAP_BROWSER_ACCOUNT_SCOPE"
            | "AHAP_BROWSER_CDP_WS_URL" | "AHAP_BROWSER_CDP_CONTEXT_ID" | "AHAP_BROWSER_CDP_TARGET_ID"
            | "AHAP_BROWSER_VIBE_TARGET" | "AHAP_BROWSER_VIBE_SESSION_ID"
            | "AHAP_BROWSER_VIBE_RELAY_PORT" | "AHAP_BROWSER_VIBE_STATE_DIR"
            | "AHAP_BROWSER_MCP_URL" | "AHAP_BROWSER_MCP_PROFILE_FILE"
            | "AGENT_HERDER_MAC_MINI_SSH_TARGET" | "AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT"
            | "AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_URL"
            | "AGENT_HERDER_VIBE_MAC_SSH_TARGET" | "AGENT_HERDER_VIBE_MAC_NODE_PATH"
            | "AGENT_HERDER_VIBE_MAC_CLI_PATH" | "AGENT_HERDER_VIBE_SERVER_CLI_PATH"
            | "AHAP_USERIO_ENDPOINT" | "AHAP_USERIO_AGENT_ID" | "AHAP_USERIO_INSTANCE_ID"
            | "AHAP_USERIO_ACCOUNT_SCOPE" | "AHAP_USERIO_ACCESS_TOKEN_FILE" | "AHAP_USERIO_TOKEN_FILE"),
        _ => false,
    }
}

/// Validate the fixed installed Vibe child binding before an AHAP process is
/// started. No command, loader override, implicit session or transport fallback
/// is accepted through the profile.
fn invalid_browser_binding() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid browser binding")
}

fn valid_sha256_scope(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_browser_instance_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("browser-") else { return false };
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = uuid.split('-');
    groups.iter().all(|length| {
        parts
            .next()
            .is_some_and(|part| part.len() == *length
                && part.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    }) && parts.next().is_none()
}

fn valid_userio_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn validate_userio_endpoint(value: &str) -> io::Result<()> {
    let url = reqwest::Url::parse(value).map_err(|_| invalid_browser_binding())?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_browser_binding());
    }
    Ok(())
}

fn validate_userio_token_file(value: &str) -> io::Result<()> {
    let path = Path::new(value);
    if !path.is_absolute()
        || path.components().any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid_browser_binding());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| invalid_browser_binding())?;
    unsafe extern "C" { fn geteuid() -> u32; }
    let uid = unsafe { geteuid() };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.size() < 8
        || metadata.size() > 8192
    {
        return Err(invalid_browser_binding());
    }
    let raw = std::fs::read_to_string(path).map_err(|_| invalid_browser_binding())?;
    let trimmed = raw.trim();
    let token = if trimmed.starts_with('{') {
        let parsed: serde_json::Value = serde_json::from_str(trimmed).map_err(|_| invalid_browser_binding())?;
        parsed.get("authorization").and_then(serde_json::Value::as_str)
            .map(|value| value.strip_prefix("Bearer ").unwrap_or(value).to_owned())
            .unwrap_or_default()
    } else {
        trimmed.to_owned()
    };
    if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_whitespace) {
        return Err(invalid_browser_binding());
    }
    Ok(())
}

fn validate_userio_binding(env: &BTreeMap<String, String>) -> io::Result<()> {
    let get = |name: &str| env.get(name).map(String::as_str);
    if get("AHAP_BROWSER_TRANSPORT") != Some("userio") {
        return Err(invalid_browser_binding());
    }
    let endpoint = get("AHAP_USERIO_ENDPOINT").ok_or_else(invalid_browser_binding)?;
    validate_userio_endpoint(endpoint)?;
    let agent = get("AHAP_USERIO_AGENT_ID").ok_or_else(invalid_browser_binding)?;
    if !valid_userio_agent_id(agent) {
        return Err(invalid_browser_binding());
    }
    let instance = get("AHAP_USERIO_INSTANCE_ID").ok_or_else(invalid_browser_binding)?;
    if !valid_browser_instance_id(instance) {
        return Err(invalid_browser_binding());
    }
    let browser_scope = get("AHAP_BROWSER_ACCOUNT_SCOPE");
    let userio_scope = get("AHAP_USERIO_ACCOUNT_SCOPE");
    if let Some(scope) = browser_scope {
        if !valid_sha256_scope(scope) { return Err(invalid_browser_binding()); }
    }
    if let Some(scope) = userio_scope {
        if !valid_sha256_scope(scope) || browser_scope.is_some_and(|other| other != scope) {
            return Err(invalid_browser_binding());
        }
    }
    if browser_scope.is_none() && userio_scope.is_none() {
        return Err(invalid_browser_binding());
    }
    let access_token_file = get("AHAP_USERIO_ACCESS_TOKEN_FILE");
    let legacy_token_file = get("AHAP_USERIO_TOKEN_FILE");
    if access_token_file.is_some() && legacy_token_file.is_some() && access_token_file != legacy_token_file {
        return Err(invalid_browser_binding());
    }
    let token_file = access_token_file.or(legacy_token_file).ok_or_else(invalid_browser_binding)?;
    validate_userio_token_file(token_file)?;
    let forbidden = [
        "AHAP_BROWSER_PAGE_ID", "AHAP_BROWSER_CDP_WS_URL", "AHAP_BROWSER_CDP_CONTEXT_ID",
        "AHAP_BROWSER_CDP_TARGET_ID", "AHAP_BROWSER_VIBE_TARGET", "AHAP_BROWSER_VIBE_SESSION_ID",
        "AHAP_BROWSER_VIBE_RELAY_PORT", "AHAP_BROWSER_VIBE_STATE_DIR", "AHAP_BROWSER_MCP_URL",
        "AHAP_BROWSER_MCP_PROFILE_FILE",
    ];
    if forbidden.iter().any(|key| env.contains_key(*key)) {
        return Err(invalid_browser_binding());
    }
    Ok(())
}

fn validate_browser_binding(env: &BTreeMap<String, String>) -> io::Result<()> {
    let userio_keys = [
        "AHAP_USERIO_ENDPOINT", "AHAP_USERIO_AGENT_ID", "AHAP_USERIO_INSTANCE_ID",
        "AHAP_USERIO_ACCOUNT_SCOPE", "AHAP_USERIO_ACCESS_TOKEN_FILE", "AHAP_USERIO_TOKEN_FILE",
    ];
    if env.get("AHAP_BROWSER_TRANSPORT").map(String::as_str) == Some("userio")
        || userio_keys.iter().any(|key| env.contains_key(*key))
    {
        return validate_userio_binding(env);
    }
    if env.get("AHAP_BROWSER_TRANSPORT").map(String::as_str) == Some("mac-mini") {
        return validate_mac_binding(env);
    }
    validate_vibe_binding(env)
}

fn validate_mac_binding(env: &BTreeMap<String, String>) -> io::Result<()> {
    let bad = || io::Error::new(io::ErrorKind::InvalidInput, "invalid Mac Mini browser binding");
    let get = |name: &str| env.get(name).map(String::as_str);
    let ssh = get("AGENT_HERDER_MAC_MINI_SSH_TARGET").ok_or_else(bad)?;
    let script = get("AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT").ok_or_else(bad)?;
    let valid_ssh = |value: &str| {
        let mut parts = value.split('@');
        let user = parts.next().unwrap_or_default();
        let host = parts.next().unwrap_or_default();
        !user.is_empty() && !host.is_empty() && parts.next().is_none()
            && user.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            && host.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    };
    let valid_path = |value: &str| value.starts_with('/') && !value.contains("..")
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/_.-".contains(&byte));
    if !valid_ssh(ssh) || !valid_path(script) { return Err(bad()); }
    if let Some(url) = get("AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_URL") {
        let parsed = reqwest::Url::parse(url).map_err(|_| bad())?;
        if !matches!(parsed.scheme(), "http" | "https") || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(bad());
        }
    }
    Ok(())
}

fn validate_vibe_binding(env: &BTreeMap<String, String>) -> io::Result<()> {
    let bad = || io::Error::new(io::ErrorKind::InvalidInput, "invalid Vibe browser binding");
    let get = |name: &str| env.get(name).map(String::as_str);
    let keys = ["AHAP_BROWSER_VIBE_TARGET", "AHAP_BROWSER_VIBE_SESSION_ID",
        "AHAP_BROWSER_VIBE_RELAY_PORT", "AHAP_BROWSER_VIBE_STATE_DIR"];
    if get("AHAP_BROWSER_TRANSPORT") != Some("vibe") {
        return if keys.iter().any(|key| env.contains_key(*key)) { Err(bad()) } else { Ok(()) };
    }
    let target = get("AHAP_BROWSER_VIBE_TARGET").ok_or_else(bad)?;
    if !matches!(target, "mac-mini" | "server-100") { return Err(bad()); }
    let valid_path = |value: &str| value.starts_with('/') && !value.contains("..")
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/_.-".contains(&byte));
    let valid_ssh = |value: &str| {
        let mut parts = value.split('@');
        let user = parts.next().unwrap_or_default();
        let host = parts.next().unwrap_or_default();
        !user.is_empty() && !host.is_empty() && parts.next().is_none()
            && user.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            && host.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    };
    if target == "mac-mini" {
        if get("AGENT_HERDER_VIBE_SERVER_CLI_PATH").is_some() { return Err(bad()); }
        let ssh = get("AGENT_HERDER_VIBE_MAC_SSH_TARGET").ok_or_else(bad)?;
        let node = get("AGENT_HERDER_VIBE_MAC_NODE_PATH").ok_or_else(bad)?;
        let cli = get("AGENT_HERDER_VIBE_MAC_CLI_PATH").ok_or_else(bad)?;
        if !valid_ssh(ssh) || !valid_path(node) || !valid_path(cli) { return Err(bad()); }
    } else {
        if get("AGENT_HERDER_VIBE_MAC_SSH_TARGET").is_some()
            || get("AGENT_HERDER_VIBE_MAC_NODE_PATH").is_some()
            || get("AGENT_HERDER_VIBE_MAC_CLI_PATH").is_some() { return Err(bad()); }
        let cli = get("AGENT_HERDER_VIBE_SERVER_CLI_PATH").ok_or_else(bad)?;
        if !valid_path(cli) { return Err(bad()); }
    }
    let session = get("AHAP_BROWSER_VIBE_SESSION_ID").ok_or_else(bad)?;
    if session.is_empty() || session.len() > 128 || !session.as_bytes()[0].is_ascii_alphanumeric()
        || !session.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c)) {
        return Err(bad());
    }
    let scope = get("AHAP_BROWSER_ACCOUNT_SCOPE").ok_or_else(bad)?;
    if scope.len() != 64 || !scope.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(bad());
    }
    let port = match get("AHAP_BROWSER_VIBE_RELAY_PORT") {
        None => 19888,
        Some(raw) if !raw.is_empty() && raw.bytes().all(|c| c.is_ascii_digit()) =>
            raw.parse::<u16>().map_err(|_| bad())?,
        _ => return Err(bad()),
    };
    if !(1024..=65534).contains(&port) { return Err(bad()); }
    match get("AHAP_BROWSER_VIBE_STATE_DIR") {
        Some(state) if state.len() > 1 && state.starts_with('/')
            && state.bytes().all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
            && !state.split('/').any(|part| part == "..") => (),
        None if port == 19888 => (),
        _ => return Err(bad()),
    }
    Ok(())
}

fn codex_kind() -> String {
    "codex".into()
}

pub struct OpenedOwner {
    pub authority: ScopedAuthority,
    pub owner: OwnerProfile,
    pub database: PathBuf,
    pub gate: PathBuf,
    pub generation: String,
}

/// Reject symlinks and any executable path component writable by another UID.
fn trusted_executable(path: &Path) -> io::Result<()> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let uid = unsafe { geteuid() };
    if !path.is_absolute() || path.canonicalize()? != path {
        return Err(invalid());
    }
    for (index, component) in path.ancestors().enumerate() {
        let m = std::fs::symlink_metadata(component)?;
        if (m.uid() != uid && m.uid() != 0)
            || m.mode() & 0o022 != 0
            || (index == 0 && !m.is_file())
            || (index > 0 && !m.is_dir())
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "invalid or untrusted scoped launch profile",
    )
}

/// The profile is a local protected file, not MCP arguments or request metadata.
/// Its authority remains subject to the normal generation and hold rechecks.
pub fn open(path: &Path) -> Result<ScopedAuthority, Box<dyn std::error::Error>> {
    Ok(open_profile(path)?.0)
}

/// Explicit opt-in only; an ordinary scoped profile never establishes caller identity.
pub fn open_owner(path: &Path) -> Result<OpenedOwner, Box<dyn std::error::Error>> {
    let (authority, profile) = open_profile(path)?;
    let owner = profile.owner.ok_or_else(invalid)?;
    if [&owner.principal, &owner.node, &owner.instance]
        .iter()
        .any(|s| s.is_empty() || s.len() > 4096 || s.chars().any(char::is_control))
        || !owner.executable.is_absolute()
        || !owner.code_home.is_absolute()
        || !owner.cwd.is_absolute()
    {
        return Err(invalid().into());
    }
    match owner.kind.as_str() {
        "codex" if owner.ahap_script.is_none() && owner.ahap_base_url.is_none() && owner.ahap_env.is_empty() => (),
        "opencode" | "codex" | "zcode" | "chatgpt" | "zai" => {
            trusted_executable(&owner.executable)?;
            if !owner.ahap_script.as_ref().is_some_and(|p| p.is_absolute()) {
                return Err(invalid().into());
            }
            trusted_executable(owner.ahap_script.as_ref().ok_or_else(invalid)?)?;
            if owner.kind == "opencode" {
                let url = reqwest::Url::parse(owner.ahap_base_url.as_deref().ok_or_else(invalid)?)?;
                if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                {
                    return Err(invalid().into());
                }
            } else if owner.ahap_base_url.is_some() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput,
                    "ahap_base_url belongs to opencode; configure the selected adapter through ahap_env").into());
            }
            for (key, value) in &owner.ahap_env {
                if key == "AGENT_HERDER_WORKLOAD_ISOLATION" && value != "off" {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput,
                        "AGENT_HERDER_WORKLOAD_ISOLATION only accepts the exact value \"off\" (direct-child launch without the isolation wrapper)").into());
                }
                if !allowed_adapter_env(&owner.kind, key) || value.contains('\0') || value.len() > 8192 {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput,
                        format!("unsupported adapter environment key {key}; use the documented keys for owner.kind, without process loader or identity overrides")).into());
                }
            }
            if matches!(owner.kind.as_str(), "chatgpt" | "zai") {
                validate_browser_binding(&owner.ahap_env)?;
            }
        }
        _ => return Err(invalid().into()),
    }
    validate_existing_sessions(&owner)?;
    Ok(OpenedOwner {
        authority,
        owner,
        database: profile.database,
        gate: profile.gate,
        generation: profile.generation,
    })
}

/// A protected profile grants only exact existing native identities in its
/// pinned account. No wildcard, native draft alias, or cross-provider import.
fn validate_existing_sessions(owner: &OwnerProfile) -> io::Result<()> {
    if owner.existing_sessions.is_empty() { return Ok(()) }
    if owner.kind != "chatgpt" || owner.ahap_script.is_none() || owner.existing_sessions.len() > 256 {
        return Err(invalid());
    }
    let scope = owner
        .ahap_env
        .get("AHAP_BROWSER_ACCOUNT_SCOPE")
        .or_else(|| owner.ahap_env.get("AHAP_USERIO_ACCOUNT_SCOPE"))
        .ok_or_else(invalid)?;
    let mut keys = std::collections::BTreeSet::new();
    let mut natives = std::collections::BTreeSet::new();
    for approval in &owner.existing_sessions {
        if !approval.valid() || &approval.account_scope != scope
            || !keys.insert(&approval.request_key) || !natives.insert(&approval.native_session_id) {
            return Err(invalid());
        }
    }
    Ok(())
}

fn open_profile(path: &Path) -> Result<(ScopedAuthority, Profile), Box<dyn std::error::Error>> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let uid = unsafe { geteuid() };
    let parent = path.parent().ok_or_else(invalid)?;
    // Root-owned or current-user-owned ancestors must not be replaceable by
    // another user. Same-UID adversaries and concurrent chmod are out of scope.
    for ancestor in parent.ancestors() {
        let m = std::fs::symlink_metadata(ancestor)?;
        if !m.is_dir() || (m.uid() != uid && m.uid() != 0) || m.mode() & 0o022 != 0 {
            return Err(invalid().into());
        }
    }
    let dir = parent.metadata()?;
    if !path.is_absolute()
        || parent.canonicalize()? != parent
        || !dir.is_dir()
        || dir.uid() != uid
        || dir.mode() & 0o077 != 0
    {
        return Err(invalid().into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(0x20000 | 0x800)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != uid
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.len() > 16384
    {
        return Err(invalid().into());
    }
    let mut json = String::new();
    (&mut file).take(16385).read_to_string(&mut json)?;
    if json.len() > 16384 {
        return Err(invalid().into());
    }
    let p: Profile = serde_json::from_str(&json)?;
    if p.database.parent() != Some(parent)
        || p.gate.parent() != Some(parent)
        || p.generation.is_empty()
        || p.generation.len() > 4096
        || p.generation.chars().any(char::is_control)
    {
        return Err(invalid().into());
    }
    let gm = std::fs::symlink_metadata(&p.gate)?;
    let _guard = acquire_pinned(&p.gate, gm.dev(), gm.ino())?;
    // O_NOFOLLOW | O_NONBLOCK prevents symlink and special-file blocking.
    let database = OpenOptions::new()
        .read(true)
        .custom_flags(0x20000 | 0x800)
        .open(&p.database)?;
    let dm = database.metadata()?;
    if !dm.is_file()
        || dm.uid() != uid
        || dm.nlink() != 1
        || dm.mode() & 0o077 != 0
        || p.database.canonicalize()? != p.database
    {
        return Err(invalid().into());
    }
    // Protected ancestors prevent other UIDs from swapping the pathname while
    // SQLite opens it. Pin the file descriptor and compare device/inode again
    // before and after the single read transaction; no same-UID claim is made.
    let db = rusqlite::Connection::open_with_flags(
        &p.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let same = || -> io::Result<bool> {
        let pinned = database.metadata()?;
        let named = std::fs::symlink_metadata(&p.database)?;
        Ok(pinned.is_file()
            && named.is_file()
            && pinned.dev() == dm.dev()
            && pinned.ino() == dm.ino()
            && named.dev() == dm.dev()
            && named.ino() == dm.ino()
            && named.nlink() == 1
            && named.uid() == uid
            && named.mode() & 0o077 == 0)
    };
    if !same()? {
        return Err(invalid().into());
    }
    db.execute_batch("BEGIN")?;
    let opened_path: String = db.query_row(
        "SELECT file FROM pragma_database_list WHERE name='main'",
        [],
        |r| r.get(0),
    )?;
    let opened_metadata = std::fs::symlink_metadata(&opened_path)?;
    if opened_metadata.dev() != dm.dev() || opened_metadata.ino() != dm.ino() {
        return Err(invalid().into());
    }
    Writer::validate_scoped_schema(&db)?;
    let row: (String, i64, i64, i64, i64) = db.query_row("SELECT generation,gate_device,gate_inode,database_device,database_inode FROM humanstop_authority WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if row
        != (
            p.generation.clone(),
            gm.dev().try_into()?,
            gm.ino().try_into()?,
            dm.dev().try_into()?,
            dm.ino().try_into()?,
        )
        || !same()?
    {
        return Err(invalid().into());
    }
    db.execute_batch("COMMIT")?;
    let authority = ScopedAuthority::new(p.database.clone(), p.gate.clone(), p.generation.clone())
        .map_err(|_| invalid())?;
    Ok((authority, p))
}

#[cfg(test)]
mod enrollment_tests {
    use super::*;
    use herder::application::scoped_stop::enroll::ExistingSessionApproval;
    fn owner() -> OwnerProfile {
        OwnerProfile {
            principal:"owner".into(),node:"node".into(),instance:"profile".into(),
            executable:"/usr/bin/node".into(),code_home:"/home/owner".into(),cwd:"/home/owner/project".into(),
            kind:"chatgpt".into(),ahap_script:Some("/opt/herder/browser.js".into()),ahap_base_url:None,
            ahap_env:BTreeMap::from([("AHAP_BROWSER_ACCOUNT_SCOPE".into(),"b".repeat(64))]),
            existing_sessions:vec![ExistingSessionApproval{request_key:"k".into(),native_session_id:"native~conversation".into(),account_scope:"b".repeat(64)}],
        }
    }
    #[test]
    fn exact_profile_account_scope_is_required() {
        let mut profile=owner();assert!(validate_existing_sessions(&profile).is_ok());
        profile.existing_sessions[0].account_scope="a".repeat(64);assert!(validate_existing_sessions(&profile).is_err());
        let mut profile=owner();profile.kind="zai".into();assert!(validate_existing_sessions(&profile).is_err());
        let mut profile=owner();profile.ahap_script=None;assert!(validate_existing_sessions(&profile).is_err());
    }
    #[test]
    fn duplicate_keys_natives_and_wildcards_are_not_grants() {
        let mut profile=owner();profile.existing_sessions.push(profile.existing_sessions[0].clone());
        assert!(validate_existing_sessions(&profile).is_err());
        profile.existing_sessions[1].request_key="other".into();assert!(validate_existing_sessions(&profile).is_err());
        profile.existing_sessions[1].native_session_id="other".into();assert!(validate_existing_sessions(&profile).is_ok());
        profile.existing_sessions[1].request_key="k".into();assert!(validate_existing_sessions(&profile).is_err());
        let mut profile=owner();profile.existing_sessions[0].native_session_id="*".into();assert!(validate_existing_sessions(&profile).is_err());
    }
    #[test]
    fn vibe_route_references_are_browser_only() {
        for key in ["AHAP_BROWSER_MCP_URL", "AHAP_BROWSER_MCP_PROFILE_FILE"] {
            assert!(allowed_adapter_env("chatgpt", key));
            assert!(allowed_adapter_env("zai", key));
            assert!(!allowed_adapter_env("codex", key));
            assert!(!allowed_adapter_env("opencode", key));
            assert!(!allowed_adapter_env("zcode", key));
        }
        assert!(!allowed_adapter_env("chatgpt", "VIBE_REMOTE_URL"));
        assert!(!allowed_adapter_env("chatgpt", "VIBE_EXTENSION_UUID"));
        assert!(!allowed_adapter_env("chatgpt", "NODE_OPTIONS"));
    }

    #[test]
    fn userio_binding_accepts_exact_protected_profile() {
        use std::{fs, os::unix::fs::PermissionsExt, time::{SystemTime, UNIX_EPOCH}};
        let path = std::env::temp_dir().join(format!(
            "herder-userio-token-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::write(&path, "userio-secret-token").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut env = BTreeMap::from([
            ("AHAP_BROWSER_TRANSPORT".into(), "userio".into()),
            ("AHAP_USERIO_ENDPOINT".into(), "https://userio.example/".into()),
            ("AHAP_USERIO_AGENT_ID".into(), "browser-owner".into()),
            ("AHAP_USERIO_INSTANCE_ID".into(), "browser-01234567-89ab-cdef-0123-456789abcdef".into()),
            ("AHAP_BROWSER_ACCOUNT_SCOPE".into(), "b".repeat(64)),
            ("AHAP_USERIO_ACCESS_TOKEN_FILE".into(), path.to_string_lossy().into_owned()),
        ]);
        assert!(validate_userio_binding(&env).is_ok());
        env.insert("AHAP_USERIO_ACCOUNT_SCOPE".into(), "b".repeat(64));
        assert!(validate_userio_binding(&env).is_ok());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn userio_binding_rejects_unsafe_transport_and_credentials() {
        use std::{fs, os::unix::fs::PermissionsExt, time::{SystemTime, UNIX_EPOCH}};
        let path = std::env::temp_dir().join(format!(
            "herder-userio-token-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::write(&path, "userio-secret-token").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let base = BTreeMap::from([
            ("AHAP_BROWSER_TRANSPORT".into(), "userio".into()),
            ("AHAP_USERIO_ENDPOINT".into(), "https://userio.example/".into()),
            ("AHAP_USERIO_AGENT_ID".into(), "browser-owner".into()),
            ("AHAP_USERIO_INSTANCE_ID".into(), "browser-01234567-89ab-cdef-0123-456789abcdef".into()),
            ("AHAP_BROWSER_ACCOUNT_SCOPE".into(), "b".repeat(64)),
            ("AHAP_USERIO_ACCESS_TOKEN_FILE".into(), path.to_string_lossy().into_owned()),
        ]);
        for (name, value) in [
            ("AHAP_USERIO_ENDPOINT", "http://userio.example/"),
            ("AHAP_USERIO_ENDPOINT", "https://userio.example/path"),
            ("AHAP_USERIO_ENDPOINT", "https://user:pass@userio.example/"),
            ("AHAP_USERIO_INSTANCE_ID", "browser-invalid"),
            ("AHAP_BROWSER_TRANSPORT", "vibe"),
        ] {
            let mut env = base.clone();
            env.insert(name.into(), value.into());
            assert!(validate_userio_binding(&env).is_err(), "invalid {name}={value}");
        }
        let mut env = base.clone();
        env.insert("AHAP_BROWSER_CDP_WS_URL".into(), "wss://foreign".into());
        assert!(validate_userio_binding(&env).is_err(), "mixed CDP/UserIO binding");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(validate_userio_binding(&base).is_err(), "group-readable token");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_profile_without_enrollment_remains_valid() {
        let mut profile=owner();profile.existing_sessions.clear();profile.kind="codex".into();
        assert!(validate_existing_sessions(&profile).is_ok());
    }
}
