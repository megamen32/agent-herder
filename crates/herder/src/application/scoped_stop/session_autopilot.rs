//! One opt-in semantic Codex rule in the existing owner's automation driver and delivery ledger.
mod executor;
mod judge;
mod policy;
pub use policy::AutopilotProfile;

use super::{
    create_prompt::FreshSessionGrantPolicy,
    mcp_deliver::utc_now,
    task_reconcile::TaskReconciler,
    wait_automation::{DependencySource, WaitAutomationApplication, hex},
    wait_sources::{SessionProof, valid_id},
};
use crate::{
    adapters::codex::control::{CodexControl, SemanticBaseline},
    auth::identity::ConnectionIdentity,
    domain::address::SessionRef,
    mcp::{
        catalog::{Automation, AutomationRule},
        transport::ApplicationPort,
    },
    store::{Writer, intents::SettingAdmission},
};
use policy::PolicyVersion;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Result<T> = std::result::Result<T, &'static str>;
const STORE: &str = "autopilot_store_unavailable";

fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value).map_err(|_| STORE)?))
}

#[derive(Clone, Serialize, Deserialize)]
struct Rule {
    proof: SessionProof,
    cwd: String,
    create_fingerprint: String,
    request_key: String,
    instructions: String,
    revision: u64,
    policy: PolicyVersion,
    anchor: Option<String>,
    turn_id: Option<String>,
    phase: Phase,
    continuations: u64,
    last_task: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Phase {
    Armed,
    Paused,
    Evaluating {
        expires_at_ms: u64,
    },
    JudgeUnavailable,
    JudgeRateLimited,
    JudgeQuotaExhausted,
    Held,
    Done,
    Human,
    Choice,
    Continue {
        next_goal: String,
        observation: String,
    },
}

type Stored = (u64, Rule);

#[derive(Clone)]
pub struct SessionAutopilot {
    source: Arc<DependencySource>,
    principal: String,
    control: Arc<CodexControl>,
    reconciler: Arc<dyn TaskReconciler>,
    grants_policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
    profile: AutopilotProfile,
    client: reqwest::Client,
    scope: String,
    scan: Arc<std::sync::Mutex<executor::Scan>>,
}

#[derive(Clone)]
struct BoundRule {
    owner: SessionAutopilot,
    rule_ref: String,
    key: String,
}

impl std::ops::Deref for BoundRule {
    type Target = SessionAutopilot;
    fn deref(&self) -> &Self::Target {
        &self.owner
    }
}

impl SessionAutopilot {
    pub fn new(
        source: Arc<DependencySource>,
        control: Arc<CodexControl>,
        reconciler: Arc<dyn TaskReconciler>,
        grants_policy: Arc<dyn FreshSessionGrantPolicy + Send + Sync>,
        principal: &str,
        profile: AutopilotProfile,
    ) -> Result<Self> {
        let scope = format!(
            "automation:codex-autopilot:{}",
            fingerprint(&(principal, &source.instance))?
        );
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| "judge_client_unavailable")?;
        Ok(Self {
            scope,
            scan: Arc::default(),
            source,
            principal: principal.into(),
            control,
            reconciler,
            grants_policy,
            profile,
            client,
        })
    }
    fn for_session(&self, session: &str) -> Result<BoundRule> {
        self.by_ref(&format!(
            "autopilot-rule:{}",
            fingerprint(&(&self.scope, session))?
        ))
    }
    fn by_ref(&self, rule_ref: &str) -> Result<BoundRule> {
        if !rule_ref
            .strip_prefix("autopilot-rule:")
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("rule_not_found");
        }
        Ok(BoundRule {
            owner: self.clone(),
            key: format!("rule:{rule_ref}"),
            rule_ref: rule_ref.to_owned(),
        })
    }
    pub fn owns_rule(&self, rule_ref: &str) -> Result<bool> {
        if !rule_ref.starts_with("autopilot-rule:") {
            return Ok(false);
        }
        Ok(self.by_ref(rule_ref)?.read()?.is_some())
    }
    pub fn list(&self, identity: &ConnectionIdentity, session: Option<&str>) -> Result<Vec<Value>> {
        self.source.principal(identity)?;
        let rules = if let Some(s) = session {
            vec![self.for_session(s)?]
        } else {
            let (_gate, w) = self.source.authority.lock().map_err(|_| STORE)?;
            w.list_settings(&self.scope, "rule:")
                .map_err(|_| STORE)?
                .into_iter()
                .map(|(k, _)| self.by_ref(k.strip_prefix("rule:").ok_or(STORE)?))
                .collect::<Result<Vec<_>>>()?
        };
        let mut rows = Vec::new();
        for bound in rules {
            match bound.authorized(identity, false) {
                Ok((_, r)) => rows.push(bound.view(&r)),
                Err("rule_not_found" | "session_grant_required" | "unauthorized") => (),
                Err(e) => return Err(e),
            }
        }
        Ok(rows)
    }
}

impl BoundRule {
    fn read_locked(&self, writer: &Writer) -> Result<Option<Stored>> {
        writer
            .get_setting_versioned(&self.scope, &self.key)
            .map_err(|_| STORE)?
            .map(|(v, raw)| Ok((v, serde_json::from_str(&raw).map_err(|_| STORE)?)))
            .transpose()
    }
    fn read(&self) -> Result<Option<Stored>> {
        let (_lock, w) = self.source.authority.lock_wait().map_err(|_| STORE)?;
        self.read_locked(&w)
    }
    fn cas(&self, writer: &mut Writer, version: u64, rule: &Rule) -> Result<()> {
        let value = serde_json::to_string(rule).map_err(|_| STORE)?;
        if writer
            .compare_and_set_setting(
                &self.scope,
                &self.key,
                version,
                &value,
                &utc_now().map_err(|_| STORE)?,
            )
            .map_err(|_| STORE)?
        {
            Ok(())
        } else {
            Err("revision_conflict")
        }
    }
    fn view(&self, rule: &Rule) -> Value {
        let phase = json!(&rule.phase)["phase"].clone();
        json!({"rule_ref":self.rule_ref,"kind":"autopilot","session_ref":rule.proof.session_ref,
            "rule":{"kind":"autopilot","instructions":rule.instructions},"revision":rule.revision,
            "enabled":!matches!(rule.phase,Phase::Paused),"phase":phase,"status":phase,
            "turn_id":rule.turn_id,"delivery_task_id":rule.last_task,"continuations":rule.continuations})
    }
    fn authorized(&self, identity: &ConnectionIdentity, write: bool) -> Result<Stored> {
        self.source.principal(identity)?;
        let stored = self.read()?.ok_or("rule_not_found")?;
        let proof = &stored.1.proof;
        self.source
            .grants(identity, &SessionRef(proof.session_ref.clone()), write)?;
        if self.for_session(&proof.session_ref)?.rule_ref != self.rule_ref
            || proof.owner.address().instance != self.source.instance
        {
            return Err("session_binding_changed");
        }
        Ok(stored)
    }
    fn baseline(
        &self,
        identity: &ConnectionIdentity,
        session: &SessionRef,
    ) -> Result<(SessionProof, SemanticBaseline, PolicyVersion)> {
        let proof = self.source.capture(identity, session, true)?;
        let address = proof.owner.address();
        let baseline = self
            .control
            .autopilot_baseline(&address)
            .map_err(|_| "native_baseline_unavailable")?;
        let policy = self
            .profile
            .policy(&address.native_session_id, &baseline.cwd)?;
        Ok((proof, baseline, policy))
    }
    fn create(
        &self,
        identity: &ConnectionIdentity,
        session: String,
        instructions: String,
        key: String,
    ) -> Result<Value> {
        if !valid_id(&key) || !valid_instructions(&instructions) {
            return Err("invalid_request");
        }
        let session = SessionRef(session);
        self.source.grants(identity, &session, true)?;
        let fingerprint = fingerprint(&(&session, &key, &instructions))?;
        if let Some((_, saved)) = self.read()? {
            return self.existing(&saved, &session, &fingerprint);
        }
        let (proof, baseline, policy) = self.baseline(identity, &session)?;
        let rule = Rule {
            proof,
            cwd: baseline.cwd,
            create_fingerprint: fingerprint.clone(),
            request_key: key,
            instructions,
            revision: 1,
            policy,
            anchor: baseline.context_start,
            turn_id: baseline.completed,
            phase: Phase::Armed,
            continuations: 0,
            last_task: None,
        };
        let (_gate, mut w) = self.source.authority.lock().map_err(|_| STORE)?;
        self.validate_locked(&rule, &w)?;
        match w
            .put_setting_once(
                &self.scope,
                &self.key,
                &serde_json::to_string(&rule).map_err(|_| STORE)?,
                &utc_now().map_err(|_| STORE)?,
            )
            .map_err(|_| STORE)?
        {
            SettingAdmission::Stored | SettingAdmission::Existing => Ok(self.view(&rule)),
            SettingAdmission::Conflict => self.existing(
                &self.read_locked(&w)?.ok_or(STORE)?.1,
                &session,
                &fingerprint,
            ),
        }
    }

    fn existing(&self, saved: &Rule, session: &SessionRef, fingerprint: &str) -> Result<Value> {
        if saved.proof.session_ref != session.0 {
            return Err("autopilot_session_mismatch");
        }
        if saved.create_fingerprint != fingerprint {
            return Err("idempotency_conflict");
        }
        Ok(self.view(saved))
    }

    fn validate_locked(&self, rule: &Rule, w: &Writer) -> Result<()> {
        self.source.validate_locked(&rule.proof, w)?;
        if !WaitAutomationApplication::blocking_rules_locked(
            w,
            &self.principal,
            &rule.proof.session_ref,
            &self.source.instance,
        )?
        .is_empty()
        {
            return Err("automation_held");
        }
        if self
            .source
            .authority
            .migration_for_address(
                w.connection(),
                &rule.proof.owner.address(),
                &rule.request_key,
            )
            .map_err(|_| STORE)?
            .blocked
        {
            return Err("legacy_migration_quarantined");
        }
        if self
            .profile
            .policy(&rule.proof.owner.native_session_id, &rule.cwd)?
            != rule.policy
            || !self
                .profile
                .clear(&rule.proof.owner.native_session_id, &rule.cwd)
        {
            return Err("automation_held");
        }
        Ok(())
    }
    fn change(
        &self,
        identity: &ConnectionIdentity,
        revision: u64,
        instructions: Option<String>,
    ) -> Result<Value> {
        let (_, orig) = self.authorized(identity, true)?;
        if revision != orig.revision {
            return Err("revision_conflict");
        }
        let mut baseline = None;
        if let Some(text) = instructions.as_ref() {
            if !valid_instructions(text) {
                return Err("invalid_request");
            }
            baseline = Some(self.baseline(identity, &SessionRef(orig.proof.session_ref.clone()))?);
        }
        // Internal cursor updates never invalidate the revision displayed to an operator.
        let (_gate, mut w) = self.source.authority.lock_wait().map_err(|_| STORE)?;
        let (v, mut saved) = self.read_locked(&w)?.ok_or("rule_not_found")?;
        if revision != saved.revision {
            return Err("revision_conflict");
        }
        if let (Some(text), Some((proof, baseline, policy))) = (instructions, baseline) {
            saved.instructions = text;
            saved.proof = proof;
            saved.cwd = baseline.cwd;
            saved.policy = policy;
            saved.anchor = baseline.context_start;
            saved.turn_id = baseline.completed;
            saved.phase = Phase::Armed;
            self.validate_locked(&saved, &w)?;
        } else {
            saved.phase = Phase::Paused;
        }
        saved.revision = saved.revision.checked_add(1).ok_or(STORE)?;
        self.cas(&mut w, v, &saved)?;
        Ok(self.view(&saved))
    }
}
impl SessionAutopilot {
    fn command(&self, identity: &ConnectionIdentity, action: Automation) -> Result<Value> {
        match action {
            Automation::Create {
                session_ref,
                rule: AutomationRule::Autopilot { instructions },
                request_key,
            } => self.for_session(&session_ref)?.create(
                identity,
                session_ref,
                instructions,
                request_key,
            ),
            Automation::Get { rule_ref } => {
                let bound = self.by_ref(&rule_ref)?;
                Ok(bound.view(&bound.authorized(identity, false)?.1))
            }
            Automation::Pause { rule_ref, revision } => {
                self.by_ref(&rule_ref)?.change(identity, revision, None)
            }
            Automation::Update {
                rule_ref,
                revision,
                rule: AutomationRule::Autopilot { instructions },
            } => self
                .by_ref(&rule_ref)?
                .change(identity, revision, Some(instructions)),
            _ => Err("rule_not_found"),
        }
    }
}

fn valid_instructions(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= 4096 && !text.contains('\0')
}

impl ApplicationPort for SessionAutopilot {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: crate::mcp::catalog::Request,
    ) -> crate::mcp::transport::ApplicationFuture<'a> {
        use rmcp::model::CallToolResult;
        Box::pin(async move {
            let crate::mcp::catalog::Request::Automation(action) = request else {
                return None;
            };
            match &action {
                Automation::Create {
                    rule: AutomationRule::Autopilot { .. },
                    ..
                } => (),
                Automation::Get { rule_ref }
                | Automation::Update { rule_ref, .. }
                | Automation::Pause { rule_ref, .. }
                    if rule_ref.starts_with("autopilot-rule:") =>
                {
                    ()
                }
                _ => return None,
            }
            let (app, id) = (self.clone(), identity.clone());
            let result = tokio::task::spawn_blocking(move || app.command(&id, action))
                .await
                .unwrap_or(Err(STORE));
            Some(match result {
                Ok(data) => CallToolResult::structured(data),
                Err(code) => CallToolResult::structured_error(json!({"code":code,"effect":"none"})),
            })
        })
    }
}
