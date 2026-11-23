//! Crash recovery for a native session owner, using the ordinary scoped intent and stop gate.
mod discovery;
mod stages;
use super::{
    BoundedNativeHandoff, GateError, ScopedAuthority,
    automation_driver::AutomationTick,
    create_prompt::FreshSessionGrantPolicy,
    mcp_deliver::utc_now,
    recovery_handoff::{
        LegacyRecoveryHandoff, RecoveryWorkspaceProbe, automation_disarm_held, notice_attempt_held, private_json,
    },
    recovery_omniroute,
    task_reconcile::TaskReconciler,
    wait_automation::WaitAutomationApplication,
};
use crate::{
    application::reconcile::{DurableDispatch, ReceiptBinding},
    auth::identity::{Caller, ConnectionIdentity, Grant, PrincipalId},
    domain::{
        adapter::{Admission, DispatchPlan, RequestKey, SubmitError},
        address::{InstanceRef, SessionAddress, SessionRef},
        recovery::{
            RecoveryAncestor, RecoveryBoundary, RecoveryControl, RecoveryCredential,
            RecoveryFailure, RecoveryPermit, RecoveryQuotaProof, RecoveryRoute, SameRouteRetry,
        },
    },
};
pub use discovery::{RecoveryDiscovery, RecoveryListing, RecoveryPage};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use stages::{RecoveryAttempt, RecoveryStage};
use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

const RECOVERY_MESSAGE: &str = "Продолжай прерванную задачу с места остановки. Сначала проверь результаты уже выполненных действий и сохрани их.";
const MAX_AGE_MS: u64 = 48 * 60 * 60 * 1000;
const SCAN_INTERVAL: Duration = Duration::from_secs(30);
const SCAN_BUDGET: Duration = Duration::from_secs(8);
const PAGE_SIZE: u32 = 32;
const MAX_STARTS_PER_TICK: u32 = 8;
const RETAIN_UNTIL: &str = "9999-12-31T23:59:59Z";

fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn recent(timestamp_ms: u64) -> bool {
    now_ms()
        .and_then(|now| now.checked_sub(timestamp_ms))
        .is_some_and(|age| age <= MAX_AGE_MS)
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryRunner {
    #[default]
    Mcp,
    Service,
}

/// This profile binds the existing owner settings and the provider/model pairs
/// explicitly authorized for this workspace. It is never sourced from a prompt.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryProfile {
    pub autopilot_state_dir: PathBuf,
    pub legacy_handoff: Option<LegacyRecoveryHandoff>,
    #[serde(default)]
    pub runner: RecoveryRunner,
    #[serde(default)]
    fallback_routes: Vec<FallbackRoute>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FallbackRoute {
    workspace: PathBuf,
    provider: String,
    model: String,
    omniroute: Option<OmniRouteQuota>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct OmniRouteQuota {
    endpoint: String,
    database: PathBuf,
    account: String,
    upstream_provider: String,
}

impl OmniRouteQuota {
    fn available(&self, credential: &RecoveryCredential, model: &str, reserve: u8) -> Option<bool> {
        if credential.endpoint != self.endpoint {
            return None;
        }
        recovery_omniroute::available(
            &self.database,
            &credential.sha256,
            &self.upstream_provider,
            &self.account,
            model,
            reserve,
            chrono::DateTime::<chrono::Utc>::from(SystemTime::now()),
        )
    }
}

impl RecoveryProfile {
    pub fn valid_for(&self, harness: &str) -> bool {
        self.valid()
            && (harness == "codex"
                || self.runner == RecoveryRunner::Mcp
                    && self.legacy_handoff.as_ref().is_none_or(|h| !h.scans_workspaces()))
    }

    pub fn valid_for_browser(&self) -> bool {
        self.valid()
            && self.runner == RecoveryRunner::Mcp
            && self.fallback_routes.is_empty()
            && self.legacy_handoff.as_ref().is_some_and(|handoff| {
                handoff.cohort().is_some() && !handoff.scans_workspaces()
            })
    }

    pub fn valid(&self) -> bool {
        self.autopilot_state_dir.is_absolute()
            && (self.runner == RecoveryRunner::Mcp || self.legacy_handoff.is_some())
            && self
                .legacy_handoff
                .as_ref()
                .is_none_or(LegacyRecoveryHandoff::valid)
            && self.fallback_routes.len() <= 16
            && self.fallback_routes.iter().all(|r| {
                r.workspace.is_absolute()
                    && route_id(&r.provider)
                    && route_id(&r.model)
                    && r.omniroute.as_ref().is_none_or(|router| {
                        r.provider != "openai"
                            && router.database.is_absolute()
                            && route_id(&router.account)
                            && route_id(&router.upstream_provider)
                    })
            })
            && self.fallback_routes.iter().enumerate().all(|(idx, route)| {
                !self.fallback_routes[..idx].iter().any(|prior| {
                    prior.workspace == route.workspace
                        && prior.provider == route.provider
                        && prior.model == route.model
                })
            })
    }

    fn recovery_held(&self, harness: &str, native_id: &str) -> bool {
        self.legacy_handoff
            .as_ref()
            .is_some_and(|handoff| handoff.held(harness, native_id))
            || (harness == "opencode"
                && notice_attempt_held(&self.autopilot_state_dir.join("sessions.json"), native_id))
    }

    fn automation_disarmed(&self, harness: &str, boundary: &RecoveryBoundary) -> bool {
        automation_disarm_held(&self.autopilot_state_dir, harness, Path::new(&boundary.cwd))
            || boundary.ancestors.iter().any(|ancestor| {
                automation_disarm_held(&self.autopilot_state_dir, harness, Path::new(&ancestor.cwd))
                    || self.legacy_handoff.as_ref().is_some_and(|handoff| {
                        handoff.held(harness, &ancestor.address.native_session_id)
                    })
            })
    }

    fn owns_target(&self, harness: &str, address: &SessionAddress, boundary: &RecoveryBoundary) -> bool {
        self.legacy_handoff.as_ref().is_none_or(|h| {
            h.owns_boundary(harness, &address.native_session_id, &boundary.cwd, &boundary.provider)
        })
    }

    fn owns_ancestors(&self, harness: &str, address: &SessionAddress, boundary: &RecoveryBoundary) -> bool {
        self.legacy_handoff.as_ref().is_none_or(|h| {
            boundary.ancestors.iter().all(|a| {
                a.address.instance == address.instance && h.owns_ancestor(harness, &a.address, &a.cwd)
            })
        })
    }

    fn router(&self, provider: &str, model: Option<&str>, cwd: &str) -> Option<&OmniRouteQuota> {
        let model = model?;
        self.fallback_routes
            .iter()
            .find(|route| {
                route.provider == provider
                    && route.model == model
                    && route.workspace == Path::new(cwd)
            })?
            .omniroute
            .as_ref()
    }

    fn quota(
        &self,
        native: &dyn RecoveryControl,
        provider: &str,
        model: Option<&str>,
        cwd: &str,
        reserve: u8,
    ) -> Option<bool> {
        if let Some(router) = self.router(provider, model, cwd) {
            let model = model?;
            let credential = native.credential(provider, model, cwd)?;
            return router.available(&credential, model, reserve);
        }
        native.quota(provider, cwd, reserve)
    }
}

pub(super) fn route_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:$".contains(&b))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Autostart {
    version: u8,
    enabled: bool,
    #[serde(default = "recovery_enabled_by_default")]
    recover_on_disconnect: bool,
    #[serde(default = "recovery_enabled_by_default")]
    recover_on_failure: bool,
    #[serde(default)]
    wait_for_quota: bool,
    #[serde(default)]
    fallback_for_quota: bool,
    #[serde(default)]
    harnesses: Vec<AutostartOverride>,
    sessions: Vec<AutostartOverride>,
    #[serde(default)]
    wait_for_quota_harnesses: Vec<QuotaOverride>,
    #[serde(default)]
    wait_for_quota_sessions: Vec<QuotaOverride>,
}

fn recovery_enabled_by_default() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutostartOverride {
    harness: String,
    session_id: Option<String>,
    enabled: bool,
    updated_at: chrono::DateTime<chrono::FixedOffset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaOverride {
    harness: String,
    session_id: Option<String>,
    wait_for_quota: bool,
    fallback_for_quota: Option<bool>,
    updated_at: chrono::DateTime<chrono::FixedOffset>,
}

impl Autostart {
    fn enabled(&self, harness: &str, id: &str) -> bool {
        if !(1..=8).contains(&self.version) {
            return false;
        }
        let newest = |rows: &[AutostartOverride], session| {
            rows.iter()
                .filter(|r| r.harness == harness && r.session_id.as_deref() == session)
                .max_by_key(|r| (r.updated_at, !r.enabled))
                .map(|r| r.enabled)
        };
        newest(&self.sessions, Some(id))
            .or_else(|| {
                (self.version >= 2)
                    .then(|| newest(&self.harnesses, None))
                    .flatten()
            })
            .unwrap_or(self.enabled)
    }

    fn quota_options(&self, harness: &str, id: &str) -> (bool, bool) {
        if self.version != 8 {
            return (false, false);
        }
        let newest = |rows: &[QuotaOverride], session| {
            rows.iter()
                .filter(|r| r.harness == harness && r.session_id.as_deref() == session)
                .max_by_key(|r| {
                    (
                        r.updated_at,
                        !r.wait_for_quota,
                        r.fallback_for_quota == Some(false),
                    )
                })
                .map(|r| (r.wait_for_quota, r.fallback_for_quota))
        };
        let harness = newest(&self.wait_for_quota_harnesses, None);
        let session = newest(&self.wait_for_quota_sessions, Some(id));
        let wait = session
            .or(harness)
            .map_or(self.wait_for_quota, |(wait, _)| wait);
        let fallback = session
            .and_then(|(_, fallback)| fallback)
            .or_else(|| harness.and_then(|(_, fallback)| fallback))
            .unwrap_or(self.fallback_for_quota);
        (wait, fallback)
    }

    fn admits(&self, harness: &str, id: &str, boundary: &RecoveryBoundary) -> bool {
        self.enabled(harness, id)
            && boundary
                .ancestors
                .iter()
                .all(|ancestor| self.enabled(harness, &ancestor.address.native_session_id))
            && match boundary.failure {
                RecoveryFailure::Interrupted => self.recover_on_disconnect,
                _ => self.recover_on_failure,
            }
    }
}

#[derive(Deserialize)]
struct QuotaPolicyFile {
    version: u8,
    policy: QuotaPolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaPolicy {
    enabled: bool,
    min_remaining_percent: f64,
}

impl Default for QuotaPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            min_remaining_percent: 20.0,
        }
    }
}

fn quota_policy(profile: &RecoveryProfile, harness: &str) -> Option<QuotaPolicy> {
    match private_json::<QuotaPolicyFile>(
        &profile
            .autopilot_state_dir
            .join(format!("{harness}-quota-guard.json")),
    ) {
        Ok(value)
            if value.version == 1
                && (0.0..=100.0).contains(&value.policy.min_remaining_percent) =>
        {
            Some(value.policy)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(QuotaPolicy::default()),
        _ => None,
    }
}

fn select_route(
    profile: &RecoveryProfile,
    settings: &Autostart,
    quota_policy: &QuotaPolicy,
    target: &SessionAddress,
    boundary: &RecoveryBoundary,
    native: &dyn RecoveryControl,
    stage: RecoveryStage,
) -> Option<RecoveryRoute> {
    let (wait, _) = settings.quota_options(native.harness(), &target.native_session_id);
    let reserve = quota_policy.min_remaining_percent.ceil() as u8;
    let saved = RecoveryRoute {
        provider: boundary.provider.clone(),
        model: boundary.model.clone(),
    };
    let alternate = || {
        profile.fallback_routes.iter().find_map(|route| {
            let candidate = RecoveryRoute {
                provider: route.provider.clone(),
                model: Some(route.model.clone()),
            };
            let supports = native.supports_alternate(target, boundary, &candidate);
            let quota = profile.quota(
                native,
                &route.provider,
                Some(&route.model),
                &boundary.cwd,
                reserve,
            );
            (candidate != saved
                && route.workspace == Path::new(&boundary.cwd)
                && supports
                && quota == Some(true))
            .then_some(candidate)
        })
    };
    if stage == RecoveryStage::Fallback {
        return Some(alternate().unwrap_or(saved));
    }

    let from_quota_failure = boundary.failure == RecoveryFailure::Quota;
    let throttled = boundary.failure == RecoveryFailure::Throttled;
    let primary = if from_quota_failure || throttled || quota_policy.enabled {
        profile.quota(
            native,
            &saved.provider,
            saved.model.as_deref(),
            &boundary.cwd,
            reserve,
        )
    } else {
        Some(true)
    };
    if primary == Some(false) {
        // A known exhausted primary route skips an unusable same-route probe
        // and uses a permitted alternate immediately. If none exists, the
        // caller keeps the boundary pending until a later quota check passes.
        return alternate();
    }
    let allowed = if from_quota_failure {
        // An unknown quota is one permitted probe. A known exhausted quota
        // still follows the configured wait policy.
        wait && primary == Some(true) || primary.is_none()
    } else if throttled {
        match native.same_route_retry(target, boundary) {
            SameRouteRetry::Hold => false,
            SameRouteRetry::UseQuotaPolicy => primary.unwrap_or(true),
            SameRouteRetry::Ready => primary.unwrap_or(true),
        }
    } else {
        // Any error, including an unclassified one, gets its first retry.
        primary.unwrap_or(true)
    };
    allowed.then_some(saved)
}

#[derive(Clone)]
pub struct SessionRecovery {
    authority: Arc<ScopedAuthority>,
    control: Arc<dyn RecoveryControl>,
    policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
    waits: Arc<WaitAutomationApplication>,
    reconciler: Arc<dyn TaskReconciler>,
    profile: RecoveryProfile,
    discovery: RecoveryDiscovery,
    scan: Arc<Mutex<Scan>>,
}

#[derive(Default)]
struct Scan {
    after: String,
    native: discovery::NativePages,
    cohort_offset: usize,
    workspaces_first: bool,
    last_tick: Option<Instant>,
}

impl SessionRecovery {
    pub fn new(
        authority: Arc<ScopedAuthority>,
        control: Arc<dyn RecoveryWorkspaceProbe>,
        policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
        waits: Arc<WaitAutomationApplication>,
        reconciler: Arc<dyn TaskReconciler>,
        profile: RecoveryProfile,
        discovery: RecoveryDiscovery,
    ) -> Self {
        if let Some(handoff) = &profile.legacy_handoff {
            handoff.bind_workspace_probe(control.clone());
        }
        Self {
            authority,
            control,
            policy,
            waits,
            reconciler,
            profile,
            discovery,
            scan: Arc::default(),
        }
    }

    fn session_page(
        &self,
        principal: &PrincipalId,
        instance: &InstanceRef,
        after: &str,
        pending_only: bool,
    ) -> Result<Vec<SessionRef>, GateError> {
        let (_gate, writer) = self.authority.lock()?;
        let mut rows = writer
            .connection()
            .prepare(
                "SELECT b.session_ref FROM session_bindings b
             JOIN humanstop_sessions h ON h.session_ref = b.session_ref
             JOIN lineage l ON l.session_ref = b.session_ref
             WHERE b.node_ref=?1 AND b.instance_id=?2 AND h.authority_generation=?3
                AND l.creator_ref=?4 AND b.session_ref > ?5
                AND (NOT ?7 OR b.session_ref IN (
                    SELECT i.target FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
                    WHERE i.principal=?4 AND i.request_key GLOB ?8
                    AND (i.state IN ('admitted','unknown') OR (i.state='dispatching' AND d.phase='handing_off'))))
             ORDER BY b.session_ref LIMIT ?6",
            )
            .map_err(|_| GateError::Store)?;
        rows.query_map(
            params![
                instance.node.0,
                instance.instance_id,
                self.authority.generation,
                principal.0,
                after,
                PAGE_SIZE,
                pending_only,
                format!("{}-recovery:*", self.control.harness())
            ],
            |row| row.get(0).map(SessionRef),
        )
        .map_err(|_| GateError::Store)?
        .collect::<Result<_, _>>()
        .map_err(|_| GateError::Store)
    }

    fn grants(
        &self,
        principal: &PrincipalId,
        instance: &InstanceRef,
        session: &SessionRef,
    ) -> Option<Vec<Grant>> {
        Some(vec![
            self.policy
                .session_read_grant(principal, instance, session)
                .ok()??,
            self.policy
                .session_write_grant(principal, instance, session)
                .ok()??,
        ])
    }

    fn eligible_boundary(
        &self,
        address: &SessionAddress,
    ) -> Result<Option<(Autostart, RecoveryBoundary)>, GateError> {
        let harness = self.control.harness();
        let settings = private_json::<Autostart>(
            &self
                .profile
                .autopilot_state_dir
                .join("session-autostart.json"),
        )
        .map_err(|_| GateError::Unavailable)?;
        if !settings.enabled(harness, &address.native_session_id) {
            return Ok(None);
        }
        let boundary = self
            .control
            .read_boundary(address)
            .map_err(|_| GateError::Unavailable)?;
        Ok(boundary
            .filter(|b| {
                !b.turn_id.trim().is_empty()
                    && !b.input_item_id.trim().is_empty()
                    && !self.profile.recovery_held(harness, &address.native_session_id)
                    && self.profile.owns_target(harness, address, b)
                    && self.profile.owns_ancestors(harness, address, b)
                    && settings.admits(harness, &address.native_session_id, b)
                    && !self.profile.automation_disarmed(harness, b)
            })
            .map(|b| (settings, b)))
    }

    fn recover(
        &self,
        identity: &ConnectionIdentity,
        principal: &PrincipalId,
        session: &SessionRef,
    ) -> Result<bool, GateError> {
        let native = self.control.as_ref();
        let harness = native.harness();
        let instance = native.instance();
        let Some(grants) = self.grants(principal, instance, session) else {
            return Ok(false);
        };
        let (address, scope) = self
            .authority
            .resolve_session(identity, &grants, session, instance)?;
        self.reconcile_pending(identity, &grants, principal, session)?;
        if self.waits.human_stop_active(identity, &address) {
            return Ok(false);
        }
        let Some((settings, boundary)) = self.eligible_boundary(&address)? else {
            return Ok(false);
        };
        if boundary
            .ancestors
            .iter()
            .any(|ancestor| self.waits.human_stop_active(identity, &ancestor.address))
        {
            return Ok(false);
        }
        let Some(quota_policy) = quota_policy(&self.profile, harness) else {
            return Ok(false);
        };
        let now = utc_now().map_err(|_| GateError::Unavailable)?;
        let boundary_key = recovery_key(harness, &address, &boundary)?;
        let history = stages::RecoveryHistory::new(
            harness,
            principal,
            session,
            &address,
            &boundary_key,
            &boundary,
            native.receipt_id(&boundary),
        );
        let attempt = {
            let (_gate, mut writer) = self.authority.lock()?;
            let binding = ReceiptBinding {
                intent_id: "recovery-history",
                principal: &principal.0,
                target_ref: &session.0,
                request_key: "recovery-history",
                address: &address,
            };
            if !super::scope_identity_valid(
                writer.connection(),
                &binding,
                &scope,
                &self.authority.generation,
            )? {
                return Ok(false);
            }
            history.next_attempt(writer.connection_mut(), &scope, &now)?
        };
        let Some(attempt) = attempt else {
            return Ok(false);
        };
        let Some(route) = select_route(
            &self.profile,
            &settings,
            &quota_policy,
            &address,
            &boundary,
            native,
            attempt.stage,
        ) else {
            return Ok(false);
        };
        if self.waits.human_stop_active(identity, &address) {
            return Ok(false);
        }
        let suffix = &attempt.suffix;
        let key = format!("{harness}-recovery:{suffix}");
        let intent_id = format!("{harness}-recovery-intent:{suffix}");
        let task = format!("{harness}-recovery-task:{suffix}");
        let binding = ReceiptBinding {
            intent_id: &intent_id,
            principal: &principal.0,
            target_ref: &session.0,
            request_key: &key,
            address: &address,
        };
        let plan = DispatchPlan {
            target: address.clone(),
            mode: native.mode(),
            expected_turn: None,
        };
        if !attempt.claimed {
            let Some(prepared) = self.authority.prepare(
                identity,
                &grants,
                &binding,
                &scope,
                &plan,
                RECOVERY_MESSAGE,
                &task,
                &now,
                RETAIN_UNTIL,
            )?
            else {
                return Ok(false);
            };
            if prepared != intent_id
                || !self.authority.claim(
                    identity,
                    &grants,
                    &binding,
                    &scope,
                    &plan,
                    RECOVERY_MESSAGE,
                    &now,
                )?
            {
                return Ok(false);
            }
        }
        let handoff = RecoveryHandoff {
            control: native,
            boundary,
            route,
            attempt,
            boundary_key,
            address: &address,
            now: &now,
            principal,
            session,
            settings_path: self
                .profile
                .autopilot_state_dir
                .join("session-autostart.json"),
            profile: &self.profile,
        };
        let outcome = self.authority.handoff(
            identity,
            &grants,
            &binding,
            &scope,
            plan,
            RECOVERY_MESSAGE,
            &now,
            &handoff,
        )?;
        if matches!(
            outcome,
            DurableDispatch::Admitted(_)
                | DurableDispatch::Unknown
                | DurableDispatch::BrowserOutcomeUnknown(_)
        ) {
            self.reconciler
                .reconcile(identity.clone(), grants, task, Some(self.policy.clone()));
            return Ok(true);
        }
        Ok(false)
    }

    fn reconcile_pending(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        principal: &PrincipalId,
        session: &SessionRef,
    ) -> Result<(), GateError> {
        let task = {
            let (_gate, writer) = self.authority.lock()?;
            writer.connection().query_row(
                "SELECT i.task_id FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
                 WHERE i.principal=?1 AND i.target=?2 AND i.request_key GLOB ?3
                   AND (i.state IN ('admitted','unknown') OR (i.state='dispatching' AND d.phase='handing_off'))
                 ORDER BY i.created_at DESC LIMIT 1",
                params![principal.0, session.0, format!("{}-recovery:*", self.control.harness())], |r| r.get::<_, String>(0),
            ).optional().map_err(|_| GateError::Store)?
        };
        if let Some(task) = task {
            self.reconciler.reconcile(
                identity.clone(),
                grants.to_vec(),
                task,
                Some(self.policy.clone()),
            );
        }
        Ok(())
    }
}

impl AutomationTick for SessionRecovery {
    fn tick<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Caller::Principal(principal) = identity.caller() else {
                return;
            };
            let principal = principal.id.clone();
            let identity = identity.clone();
            let authority = self.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if authority
                    .profile
                    .legacy_handoff
                    .as_ref()
                    .is_some_and(|handoff| !handoff.released())
                {
                    return;
                }
                let Ok(mut scan) = authority.scan.lock() else {
                    return;
                };
                if scan
                    .last_tick
                    .is_some_and(|last| last.elapsed() < SCAN_INTERVAL)
                {
                    return;
                }
                scan.last_tick = Some(Instant::now());
                let began = Instant::now();
                let handoff = authority.profile.legacy_handoff.as_ref();
                if let Some(ids) = handoff.filter(|h| !h.scans_workspaces()).and_then(LegacyRecoveryHandoff::cohort) {
                    authority.recover_cohort(
                        &identity, &principal, ids, &mut scan.cohort_offset,
                        began + SCAN_BUDGET, MAX_STARTS_PER_TICK,
                    );
                    return;
                }
                let instance = authority.control.instance();
                let wide = handoff.is_some_and(|h| h.instance_wide || h.scans_workspaces());
                // A settled or archived thread can disappear from listing while its
                // previous admission still needs receipt reconciliation.
                let Ok(sessions) = authority.session_page(&principal, instance, &scan.after, wide)
                else {
                    return;
                };
                let mut starts = 0;
                let registered_budget = if wide { SCAN_BUDGET / 2 } else { SCAN_BUDGET };
                for session in &sessions {
                    if began.elapsed() >= registered_budget {
                        break;
                    }
                    scan.after.clone_from(&session.0);
                    if wide {
                        if let Some(grants) = authority.grants(&principal, instance, session) {
                            let _ = authority
                                .reconcile_pending(&identity, &grants, &principal, session);
                        }
                    } else if authority
                        .recover(&identity, &principal, session)
                        .unwrap_or(false)
                    {
                        starts += 1;
                        if starts >= MAX_STARTS_PER_TICK {
                            return;
                        }
                    }
                }
                if sessions.len() < PAGE_SIZE as usize
                    && sessions.last().is_none_or(|s| scan.after == s.0)
                {
                    scan.after.clear();
                }
                if wide {
                    authority.discover_scope(&identity, &principal, &mut scan, began + SCAN_BUDGET);
                }
            })
            .await;
        })
    }
}

fn recovery_key(
    harness: &str,
    address: &SessionAddress,
    boundary: &RecoveryBoundary,
) -> Result<String, GateError> {
    let bytes = serde_json::to_vec(&(
        format!("{harness}-recovery-v1"),
        address,
        &boundary.turn_id,
        &boundary.input_item_id,
    ))
    .map_err(|_| GateError::Store)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

struct RecoveryHandoff<'a> {
    control: &'a dyn RecoveryControl,
    boundary: RecoveryBoundary,
    route: RecoveryRoute,
    attempt: RecoveryAttempt,
    boundary_key: String,
    address: &'a SessionAddress,
    now: &'a str,
    principal: &'a PrincipalId,
    session: &'a SessionRef,
    settings_path: PathBuf,
    profile: &'a RecoveryProfile,
}

impl BoundedNativeHandoff for RecoveryHandoff<'_> {
    fn permits_claim_locked(&self, writer: &crate::store::Writer) -> Result<bool, GateError> {
        let history = stages::RecoveryHistory::new(
            self.control.harness(),
            self.principal,
            self.session,
            self.address,
            &self.boundary_key,
            &self.boundary,
            self.control.receipt_id(&self.boundary),
        );
        history.matches_claim(writer.connection(), &self.attempt, self.now)
    }

    fn recovery_ancestors(&self) -> &[RecoveryAncestor] {
        &self.boundary.ancestors
    }

    fn requires_clear_waits(&self) -> bool {
        true
    }

    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        let native = self.control;
        let harness = native.harness();
        // The adapter revalidates this native boundary under its control lock.
        // The permit rechecks scope and legacy state without a recursive RPC.
        let target_allowed = || self.profile.owns_target(harness, &plan.target, &self.boundary)
            && !self.profile.recovery_held(harness, &plan.target.native_session_id);
        if !target_allowed() || !self.profile.owns_ancestors(harness, &plan.target, &self.boundary) {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Native recovery ownership or legacy hold changed".into(),
            });
        }
        let current = private_json::<Autostart>(&self.settings_path)
            .ok()
            .zip(quota_policy(self.profile, harness))
            .filter(|(settings, _)| {
                settings.admits(harness, &plan.target.native_session_id, &self.boundary)
            })
            .and_then(|(settings, policy)| {
                let route = select_route(
                    self.profile,
                    &settings,
                    &policy,
                    &plan.target,
                    &self.boundary,
                    native,
                    self.attempt.stage,
                )?;
                Some((route, policy.min_remaining_percent.ceil() as u8))
            });
        let Some((_, reserve)) = current.filter(|(route, _)| *route == self.route) else {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Native recovery policy or quota changed before admission".into(),
            });
        };
        let router = self.profile.router(
            &self.route.provider,
            self.route.model.as_deref(),
            &self.boundary.cwd,
        );
        let saved_quota = self.profile.quota(
            native,
            &self.boundary.provider,
            self.boundary.model.as_deref(),
            &self.boundary.cwd,
            reserve,
        );
        let credential = router.and_then(|_| {
            native.credential(
                &self.route.provider,
                self.route.model.as_deref()?,
                &self.boundary.cwd,
            )
        });
        let disarm_held = || self.profile.automation_disarmed(harness, &self.boundary);
        let still_available = || {
            router
                .zip(credential.as_ref())
                .zip(self.route.model.as_deref())
                .and_then(|((router, credential), model)| {
                    router.available(credential, model, reserve)
                })
                == Some(true)
                && target_allowed() && !disarm_held()
        };
        if router.is_some()
            && credential.is_none()
            && (self.attempt.stage == RecoveryStage::Fallback
                || self.boundary.failure == RecoveryFailure::Quota)
        {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Native recovery quota proof is unavailable before admission".into(),
            });
        }
        let quota_proof = credential.as_ref().map(|credential| RecoveryQuotaProof {
            credential,
            still_available: &still_available,
        });
        let still_allowed = || {
            target_allowed()
                && (router.is_none()
                    || self.attempt.stage != RecoveryStage::Fallback
                    || still_available())
                && private_json::<Autostart>(&self.settings_path)
                    .ok()
                    .is_some_and(|settings| {
                        let (wait, _) =
                            settings.quota_options(harness, &plan.target.native_session_id);
                        let saved_route = RecoveryRoute {
                            provider: self.boundary.provider.clone(),
                            model: self.boundary.model.clone(),
                        };
                        let alternate = self.route != saved_route;
                        settings.admits(harness, &plan.target.native_session_id, &self.boundary)
                            && (alternate
                                || self.boundary.failure != RecoveryFailure::Quota
                                || wait
                                || saved_quota.is_none())
                    })
                && !disarm_held()
        };
        if disarm_held() {
            return Err(SubmitError::DefinitelyNotSent {
                reason: "Owner automation disarm holds native recovery".into(),
            });
        }
        native.submit(
            &plan.target,
            &self.boundary,
            &self.route,
            RecoveryPermit {
                reserve,
                quota_proof,
                still_allowed: &still_allowed,
            },
            message,
            key,
        )
    }
}

impl ScopedAuthority {
    // Called under the same target gate that serializes native admission and
    // owner stops. Parent bindings can be revoked between discovery and submit.
    pub(super) fn recovery_ancestors_held(
        &self,
        writer: &crate::store::Writer,
        child: &ReceiptBinding<'_>,
        ancestors: &[RecoveryAncestor],
    ) -> Result<bool, GateError> {
        let db = writer.connection();
        for ancestor in ancestors {
            let address = &ancestor.address;
            if address.instance != child.address.instance {
                return Ok(true);
            }
            let mut stmt = db.prepare(
                "SELECT b.session_ref, s.scope_generation FROM session_bindings b
                 LEFT JOIN humanstop_sessions s ON s.session_ref=b.session_ref AND s.authority_generation=?4
                 WHERE b.node_ref=?1 AND b.instance_id=?2 AND b.native_session_id=?3 LIMIT 2",
            ).map_err(|_| GateError::Store)?;
            let rows = stmt
                .query_map(
                    params![
                        address.instance.node.0,
                        address.instance.instance_id,
                        address.native_session_id,
                        self.generation
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|_| GateError::Store)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| GateError::Store)?;
            let [(session, Some(generation))] = rows.as_slice() else {
                return Ok(true);
            };
            let binding = ReceiptBinding {
                target_ref: session,
                address,
                ..*child
            };
            if !super::scope_allowed(db, &binding, generation, &self.generation)?
                || self
                    .migration_for_address(db, address, child.request_key)?
                    .blocked
                || !WaitAutomationApplication::blocking_rules_locked(
                    writer,
                    child.principal,
                    session,
                    &address.instance,
                )
                .map_err(|_| GateError::Store)?
                .is_empty()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        adapter::{ReadError, SendMode},
        address::NodeRef,
    };
    use serde_json::{Value, json};
    use std::{
        fs,
        os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    };

    pub(super) struct TestState(pub(super) PathBuf);

    impl TestState {
        pub(super) fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("herder-disarm-{}-{stamp}", std::process::id()));
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            Self(dir)
        }

        fn write_disarm(&self, document: Value) {
            let temporary = self.0.join("new-disarm.json");
            fs::write(&temporary, document.to_string()).unwrap();
            fs::rename(temporary, self.0.join("automation-disarm.json")).unwrap();
        }
    }

    impl Drop for TestState {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn owner_disarm_prefers_narrow_scopes_and_matches_possible_works_by_realpath() {
        let state = TestState::new();
        let project = state.0.join("project");
        let child = project.join("child");
        let alias = state.0.join("alias");
        fs::create_dir_all(child.join("deeper")).unwrap();
        symlink(&project, &alias).unwrap();
        let key = format!(
            "codex\0{}\0the logical title",
            alias.join("child").display()
        );
        state.write_disarm(json!({"version": 2, "disarmed": false, "records": [
            {"scope": "*", "forbidden": true},
            {"scope": alias, "forbidden": false},
            {"scope": child, "forbidden": true, "workKeys": [key]},
        ]}));
        let held = |harness, cwd: &Path| automation_disarm_held(&state.0, harness, cwd);
        assert!(held("codex", &state.0.join("project-sibling")));
        assert!(!held("codex", &project));
        assert!(!held("codex", &alias.join("future")));
        assert!(held("codex", &child));
        assert!(held("codex", &alias.join("child")));
        assert!(!held("opencode", &child));
        assert!(!held("codex", &child.join("deeper")));
    }

    #[test]
    fn owner_disarm_reads_v1_and_fails_closed_except_for_absence() {
        let state = TestState::new();
        let path = state.0.join("automation-disarm.json");
        let project = state.0.join("project");
        let child = project.join("child");
        let held = |cwd: &Path| automation_disarm_held(&state.0, "codex", cwd);
        assert!(!held(&child));
        state.write_disarm(json!({"version": 1, "disarmed": false, "blockedWorkKeys": [
            format!("project\0{}", project.display()),
        ]}));
        assert!(held(&child));
        assert!(!held(&state.0.join("project-sibling")));
        state.write_disarm(json!({"version": 1, "disarmed": true}));
        assert!(held(&state.0));
        for invalid in [
            "{",
            r#"{"version": 3, "records": []}"#,
            r#"{"version": 2, "disarmed": false}"#,
            r#"{"version": 2, "records": [["*", false, []]]}"#,
            r#"{"version": 2, "records": [{"scope": "*", "forbidden": false, "workKeys": null}]}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(held(&child), "{invalid}");
        }
        state.write_disarm(json!({"version": 2, "records": [], "disarmed": true}));
        assert!(!held(&child));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o620)).unwrap();
        assert!(held(&child));
        let other = state.0.join("permitted.json");
        fs::rename(&path, &other).unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(other, path).unwrap();
        assert!(held(&child));
    }

    struct RouteControl {
        target: SessionAddress,
        quota: Option<bool>,
        alternate: bool,
    }

    impl RecoveryControl for RouteControl {
        fn harness(&self) -> &'static str {
            "codex"
        }
        fn instance(&self) -> &InstanceRef {
            &self.target.instance
        }
        fn mode(&self) -> SendMode {
            SendMode::Start
        }
        fn read_boundary(&self, _: &SessionAddress) -> Result<Option<RecoveryBoundary>, ReadError> {
            unreachable!()
        }
        fn quota(&self, provider: &str, _: &str, _: u8) -> Option<bool> {
            match provider {
                "saved" => self.quota,
                "unknown-quota" => None,
                _ => Some(true),
            }
        }
        fn credential(&self, _: &str, _: &str, _: &str) -> Option<RecoveryCredential> {
            None
        }
        fn same_route_retry(&self, _: &SessionAddress, _: &RecoveryBoundary) -> SameRouteRetry {
            SameRouteRetry::Ready
        }
        fn supports_alternate(
            &self,
            _: &SessionAddress,
            _: &RecoveryBoundary,
            route: &RecoveryRoute,
        ) -> bool {
            self.alternate && route.provider != "unsupported"
        }
        fn submit(
            &self,
            _: &SessionAddress,
            _: &RecoveryBoundary,
            _: &RecoveryRoute,
            _: RecoveryPermit<'_>,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            unreachable!()
        }
    }

    #[test]
    fn throttle_retries_the_saved_route_first_even_with_a_good_fallback() {
        let mut control = RouteControl {
            target: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("local".into()),
                    instance_id: "owner".into(),
                },
                native_session_id: "thread".into(),
            },
            quota: Some(true),
            alternate: true,
        };
        let mut boundary = RecoveryBoundary {
            turn_id: "failed-turn".into(),
            input_item_id: "user-input".into(),
            cwd: "/project".into(),
            provider: "saved".into(),
            model: Some("saved-model".into()),
            started_at_ms: 1000,
            failure: RecoveryFailure::Throttled,
            ancestors: vec![],
        };
        let settings = serde_json::from_value(json!({
            "version": 8, "enabled": true, "fallbackForQuota": false, "waitForQuota": true,
            "sessions": [],
        }))
        .unwrap();
        let profile = serde_json::from_value(json!({
            "autopilot_state_dir": "/state",
            "fallback_routes": [
                {"workspace": "/elsewhere", "provider": "wrong-workspace", "model": "replacement"},
                {"workspace": "/project", "provider": "unsupported", "model": "replacement"},
                {"workspace": "/project", "provider": "unknown-quota", "model": "replacement"},
                {"workspace": "/project", "provider": "alternate", "model": "replacement"},
                {"workspace": "/project", "provider": "other", "model": "replacement"}
            ],
        }))
        .unwrap();
        let select = |control: &RouteControl, boundary: &RecoveryBoundary, stage| {
            select_route(
                &profile,
                &settings,
                &QuotaPolicy::default(),
                &control.target,
                boundary,
                control,
                stage,
            )
        };
        let selected = select(&control, &boundary, RecoveryStage::Primary).unwrap();
        assert_eq!(selected.provider, "saved");
        assert_eq!(selected.model.as_deref(), Some("saved-model"));
        let alternate = select(&control, &boundary, RecoveryStage::Fallback).unwrap();
        assert_eq!(alternate.provider, "alternate");
        let mut unconfigured = profile.clone();
        unconfigured.fallback_routes.clear();
        assert_eq!(
            select_route(
                &unconfigured,
                &settings,
                &QuotaPolicy::default(),
                &control.target,
                &boundary,
                &control,
                RecoveryStage::Fallback,
            )
            .unwrap()
            .provider,
            "saved"
        );

        control.alternate = false;
        assert_eq!(
            select(&control, &boundary, RecoveryStage::Fallback)
                .unwrap()
                .provider,
            "saved"
        );
        control.alternate = true;
        for failure in [
            RecoveryFailure::Throttled,
            RecoveryFailure::Quota,
            RecoveryFailure::Retryable,
        ] {
            boundary.failure = failure;
            control.quota = Some(false);
            assert_eq!(
                select(&control, &boundary, RecoveryStage::Primary)
                    .unwrap()
                    .provider,
                "alternate"
            );
        }
        boundary.failure = RecoveryFailure::Quota;
        control.quota = None;
        assert_eq!(
            select(&control, &boundary, RecoveryStage::Primary)
                .unwrap()
                .provider,
            "saved"
        );
        control.quota = Some(true);
        assert_eq!(
            select(&control, &boundary, RecoveryStage::Primary)
                .unwrap()
                .provider,
            "saved"
        );
    }

    struct DisarmAtSubmit<'a> {
        state: &'a TestState,
        instance: InstanceRef,
    }

    impl RecoveryControl for DisarmAtSubmit<'_> {
        fn harness(&self) -> &'static str {
            "codex"
        }
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        fn mode(&self) -> SendMode {
            SendMode::Start
        }
        fn read_boundary(&self, _: &SessionAddress) -> Result<Option<RecoveryBoundary>, ReadError> {
            unreachable!()
        }
        fn quota(&self, _: &str, _: &str, _: u8) -> Option<bool> {
            None
        }
        fn credential(&self, _: &str, _: &str, _: &str) -> Option<RecoveryCredential> {
            unreachable!()
        }

        fn submit(
            &self,
            _: &SessionAddress,
            _: &RecoveryBoundary,
            _: &RecoveryRoute,
            permit: RecoveryPermit<'_>,
            _: &str,
            _: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            assert!((permit.still_allowed)());
            self.state.write_disarm(json!({"version": 2, "records": [
                {"scope": self.state.0, "forbidden": true},
            ]}));
            assert!(!(permit.still_allowed)());
            Err(SubmitError::DefinitelyNotSent {
                reason: "held before native effect".into(),
            })
        }
    }

    #[test]
    fn recovery_handoff_rereads_owner_disarm_in_native_permit() {
        let state = TestState::new();
        let profile = RecoveryProfile {
            autopilot_state_dir: state.0.clone(),
            legacy_handoff: None,
            runner: RecoveryRunner::Mcp,
            fallback_routes: Vec::new(),
        };
        let control = DisarmAtSubmit {
            state: &state,
            instance: InstanceRef {
                node: NodeRef("test-node".into()),
                instance_id: "test-owner".into(),
            },
        };
        let settings_path = state.0.join("session-autostart.json");
        fs::write(
            &settings_path,
            r#"{"version": 8, "enabled": true, "sessions": []}"#,
        )
        .unwrap();
        let address = SessionAddress {
            instance: control.instance.clone(),
            native_session_id: "test-session".into(),
        };
        let handoff = RecoveryHandoff {
            control: &control,
            boundary: RecoveryBoundary {
                turn_id: "turn".into(),
                input_item_id: "input".into(),
                cwd: state.0.to_str().unwrap().into(),
                provider: "test-provider".into(),
                model: None,
                started_at_ms: now_ms().unwrap(),
                failure: RecoveryFailure::Interrupted,
                ancestors: Vec::new(),
            },
            route: RecoveryRoute {
                provider: "test-provider".into(),
                model: None,
            },
            attempt: RecoveryAttempt {
                stage: RecoveryStage::Primary,
                suffix: "test".into(),
                claimed: false,
            },
            boundary_key: "test".into(),
            address: &address,
            now: "2026-11-22T00:00:00Z",
            principal: &PrincipalId("test-principal".into()),
            session: &SessionRef("test-session-ref".into()),
            settings_path,
            profile: &profile,
        };
        let plan = DispatchPlan {
            target: address.clone(),
            mode: control.mode(),
            expected_turn: None,
        };
        let key = RequestKey("test-recovery".into());
        assert!(
            matches!(handoff.submit_bounded(plan.clone(), RECOVERY_MESSAGE, &key),
            Err(SubmitError::DefinitelyNotSent { reason }) if reason == "held before native effect")
        );
        assert!(
            matches!(handoff.submit_bounded(plan, RECOVERY_MESSAGE, &key),
            Err(SubmitError::DefinitelyNotSent { reason }) if reason == "Owner automation disarm holds native recovery")
        );
    }
}
