//! Crash recovery for a native session owner, using the ordinary scoped intent and stop gate.
mod discovery;
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

/// This profile binds the existing owner settings and the provider/model pairs
/// explicitly authorized for this workspace. It is never sourced from a prompt.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryProfile {
    pub autopilot_state_dir: PathBuf,
    pub legacy_handoff: Option<LegacyRecoveryHandoff>,
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
            && (harness == "codex" || self.legacy_handoff.as_ref().is_none_or(|h| !h.scans_workspaces()))
    }

    pub fn valid(&self) -> bool {
        self.autopilot_state_dir.is_absolute()
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
    on_unknown: UnknownQuota,
}

#[derive(PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum UnknownQuota {
    Block,
    Allow,
}

impl Default for QuotaPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            min_remaining_percent: 20.0,
            on_unknown: UnknownQuota::Block,
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
    id: &str,
    boundary: &RecoveryBoundary,
    native: &dyn RecoveryControl,
) -> Option<RecoveryRoute> {
    let (wait, fallback) = settings.quota_options(native.harness(), id);
    let reserve = quota_policy.min_remaining_percent.ceil() as u8;
    let from_quota_failure = boundary.failure == RecoveryFailure::Quota;
    let throttled = boundary.failure == RecoveryFailure::Throttled;
    let needs_primary_quota = from_quota_failure
        || throttled
        || (quota_policy.enabled
            && (native.harness() == "codex" && boundary.provider == "openai"
                || profile
                    .router(&boundary.provider, boundary.model.as_deref(), &boundary.cwd)
                    .is_some()));
    let primary = if needs_primary_quota {
        profile.quota(
            native,
            &boundary.provider,
            boundary.model.as_deref(),
            &boundary.cwd,
            reserve,
        )
    } else {
        Some(true)
    };

    let same_route = if from_quota_failure {
        wait && primary == Some(true)
    } else {
        primary.unwrap_or(quota_policy.on_unknown == UnknownQuota::Allow)
    };
    let target = SessionAddress {
        instance: native.instance().clone(),
        native_session_id: id.into(),
    };
    if fallback && (throttled || !same_route && (from_quota_failure || primary == Some(false))) {
        for route in &profile.fallback_routes {
            let candidate = RecoveryRoute {
                provider: route.provider.clone(),
                model: Some(route.model.clone()),
            };
            if route.provider != boundary.provider
                && route.workspace == Path::new(&boundary.cwd)
                && profile.quota(
                    native,
                    &route.provider,
                    Some(&route.model),
                    &boundary.cwd,
                    reserve,
                ) == Some(true)
                && native.supports_alternate(&target, boundary, &candidate)
            {
                return Some(candidate);
            }
        }
    }
    let allowed = if throttled && native.harness() == "codex" {
        match native.same_route_retry(&target, boundary) {
            SameRouteRetry::Hold => false,
            SameRouteRetry::UseQuotaPolicy => same_route,
            // Absence of an account meter on this custom route is expected.
            // A configured meter with unknown or exhausted quota retains its policy.
            SameRouteRetry::Ready => same_route || (primary.is_none()
                && profile.router(&boundary.provider, boundary.model.as_deref(), &boundary.cwd).is_none()),
        }
    } else {
        same_route
    };
    allowed.then(|| RecoveryRoute {
        provider: boundary.provider.clone(),
        model: boundary.model.clone(),
    })
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
        if self
            .profile
            .recovery_held(harness, &address.native_session_id)
        {
            return Ok(None);
        }
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
                recent(b.started_at_ms)
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
        if self.waits.recovery_blocked(identity, &address) {
            return Ok(false);
        }
        let Some((settings, boundary)) = self.eligible_boundary(&address)? else {
            return Ok(false);
        };
        if boundary
            .ancestors
            .iter()
            .any(|ancestor| self.waits.recovery_blocked(identity, &ancestor.address))
        {
            return Ok(false);
        }
        let Some(quota_policy) = quota_policy(&self.profile, harness) else {
            return Ok(false);
        };
        let route = select_route(
            &self.profile,
            &settings,
            &quota_policy,
            &address.native_session_id,
            &boundary,
            native,
        );
        let Some(route) = route else { return Ok(false) };

        let now = utc_now().map_err(|_| GateError::Unavailable)?;
        let boundary_key = recovery_key(harness, &address, &boundary)?;
        let (suffix, already_claimed, may_start) = {
            let (_gate, writer) = self.authority.lock()?;
            let connection = writer.connection();
            let base_key = format!("{harness}-recovery:{boundary_key}");
            let attempts: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM intents WHERE principal=?1 AND target=?2 AND
                   (request_key=?3 OR request_key GLOB ?4)",
                    params![principal.0, session.0, base_key, format!("{base_key}:*")],
                    |r| r.get(0),
                )
                .map_err(|_| GateError::Store)?;
            let mut suffix = if attempts > 1 {
                format!("{boundary_key}:{}", attempts - 1)
            } else {
                boundary_key.clone()
            };
            let key = format!("{harness}-recovery:{suffix}");
            let state = connection
                .query_row(
                    "SELECT i.state, d.phase, i.native_receipt IS NULL AND
                   coalesce(json_extract(t.result_json, '$.native_submit')='definitely_not_sent', 0)
                 FROM intents i JOIN tasks t ON t.task_id=i.task_id
                 LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
                 WHERE i.principal=?1 AND i.target=?2 AND i.request_key=?3",
                    params![principal.0, session.0, key],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, bool>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| GateError::Store)?;
            let retry = matches!(&state, Some((s, Some(p), true))
                if s == "rejected" && matches!(p.as_str(), "finished" | "stopped"));
            if retry {
                // This is a new attempt only after an explicit no-submit receipt.
                suffix = format!("{boundary_key}:{attempts}");
            }
            let key = format!("{harness}-recovery:{suffix}");
            let recovery_keys = format!("{harness}-recovery:*");
            let held = recovery_delivery_held(connection, &principal.0, &session.0, &key, harness, &boundary)?;
            let previous: u32 = connection.query_row(
                "SELECT COUNT(*) FROM intents WHERE principal=?1 AND target=?2 AND request_key<>?3
                   AND request_key GLOB ?4 AND julianday(created_at) > julianday(?5, '-10 minutes')",
                params![principal.0, session.0, key, recovery_keys, now], |r| r.get(0),
            ).map_err(|_| GateError::Store)?;
            let claimed =
                matches!(&state, Some((s, Some(p), _)) if s == "dispatching" && p == "claimed");
            let ready = retry || attempts == 0 || state.is_some_and(|(s, _, _)| s == "prepared");
            (
                suffix,
                claimed,
                !held && previous < 3 && (ready || claimed),
            )
        };
        if !may_start || self.waits.recovery_blocked(identity, &address) {
            return Ok(false);
        }
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
        if !already_claimed {
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
            DurableDispatch::Admitted(_) | DurableDispatch::Unknown
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

fn recovery_delivery_held(
    connection: &rusqlite::Connection,
    principal: &str,
    session: &str,
    key: &str,
    harness: &str,
    boundary: &RecoveryBoundary,
) -> Result<bool, GateError> {
    // A failed continuation has a new turn and input, hence a new request key.
    // The earlier admission receipt still identifies its output turn after restart.
    let retryable_codex = harness == "codex"
        && matches!(boundary.failure, RecoveryFailure::Retryable | RecoveryFailure::Throttled);
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM intents WHERE principal=?1 AND target=?2 AND request_key<>?3
            AND request_key GLOB ?4 AND (state IN ('dispatching','unknown','admitted')
                OR (?5 AND json_extract(native_receipt,'$.native_id')=?6)))",
        params![principal, session, key, format!("{harness}-recovery:*"), retryable_codex, boundary.turn_id],
        |r| r.get(0),
    ).map_err(|_| GateError::Store)
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
    settings_path: PathBuf,
    profile: &'a RecoveryProfile,
}

impl BoundedNativeHandoff for RecoveryHandoff<'_> {
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
                    &plan.target.native_session_id,
                    &self.boundary,
                    native,
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
        let quota_proof = credential.as_ref().map(|credential| RecoveryQuotaProof {
            credential,
            still_available: &still_available,
        });
        let still_allowed = || {
            recent(self.boundary.started_at_ms) && target_allowed()
                && private_json::<Autostart>(&self.settings_path)
                    .ok()
                    .is_some_and(|settings| {
                        let (wait, fallback) =
                            settings.quota_options(harness, &plan.target.native_session_id);
                        settings.admits(harness, &plan.target.native_session_id, &self.boundary)
                            && if self.route.provider != self.boundary.provider {
                                fallback
                            } else {
                                self.boundary.failure != RecoveryFailure::Quota || wait
                            }
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

    struct TestState(PathBuf);

    #[test]
    fn retry_429_cannot_recover_a_confirmed_recovery_turn() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE intents(principal, target, request_key, state, native_receipt);
            INSERT INTO intents VALUES ('owner','session','codex-recovery:original','confirmed',
                                         '{\"native_id\":\"recovery-turn\"}');").unwrap();
        let mut boundary = RecoveryBoundary {
            turn_id: "recovery-turn".into(), input_item_id: "new-input".into(),
            cwd: "/project".into(), provider: "opencodex".into(), model: Some("saved".into()),
            started_at_ms: 1000, failure: RecoveryFailure::Throttled, ancestors: vec![],
        };
        let held = |boundary: &RecoveryBoundary| {
            recovery_delivery_held(&db, "owner", "session", "codex-recovery:next", "codex", boundary).unwrap()
        };
        assert!(held(&boundary));
        boundary.turn_id = "subsequent-user-turn".into();
        assert!(!held(&boundary));
        db.execute("UPDATE intents SET state='unknown', native_receipt=NULL", []).unwrap();
        assert!(held(&boundary));
    }

    impl TestState {
        fn new() -> Self {
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
            unreachable!()
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
            settings_path,
            profile: &profile,
        };
        let plan = DispatchPlan {
            target: SessionAddress {
                instance: control.instance.clone(),
                native_session_id: "test-session".into(),
            },
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
