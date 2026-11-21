use super::{
    BoundRule, Phase, Result, Rule, STORE, SessionAutopilot, fingerprint,
    judge::{Decision, JudgeFailure},
};
use crate::{
    adapters::codex::control::SemanticTurn,
    application::{
        reconcile::ReceiptBinding,
        scoped_stop::{
            BoundedNativeHandoff, GateError,
            automation_driver::{AutomationTick, has_rule_hint},
            mcp_deliver::utc_now,
        },
    },
    auth::identity::ConnectionIdentity,
    domain::{
        adapter::{Admission, DispatchPlan, RequestKey, SendMode, SubmitError},
        address::SessionRef,
    },
    store::{Writer, intents::EventAdmission},
};
use rusqlite::{OptionalExtension, params};
use std::{future::Future, pin::Pin};

struct Evaluation {
    version: u64,
    rule: Rule,
    turn: SemanticTurn,
}

fn now_ms() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| d.as_millis().try_into().ok())
        .ok_or("clock_unavailable")
}

impl BoundRule {
    /// A pending handoff is reconciled even while the rule or its personal switch is off.
    fn reconcile_prior(
        &self,
        identity: &ConnectionIdentity,
        version: u64,
        rule: &Rule,
    ) -> Result<bool> {
        let Some(task) = &rule.last_task else {
            return Ok(true);
        };
        let principal = self.source.principal(identity)?;
        let status = {
            let (_gate, w) = self.source.authority.lock().map_err(|_| STORE)?;
            w.connection()
                .query_row(
                    "SELECT i.state,d.phase FROM intents i LEFT JOIN humanstop_dispatches d
                ON d.intent_id=i.intent_id WHERE i.task_id=?1 AND i.principal=?2 AND i.target=?3",
                    params![task, principal, rule.proof.session_ref],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(|_| STORE)?
        };
        let Some((state, phase)) = status else {
            return Ok(true);
        };
        if matches!(state.as_str(), "admitted" | "unknown")
            || phase.as_deref() == Some("handing_off")
        {
            let grants =
                self.source
                    .grants(identity, &SessionRef(rule.proof.session_ref.clone()), false)?;
            self.reconciler.reconcile(
                identity.clone(),
                grants,
                task.clone(),
                Some(self.grants_policy.clone()),
            );
            return Ok(false);
        }
        if state == "prepared" || phase.as_deref() == Some("claimed") {
            // An operator may have paused, changed policy, or superseded the observed turn
            // between prepare/claim and handoff. Retire only a provably unsent intent.
            let still_current = matches!(rule.phase, Phase::Continue { .. })
                && self
                    .profile
                    .policy(&rule.proof.owner.native_session_id, &rule.cwd)
                    .ok()
                    .as_ref()
                    == Some(&rule.policy)
                && self
                    .profile
                    .clear(&rule.proof.owner.native_session_id, &rule.cwd)
                && self
                    .control
                    .semantic_turn(&rule.proof.owner.address(), rule.anchor.as_deref(), None)
                    .map_err(|_| "native_boundary_unavailable")?
                    .is_some_and(|turn| Some(turn.id.as_str()) == rule.turn_id.as_deref());
            let (_gate, mut w) = self.source.authority.lock().map_err(|_| STORE)?;
            if self.read_locked(&w)?.is_none_or(|(v, _)| v != version) {
                return Ok(false);
            }
            if still_current && self.validate_locked(rule, &w).is_ok() {
                return Ok(true);
            }
            let tx = w.connection_mut().transaction().map_err(|_| STORE)?;
            let now = utc_now().map_err(|_| STORE)?;
            let n=tx.execute("UPDATE intents SET state='rejected',updated_at=?2 WHERE task_id=?1 AND native_receipt IS NULL
                AND (state='prepared' OR (state='dispatching' AND EXISTS(SELECT 1 FROM humanstop_dispatches d
                    WHERE d.intent_id=intents.intent_id AND d.phase='claimed')))",params![task,now]).map_err(|_|STORE)?;
            if n == 1 {
                tx.execute("UPDATE humanstop_dispatches SET phase='stopped',updated_at=?2 WHERE phase='claimed'
                    AND intent_id=(SELECT intent_id FROM intents WHERE task_id=?1)",params![task,now]).map_err(|_|STORE)?;
                tx.execute("UPDATE tasks SET result_json=?2,updated_at=?3 WHERE task_id=?1",params![task,
                    r#"{"outcome":"rejected","native_submit":"definitely_not_sent","reason":"semantic decision expired"}"#,now]).map_err(|_|STORE)?;
            }
            tx.commit().map_err(|_| STORE)?;
            return Ok(false);
        }
        Ok(true)
    }

    fn next(&self, identity: &ConnectionIdentity) -> Result<Option<Evaluation>> {
        let (version, mut rule) = self.authorized(identity, false)?;
        if !self.reconcile_prior(identity, version, &rule)? || matches!(rule.phase, Phase::Paused) {
            return Ok(None);
        }
        if let Phase::Evaluating { expires_at_ms } = rule.phase
            && now_ms()? >= expires_at_ms
        {
            // A judge process can disappear after its paid request. Keep its cursor;
            // report the missing verdict without evaluating this turn again.
            let (_gate, mut w) = self.source.authority.lock().map_err(|_| STORE)?;
            rule.phase = Phase::JudgeUnavailable;
            self.cas(&mut w, version, &rule)?;
            return Ok(None);
        }
        let session = SessionRef(rule.proof.session_ref.clone());
        self.source.grants(identity, &session, true)?;
        let policy = self
            .profile
            .policy(&rule.proof.owner.native_session_id, &rule.cwd)?;
        let address = rule.proof.owner.address();
        if rule.policy != policy {
            let baseline = self
                .control
                .autopilot_baseline(&address)
                .map_err(|_| "native_baseline_unavailable")?;
            if rule.cwd != baseline.cwd {
                return Ok(None);
            }
            rule.policy = policy;
            rule.turn_id = baseline.completed;
            rule.anchor = baseline.context_start;
            rule.phase = Phase::Armed;
            let (_gate, mut w) = self.source.authority.lock().map_err(|_| STORE)?;
            self.validate_locked(&rule, &w)?;
            self.cas(&mut w, version, &rule)?;
            return Ok(None);
        }
        {
            let (_gate, w) = self.source.authority.lock().map_err(|_| STORE)?;
            self.validate_locked(&rule, &w)?;
        }
        let pending = matches!(rule.phase, Phase::Continue { .. }) && self.needs_handoff(&rule)?;
        let skip = if pending {
            None
        } else {
            rule.turn_id.as_deref()
        };
        let Some(turn) = self
            .control
            .semantic_turn(&address, rule.anchor.as_deref(), skip)
            .map_err(|_| "native_boundary_unavailable")?
        else {
            return Ok(None);
        };
        if turn.cwd != rule.cwd {
            return Ok(None);
        }
        if rule.turn_id.as_ref() == Some(&turn.id) {
            if pending {
                self.dispatch(identity, version, &rule, &turn)?;
            }
            return Ok(None);
        }
        if matches!(
            rule.phase,
            Phase::Done | Phase::Human | Phase::Choice | Phase::Held
        ) && !turn.has_new_human_input
        {
            return Ok(None);
        }
        let (_gate, mut w) = self.source.authority.lock().map_err(|_| STORE)?;
        self.validate_locked(&rule, &w)?;
        if self.read_locked(&w)?.is_none_or(|(v, _)| v != version) {
            return Ok(None);
        }
        let b = ReceiptBinding {
            intent_id: "semantic-observation",
            request_key: &rule.request_key,
            principal: self.source.principal(identity)?,
            target_ref: &session.0,
            address: &address,
        };
        if super::super::scope_unsettled(w.connection(), &b).map_err(|_| STORE)?
            || self
                .source
                .authority
                .recovery_ancestors_held(&w, &b, &turn.ancestors)
                .map_err(|_| STORE)?
            || !turn
                .ancestors
                .iter()
                .all(|a| self.profile.clear(&a.address.native_session_id, &a.cwd))
        {
            return Ok(None);
        }
        // Persist paid inference admission first. A crashed or duplicated observer can
        // never charge the judge again for the same native turn, even after a rollback.
        let now = utc_now().map_err(|_| STORE)?;
        let admission = w
            .admit_event_once(&self.rule_ref, &turn.id, &fingerprint(&turn)?, &now)
            .map_err(|_| STORE)?;
        rule.turn_id = Some(turn.id.clone());
        if admission != EventAdmission::Admitted {
            // The owner may have exited between event admission and saving its cursor.
            // Record the unresolved verdict without issuing a second judge request.
            rule.phase = Phase::JudgeUnavailable;
            self.cas(&mut w, version, &rule)?;
            return Ok(None);
        }
        rule.phase = Phase::Evaluating {
            expires_at_ms: now_ms()?.saturating_add(90_000),
        };
        self.cas(&mut w, version, &rule)?;
        Ok(Some(Evaluation {
            version: version + 1,
            rule,
            turn,
        }))
    }

    fn finish(
        &self,
        identity: &ConnectionIdentity,
        evaluation: Evaluation,
        decision: std::result::Result<Decision, JudgeFailure>,
    ) -> Result<()> {
        let Evaluation {
            version,
            mut rule,
            turn,
        } = evaluation;
        let permitted = self
            .source
            .grants(identity, &SessionRef(rule.proof.session_ref.clone()), true)
            .is_ok();
        let observation = matches!(decision, Ok(Decision::Continue { .. })).then(|| {
            self.control
                .semantic_turn(&rule.proof.owner.address(), rule.anchor.as_deref(), None)
        });
        let stale = matches!(&observation, Some(Ok(current)) if current.as_ref() != Some(&turn));
        let verified = matches!(observation, Some(Ok(Some(_))));
        {
            let (_gate, mut w) = self.source.authority.lock_wait().map_err(|_| STORE)?;
            if self.read_locked(&w)?.is_none_or(|(v, _)| v != version) {
                return Ok(());
            }
            rule.phase = if stale || !permitted || self.validate_locked(&rule, &w).is_err() {
                Phase::Held
            } else {
                match decision {
                    Err(JudgeFailure::Unavailable) => Phase::JudgeUnavailable,
                    Err(JudgeFailure::RateLimited) => Phase::JudgeRateLimited,
                    Err(JudgeFailure::QuotaExhausted) => Phase::JudgeQuotaExhausted,
                    Ok(Decision::Done) => Phase::Done,
                    Ok(Decision::Human) => Phase::Human,
                    Ok(Decision::Choice) => Phase::Choice,
                    Ok(Decision::Continue { .. }) if rule.continuations >= rule.policy.limit => {
                        Phase::Held
                    }
                    Ok(Decision::Continue { next_goal }) => {
                        rule.last_task = Some(self.ids(&rule, &turn.id)?.2);
                        rule.continuations += 1;
                        Phase::Continue {
                            next_goal,
                            observation: fingerprint(&turn)?,
                        }
                    }
                }
            };
            self.cas(&mut w, version, &rule)?;
        }
        // A busy native reader can recheck this saved decision on the next tick.
        if verified && matches!(rule.phase, Phase::Continue { .. }) {
            self.dispatch(identity, version + 1, &rule, &turn)?;
        }
        Ok(())
    }
    fn ids(&self, rule: &Rule, turn: &str) -> Result<(String, String, String)> {
        let hash = fingerprint(&(&rule.proof.owner, turn))?;
        Ok((
            format!("codex-autopilot:{hash}"),
            format!("codex-autopilot-intent:{hash}"),
            format!("codex-autopilot-task:{hash}"),
        ))
    }
    fn needs_handoff(&self, rule: &Rule) -> Result<bool> {
        let (_gate, w) = self.source.authority.lock().map_err(|_| STORE)?;
        let started:bool=w.connection().query_row("SELECT EXISTS(SELECT 1 FROM intents i LEFT JOIN humanstop_dispatches d
            ON d.intent_id=i.intent_id WHERE i.task_id=?1 AND i.state<>'prepared' AND COALESCE(d.phase,'')<>'claimed')",
            [&rule.last_task],|r|r.get(0)).map_err(|_|STORE)?;
        Ok(!started)
    }
    fn dispatch(
        &self,
        identity: &ConnectionIdentity,
        version: u64,
        rule: &Rule,
        turn: &SemanticTurn,
    ) -> Result<()> {
        let Phase::Continue {
            next_goal,
            observation,
        } = &rule.phase
        else {
            return Ok(());
        };
        if observation != &fingerprint(turn)? {
            return Ok(());
        }
        let address = rule.proof.owner.address();
        let session = SessionRef(rule.proof.session_ref.clone());
        let grants = self.source.grants(identity, &session, true)?;
        let (key, intent, task) = self.ids(rule, &turn.id)?;
        let b = ReceiptBinding {
            intent_id: &intent,
            principal: self.source.principal(identity)?,
            target_ref: &session.0,
            request_key: &key,
            address: &address,
        };
        let plan = DispatchPlan {
            target: address.clone(),
            mode: SendMode::Start,
            expected_turn: None,
        };
        let scope = &rule.proof.scope_generation;
        let now = utc_now().map_err(|_| STORE)?;
        let authority = &self.source.authority;
        let control = SemanticHandoff {
            app: self,
            version,
            rule,
            turn,
        };
        {
            let (_gate, w) = authority.lock().map_err(|_| STORE)?;
            if !control.permits_claim_locked(&w).map_err(|_| STORE)? {
                return Ok(());
            }
        }
        if authority
            .prepare(
                identity,
                &grants,
                &b,
                scope,
                &plan,
                next_goal,
                &task,
                &now,
                "9999-12-31T23:59:59Z",
            )
            .map_err(|_| STORE)?
            .as_deref()
            != Some(&intent)
        {
            return Ok(());
        }
        // A claim from this turn can survive a process exit. Handoff itself serializes
        // claimed -> handing_off and rejects every later submit with this key.
        authority
            .claim(identity, &grants, &b, scope, &plan, next_goal, &now)
            .map_err(|_| STORE)?;
        authority
            .handoff(
                identity, &grants, &b, scope, plan, next_goal, &now, &control,
            )
            .map_err(|_| STORE)?;
        self.reconciler.reconcile(
            identity.clone(),
            grants,
            task,
            Some(self.grants_policy.clone()),
        );
        Ok(())
    }
}

struct SemanticHandoff<'a> {
    app: &'a BoundRule,
    version: u64,
    rule: &'a Rule,
    turn: &'a SemanticTurn,
}
impl BoundedNativeHandoff for SemanticHandoff<'_> {
    fn recovery_ancestors(&self) -> &[crate::domain::recovery::RecoveryAncestor] {
        &self.turn.ancestors
    }
    fn requires_clear_waits(&self) -> bool {
        true
    }
    fn permits_claim_locked(&self, w: &Writer) -> std::result::Result<bool, GateError> {
        Ok(self
            .app
            .read_locked(w)
            .map_err(|_| GateError::Store)?
            .is_some_and(|(v, _)| v == self.version)
            && self.app.validate_locked(self.rule, w).is_ok())
    }
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> std::result::Result<Admission, SubmitError> {
        self.app.control.submit_semantic(
            &plan.target,
            self.rule.anchor.as_deref(),
            self.turn,
            key,
            message,
            || {
                self.app
                    .profile
                    .policy(&self.rule.proof.owner.native_session_id, &self.rule.cwd)
                    .ok()
                    .as_ref()
                    == Some(&self.rule.policy)
                    && self
                        .app
                        .profile
                        .clear(&self.rule.proof.owner.native_session_id, &self.rule.cwd)
                    && self
                        .turn
                        .ancestors
                        .iter()
                        .all(|a| self.app.profile.clear(&a.address.native_session_id, &a.cwd))
            },
        )
    }
}
#[derive(Default)]
pub(super) struct Scan {
    after: String,
    running: std::collections::BTreeMap<String, tokio::task::JoinHandle<()>>,
}

impl BoundRule {
    async fn observe(self, identity: ConnectionIdentity) {
        let (rule, id) = (self.clone(), identity.clone());
        if let Ok(Ok(Some(evaluation))) = tokio::task::spawn_blocking(move || rule.next(&id)).await
        {
            let decision = self
                .profile
                .judge
                .decide(
                    &self.client,
                    &evaluation.rule.instructions,
                    &evaluation.turn,
                )
                .await;
            let _ =
                tokio::task::spawn_blocking(move || self.finish(&identity, evaluation, decision))
                    .await;
        }
    }
}
impl SessionAutopilot {
    fn scan_rules(&self, identity: ConnectionIdentity) -> Result<()> {
        if !has_rule_hint(&self.source.authority, &self.scope) {
            return Ok(());
        }
        let mut scan = self.scan.lock().map_err(|_| STORE)?;
        scan.running.retain(|_, task| !task.is_finished());
        let slots = 4 - scan.running.len();
        if slots == 0 {
            return Ok(());
        }
        let keys = {
            let (_gate, w) = self.source.authority.lock().map_err(|_| STORE)?;
            let mut q = w
                .connection()
                .prepare(
                    "SELECT setting_key FROM settings WHERE scope=?1
                AND setting_key GLOB 'rule:*' AND setting_key>?2 ORDER BY setting_key LIMIT ?3",
                )
                .map_err(|_| STORE)?;
            q.query_map(params![self.scope, scan.after, slots], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|_| STORE)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| STORE)?
        };
        for key in &keys {
            let reference = key.strip_prefix("rule:").ok_or(STORE)?;
            if !scan.running.contains_key(reference) {
                let rule = self.by_ref(reference)?;
                scan.running.insert(
                    reference.into(),
                    tokio::spawn(rule.observe(identity.clone())),
                );
            }
        }
        // Fair bounded pages over explicitly registered rules, including after a restart.
        scan.after = if keys.len() == slots {
            keys.last().cloned().unwrap_or_default()
        } else {
            String::new()
        };
        Ok(())
    }
}
impl AutomationTick for SessionAutopilot {
    fn tick<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let (app, id) = (self.clone(), identity.clone());
            let _ = tokio::task::spawn_blocking(move || app.scan_rules(id)).await;
        })
    }
}
