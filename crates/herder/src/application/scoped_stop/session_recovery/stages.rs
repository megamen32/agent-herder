//! The intent key records the stage. The latest native boundary determines
//! whether a previous admission belongs to this failure or to earlier work.
use super::GateError;
use crate::{
    application::reconcile::{ReceiptBinding, StoredReceipt, load_native_receipt},
    auth::identity::PrincipalId,
    domain::{
        address::{SessionAddress, SessionRef},
        recovery::RecoveryBoundary,
    },
};
use rmcp::model::CallToolResult;
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::json;
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RecoveryStage {
    Primary,
    Fallback,
}

impl RecoveryStage {
    fn label(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct RecoveryAttempt {
    pub suffix: String,
    pub stage: RecoveryStage,
    pub claimed: bool,
}

fn parse_suffix(suffix: &str) -> Option<(&str, RecoveryStage, u32)> {
    let (digest, stage) = suffix.split_once(':')?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let (stage, retry) = match stage.split_once(':') {
        Some((stage, value)) => {
            let retry: u32 = value.parse().ok()?;
            if retry == 0 || retry.to_string() != value {
                return None;
            }
            (stage, retry)
        }
        None => (stage, 0),
    };
    let stage = match stage {
        "primary" => RecoveryStage::Primary,
        "fallback" => RecoveryStage::Fallback,
        _ => return None,
    };
    Some((digest, stage, retry))
}

pub(super) struct RecoveryHistory<'a> {
    prefix: String,
    principal: &'a str,
    session: &'a str,
    address: &'a SessionAddress,
    digest: &'a str,
    native_id: Cow<'a, str>,
    boundary_started_at_ms: u64,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DeliveryState {
    Prepared,
    Claimed,
    DefinitelyNotSent,
    Admitted,
    Settled,
    Uncertain,
}

struct Delivery {
    intent_id: String,
    task_id: String,
    key: String,
    state: DeliveryState,
    phase: Option<String>,
    task_result: Option<String>,
    dispatch_scope: Option<String>,
    claim_before_boundary: bool,
    matches_boundary: bool,
}

impl<'a> RecoveryHistory<'a> {
    pub fn new(
        harness: &str,
        principal: &'a PrincipalId,
        session: &'a SessionRef,
        address: &'a SessionAddress,
        digest: &'a str,
        boundary: &'a RecoveryBoundary,
        native_id: Cow<'a, str>,
    ) -> Self {
        Self {
            prefix: format!("{harness}-recovery"),
            principal: &principal.0,
            session: &session.0,
            address,
            digest,
            native_id,
            boundary_started_at_ms: boundary.started_at_ms,
        }
    }

    fn deliveries(&self, db: &Connection, now: &str) -> Result<Vec<Delivery>, GateError> {
        let mut stmt = db.prepare(
            "SELECT i.intent_id, i.task_id, i.request_key, i.state, d.phase, d.scope_generation,
                    i.native_receipt IS NOT NULL,
                    CASE WHEN json_valid(t.result_json)
                         THEN coalesce(json_extract(t.result_json, '$.native_submit')='definitely_not_sent', 0)
                              OR coalesce(json_extract(t.result_json, '$.structuredContent.effect')='none'
                                  AND json_extract(t.result_json, '$.structuredContent.code')
                                      IN ('adapter_refused','human_stop_active'), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(i.native_receipt)
                         THEN coalesce(json_extract(i.native_receipt, '$.native_id')=?5, 0)
                         ELSE 0 END AS same_id, d.updated_at, t.result_json
             FROM intents i JOIN tasks t ON t.task_id=i.task_id AND t.principal=i.principal
             LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
             WHERE i.principal=?1 AND i.target=?2 AND i.request_key GLOB ?3
                AND (i.state IN ('admitted','unknown','dispatching') OR d.phase='handing_off'
                     OR i.request_key=?6 OR i.request_key GLOB ?7
                     OR julianday(i.created_at) > julianday(?4, '-10 minutes') OR same_id)",
        ).map_err(|_| GateError::Store)?;
        let base = format!("{}:{}", self.prefix, self.digest);
        let rows = stmt
            .query_map(
                params![
                    self.principal,
                    self.session,
                    format!("{}:*", self.prefix),
                    now,
                    self.native_id.as_ref(),
                    base,
                    format!("{base}:*"),
                ],
                |row| {
                    let state: String = row.get(3)?;
                    let phase: Option<String> = row.get(4)?;
                    let has_receipt: bool = row.get(6)?;
                    let no_submit: bool = row.get(7)?;
                    let state = match (state.as_str(), phase.as_deref(), has_receipt) {
                        ("prepared", None, false) => DeliveryState::Prepared,
                        ("dispatching", Some("claimed"), false) => DeliveryState::Claimed,
                        ("rejected", Some("finished" | "stopped"), false) if no_submit => {
                            DeliveryState::DefinitelyNotSent
                        }
                        ("admitted", None | Some("finished" | "handing_off"), true) => {
                            DeliveryState::Admitted
                        }
                        ("confirmed" | "rejected", None | Some("finished" | "stopped"), _) => {
                            DeliveryState::Settled
                        }
                        _ => DeliveryState::Uncertain,
                    };
                    let dispatch_time: Option<String> = row.get(9)?;
                    let claim_before_boundary = dispatch_time
                        .as_deref()
                        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                        .and_then(|claim| u64::try_from(claim.timestamp_millis()).ok())
                        // Durable UTC timestamps are truncated to seconds.
                        .is_some_and(|claim_ms| {
                            claim_ms.saturating_add(1000) <= self.boundary_started_at_ms
                        });
                    Ok(Delivery {
                        intent_id: row.get(0)?,
                        task_id: row.get(1)?,
                        key: row.get(2)?,
                        state,
                        phase,
                        task_result: row.get(10)?,
                        dispatch_scope: row.get(5)?,
                        matches_boundary: row.get(8)?,
                        claim_before_boundary,
                    })
                },
            )
            .map_err(|_| GateError::Store)?;
        rows.collect::<Result<_, _>>().map_err(|_| GateError::Store)
    }

    fn binding<'b>(&'b self, delivery: &'b Delivery) -> ReceiptBinding<'b> {
        ReceiptBinding {
            intent_id: &delivery.intent_id,
            principal: self.principal,
            target_ref: self.session,
            request_key: &delivery.key,
            address: self.address,
        }
    }

    fn suffix<'b>(&self, delivery: &'b Delivery) -> &'b str {
        // The query selects this namespace.
        &delivery.key[self.prefix.len() + 1..]
    }

    fn is_current(&self, suffix: &str) -> bool {
        suffix == self.digest
            || suffix
                .strip_prefix(self.digest)
                .is_some_and(|rest| rest.starts_with(':'))
    }

    fn is_bound(&self, delivery: &Delivery) -> bool {
        let suffix = self.suffix(delivery);
        delivery.intent_id == format!("{}-intent:{suffix}", self.prefix)
            && delivery.task_id == format!("{}-task:{suffix}", self.prefix)
    }

    fn exact_receipt(&self, db: &Connection, delivery: &Delivery) -> Result<bool, GateError> {
        if !delivery.matches_boundary || !self.is_bound(delivery) {
            return Ok(false);
        }
        let receipt =
            load_native_receipt(db, &self.binding(delivery)).map_err(|_| GateError::Store)?;
        Ok(matches!(receipt, StoredReceipt::Found(receipt) if receipt.native_id == self.native_id.as_ref()))
    }

    pub fn next_attempt(
        &self,
        db: &mut Connection,
        scope: &str,
        now: &str,
    ) -> Result<Option<RecoveryAttempt>, GateError> {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        let mut deliveries = self.deliveries(&tx, now)?;
        for delivery in &mut deliveries {
            if delivery.state == DeliveryState::Admitted
                && (delivery.phase.is_none() || delivery.dispatch_scope.as_deref() == Some(scope))
                && self.exact_receipt(&tx, delivery)?
            {
                // An exact latest failed turn proves this admission, even if
                // its ordinary receipt reader is still waiting for content.
                self.confirm_terminal_admission(&tx, delivery, now)?;
                delivery.state = DeliveryState::Settled;
            }
            let suffix = self.suffix(delivery);
            if delivery.state == DeliveryState::Claimed
                && delivery.dispatch_scope.as_deref() == Some(scope)
                && delivery.claim_before_boundary
                && !delivery.matches_boundary
                && !self.is_current(suffix)
                && self.is_bound(delivery)
            {
                self.stop_superseded_claim(&tx, delivery, scope, now)?;
                delivery.state = DeliveryState::DefinitelyNotSent;
            }
        }
        let attempt = self.decide(&tx, &deliveries)?;
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(attempt)
    }

    fn stop_superseded_claim(
        &self,
        db: &Connection,
        delivery: &Delivery,
        scope: &str,
        now: &str,
    ) -> Result<(), GateError> {
        let phase = db
            .execute(
                "UPDATE humanstop_dispatches SET phase='stopped', updated_at=?3
             WHERE intent_id=?1 AND scope_generation=?2 AND phase='claimed'",
                params![delivery.intent_id, scope, now],
            )
            .map_err(|_| GateError::Store)?;
        let intent = db
            .execute(
                "UPDATE intents SET state='rejected', updated_at=?2
             WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NULL",
                params![delivery.intent_id, now],
            )
            .map_err(|_| GateError::Store)?;
        let task = db.execute(
            "UPDATE tasks SET result_json=?2, updated_at=?3 WHERE task_id=?1",
            params![
                delivery.task_id,
                r#"{"outcome":"rejected","native_submit":"definitely_not_sent","reason":"superseded by newer native input before handoff"}"#,
                now,
            ],
        ).map_err(|_| GateError::Store)?;
        if (phase, intent, task) != (1, 1, 1) {
            return Err(GateError::Store);
        }
        Ok(())
    }

    fn confirm_terminal_admission(
        &self,
        db: &Connection,
        delivery: &Delivery,
        now: &str,
    ) -> Result<(), GateError> {
        if delivery.phase.as_deref() == Some("handing_off") {
            let changed = db
                .execute(
                    "UPDATE humanstop_dispatches SET phase='finished', updated_at=?2
                 WHERE intent_id=?1 AND phase='handing_off' AND scope_generation=?3",
                    params![delivery.intent_id, now, delivery.dispatch_scope],
                )
                .map_err(|_| GateError::Store)?;
            if changed != 1 {
                return Err(GateError::Store);
            }
        }
        let changed = db
            .execute(
                "UPDATE intents SET state='confirmed', updated_at=?2
             WHERE intent_id=?1 AND state='admitted' AND native_receipt IS NOT NULL",
                params![delivery.intent_id, now],
            )
            .map_err(|_| GateError::Store)?;
        if changed != 1 {
            return Err(GateError::Store);
        }
        let result = CallToolResult::structured(json!({
            "outcome": "confirmed",
            "native_receipt_id": self.native_id,
            "reconciliation": {
                "kind": "native_admission",
                "evidence": "exact_failed_recovery_boundary",
                "observed_at": now,
                "original_result_json": delivery.task_result,
                "original_dispatch_phase": delivery.phase,
            },
        }));
        let result = serde_json::to_string(&result).map_err(|_| GateError::Store)?;
        let changed = db.execute(
            "UPDATE tasks SET status='completed', result_json=?2, updated_at=?3 WHERE task_id=?1",
            params![delivery.task_id, result, now],
        ).map_err(|_| GateError::Store)?;
        if changed != 1 {
            return Err(GateError::Store);
        }
        Ok(())
    }

    pub fn matches_claim(
        &self,
        db: &Connection,
        attempt: &RecoveryAttempt,
        now: &str,
    ) -> Result<bool, GateError> {
        Ok(self
            .decide(db, &self.deliveries(db, now)?)?
            .is_some_and(|candidate| candidate.claimed && candidate.suffix == attempt.suffix))
    }

    fn decide(
        &self,
        db: &Connection,
        deliveries: &[Delivery],
    ) -> Result<Option<RecoveryAttempt>, GateError> {
        let mut stage = RecoveryStage::Primary;
        for delivery in deliveries {
            if matches!(
                delivery.state,
                DeliveryState::Uncertain | DeliveryState::Admitted
            ) {
                return Ok(None);
            }
            if !delivery.matches_boundary {
                continue;
            }
            if stage == RecoveryStage::Fallback
                || delivery.state != DeliveryState::Settled
                || !self.exact_receipt(db, delivery)?
            {
                return Ok(None);
            }
            match parse_suffix(self.suffix(delivery)) {
                Some((digest, RecoveryStage::Primary | RecoveryStage::Fallback, _))
                    if digest != self.digest =>
                {
                    stage = RecoveryStage::Fallback;
                }
                _ => return Ok(None),
            }
        }

        let mut current = None;
        let mut claimed_suffix = None;
        for delivery in deliveries {
            let suffix = self.suffix(delivery);
            if !self.is_current(suffix) {
                if delivery.state == DeliveryState::Claimed {
                    return Ok(None);
                }
                continue;
            }

            match parse_suffix(suffix) {
                Some((_, saved_stage, retry))
                    if saved_stage == stage && self.is_bound(delivery) =>
                {
                    if delivery.state == DeliveryState::Claimed
                        && claimed_suffix.replace(suffix).is_some()
                    {
                        return Ok(None);
                    }
                    if current.is_none_or(|(highest, _)| retry > highest) {
                        current = Some((retry, delivery));
                    }
                    if !matches!(
                        delivery.state,
                        DeliveryState::Claimed
                            | DeliveryState::Prepared
                            | DeliveryState::DefinitelyNotSent
                    ) {
                        return Ok(None);
                    }
                }
                None if delivery.state == DeliveryState::DefinitelyNotSent
                    && self.is_bound(delivery) => {}
                _ => return Ok(None),
            }
        }

        let (retry, claimed) = match current {
            None => (0, false),
            Some((retry, row)) if row.state == DeliveryState::DefinitelyNotSent => {
                let Some(next) = retry.checked_add(1) else {
                    return Ok(None);
                };
                (next, false)
            }
            Some((retry, row)) => (retry, row.state == DeliveryState::Claimed),
        };
        let base = format!("{}:{}", self.digest, stage.label());
        let suffix = if retry == 0 {
            base
        } else {
            format!("{base}:{retry}")
        };
        if claimed_suffix.is_some_and(|claimed| claimed != suffix) {
            return Ok(None);
        }

        Ok(Some(RecoveryAttempt {
            suffix,
            stage,
            claimed,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::reconcile::encode_native_receipt,
        domain::{
            adapter::NativeReceipt,
            address::{InstanceRef, NodeRef},
            recovery::RecoveryFailure,
        },
    };
    use std::path::PathBuf;

    const ORIGINAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const RETRY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REPLACEMENT: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const FRESH: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const NOW: &str = "2026-11-22T00:00:00Z";
    const SCOPE: &str = "owner-scope";

    struct Fixture {
        path: PathBuf,
        _directory: super::super::tests::TestState,
        address: SessionAddress,
        principal: PrincipalId,
        session: SessionRef,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = super::super::tests::TestState::new();
            let path = dir.0.join("intents.sqlite");
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE intents (intent_id, task_id, principal, target, request_key, state,
                                       native_receipt, created_at, updated_at);
                 CREATE TABLE tasks (task_id, principal, status, result_json, updated_at);
                 CREATE TABLE humanstop_dispatches (intent_id, phase, scope_generation, updated_at);",
            ).unwrap();
            Self {
                path,
                _directory: dir,
                address: SessionAddress {
                    instance: InstanceRef {
                        node: NodeRef("local".into()),
                        instance_id: "owner".into(),
                    },
                    native_session_id: "native".into(),
                },
                principal: PrincipalId("recovery-owner".into()),
                session: SessionRef("session".into()),
            }
        }

        fn db(&self) -> Connection {
            Connection::open(&self.path).unwrap()
        }

        fn history<'a>(
            &'a self,
            harness: &str,
            digest: &'a str,
            boundary: &'a RecoveryBoundary,
        ) -> RecoveryHistory<'a> {
            RecoveryHistory::new(
                harness,
                &self.principal,
                &self.session,
                &self.address,
                digest,
                boundary,
                Cow::Borrowed(boundary.receipt_id(harness)),
            )
        }

        fn insert(
            &self,
            harness: &str,
            suffix: &str,
            state: &str,
            id: Option<&str>,
            phase: &str,
            no_submit: bool,
        ) {
            let db = self.db();
            let intent = format!("{harness}-recovery-intent:{suffix}");
            let task = format!("{harness}-recovery-task:{suffix}");
            let key = format!("{harness}-recovery:{suffix}");
            let receipt = id.map(|id| {
                encode_native_receipt(
                    &ReceiptBinding {
                        intent_id: &intent,
                        principal: &self.principal.0,
                        target_ref: &self.session.0,
                        request_key: &key,
                        address: &self.address,
                    },
                    &NativeReceipt {
                        target: self.address.clone(),
                        native_id: id.into(),
                    },
                )
                .unwrap()
            });
            let result = no_submit.then_some(r#"{"native_submit":"definitely_not_sent"}"#);
            db.execute(
                "INSERT INTO tasks VALUES (?1,?2,'working',?3,?4)",
                params![task, self.principal.0, result, NOW],
            )
            .unwrap();
            db.execute(
                "INSERT INTO intents VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
                params![
                    intent,
                    task,
                    self.principal.0,
                    self.session.0,
                    key,
                    state,
                    receipt,
                    NOW
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO humanstop_dispatches VALUES (?1,?2,?3,?4)",
                params![intent, phase, SCOPE, NOW],
            )
            .unwrap();
        }
    }

    fn boundary(turn: &str, input: &str) -> RecoveryBoundary {
        RecoveryBoundary {
            turn_id: turn.into(),
            input_item_id: input.into(),
            cwd: "/work".into(),
            provider: "saved".into(),
            model: Some("model".into()),
            started_at_ms: 1000,
            failure: RecoveryFailure::Throttled,
            ancestors: Vec::new(),
        }
    }

    #[test]
    fn exact_failed_primary_advances_across_restarts_and_failed_fallback_continues() {
        for (harness, primary_id, fallback_id) in [
            ("codex", "retry-turn", "fallback-turn"),
            ("opencode", "retry-input", "fallback-input"),
            ("chatgpt", "retry-input", "fallback-input"),
        ] {
            let fixture = Fixture::new();
            let original = boundary("user-turn", "user-input");
            let retry = boundary("retry-turn", "retry-input");
            let replacement = boundary("fallback-turn", "fallback-input");
            let fresh = boundary("new-user-turn", "new-user-input");
            let primary = fixture.history(harness, ORIGINAL, &original);
            let attempt = primary
                .next_attempt(&mut fixture.db(), SCOPE, NOW)
                .unwrap()
                .unwrap();
            assert_eq!(attempt.stage, RecoveryStage::Primary);
            assert_eq!(attempt.suffix, format!("{ORIGINAL}:primary"));

            fixture.insert(
                harness,
                &attempt.suffix,
                "admitted",
                Some(primary_id),
                "finished",
                false,
            );
            assert!(
                primary
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap()
                    .is_none()
            );
            assert!(
                fixture
                    .history(harness, FRESH, &fresh)
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap()
                    .is_none()
            );

            let fallback = fixture.history(harness, RETRY, &retry);
            let attempt = fallback
                .next_attempt(&mut fixture.db(), SCOPE, NOW)
                .unwrap()
                .unwrap();
            assert_eq!(attempt.stage, RecoveryStage::Fallback);
            assert_eq!(attempt.suffix, format!("{RETRY}:fallback"));
            assert_eq!(
                fallback
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap(),
                Some(attempt)
            );
            let (state, status): (String, String) = fixture
                .db()
                .query_row(
                    "SELECT i.state, t.status FROM intents i JOIN tasks t USING (task_id)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                (state.as_str(), status.as_str()),
                ("confirmed", "completed")
            );

            fixture.insert(
                harness,
                &format!("{RETRY}:fallback"),
                "admitted",
                Some(fallback_id),
                "finished",
                false,
            );
            assert!(
                fallback
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap()
                    .is_none()
            );
            let failed_fallback = fixture.history(harness, REPLACEMENT, &replacement);
            let next = failed_fallback
                .next_attempt(&mut fixture.db(), SCOPE, NOW)
                .unwrap()
                .unwrap();
            assert_eq!(next.stage, RecoveryStage::Fallback);
            assert_eq!(next.suffix, format!("{REPLACEMENT}:fallback"));
            assert_eq!(
                failed_fallback
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap(),
                Some(next)
            );
            let next = fixture
                .history(harness, FRESH, &fresh)
                .next_attempt(&mut fixture.db(), SCOPE, NOW)
                .unwrap()
                .unwrap();
            assert_eq!(next.suffix, format!("{FRESH}:primary"));
        }
    }

    #[test]
    fn absent_or_mismatching_receipts_block_but_technical_interruptions_continue() {
        let retry = boundary("retry-turn", "retry-input");
        for (state, phase, id) in [
            ("unknown", "finished", None),
            ("unknown", "finished", Some("retry-turn")),
            ("dispatching", "handing_off", Some("retry-turn")),
            ("admitted", "finished", Some("retry-input")),
            ("admitted", "finished", None),
        ] {
            let fixture = Fixture::new();
            fixture.insert(
                "codex",
                &format!("{ORIGINAL}:primary"),
                state,
                id,
                phase,
                false,
            );
            assert!(
                fixture
                    .history("codex", RETRY, &retry)
                    .next_attempt(&mut fixture.db(), SCOPE, NOW)
                    .unwrap()
                    .is_none(),
                "{state} {id:?}"
            );
        }
        let fixture = Fixture::new();
        fixture.insert(
            "codex",
            &format!("{ORIGINAL}:primary"),
            "admitted",
            Some("retry-turn"),
            "finished",
            false,
        );
        let mut projected = retry;
        projected.failure = RecoveryFailure::Interrupted;
        let attempt = fixture
            .history("codex", RETRY, &projected)
            .next_attempt(&mut fixture.db(), SCOPE, NOW)
            .unwrap()
            .unwrap();
        assert_eq!(attempt.stage, RecoveryStage::Fallback);
        assert_eq!(attempt.suffix, format!("{RETRY}:fallback"));
    }

    #[test]
    fn old_keys_dedupe_and_do_not_authorize_fallback() {
        for suffix in [ORIGINAL.to_owned(), format!("{ORIGINAL}:2")] {
            let fixture = Fixture::new();
            fixture.insert(
                "codex",
                &suffix,
                "confirmed",
                Some("retry-turn"),
                "finished",
                false,
            );
            for (digest, boundary) in [
                (ORIGINAL, boundary("user-turn", "user-input")),
                (RETRY, boundary("retry-turn", "retry-input")),
            ] {
                assert!(
                    fixture
                        .history("codex", digest, &boundary)
                        .next_attempt(&mut fixture.db(), SCOPE, NOW)
                        .unwrap()
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn newest_user_boundary_supersedes_older_claim_after_restart() {
        let fixture = Fixture::new();
        let mut new_user = boundary("new-user-turn", "new-user-input");
        new_user.started_at_ms = chrono::DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .timestamp_millis() as u64
            + 1000;
        let observed = "2026-11-22T00:00:02Z";
        let history = fixture.history("codex", FRESH, &new_user);

        fixture.insert(
            "codex",
            &format!("{ORIGINAL}:primary"),
            "dispatching",
            None,
            "claimed",
            false,
        );
        let next = history
            .next_attempt(&mut fixture.db(), SCOPE, observed)
            .unwrap()
            .unwrap();
        assert_eq!(next.suffix, format!("{FRESH}:primary"));
        assert_eq!(
            history
                .next_attempt(&mut fixture.db(), SCOPE, observed)
                .unwrap(),
            Some(next)
        );
        let (state, phase, result): (String, String, String) = fixture.db().query_row(
            "SELECT i.state, d.phase, json_extract(t.result_json, '$.native_submit')
             FROM intents i JOIN tasks t USING (task_id) JOIN humanstop_dispatches d USING (intent_id)",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(
            (state.as_str(), phase.as_str(), result.as_str()),
            ("rejected", "stopped", "definitely_not_sent")
        );

        for (state, phase) in [
            ("dispatching", "handing_off"),
            ("admitted", "finished"),
            ("unknown", "finished"),
        ] {
            let fixture = Fixture::new();
            fixture.insert(
                "codex",
                &format!("{ORIGINAL}:primary"),
                state,
                Some("old-native"),
                phase,
                false,
            );
            assert!(
                fixture
                    .history("codex", FRESH, &new_user)
                    .next_attempt(&mut fixture.db(), SCOPE, observed)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                fixture
                    .db()
                    .query_row("SELECT state FROM intents", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                state
            );
        }
    }

    #[test]
    fn only_definite_no_submit_allocates_another_key_for_the_same_stage() {
        let fixture = Fixture::new();
        fixture.insert("codex", ORIGINAL, "rejected", None, "finished", true);
        let original = boundary("user-turn", "user-input");
        let history = fixture.history("codex", ORIGINAL, &original);
        let first = history
            .next_attempt(&mut fixture.db(), SCOPE, NOW)
            .unwrap()
            .unwrap();
        assert_eq!(first.suffix, format!("{ORIGINAL}:primary"));
        fixture.insert("codex", &first.suffix, "rejected", None, "finished", true);
        let retry = history
            .next_attempt(&mut fixture.db(), SCOPE, NOW)
            .unwrap()
            .unwrap();
        assert_eq!(retry.suffix, format!("{ORIGINAL}:primary:1"));
        assert_eq!(retry.stage, RecoveryStage::Primary);

        fixture.insert(
            "codex",
            &retry.suffix,
            "dispatching",
            None,
            "claimed",
            false,
        );
        let resumed = history
            .next_attempt(&mut fixture.db(), SCOPE, NOW)
            .unwrap()
            .unwrap();
        assert!(resumed.claimed);
        assert_eq!(resumed.suffix, retry.suffix);
        assert!(history.matches_claim(&fixture.db(), &resumed, NOW).unwrap());
    }
}
