//! The TypeScript browser runners and native runners share one JSON file per draft.
//! Native writers lock the stable account directory across read, transition, rename
//! and directory fsync. No lock is held while a browser operation is in flight.
use super::{Provider, valid_route};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, ErrorKind, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::SystemTime,
};

const MAX_DRAFTS: usize = 100;
const MAX_BYTES: usize = 2048; // TypeScript skips larger records on restart.
const DEFAULT_ROOT: &str = ".local/state/agent-herder/browser-chat-drafts";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DraftState {
    Pending,
    Sending,
    Uncertain,
    Admitted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Draft {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) state: DraftState,
    pub(super) remote_id: Option<String>,
    pub(super) target_id: Option<String>,
}

enum Transition<'a> {
    Reserve(&'a str),
    ResetBeforeClick(&'a str),
    MarkUncertain,
    Confirm {
        remote: &'a str,
        message: &'a str,
        target: &'a str,
        binding: &'a str,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    title: String,
    state: DraftState,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_id: Option<String>,
    // The TS reader only accepts UUID-shaped IDs in this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    native_input_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_binding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_reservation: Option<String>,
    // Preserve commandId, inputDigest and any extensions on read/modify/write.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn conflict() -> io::Error {
    io::Error::new(
        ErrorKind::AlreadyExists,
        "draft first-send reservation changed",
    )
}

fn invalid_record() -> io::Error {
    io::Error::new(ErrorKind::InvalidData, "invalid browser draft record")
}

fn sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn new_uuid() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let n = u128::from_be_bytes(bytes);
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        n >> 96,
        (n >> 80) as u16,
        (n >> 64) as u16,
        (n >> 48) as u16,
        n & 0xffff_ffff_ffff
    ))
}

fn filename(id: &str) -> io::Result<String> {
    let suffix = id
        .strip_prefix("draft:")
        .filter(|s| uuid(s))
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "invalid browser draft ID"))?;
    Ok(format!("{suffix}.json"))
}

fn hex_route(id: &str) -> bool {
    id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn valid_remote(provider: Provider, raw: &str) -> bool {
    let min = match provider {
        Provider::ChatGpt => 28,
        Provider::Zai => 12,
    };
    (min..=80).contains(&raw.len()) && hex_route(raw)
}

impl Record {
    fn pending(provider: Provider, title: &str, uuid: String, now: SystemTime) -> Self {
        let mut units = 0;
        let mut title: String = title
            .trim()
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 120
            })
            .collect();
        if title.is_empty() {
            title = match provider {
                Provider::ChatGpt => "Новый чат ChatGPT",
                Provider::Zai => "Новый чат Z.ai",
            }
            .into();
        }
        Self {
            id: format!("draft:{uuid}"),
            title,
            state: DraftState::Pending,
            created_at: DateTime::<Utc>::from(now).to_rfc3339_opts(SecondsFormat::Nanos, true),
            remote_id: None,
            native_input_message_id: None,
            native_message_id: None,
            target_id: None,
            target_binding: None,
            native_reservation: None,
            extra: Default::default(),
        }
    }

    fn transition(self, provider: Provider, change: Transition<'_>) -> io::Result<Self> {
        use DraftState::{Admitted, Pending, Sending, Uncertain};
        match (self.state, change) {
            (Pending, Transition::Reserve(owner)) => Ok(Self {
                state: Sending,
                native_reservation: Some(owner.into()),
                ..self
            }),
            // Only the instance which observed the pre-click failure may reopen a draft.
            (Sending, Transition::ResetBeforeClick(owner))
                if self.native_reservation.as_deref() == Some(owner) =>
            {
                Ok(Self {
                    state: Pending,
                    native_reservation: None,
                    ..self
                })
            }
            (Sending, Transition::MarkUncertain) => Ok(Self {
                state: Uncertain,
                native_reservation: None,
                ..self
            }),
            (
                Sending | Uncertain,
                Transition::Confirm {
                    remote,
                    message,
                    target,
                    binding,
                },
            ) => {
                if !valid_remote(provider, remote)
                    || !valid_message(message)
                    || !valid_route(target)
                {
                    return Err(io::Error::new(
                        ErrorKind::InvalidInput,
                        "invalid browser first-send receipt",
                    ));
                }
                let legacy_id = message.len() == 36 && hex_route(message);
                Ok(Self {
                    state: Admitted,
                    remote_id: Some(match provider {
                        Provider::ChatGpt => remote.into(),
                        Provider::Zai => format!("route:{remote}"),
                    }),
                    native_input_message_id: legacy_id.then(|| message.into()),
                    native_message_id: (!legacy_id).then(|| message.into()),
                    target_id: Some(target.into()),
                    target_binding: Some(binding.into()),
                    native_reservation: None,
                    ..self
                })
            }
            _ => Err(conflict()),
        }
    }

    fn raw_remote(&self, provider: Provider) -> Option<&str> {
        let stored = self.remote_id.as_deref()?;
        match provider {
            Provider::ChatGpt => Some(stored),
            Provider::Zai => stored.strip_prefix("route:"),
        }
    }

    fn validate(&self, provider: Provider, expected_id: &str) -> io::Result<()> {
        let admitted = self.state == DraftState::Admitted;
        let valid_binding = match self.remote_id {
            Some(_) => {
                admitted
                    && self
                        .raw_remote(provider)
                        .is_some_and(|s| valid_remote(provider, s))
            }
            None => !admitted,
        };
        let legacy_receipt = self.native_input_message_id.as_deref();
        if self.id != expected_id
            || self.title.encode_utf16().count() > 180
            || !valid_binding
            || legacy_receipt.is_some_and(|s| !admitted || s.len() != 36 || !hex_route(s))
            || self
                .native_message_id
                .as_deref()
                .is_some_and(|s| !admitted || !valid_message(s))
            || self
                .target_id
                .as_deref()
                .is_some_and(|s| !admitted || !valid_route(s))
            || self
                .target_binding
                .as_deref()
                .is_some_and(|s| self.target_id.is_none() || !sha256_hex(s))
            || self.native_reservation.as_deref().is_some_and(|s| !uuid(s))
            || self
                .extra
                .get("inputDigest")
                .is_some_and(|v| !v.as_str().is_some_and(sha256_hex))
            || self.extra.get("commandId").is_some_and(|v| {
                !v.as_str().is_some_and(|s| {
                    (1..=256).contains(&s.len())
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                })
            })
        {
            return Err(invalid_record());
        }
        Ok(())
    }

    fn into_draft(self, provider: Provider, target_binding: &str) -> Draft {
        let remote_id = self.raw_remote(provider).map(str::to_owned);
        // The store supplies only a target ID for the caller's pinned endpoint.
        // The caller still verifies the live page origin, account, context and route.
        let target_id = self
            .target_id
            .filter(|_| self.target_binding.as_deref() == Some(target_binding));
        Draft {
            id: self.id,
            title: self.title,
            state: self.state,
            remote_id,
            target_id,
        }
    }
}

fn valid_message(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn directory_file(path: &Path, create: bool) -> io::Result<File> {
    let open = || {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)
    };
    match open() {
        Err(e) if create && e.kind() == ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let parent = directory_file(parent, true)?;
            match DirBuilder::new().mode(0o700).create(path) {
                Err(e) if e.kind() != ErrorKind::AlreadyExists => return Err(e),
                _ => {}
            }
            parent.sync_all()?;
            open()
        }
        result => result,
    }
}

fn owned_directory(path: &Path, create: bool, forbidden_mode: u32) -> io::Result<File> {
    let dir = directory_file(path, create)?;
    let meta = dir.metadata()?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & forbidden_mode != 0 {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "untrusted browser draft directory",
        ));
    }
    Ok(dir)
}

fn read_record(dir: &Path, provider: Provider, id: &str) -> io::Result<Record> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(filename(id)?))?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.nlink() > 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.len() > MAX_BYTES as u64
    {
        return Err(invalid_record());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid_record());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| invalid_record())?;
    record.validate(provider, id)?;
    Ok(record)
}

fn save(dir: &Path, guard: &File, record: &Record) -> io::Result<()> {
    let path = dir.join(filename(&record.id)?);
    let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid_record());
    }
    let temp = dir.join(format!(".{}.tmp", new_uuid()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        guard.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(super) struct DraftStore {
    root: PathBuf,
    provider: Option<Provider>,
    account_scope: String,
    target_binding: String,
    reset_owner: OnceLock<String>,
}

impl DraftStore {
    pub(super) fn new(
        home: &Path,
        harness: &str,
        account_scope: &str,
        endpoint: &str,
        node_id: &str,
        instance_id: &str,
        browser_context_id: &str,
    ) -> Self {
        let root = env::var_os("AGENT_HERDER_BROWSER_DRAFT_ROOT")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(DEFAULT_ROOT));
        let provider = match harness {
            "chatgpt" => Some(Provider::ChatGpt),
            "zai" => Some(Provider::Zai),
            _ => None,
        };
        let mut hash = Sha256::new();
        for field in [
            harness,
            account_scope,
            endpoint,
            node_id,
            instance_id,
            browser_context_id,
        ] {
            hash.update((field.len() as u64).to_be_bytes());
            hash.update(field.as_bytes());
        }
        let target_binding = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        Self {
            root,
            provider,
            account_scope: account_scope.into(),
            target_binding,
            reset_owner: OnceLock::new(),
        }
    }

    fn directory(&self, create: bool) -> io::Result<(Provider, PathBuf, File)> {
        let provider = self
            .provider
            .filter(|_| sha256_hex(&self.account_scope))
            .ok_or_else(|| {
                io::Error::new(ErrorKind::InvalidInput, "invalid browser draft scope")
            })?;
        let provider_dir = self.root.join(provider.name());
        let account_dir = provider_dir.join(&self.account_scope);
        owned_directory(&self.root, create, 0o022)?;
        owned_directory(&provider_dir, create, 0o022)?;
        let dir = owned_directory(&account_dir, create, 0o077)?;
        Ok((provider, account_dir, dir))
    }

    pub(super) fn get(&self, id: &str) -> io::Result<Draft> {
        let (provider, dir, guard) = self.directory(false)?;
        guard.lock_shared()?;
        Ok(read_record(&dir, provider, id)?.into_draft(provider, &self.target_binding))
    }

    pub(super) fn list(&self) -> io::Result<Vec<Draft>> {
        let (provider, dir, guard) = match self.directory(false) {
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            result => result?,
        };
        guard.lock_shared()?;
        let mut newest = BTreeMap::new();
        for entry in fs::read_dir(&dir)? {
            let name = entry?.file_name();
            let Some(suffix) = name
                .to_str()
                .and_then(|s| s.strip_suffix(".json"))
                .filter(|s| uuid(s))
            else {
                continue;
            };
            let id = format!("draft:{suffix}");
            let record = match read_record(&dir, provider, &id) {
                Err(e)
                    if matches!(e.kind(), ErrorKind::InvalidData | ErrorKind::NotFound)
                        || e.raw_os_error() == Some(libc::ELOOP) =>
                {
                    continue;
                }
                result => result?,
            };
            let created = DateTime::parse_from_rfc3339(&record.created_at).ok();
            newest.insert(
                (created, id),
                record.into_draft(provider, &self.target_binding),
            );
            if newest.len() > MAX_DRAFTS {
                newest.pop_first();
            }
        }
        Ok(newest.into_values().rev().collect())
    }

    pub(super) fn create(&self, title: &str) -> io::Result<Draft> {
        let (provider, dir, guard) = self.directory(true)?;
        guard.lock()?;
        // Count under the same lock as the rename. A damaged record still occupies its slot.
        let mut count = 0;
        for entry in fs::read_dir(&dir)? {
            if entry?
                .file_name()
                .to_str()
                .and_then(|s| s.strip_suffix(".json"))
                .is_some_and(uuid)
            {
                count += 1;
                if count >= MAX_DRAFTS {
                    return Err(io::Error::other("browser account has 100 drafts"));
                }
            }
        }
        let record = Record::pending(provider, title, new_uuid()?, SystemTime::now());
        match fs::symlink_metadata(dir.join(filename(&record.id)?)) {
            Ok(_) => return Err(conflict()),
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        save(&dir, &guard, &record)?;
        Ok(record.into_draft(provider, &self.target_binding))
    }

    fn update(&self, id: &str, change: Transition<'_>) -> io::Result<()> {
        let (provider, dir, guard) = self.directory(false)?;
        guard.lock()?;
        let record = read_record(&dir, provider, id)?.transition(provider, change)?;
        save(&dir, &guard, &record)
    }

    pub(super) fn begin(&self, id: &str) -> io::Result<()> {
        let owner = match self.reset_owner.get() {
            Some(owner) => owner,
            None => {
                let token = new_uuid()?;
                self.reset_owner.get_or_init(|| token)
            }
        };
        self.update(id, Transition::Reserve(owner))
    }

    pub(super) fn reset(&self, id: &str) -> io::Result<()> {
        let owner = self.reset_owner.get().ok_or_else(conflict)?;
        self.update(id, Transition::ResetBeforeClick(owner))
    }

    pub(super) fn uncertain(&self, id: &str) -> io::Result<()> {
        self.update(id, Transition::MarkUncertain)
    }

    pub(super) fn bind(
        &self,
        id: &str,
        remote: &str,
        native_message: &str,
        target_id: &str,
    ) -> io::Result<()> {
        self.update(
            id,
            Transition::Confirm {
                remote,
                message: native_message,
                target: target_id,
                binding: &self.target_binding,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader},
        os::unix::fs::{PermissionsExt, symlink},
        process::{Command, Stdio},
        sync::{Arc, Barrier},
        thread,
    };

    const SCOPE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ENDPOINT: &str = "ws://127.0.0.1:9222/devtools/browser/test-browser";
    const REMOTE: &str = "c0010000-0000-4000-8000-000000000001";
    const MESSAGE: &str = "f0010000-0000-4000-8000-000000000001";
    const LEGACY: &str = "draft:d0010000-0000-4000-8000-000000000001";

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let path =
                env::temp_dir().join(format!("herder-browser-drafts-{}", new_uuid().unwrap()));
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
        fn store(&self, harness: &str) -> DraftStore {
            self.scoped(harness, SCOPE, [ENDPOINT, "node", "instance", "context"])
        }
        fn scoped(&self, harness: &str, scope: &str, cdp: [&str; 4]) -> DraftStore {
            let [endpoint, node, instance, context] = cdp;
            let mut store =
                DraftStore::new(&self.0, harness, scope, endpoint, node, instance, context);
            // Unit tests use a private home even if a user's root override is set.
            store.root = self.0.join(DEFAULT_ROOT);
            store
        }
        fn dir(&self, harness: &str) -> PathBuf {
            self.0.join(DEFAULT_ROOT).join(harness).join(SCOPE)
        }
        fn disk(&self, harness: &str, id: &str) -> Value {
            serde_json::from_slice(
                &fs::read(self.dir(harness).join(filename(id).unwrap())).unwrap(),
            )
            .unwrap()
        }
        fn legacy(&self, harness: &str, value: &Value) {
            let dir = self.dir(harness);
            DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&dir)
                .unwrap();
            let id = value["id"].as_str().unwrap();
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(dir.join(filename(id).unwrap()))
                .unwrap();
            serde_json::to_writer(file, value).unwrap();
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn separate_processes_compete_then_restart_without_replaying() {
        const CHILD_HOME: &str = "HERDER_DRAFT_CAS_TEST_HOME";
        const CHILD_ID: &str = "HERDER_DRAFT_CAS_TEST_ID";
        if let Some(home) = env::var_os(CHILD_HOME) {
            let id = env::var(CHILD_ID).unwrap();
            let store = DraftStore::new(
                Path::new(&home),
                "zai",
                SCOPE,
                ENDPOINT,
                "node",
                "instance",
                "context",
            );
            assert_eq!(store.get(&id).unwrap().state, DraftState::Pending);
            println!("READY");
            io::stdout().flush().unwrap();
            io::stdin().read_exact(&mut [0u8]).unwrap();
            let exit = match store.begin(&id) {
                Ok(()) => 31,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => 32,
                Err(e) => panic!("reserve first send: {e}"),
            };
            // Exit without running destructors or settling the winning reservation.
            std::process::exit(exit);
        }

        let home = Home::new();
        let pending = home.store("zai").create("first message").unwrap();
        let mut children = Vec::new();
        for _ in 0..2 {
            let mut child = Command::new(env::current_exe().unwrap())
                .args(["--exact", thread::current().name().unwrap(), "--nocapture"])
                .env_remove("AGENT_HERDER_BROWSER_DRAFT_ROOT")
                .env(CHILD_HOME, &home.0)
                .env(CHILD_ID, &pending.id)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            assert!(
                BufReader::new(child.stdout.take().unwrap())
                    .lines()
                    .any(|s| s.unwrap() == "READY")
            );
            children.push(child);
        }
        for child in &mut children {
            child.stdin.take().unwrap().write_all(b"!").unwrap();
        }
        let mut codes: Vec<_> = children
            .iter_mut()
            .map(|c| c.wait().unwrap().code().unwrap())
            .collect();
        codes.sort();
        assert_eq!(codes, [31, 32]);

        let store = home.store("zai");
        let id = &pending.id;
        assert_eq!(store.get(id).unwrap().state, DraftState::Sending);
        assert!(store.begin(id).is_err());
        assert!(store.reset(id).is_err());
        store.uncertain(id).unwrap();
        let restarted = home.store("zai");
        assert_eq!(restarted.get(id).unwrap().state, DraftState::Uncertain);
        assert!(restarted.begin(id).is_err());
        assert!(restarted.reset(id).is_err());
        restarted.bind(id, REMOTE, MESSAGE, "page-1").unwrap();
        let restored = home.store("zai").get(id).unwrap();
        assert_eq!(restored.state, DraftState::Admitted);
        assert_eq!(restored.remote_id.as_deref(), Some(REMOTE));
        assert_eq!(restored.target_id.as_deref(), Some("page-1"));
        assert_eq!(home.disk("zai", id)["nativeInputMessageId"], MESSAGE);
        assert_eq!(home.disk("zai", id)["remoteId"], format!("route:{REMOTE}"));
        assert!(store.begin(id).is_err());
        assert!(store.uncertain(id).is_err());
    }

    #[test]
    fn only_preclick_owner_can_reset_and_binding_is_scoped_to_the_created_target() {
        let home = Home::new();
        let store = home.store("chatgpt");
        let id = &store.create("  chat  ").unwrap().id;
        let contender = home.store("chatgpt");
        store.begin(id).unwrap();
        assert!(contender.reset(id).is_err());
        store.reset(id).unwrap();
        contender.begin(id).unwrap();
        assert!(store.reset(id).is_err());
        for bad_target in [
            "ws://localhost:9000/devtools/page/a",
            "../tab",
            "x?target=y",
        ] {
            assert!(contender.bind(id, REMOTE, MESSAGE, bad_target).is_err());
        }
        assert!(
            contender
                .bind(id, &format!("route:{REMOTE}"), MESSAGE, "tab")
                .is_err()
        );
        assert_eq!(store.get(id).unwrap().state, DraftState::Sending);
        contender.bind(id, REMOTE, "message-7", "new-tab").unwrap();
        let disk = home.disk("chatgpt", id);
        assert_eq!(disk["remoteId"], REMOTE);
        assert_eq!(disk["nativeMessageId"], "message-7");
        assert!(disk.get("nativeInputMessageId").is_none());
        assert_eq!(store.get(id).unwrap().target_id.as_deref(), Some("new-tab"));
        for changed in [
            [
                "ws://127.0.0.1:9333/devtools/browser/other",
                "node",
                "instance",
                "context",
            ],
            [ENDPOINT, "other-node", "instance", "context"],
            [ENDPOINT, "node", "other-instance", "context"],
            [ENDPOINT, "node", "instance", "other-context"],
        ] {
            let other = home.scoped("chatgpt", SCOPE, changed);
            let draft = other.get(id).unwrap();
            assert_eq!(draft.remote_id.as_deref(), Some(REMOTE));
            assert_eq!(draft.target_id, None);
            assert_eq!(other.list().unwrap(), [draft]);
        }
        assert!(home.store("zai").list().unwrap().is_empty());
        assert_eq!(
            home.store("zai").get(id).unwrap_err().kind(),
            ErrorKind::NotFound
        );
        assert!(
            home.scoped(
                "chatgpt",
                &"b".repeat(64),
                [ENDPOINT, "node", "instance", "context"]
            )
            .list()
            .unwrap()
            .is_empty()
        );
        assert!(contender.bind(id, MESSAGE, REMOTE, "other-page").is_err());
        assert_eq!(home.disk("chatgpt", id), disk);
    }

    #[test]
    fn reads_typescript_records_and_preserves_legacy_recovery_fields() {
        let home = Home::new();
        for harness in ["chatgpt", "zai"] {
            let stored_remote = if harness == "zai" {
                format!("route:{REMOTE}")
            } else {
                REMOTE.to_owned()
            };
            home.legacy(
                harness,
                &json!({"id": LEGACY, "title": "TS", "state": "admitted",
                "createdAt": "2026-11-01T10:00:00.000Z", "remoteId": stored_remote}),
            );
            let store = home.store(harness);
            let restored = store.get(LEGACY).unwrap();
            assert_eq!(restored.remote_id.as_deref(), Some(REMOTE));
            assert_eq!(restored.target_id, None);
            assert_eq!(store.list().unwrap(), [restored]);
            assert!(store.begin(LEGACY).is_err());
            let uncertain = format!("draft:{}", new_uuid().unwrap());
            let digest = "e".repeat(64);
            home.legacy(harness, &json!({"id":uncertain,"title":"awaiting receipt","state":"uncertain",
                "createdAt":"2026-11-01T10:00:00.001Z","commandId":"original:1","inputDigest":digest}));
            assert!(store.begin(&uncertain).is_err());
            store.bind(&uncertain, REMOTE, MESSAGE, "tab-2").unwrap();
            let disk = home.disk(harness, &uncertain);
            assert_eq!(disk["remoteId"], stored_remote);
            assert_eq!(disk["nativeInputMessageId"], MESSAGE);
            assert_eq!(disk["commandId"], "original:1");
            assert_eq!(disk["inputDigest"], digest);
            assert_eq!(store.list().unwrap()[0].id, uncertain);
        }
    }

    #[test]
    fn missing_reads_stay_read_only_and_files_are_private() {
        let home = Home::new();
        let store = home.store("chatgpt");
        assert!(store.list().unwrap().is_empty());
        assert_eq!(store.get(LEGACY).unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
        for (harness, scope) in [("../zai", SCOPE), ("chatgpt", "../another-account")] {
            assert!(
                home.scoped(harness, scope, [ENDPOINT, "node", "instance", "context"])
                    .create("bad")
                    .is_err()
            );
        }
        let draft = store.create("   ").unwrap();
        assert_eq!(draft.title, "Новый чат ChatGPT");
        let dir = home.dir("chatgpt");
        let path = dir.join(filename(&draft.id).unwrap());
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        symlink(path, dir.join(filename(LEGACY).unwrap())).unwrap();
        fs::write(dir.join(".interrupted.tmp"), b"unfinished").unwrap();
        assert!(store.get(LEGACY).is_err());
        assert!(store.begin(LEGACY).is_err());
        assert!(store.get("../other.json").is_err());
        assert_eq!(store.list().unwrap(), [draft]);
        symlink(&dir, dir.parent().unwrap().join("b".repeat(64))).unwrap();
        let alias = home.scoped(
            "chatgpt",
            &"b".repeat(64),
            [ENDPOINT, "node", "instance", "context"],
        );
        assert!(alias.create("wrong account").is_err());
    }

    #[test]
    fn concurrent_creates_share_the_last_slot_and_overfull_legacy_lists_stay_bounded() {
        let home = Home::new();
        let store = home.store("zai");
        for n in 0..MAX_DRAFTS - 1 {
            store.create(&n.to_string()).unwrap();
        }
        let go = Arc::new(Barrier::new(2));
        let won = thread::scope(|threads| {
            let mut handles = Vec::new();
            for _ in 0..2 {
                let store = home.store("zai");
                let go = Arc::clone(&go);
                handles.push(threads.spawn(move || {
                    go.wait();
                    store.create("last slot").is_ok()
                }));
            }
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|&won| won)
                .count()
        });
        assert_eq!(won, 1);
        assert_eq!(store.list().unwrap().len(), MAX_DRAFTS);
        home.legacy("zai", &json!({"id":LEGACY,"title":"latest","state":"pending","createdAt":"9999-12-31T23:59:59.999Z"}));
        let list = store.list().unwrap();
        assert_eq!(list.len(), MAX_DRAFTS);
        assert_eq!(list[0].id, LEGACY);
        assert!(store.create("overflow").is_err());
    }
}
