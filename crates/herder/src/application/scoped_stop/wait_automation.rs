//! One-shot timer and exact-session completion waits in the canonical authority.
pub use super::wait_sources::{
    DependencyRegistry, DependencySource, NativeOwner, NativeTurn, NativeTurnReader,
    NativeTurnStatus, native_turn,
};
use super::{
    ScopedAuthority,
    automation_driver::AutomationTick,
    wait_sources::{self, SessionProof},
};
use crate::{
    auth::identity::{ConnectionIdentity, Grant},
    domain::address::SessionRef,
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
    store::{Writer, intents::SettingAdmission},
};
use chrono::{DateTime, SecondsFormat, Utc};
use rmcp::model::CallToolResult;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    future::Future,
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    pin::Pin,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitRule {
    version: u8,
    rule_ref: String,
    principal: String,
    session_ref: String,
    request_key: String,
    rule: catalog::AutomationRule,
    created_at: String,
    due_unix_ms: Option<u64>,
    target: SessionProof,
    dependencies: Vec<SessionProof>,
}
impl WaitRule {
    fn kind(&self) -> &'static str {
        match self.rule {
            catalog::AutomationRule::Timer { .. } => "timer",
            catalog::AutomationRule::SessionCompletion { .. } => "session_completion",
            _ => "invalid",
        }
    }
    fn message(&self) -> &str {
        match &self.rule {
            catalog::AutomationRule::Timer { wake_message, .. }
            | catalog::AutomationRule::SessionCompletion { wake_message, .. } => wake_message,
            _ => "",
        }
    }
    fn all_proofs(&self) -> impl Iterator<Item = &SessionProof> {
        std::iter::once(&self.target).chain(&self.dependencies)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitState {
    phase: String,
    detail: Option<String>,
    delivery_task: Option<String>,
    wake_cancelled: bool,
    cancel_generation: u64,
    wake_message: Option<String>,
    completed_dependencies: BTreeMap<String, NativeTurn>,
    completed_at: Option<String>,
}
impl WaitState {
    fn new(rule: &WaitRule) -> Self {
        Self {
            phase: "armed".into(),
            detail: None,
            delivery_task: None,
            wake_cancelled: false,
            cancel_generation: 0,
            wake_message: None,
            completed_at: None,
            completed_dependencies: rule
                .dependencies
                .iter()
                .filter_map(|p| {
                    p.native_turn
                        .as_ref()
                        .filter(|t| t.status.terminal())
                        .map(|t| (p.session_ref.clone(), t.clone()))
                })
                .collect(),
        }
    }
    fn settled(&self) -> bool {
        self.wake_cancelled
            || matches!(
                self.phase.as_str(),
                "confirmed" | "rejected" | "paused" | "cancelled"
            )
    }
    fn cancel(&mut self, detail: &str) {
        self.phase = "cancelled".into();
        self.wake_cancelled = true;
        self.cancel_generation = self.cancel_generation.saturating_add(1);
        self.detail = Some(detail.into());
    }
}

struct WakeLock(File);
impl Drop for WakeLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn wake_lock(authority: &ScopedAuthority, rule_ref: &str) -> Result<Option<WakeLock>> {
    let root = authority
        .db
        .parent()
        .ok_or("wake_gate_unavailable")?
        .join("automation-wakes");
    match fs::DirBuilder::new().mode(0o700).create(&root) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("wake_gate_unavailable"),
    }
    let d = fs::symlink_metadata(&root).map_err(|_| "wake_gate_unavailable")?;
    if !d.is_dir() || d.uid() != unsafe { libc::geteuid() } || d.mode() & 0o077 != 0 {
        return Err("wake_gate_unavailable");
    }
    let suffix = rule_ref
        .strip_prefix("wait-rule:")
        .ok_or("invalid_rule_ref")?;
    if suffix.len() != 64 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid_rule_ref");
    }
    let path = root.join(format!("{suffix}.lock"));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| "wake_gate_unavailable")?;
    let m = file.metadata().map_err(|_| "wake_gate_unavailable")?;
    let named = fs::symlink_metadata(&path).map_err(|_| "wake_gate_unavailable")?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.nlink() != 1
        || m.mode() & 0o077 != 0
        || (m.dev(), m.ino()) != (named.dev(), named.ino())
    {
        return Err("wake_gate_unavailable");
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(None)
        } else {
            Err("wake_gate_unavailable")
        };
    }
    Ok(Some(WakeLock(file)))
}

pub struct WaitAutomationApplication {
    authority: Arc<ScopedAuthority>,
    source: Arc<DependencySource>,
    registry: Arc<DependencyRegistry>,
    deliver: Arc<dyn ApplicationPort>,
    delivery_mode: catalog::DeliveryMode,
    reconciler: Arc<dyn super::task_reconcile::TaskReconciler>,
    policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    automatic_continuation: bool,
}
impl WaitAutomationApplication {
    pub fn new(
        source: Arc<DependencySource>,
        registry: Arc<DependencyRegistry>,
        deliver: Arc<dyn ApplicationPort>,
        delivery_mode: catalog::DeliveryMode,
        reconciler: Arc<dyn super::task_reconcile::TaskReconciler>,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    ) -> Self {
        Self {
            authority: source.authority.clone(),
            source,
            registry,
            deliver,
            delivery_mode,
            reconciler,
            policy,
            automatic_continuation: true,
        }
    }
    pub fn with_automatic_continuation(mut self, allowed: bool) -> Self {
        self.automatic_continuation = allowed;
        self
    }
    fn principal<'a>(&self, identity: &'a ConnectionIdentity) -> Result<&'a str> {
        self.source.principal(identity)
    }
    fn scope(principal: &str) -> String {
        format!("automation:canonical-wait:{principal}")
    }
    fn rule_key(rule_ref: &str) -> String {
        format!("rule:{rule_ref}")
    }
    fn state_key(rule_ref: &str) -> String {
        format!("state:{rule_ref}")
    }
    fn rule_ref(principal: &str, session: &str, key: &str) -> String {
        format!(
            "wait-rule:{}",
            hex(&Sha256::digest(
                serde_json::to_vec(&("canonical-wait-v1", principal, session, key))
                    .unwrap_or_default()
            ))
        )
    }
    fn decode_rule(raw: &str, principal: &str, reference: Option<&str>) -> Result<WaitRule> {
        let rule: WaitRule = serde_json::from_str(raw).map_err(|_| "store_unavailable")?;
        if rule.version != 1
            || rule.principal != principal
            || rule.kind() == "invalid"
            || rule.rule_ref != Self::rule_ref(principal, &rule.session_ref, &rule.request_key)
            || reference.is_some_and(|r| r != rule.rule_ref)
            || rule.target.session_ref != rule.session_ref
        {
            return Err("store_unavailable");
        }
        Ok(rule)
    }
    fn read_rule(&self, principal: &str, rule_ref: &str) -> Result<Option<WaitRule>> {
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        writer
            .get_setting(&Self::scope(principal), &Self::rule_key(rule_ref))
            .map_err(|_| "store_unavailable")?
            .map(|raw| Self::decode_rule(&raw, principal, Some(rule_ref)))
            .transpose()
    }
    fn rules(&self, principal: &str) -> Result<Vec<WaitRule>> {
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        let rules: Vec<_> = writer
            .list_settings(&Self::scope(principal), "rule:")
            .map_err(|_| "store_unavailable")?
            .into_iter()
            .map(|(_, raw)| Self::decode_rule(&raw, principal, None))
            .collect::<Result<_>>()?;
        Ok(rules
            .into_iter()
            .filter(|r| r.target.owner.address().instance == self.source.instance)
            .collect())
    }
    pub fn owns_rule(&self, principal: &str, rule_ref: &str) -> std::result::Result<bool, ()> {
        self.read_rule(principal, rule_ref)
            .map(|r| r.is_some_and(|r| r.target.owner.address().instance == self.source.instance))
            .map_err(|_| ())
    }
    fn ensure_state_locked(writer: &mut Writer, rule: &WaitRule) -> Result<()> {
        let scope = Self::scope(&rule.principal);
        let key = Self::state_key(&rule.rule_ref);
        if writer
            .get_setting(&scope, &key)
            .map_err(|_| "store_unavailable")?
            .is_none()
        {
            writer
                .put_setting_once(
                    &scope,
                    &key,
                    &serde_json::to_string(&WaitState::new(rule))
                        .map_err(|_| "store_unavailable")?,
                    &utc_millis(now_ms()?)?,
                )
                .map_err(|_| "store_unavailable")?;
        }
        Ok(())
    }
    fn ensure_state(&self, rule: &WaitRule) -> Result<()> {
        let (_gate, mut writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        Self::ensure_state_locked(&mut writer, rule)
    }
    fn read_state_locked(writer: &Writer, rule: &WaitRule) -> Result<(u64, WaitState)> {
        let (revision, raw) = writer
            .get_setting_versioned(
                &Self::scope(&rule.principal),
                &Self::state_key(&rule.rule_ref),
            )
            .map_err(|_| "store_unavailable")?
            .ok_or("wait_state_missing")?;
        let state: WaitState = serde_json::from_str(&raw).map_err(|_| "store_unavailable")?;
        if !matches!(
            state.phase.as_str(),
            "armed"
                | "paused"
                | "cancelled"
                | "dispatching"
                | "waiting_receipt"
                | "delivery_unknown"
                | "confirmed"
                | "rejected"
        ) {
            return Err("invalid_wait_state");
        }
        if state.completed_dependencies.iter().any(|(session, turn)| {
            !turn.status.terminal()
                || !rule.dependencies.iter().any(|p| {
                    p.session_ref == *session
                        && p.native_turn
                            .as_ref()
                            .is_some_and(|captured| captured.turn_id == turn.turn_id)
                })
        }) || state
            .delivery_task
            .as_ref()
            .is_some_and(|task| task != &Self::task_id(rule))
        {
            return Err("invalid_wait_state");
        }
        Ok((revision, state))
    }
    fn read_state(&self, rule: &WaitRule) -> Result<(u64, WaitState)> {
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        Self::read_state_locked(&writer, rule)
    }
    fn state_cas_locked(
        writer: &mut Writer,
        rule: &WaitRule,
        revision: u64,
        state: &WaitState,
    ) -> Result<bool> {
        let (actual, current) = Self::read_state_locked(writer, rule)?;
        if actual != revision {
            return Ok(false);
        }
        if &current == state {
            return Ok(true);
        }
        writer
            .compare_and_set_setting(
                &Self::scope(&rule.principal),
                &Self::state_key(&rule.rule_ref),
                revision,
                &serde_json::to_string(state).map_err(|_| "store_unavailable")?,
                &utc_millis(now_ms()?)?,
            )
            .map_err(|_| "store_unavailable")
    }
    fn state_cas(&self, rule: &WaitRule, revision: u64, state: &WaitState) -> Result<bool> {
        let (_gate, mut writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        Self::state_cas_locked(&mut writer, rule, revision, state)
    }
    fn authorized_rule(
        &self,
        identity: &ConnectionIdentity,
        rule_ref: &str,
        write: bool,
    ) -> Result<(WaitRule, Vec<Grant>)> {
        let principal = self.principal(identity)?;
        let rule = self
            .read_rule(principal, rule_ref)?
            .ok_or("rule_not_found")?;
        let session = SessionRef(rule.session_ref.clone());
        let grants = self.source.grants(identity, &session, write)?;
        let (address, generation) = self
            .authority
            .resolve_session_read(identity, &grants, &session, &self.source.instance)
            .map_err(|_| "session_unavailable")?;
        if address != rule.target.owner.address()
            || generation != rule.target.scope_generation
            || self.authority.generation != rule.target.authority_generation
        {
            return Err("session_binding_changed");
        }
        Ok((rule, grants))
    }
    fn task_key(rule: &WaitRule) -> String {
        format!("wait-wake:{}", rule.rule_ref)
    }
    fn task_id(rule: &WaitRule) -> String {
        format!(
            "mcp-delivery-task:{}",
            hex(&Sha256::digest(
                serde_json::to_vec(&(
                    "mcp-deliver-v1",
                    &rule.principal,
                    &rule.session_ref,
                    &Self::task_key(rule)
                ))
                .unwrap_or_default()
            ))
        )
    }
    fn intent_state(&self, rule: &WaitRule) -> Result<Option<String>> {
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        writer.connection().query_row("SELECT state FROM intents WHERE task_id=?1 AND principal=?2 AND target=?3 AND request_key=?4",
            rusqlite::params![Self::task_id(rule),rule.principal,rule.session_ref,Self::task_key(rule)],|r|r.get(0))
            .optional().map_err(|_|"store_unavailable")
    }
    fn snapshot(&self, rule: &WaitRule) -> Result<Value> {
        let (revision, state) = self.read_state(rule)?;
        let dependencies:Vec<_>=rule.dependencies.iter().map(|p|json!({"session_ref":p.session_ref,"owner":p.owner,
            "native_turn_id":p.native_turn.as_ref().map(|t|&t.turn_id),"captured_status":p.native_turn.as_ref().map(|t|&t.status),
            "authority_generation":p.authority_generation,"scope_generation":p.scope_generation,
            "completion":state.completed_dependencies.get(&p.session_ref)})).collect();
        Ok(
            json!({"rule_ref":rule.rule_ref,"kind":rule.kind(),"session_ref":rule.session_ref,"owner":rule.target.owner,
            "automatic_continuation":self.automatic_continuation,
            "request_key":rule.request_key,"rule":rule.rule,"created_at":rule.created_at,
            "due_at":rule.due_unix_ms.map(utc_millis).transpose()?,"due_unix_ms":rule.due_unix_ms,
            "dependencies":dependencies,"revision":revision,"status":state.phase,"wait":state,
            "delivery_status":self.intent_state(rule)?,"instruction":"End the current turn; Herder owns this durable wait."}),
        )
    }
    fn validate_request(rule: &catalog::AutomationRule, key: &str) -> Result<()> {
        if !wait_sources::valid_id(key) {
            return Err("invalid_request");
        }
        let message = match rule {
            catalog::AutomationRule::Timer { wake_message, .. } => wake_message,
            catalog::AutomationRule::SessionCompletion {
                dependencies,
                wake_message,
            } => {
                if dependencies.is_empty() || dependencies.len() > 32 {
                    return Err("invalid_dependencies");
                }
                let mut unique = HashSet::new();
                if dependencies
                    .iter()
                    .any(|d| !wait_sources::valid_id(d) || !unique.insert(d))
                {
                    return Err("invalid_dependencies");
                }
                wake_message
            }
            _ => return Err("unsupported"),
        };
        if message.trim().is_empty() || message.len() > 16384 {
            return Err("invalid_request");
        }
        Ok(())
    }
    pub async fn create(
        &self,
        identity: &ConnectionIdentity,
        session_ref: String,
        original: catalog::AutomationRule,
        key: String,
    ) -> Result<Value> {
        Self::validate_request(&original, &key)?;
        let principal = self.principal(identity)?.to_owned();
        let rule_ref = Self::rule_ref(&principal, &session_ref, &key);
        if let Some(existing) = self.read_rule(&principal, &rule_ref)? {
            if existing.session_ref != session_ref
                || existing.request_key != key
                || existing.rule != original
            {
                return Err("idempotency_conflict");
            }
            self.authorized_rule(identity, &rule_ref, false)?;
            self.ensure_state(&existing)?;
            return self.snapshot(&existing);
        }
        if !self.automatic_continuation {
            return Err("automatic_continuation_unsupported");
        }
        let target = self
            .source
            .capture(identity, &SessionRef(session_ref.clone()), true)?;
        let mut dependencies = Vec::new();
        if let catalog::AutomationRule::SessionCompletion {
            dependencies: refs, ..
        } = &original
        {
            for reference in refs {
                let source = self
                    .registry
                    .by_session(identity, &SessionRef(reference.clone()))?;
                let mut proof = source.capture(identity, &SessionRef(reference.clone()), false)?;
                proof.native_turn = Some(
                    source
                        .turn(&proof)
                        .await?
                        .ok_or("completion_identity_unavailable")?,
                );
                dependencies.push(proof);
            }
        }
        let mut sources = vec![self.registry.for_proof(identity, &target, true)?];
        for proof in &dependencies {
            sources.push(self.registry.for_proof(identity, proof, false)?);
        }
        // The complete configured graph is fenced for cycle admission. Native
        // reads above never hold these authority locks.
        let mut locked = wait_sources::lock_sources(if dependencies.is_empty() {
            sources.clone()
        } else {
            self.registry.all_sources()?
        })?;
        for (source, proof) in sources
            .iter()
            .zip(std::iter::once(&target).chain(&dependencies))
        {
            source.validate_locked(proof, &wait_sources::locked_for(&mut locked, proof)?.writer)?;
        }
        if let catalog::AutomationRule::SessionCompletion {
            dependencies: refs, ..
        } = &original
        {
            reject_cycle(&locked, &principal, &session_ref, refs)?;
        }
        let parent = wait_sources::locked_for(&mut locked, &target)?;
        // Concurrent duplicate admission returns the original due time and turn
        // identities; newly captured data is never substituted on retry.
        let saved = parent
            .writer
            .get_setting(&Self::scope(&principal), &Self::rule_key(&rule_ref))
            .map_err(|_| "store_unavailable")?;
        let admitted = if let Some(raw) = saved {
            let saved = Self::decode_rule(&raw, &principal, Some(&rule_ref))?;
            if saved.rule != original
                || saved.session_ref != session_ref
                || saved.request_key != key
            {
                return Err("idempotency_conflict");
            }
            saved
        } else {
            let now = now_ms()?;
            let due = match &original {
                catalog::AutomationRule::Timer {
                    trigger: catalog::TimerTrigger::Delay { delay_ms },
                    ..
                } => Some(now.checked_add(*delay_ms).ok_or("invalid_timer")?),
                catalog::AutomationRule::Timer {
                    trigger: catalog::TimerTrigger::At { at },
                    ..
                } => Some(parse_at(at)?),
                _ => None,
            };
            if let Some(due) = due {
                utc_millis(due)?;
            }
            let rule = WaitRule {
                version: 1,
                rule_ref,
                principal,
                session_ref,
                request_key: key,
                rule: original,
                created_at: utc_millis(now)?,
                due_unix_ms: due,
                target,
                dependencies,
            };
            let admission = parent
                .writer
                .put_setting_once(
                    &Self::scope(&rule.principal),
                    &Self::rule_key(&rule.rule_ref),
                    &serde_json::to_string(&rule).map_err(|_| "invalid_request")?,
                    &rule.created_at,
                )
                .map_err(|_| "store_unavailable")?;
            if admission == SettingAdmission::Conflict {
                return Err("idempotency_conflict");
            }
            rule
        };
        Self::ensure_state_locked(&mut parent.writer, &admitted)?;
        drop(locked);
        self.snapshot(&admitted)
    }
    fn proof_sources(
        &self,
        identity: &ConnectionIdentity,
        rule: &WaitRule,
    ) -> Result<Vec<Arc<DependencySource>>> {
        rule.all_proofs()
            .enumerate()
            .map(|(i, p)| self.registry.for_proof(identity, p, i == 0))
            .collect()
    }
    fn validate_proofs(
        &self,
        identity: &ConnectionIdentity,
        rule: &WaitRule,
    ) -> Result<Vec<wait_sources::LockedSource>> {
        let sources = self.proof_sources(identity, rule)?;
        let mut locked = wait_sources::lock_sources(sources.clone())?;
        for (source, proof) in sources.iter().zip(rule.all_proofs()) {
            source.validate_locked(proof, &wait_sources::locked_for(&mut locked, proof)?.writer)?;
        }
        Ok(locked)
    }
    async fn reconcile_intent(
        &self,
        identity: &ConnectionIdentity,
        rule: &WaitRule,
        grants: Vec<Grant>,
        mut intent: String,
        revision: u64,
        mut state: WaitState,
    ) -> Result<Value> {
        if matches!(intent.as_str(), "admitted" | "unknown" | "dispatching") {
            let reconciler = self.reconciler.clone();
            let identity = identity.clone();
            let policy = self.policy.clone();
            let task = Self::task_id(rule);
            let _ = tokio::task::spawn_blocking(move || {
                reconciler.reconcile(identity, grants, task, Some(policy))
            })
            .await;
            intent = self.intent_state(rule)?.ok_or("delivery_intent_missing")?;
        }
        state.delivery_task = Some(Self::task_id(rule));
        if !state.wake_cancelled {
            state.phase = delivery_phase(&intent)?.into();
            if matches!(state.phase.as_str(), "confirmed" | "rejected")
                && state.completed_at.is_none()
            {
                state.completed_at = Some(utc_millis(now_ms()?)?);
            }
        }
        let _ = self.state_cas(rule, revision, &state)?;
        self.snapshot(rule)
    }
    async fn reconcile_rule(
        &self,
        identity: &ConnectionIdentity,
        rule: &WaitRule,
    ) -> Result<Value> {
        let (_, grants) = self.authorized_rule(identity, &rule.rule_ref, false)?;
        let Some(_wake) = wake_lock(&self.authority, &rule.rule_ref)? else {
            return self.snapshot(rule);
        };
        self.ensure_state(rule)?;
        let (mut revision, mut state) = self.read_state(rule)?;
        if let Some(intent) = self.intent_state(rule)? {
            return self
                .reconcile_intent(identity, rule, grants, intent, revision, state)
                .await;
        }
        if state.settled() {
            return self.snapshot(rule);
        }
        if !self.automatic_continuation {
            state.detail = Some("automatic_continuation_unsupported".into());
            let _ = self.state_cas(rule, revision, &state)?;
            return self.snapshot(rule);
        }
        if matches!(
            state.phase.as_str(),
            "dispatching" | "delivery_unknown" | "waiting_receipt"
        ) {
            state.phase = "delivery_unknown".into();
            state.detail = Some(
                "dispatch admission receipt unavailable; automatic resend is forbidden".into(),
            );
            let _ = self.state_cas(rule, revision, &state)?;
            return self.snapshot(rule);
        }
        match self.validate_proofs(identity, rule) {
            Ok(locked) => drop(locked),
            Err(
                code @ ("human_stop_active"
                | "human_stop_generation_changed"
                | "session_binding_changed"),
            ) => {
                state.cancel(code);
                let _ = self.state_cas(rule, revision, &state)?;
                return self.snapshot(rule);
            }
            Err(code) => return Err(code),
        }
        if let Some(due) = rule.due_unix_ms {
            if now_ms()? < due {
                return self.snapshot(rule);
            }
        } else {
            let mut detail = None;
            for proof in &rule.dependencies {
                if state
                    .completed_dependencies
                    .contains_key(&proof.session_ref)
                {
                    continue;
                }
                let source = self.registry.for_proof(identity, proof, false)?;
                match source.turn(proof).await {
                    Ok(Some(turn))
                        if proof
                            .native_turn
                            .as_ref()
                            .is_some_and(|p| p.turn_id == turn.turn_id) =>
                    {
                        if turn.status.terminal() {
                            state
                                .completed_dependencies
                                .insert(proof.session_ref.clone(), turn);
                        }
                    }
                    Ok(_) => {
                        detail = Some("original native turn completion remains unproven".into())
                    }
                    Err(code) => detail = Some(code.into()),
                }
            }
            state.detail = detail;
            if !self.state_cas(rule, revision, &state)? {
                return self.snapshot(rule);
            }
            (revision, state) = self.read_state(rule)?;
            if state.settled() || state.completed_dependencies.len() != rule.dependencies.len() {
                return self.snapshot(rule);
            }
        }
        // Every acquisition uses the nonblocking pinned gate primitive. A
        // competing multi-source admission therefore defers, never waits while
        // holding another gate. Recheck every source under its canonical gate. Foreign dependency
        // gates stay held through bounded native handoff; the ordinary deliver
        // gate serializes the parent and same-authority dependencies with stop.
        let mut locked = match self.validate_proofs(identity, rule) {
            Ok(v) => v,
            Err(
                code @ ("human_stop_active"
                | "human_stop_generation_changed"
                | "session_binding_changed"),
            ) => {
                state.cancel(code);
                let _ = self.state_cas(rule, revision, &state)?;
                return self.snapshot(rule);
            }
            Err(code) => return Err(code),
        };
        state.phase = "dispatching".into();
        state.detail = None;
        if !Self::state_cas_locked(
            &mut wait_sources::locked_for(&mut locked, &rule.target)?.writer,
            rule,
            revision,
            &state,
        )? {
            drop(locked);
            return self.snapshot(rule);
        }
        let mut dependency_guards = Vec::new();
        for held in locked {
            let parent = held.source.authority.db == self.authority.db
                && held.source.authority.generation == self.authority.generation;
            drop(held.writer);
            if parent {
                drop(held.guard)
            } else {
                dependency_guards.push(held.guard)
            }
        }
        let evidence = json!({"kind":rule.kind(),"rule_ref":rule.rule_ref,"due_at":rule.due_unix_ms.map(utc_millis).transpose()?,
            "dependencies":state.completed_dependencies});
        let message = format!(
            "{}\n\nHerder completion evidence:\n{}",
            state.wake_message.as_deref().unwrap_or(rule.message()),
            serde_json::to_string(&evidence).map_err(|_| "store_unavailable")?
        );
        let result = self
            .deliver
            .call(
                identity,
                catalog::Request::Deliver(catalog::Deliver::Session {
                    session_ref: rule.session_ref.clone(),
                    message,
                    mode: self.delivery_mode.clone(),
                    request_key: Self::task_key(rule),
                }),
            )
            .await;
        drop(dependency_guards);
        let (revision, mut state) = self.read_state(rule)?;
        if let Some(intent) = self.intent_state(rule)? {
            state.delivery_task = Some(Self::task_id(rule));
            if !state.wake_cancelled {
                state.phase = delivery_phase(&intent)?.into();
            }
        } else if !state.wake_cancelled {
            let none = result
                .as_ref()
                .and_then(|r| r.structured_content.as_ref())
                .and_then(|v| v.get("effect"))
                == Some(&json!("none"));
            state.phase = if none { "armed" } else { "delivery_unknown" }.into();
            state.detail = Some(
                if none {
                    "wake deferred; no canonical admission"
                } else {
                    "wake outcome unknown; automatic resend is forbidden"
                }
                .into(),
            );
        }
        if matches!(state.phase.as_str(), "confirmed" | "rejected") && state.completed_at.is_none()
        {
            state.completed_at = Some(utc_millis(now_ms()?)?);
        }
        let _ = self.state_cas(rule, revision, &state)?;
        self.snapshot(rule)
    }
    pub async fn reconcile_registered(&self, identity: &ConnectionIdentity) {
        let Ok(principal) = self.principal(identity) else {
            return;
        };
        if !super::automation_driver::has_rule_hint(&self.authority, &Self::scope(principal)) {
            return;
        }
        let Ok(rules) = self.rules(principal) else {
            return;
        };
        for rule in rules {
            let _ = self.reconcile_rule(identity, &rule).await;
        }
    }
    fn change(
        &self,
        identity: &ConnectionIdentity,
        reference: &str,
        revision: u64,
        phase: &str,
    ) -> Result<Value> {
        let (rule, _) = self.authorized_rule(identity, reference, true)?;
        let Some(_wake) = wake_lock(&self.authority, reference)? else {
            return Err("wake_dispatch_in_progress");
        };
        self.ensure_state(&rule)?;
        let (actual, mut state) = self.read_state(&rule)?;
        if state.phase == phase {
            return self.snapshot(&rule);
        }
        if actual != revision {
            return Err("revision_conflict");
        }
        if matches!(state.phase.as_str(), "confirmed" | "rejected" | "cancelled")
            && phase != "cancelled"
        {
            return Err("wait_already_resolved");
        }
        state.phase = phase.into();
        state.wake_cancelled = true;
        state.cancel_generation = state.cancel_generation.saturating_add(1);
        if !self.state_cas(&rule, revision, &state)? {
            return Err("revision_conflict");
        }
        self.snapshot(&rule)
    }
    fn update(
        &self,
        identity: &ConnectionIdentity,
        reference: &str,
        revision: u64,
        rule: catalog::AutomationRule,
    ) -> Result<Value> {
        if !self.automatic_continuation {
            return Err("automatic_continuation_unsupported");
        }
        let (saved, _) = self.authorized_rule(identity, reference, true)?;
        Self::validate_request(&rule, &saved.request_key)?;
        let message = match (&saved.rule, &rule) {
            (
                catalog::AutomationRule::Timer { trigger: a, .. },
                catalog::AutomationRule::Timer {
                    trigger: b,
                    wake_message,
                },
            ) if a == b => wake_message,
            (
                catalog::AutomationRule::SessionCompletion {
                    dependencies: a, ..
                },
                catalog::AutomationRule::SessionCompletion {
                    dependencies: b,
                    wake_message,
                },
            ) if a == b => wake_message,
            _ => return Err("wait_trigger_immutable"),
        };
        let Some(_wake) = wake_lock(&self.authority, reference)? else {
            return Err("wake_dispatch_in_progress");
        };
        let (actual, mut state) = self.read_state(&saved)?;
        if actual != revision {
            return Err("revision_conflict");
        }
        if !matches!(state.phase.as_str(), "armed" | "paused")
            || self.intent_state(&saved)?.is_some()
        {
            return Err("wait_already_resolved");
        }
        let sources = self.proof_sources(identity, &saved)?;
        let mut locked = wait_sources::lock_sources(if saved.dependencies.is_empty() {
            sources.clone()
        } else {
            self.registry.all_sources()?
        })?;
        for (source, proof) in sources.iter().zip(saved.all_proofs()) {
            source.validate_locked(proof, &wait_sources::locked_for(&mut locked, proof)?.writer)?;
        }
        if let catalog::AutomationRule::SessionCompletion { dependencies, .. } = &saved.rule {
            reject_cycle(&locked, &saved.principal, &saved.session_ref, dependencies)?;
        }
        state.phase = "armed".into();
        state.wake_cancelled = false;
        state.wake_message = Some(message.clone());
        if !Self::state_cas_locked(
            &mut wait_sources::locked_for(&mut locked, &saved.target)?.writer,
            &saved,
            revision,
            &state,
        )? {
            return Err("revision_conflict");
        }
        drop(locked);
        self.snapshot(&saved)
    }
    fn wait_status(
        &self,
        identity: &ConnectionIdentity,
        native: &str,
        node: Option<&str>,
    ) -> Result<Value> {
        let principal = self.principal(identity)?;
        let observed = utc_millis(now_ms()?)?;
        let global_held = {
            let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
            writer.connection().query_row("SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL) OR EXISTS(SELECT 1 FROM holds WHERE session_ref='global' AND released_at IS NULL)",[],|r|r.get::<_,bool>(0))
                .map_err(|_|"store_unavailable")?
        };
        if global_held {
            return Ok(
                json!({"version":1,"configured":true,"complete":true,"blocked":true,
            "reason":"human_stop_active","mapped":false,"sessionRefs":[],"ruleRefs":[],"observedAt":observed}),
            );
        }
        let value = match self.source.resolve_native(identity, native, node)? {
            Some(v) => v,
            None => {
                return Ok(json!({"version":1,"configured":true,"complete":true,
                "blocked":false,"reason":"native_session_not_registered","mapped":false,"sessionRefs":[],"ruleRefs":[],"observedAt":observed}));
            }
        };
        let session = value
            .get("session_ref")
            .and_then(Value::as_str)
            .ok_or("session_unavailable")?;
        let grants = self
            .source
            .grants(identity, &SessionRef(session.into()), false)?;
        if self
            .authority
            .human_stop_held(
                identity,
                &grants,
                &SessionRef(session.into()),
                &self.source.instance,
            )
            .map_err(|_| "scope_unavailable")?
        {
            return Ok(
                json!({"version":1,"configured":true,"complete":true,"blocked":true,"reason":"human_stop_active",
                "mapped":true,"sessionRefs":[session],"ruleRefs":[],"observedAt":observed}),
            );
        }
        let mut blocked = Vec::new();
        for rule in self.rules(principal)? {
            if rule.session_ref != session {
                continue;
            }
            let state = self.read_state(&rule);
            let intent = self.intent_state(&rule)?;
            let clear = match (
                state.as_ref().map(|(_, s)| s.phase.as_str()),
                intent.as_deref(),
            ) {
                (Ok("confirmed"), Some("confirmed")) => true,
                (Ok("cancelled"), None | Some("confirmed" | "rejected")) => true,
                _ => false,
            };
            if !clear {
                blocked.push(rule.rule_ref);
            }
        }
        blocked.sort();
        Ok(
            json!({"version":1,"configured":true,"complete":true,"blocked":!blocked.is_empty(),
            "reason":if blocked.is_empty(){"no_canonical_wait"}else{"canonical_wait_active"},"mapped":true,
            "sessionRefs":[session],"ruleRefs":blocked,"observedAt":observed}),
        )
    }
}
impl AutomationTick for WaitAutomationApplication {
    fn tick<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(self.reconcile_registered(identity))
    }
}
impl ApplicationPort for WaitAutomationApplication {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let result = match request {
                catalog::Request::Session(catalog::Session::Resolve {
                    harness,
                    native_session_id,
                    node_ref,
                }) => self.registry.resolve_native(
                    identity,
                    &harness,
                    &native_session_id,
                    node_ref.as_deref(),
                ),
                catalog::Request::Automation(catalog::Automation::WaitStatus {
                    harness,
                    native_session_id,
                    node_ref,
                }) => {
                    if harness != self.source.harness() {
                        Err("owner_profile_mismatch")
                    } else {
                        self.wait_status(identity, &native_session_id, node_ref.as_deref())
                    }
                }
                catalog::Request::Automation(catalog::Automation::Create {
                    session_ref,
                    rule,
                    request_key,
                }) if matches!(
                    rule,
                    catalog::AutomationRule::Timer { .. }
                        | catalog::AutomationRule::SessionCompletion { .. }
                ) =>
                {
                    self.create(identity, session_ref, rule, request_key).await
                }
                catalog::Request::Automation(catalog::Automation::List {
                    session_ref,
                    cursor,
                }) => {
                    if cursor.is_some() {
                        return Some(error("unsupported_cursor"));
                    }
                    match self.principal(identity).and_then(|p| self.rules(p)) {
                        Err(e) => Err(e),
                        Ok(rules) => {
                            let mut rows = Vec::new();
                            for rule in rules {
                                if session_ref.as_ref().is_some_and(|s| s != &rule.session_ref) {
                                    continue;
                                }
                                match self.authorized_rule(identity, &rule.rule_ref, false) {
                                    Ok(_) => {}
                                    Err("session_grant_required" | "unauthorized") => continue,
                                    Err(code) => return Some(error(code)),
                                }
                                match self.snapshot(&rule) {
                                    Ok(v) => rows.push(v),
                                    Err(code) => return Some(error(code)),
                                }
                            }
                            Ok(
                                json!({"rules":rows,"complete":true,"source":"scoped_canonical_waits"}),
                            )
                        }
                    }
                }
                catalog::Request::Automation(catalog::Automation::Get { rule_ref })
                    if rule_ref.starts_with("wait-rule:") =>
                {
                    self.authorized_rule(identity, &rule_ref, false)
                        .and_then(|(r, _)| self.snapshot(&r))
                }
                catalog::Request::Automation(catalog::Automation::Pause { rule_ref, revision })
                    if rule_ref.starts_with("wait-rule:") =>
                {
                    self.change(identity, &rule_ref, revision, "paused")
                }
                catalog::Request::Automation(catalog::Automation::Delete {
                    rule_ref,
                    revision,
                }) if rule_ref.starts_with("wait-rule:") => {
                    self.change(identity, &rule_ref, revision, "cancelled")
                }
                catalog::Request::Automation(catalog::Automation::Update {
                    rule_ref,
                    revision,
                    rule,
                }) if rule_ref.starts_with("wait-rule:") => {
                    self.update(identity, &rule_ref, revision, rule)
                }
                _ => return None,
            };
            Some(match result {
                Ok(v) => CallToolResult::structured(v),
                Err(code) => error(code),
            })
        })
    }
}

fn reject_cycle(
    locked: &[wait_sources::LockedSource],
    principal: &str,
    target: &str,
    dependencies: &[String],
) -> Result<()> {
    let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for held in locked {
        for (_, raw) in held
            .writer
            .list_settings(&WaitAutomationApplication::scope(principal), "rule:")
            .map_err(|_| "dependency_graph_unavailable")?
        {
            let rule = WaitAutomationApplication::decode_rule(&raw, principal, None)?;
            let catalog::AutomationRule::SessionCompletion {
                dependencies: refs, ..
            } = &rule.rule
            else {
                continue;
            };
            let state = WaitAutomationApplication::read_state_locked(&held.writer, &rule);
            let pending = match state {
                Ok((_, state)) if state.settled() => Vec::new(),
                Ok((_, state)) => refs
                    .iter()
                    .filter(|r| !state.completed_dependencies.contains_key(*r))
                    .cloned()
                    .collect(),
                Err("wait_state_missing") => refs.clone(),
                Err(_) => return Err("dependency_graph_unavailable"),
            };
            graph.entry(rule.session_ref).or_default().extend(pending);
        }
    }
    let mut pending = dependencies.to_vec();
    let mut seen = HashSet::new();
    while let Some(session) = pending.pop() {
        if session == target {
            return Err("wait_dependency_cycle");
        }
        if seen.insert(session.clone()) {
            if let Some(next) = graph.get(&session) {
                pending.extend(next.iter().cloned());
            }
        }
    }
    Ok(())
}

fn delivery_phase(intent: &str) -> Result<&'static str> {
    match intent {
        "confirmed" => Ok("confirmed"),
        "rejected" => Ok("rejected"),
        "admitted" => Ok("waiting_receipt"),
        "unknown" | "prepared" | "dispatching" => Ok("delivery_unknown"),
        _ => Err("delivery_state_invalid"),
    }
}
fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_unavailable")?
        .as_millis()
        .try_into()
        .map_err(|_| "clock_unavailable")
}
fn utc_millis(ms: u64) -> Result<String> {
    let value: i64 = ms.try_into().map_err(|_| "invalid_timer")?;
    let t = DateTime::<Utc>::from_timestamp_millis(value).ok_or("invalid_timer")?;
    use chrono::Datelike;
    if !(1970..=9999).contains(&t.year()) {
        return Err("invalid_timer");
    }
    Ok(t.to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn parse_at(at: &str) -> Result<u64> {
    if at.len() > 128 {
        return Err("invalid_timer");
    }
    DateTime::parse_from_rfc3339(at)
        .map_err(|_| "invalid_timer")?
        .timestamp_millis()
        .try_into()
        .map_err(|_| "invalid_timer")
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn error(code: &str) -> CallToolResult {
    CallToolResult::structured_error(json!({"code":code,"effect":"none"}))
}

/// Stop history is durable even if a foreign owner is offline through stop+release.
pub(super) fn cancel_for_stop(
    c: &rusqlite::Connection,
    scope: &str,
    now: &str,
) -> std::result::Result<(), super::GateError> {
    c.execute("INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES ('automation:stop-epoch',?1,'{}',1,?2) ON CONFLICT(scope,setting_key) DO UPDATE SET revision=settings.revision+1,updated_at=excluded.updated_at",
        rusqlite::params![scope,now]).map_err(|_|super::GateError::Store)?;
    let rows = {
        let mut stmt=c.prepare("SELECT scope,value_json FROM settings WHERE scope LIKE 'automation:canonical-wait:%' AND setting_key LIKE 'rule:%'")
            .map_err(|_|super::GateError::Store)?;
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| super::GateError::Store)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| super::GateError::Store)?
    };
    for (rule_scope, raw) in rows {
        let Ok(rule) = serde_json::from_str::<WaitRule>(&raw) else {
            continue;
        };
        let mut affected = false;
        for proof in rule.all_proofs() {
            let held:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=?1 AND scope_ref=?2)",
                rusqlite::params![proof.session_ref,scope],|r|r.get(0)).map_err(|_|super::GateError::Store)?;
            affected |= held;
        }
        if !affected {
            continue;
        }
        let key = WaitAutomationApplication::state_key(&rule.rule_ref);
        let raw: Option<String> = c
            .query_row(
                "SELECT value_json FROM settings WHERE scope=?1 AND setting_key=?2",
                rusqlite::params![rule_scope, key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| super::GateError::Store)?;
        let mut state = match raw {
            Some(raw) => match serde_json::from_str::<WaitState>(&raw) {
                Ok(s) => s,
                Err(_) => continue,
            },
            None => WaitState::new(&rule),
        };
        if matches!(state.phase.as_str(), "confirmed" | "rejected" | "cancelled") {
            continue;
        }
        state.cancel("HumanStop cancelled this wait; releasing the hold does not reauthorize it");
        c.execute("INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES (?1,?2,?3,1,?4) ON CONFLICT(scope,setting_key) DO UPDATE SET value_json=excluded.value_json,revision=settings.revision+1,updated_at=excluded.updated_at",
            rusqlite::params![rule_scope,key,serde_json::to_string(&state).map_err(|_|super::GateError::Store)?,now]).map_err(|_|super::GateError::Store)?;
    }
    Ok(())
}
pub(super) fn wake_cancelled(
    c: &rusqlite::Connection,
    principal: &str,
    target: &str,
    key: &str,
) -> std::result::Result<bool, super::GateError> {
    let Some(reference) = key.strip_prefix("wait-wake:") else {
        return Ok(false);
    };
    let scope = WaitAutomationApplication::scope(principal);
    let raw: String = c
        .query_row(
            "SELECT value_json FROM settings WHERE scope=?1 AND setting_key=?2",
            rusqlite::params![scope, WaitAutomationApplication::rule_key(reference)],
            |r| r.get(0),
        )
        .map_err(|_| super::GateError::Store)?;
    let rule = WaitAutomationApplication::decode_rule(&raw, principal, Some(reference))
        .map_err(|_| super::GateError::Store)?;
    if rule.session_ref != target {
        return Err(super::GateError::Invalid);
    }
    let raw: String = c
        .query_row(
            "SELECT value_json FROM settings WHERE scope=?1 AND setting_key=?2",
            rusqlite::params![scope, WaitAutomationApplication::state_key(reference)],
            |r| r.get(0),
        )
        .map_err(|_| super::GateError::Store)?;
    let state: WaitState = serde_json::from_str(&raw).map_err(|_| super::GateError::Store)?;
    if state.wake_cancelled || state.phase != "dispatching" {
        return Ok(true);
    }
    for proof in rule
        .all_proofs()
        .filter(|p| p.authority_ref == rule.target.authority_ref)
    {
        let address = proof.owner.address();
        let binding = super::ReceiptBinding {
            intent_id: "wait-handoff",
            principal,
            target_ref: &proof.session_ref,
            request_key: "wait-proof",
            address: &address,
        };
        if !super::scope_identity_valid(
            c,
            &binding,
            &proof.scope_generation,
            &proof.authority_generation,
        )? || wait_sources::stop_epochs(c, &proof.session_ref)
            .map_err(|_| super::GateError::Store)?
            != proof.stop_epochs
        {
            return Ok(true);
        }
    }
    Ok(false)
}
