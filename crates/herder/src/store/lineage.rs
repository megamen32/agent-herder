use rusqlite::{OptionalExtension, Result, TransactionBehavior, params};

use super::{
    Writer,
    intents::{NewIntent, PrepareResult},
};

/// Create intent identity before the native session exists.
/// `creator_ref` and `request_ref` map to the durable intent principal and
/// deduplication key; native parent lineage is recorded separately after admission.
pub struct NewCreateLineageIntent<'a> {
    pub intent_id: &'a str,
    pub task_id: &'a str,
    pub creator_ref: &'a str,
    pub target: &'a str,
    pub request_ref: &'a str,
    pub payload_hash: &'a str,
    pub now: &'a str,
    pub retain_until: &'a str,
}

/// Native lineage learned only after the create intent was admitted.
pub struct AdmittedCreateLineage<'a> {
    pub intent_id: &'a str,
    pub session_ref: &'a str,
    pub parent_ref: Option<&'a str>,
    pub now: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecordLineageResult {
    Recorded,
    Existing,
    Conflict,
    NotAdmitted,
}

impl Writer {
    pub(crate) fn has_session_binding_schema(&self) -> Result<bool> {
        self.connection.query_row("SELECT (SELECT user_version FROM pragma_user_version)=2 AND herder_writer_version()=2 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_bindings')",[],|r|r.get(0))
    }
    /// Claim only the exact prepared create intent, before any native call.
    pub(crate) fn claim_create_exact(
        &mut self,
        intent: &NewCreateLineageIntent<'_>,
    ) -> Result<bool> {
        Ok(self.connection.execute(
            "UPDATE intents SET state='dispatching',updated_at=?6 WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='prepared' AND native_receipt IS NULL",
            params![intent.intent_id,intent.creator_ref,intent.target,intent.request_ref,intent.payload_hash,intent.now],
        )? == 1)
    }

    /// No evidence of completion is not permission to call native create again.
    pub(crate) fn mark_create_unknown(
        &mut self,
        intent: &NewCreateLineageIntent<'_>,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE intents SET state='unknown',updated_at=?6 WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='dispatching' AND native_receipt IS NULL",
            params![intent.intent_id,intent.creator_ref,intent.target,intent.request_ref,intent.payload_hash,intent.now],
        )?;
        Ok(())
    }

    pub(crate) fn mark_create_rejected(
        &mut self,
        intent: &NewCreateLineageIntent<'_>,
        reason: &str,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE intents SET state='rejected',updated_at=?6 WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='dispatching' AND native_receipt IS NULL", params![intent.intent_id,intent.creator_ref,intent.target,intent.request_ref,intent.payload_hash,intent.now])?;
        let diagnostic = serde_json::json!({"outcome":"rejected", "native_submit":"definitely_not_sent", "reason":reason}).to_string();
        let task = tx.execute("UPDATE tasks SET result_json=?2,updated_at=?3 WHERE task_id=(SELECT task_id FROM intents WHERE intent_id=?1)", params![intent.intent_id,diagnostic,intent.now])?;
        if changed != 1 || task != 1 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        tx.commit()
    }

    /// Called only by the trusted create composition after the matching native
    /// receipt. All three durable records commit or roll back together.
    pub(crate) fn commit_created_session(
        &mut self,
        intent: &NewCreateLineageIntent<'_>,
        session_ref: &str,
        address: &crate::domain::address::SessionAddress,
        parent_ref: Option<&str>,
        receipt: &str,
    ) -> Result<bool> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claimed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM intents WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='dispatching' AND native_receipt IS NULL)",
            params![intent.intent_id,intent.creator_ref,intent.target,intent.request_ref,intent.payload_hash], |r|r.get(0))?;
        if !claimed {
            return Ok(false);
        }
        if tx.execute("INSERT INTO session_bindings(session_ref,node_ref,instance_id,native_session_id) VALUES (?1,?2,?3,?4)",params![session_ref,address.instance.node.0,address.instance.instance_id,address.native_session_id])? != 1 { return Err(rusqlite::Error::InvalidQuery); }
        if tx.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,created_at) VALUES (?1,?2,?3,?4)",params![session_ref,intent.creator_ref,parent_ref,intent.now])? != 1 { return Err(rusqlite::Error::InvalidQuery); }
        let changed=tx.execute("UPDATE intents SET state='admitted',native_receipt=?2,updated_at=?3 WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NULL",params![intent.intent_id,receipt,intent.now])?;
        if changed != 1 {
            return Ok(false);
        }
        tx.commit()?;
        Ok(true)
    }
    /// Seal an isolated root's exact mapping and stop scope in the same
    /// transaction as its native create receipt. The gate must already have
    /// been held before the native create and remains held through this commit.
    /// Imported/parented sessions have no proven handoff and are refused.
    #[cfg(target_os = "linux")]
    pub(crate) fn commit_created_scoped_root(
        &mut self,
        gate: &crate::application::target_gate::PinnedTargetGateGuard,
        intent: &NewCreateLineageIntent<'_>,
        session_ref: &str,
        address: &crate::domain::address::SessionAddress,
        parent_ref: Option<&str>,
        scope_generation: &str,
        receipt: &str,
    ) -> Result<bool> {
        if parent_ref.is_some()
            || session_ref.is_empty()
            || scope_generation.is_empty()
            || receipt.is_empty()
        {
            return Ok(false);
        }
        let (device, inode) = gate.identity().map_err(|_| rusqlite::Error::InvalidQuery)?;
        let device = i64::try_from(device).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let inode = i64::try_from(inode).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authority: Option<String> = tx.query_row(
            "SELECT generation FROM humanstop_authority WHERE singleton=1 AND gate_device=?1 AND gate_inode=?2 AND (SELECT user_version FROM pragma_user_version) IN (3,4) AND herder_writer_version()=(SELECT user_version FROM pragma_user_version)",
            params![device, inode], |r| r.get(0),
        ).optional()?;
        let Some(authority) = authority else {
            return Ok(false);
        };
        let claimed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM intents WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='dispatching' AND native_receipt IS NULL)",
            params![intent.intent_id,intent.creator_ref,intent.target,intent.request_ref,intent.payload_hash], |r|r.get(0))?;
        if !claimed {
            return Ok(false);
        }
        let session_scope = format!("session:{session_ref}");
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref IN ('global',?1) AND released_at IS NULL) OR EXISTS(SELECT 1 FROM holds WHERE session_ref IN ('global',?2) AND released_at IS NULL)",
            params![session_scope, session_ref], |r| r.get(0),
        )?;
        if held {
            return Ok(false);
        }
        tx.execute("INSERT INTO session_bindings(session_ref,node_ref,instance_id,native_session_id) VALUES (?1,?2,?3,?4)", params![session_ref,address.instance.node.0,address.instance.instance_id,address.native_session_id])?;
        tx.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,created_at) VALUES (?1,?2,NULL,?3)", params![session_ref,intent.creator_ref,intent.now])?;
        tx.execute(
            "INSERT INTO humanstop_scopes(session_ref,scope_ref) VALUES (?1,'global')",
            [session_ref],
        )?;
        tx.execute(
            "INSERT INTO humanstop_scopes(session_ref,scope_ref) VALUES (?1,?2)",
            params![session_ref, session_scope],
        )?;
        tx.execute("INSERT INTO humanstop_sessions(session_ref,authority_generation,scope_generation,created_at) VALUES (?1,?2,?3,?4)", params![session_ref,authority,scope_generation,intent.now])?;
        if tx.execute("UPDATE intents SET state='admitted',native_receipt=?2,updated_at=?3 WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NULL", params![intent.intent_id,receipt,intent.now])? != 1 { return Ok(false) }
        tx.commit()?;
        Ok(true)
    }

    /// Persist creator and request identity with the Task before any native call.
    pub fn prepare_create_lineage_intent(
        &mut self,
        intent: &NewCreateLineageIntent<'_>,
    ) -> Result<PrepareResult> {
        self.prepare_intent(&NewIntent {
            intent_id: intent.intent_id,
            task_id: intent.task_id,
            principal: intent.creator_ref,
            target: intent.target,
            request_key: intent.request_ref,
            payload_hash: intent.payload_hash,
            now: intent.now,
            retain_until: intent.retain_until,
        })
    }

    /// Store the native parent separately from the creator after native admission.
    /// Existing lineage is immutable: retries are idempotent and mismatches conflict.
    pub fn record_admitted_create_lineage(
        &mut self,
        lineage: &AdmittedCreateLineage<'_>,
    ) -> Result<RecordLineageResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let admitted: Option<(String, String)> = tx
            .query_row(
                "SELECT principal, state FROM intents WHERE intent_id = ?1 AND native_receipt IS NOT NULL",
                [lineage.intent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((creator_ref, state)) = admitted else {
            tx.commit()?;
            return Ok(RecordLineageResult::NotAdmitted);
        };
        if state != "admitted" && state != "confirmed" {
            tx.commit()?;
            return Ok(RecordLineageResult::NotAdmitted);
        }

        let existing: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT creator_ref, parent_ref FROM lineage WHERE session_ref = ?1",
                [lineage.session_ref],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let requested_parent = lineage.parent_ref.map(str::to_owned);
        let result = match existing {
            Some((Some(stored_creator), stored_parent))
                if stored_creator == creator_ref && stored_parent == requested_parent =>
            {
                RecordLineageResult::Existing
            }
            Some(_) => RecordLineageResult::Conflict,
            None => {
                tx.execute(
                    "INSERT INTO lineage(session_ref, creator_ref, parent_ref, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![lineage.session_ref, creator_ref, lineage.parent_ref, lineage.now],
                )?;
                RecordLineageResult::Recorded
            }
        };
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent<'a>(payload_hash: &'a str, task_id: &'a str) -> NewCreateLineageIntent<'a> {
        NewCreateLineageIntent {
            intent_id: "create-intent-1",
            task_id,
            creator_ref: "creator-agent-a",
            target: "codex-instance-1",
            request_ref: "request-ref-1",
            payload_hash,
            now: "now",
            retain_until: "later",
        }
    }

    #[test]
    fn create_intent_persists_creator_and_request_ref_before_dispatch() -> Result<()> {
        let mut writer = Writer::temporary()?;
        let first = intent("payload-hash-1", "task-1");
        assert_eq!(
            writer.prepare_create_lineage_intent(&first)?,
            PrepareResult::Created {
                intent_id: "create-intent-1".into(),
                task_id: "task-1".into(),
            }
        );

        let stored: (String, String, String, String) = writer.connection.query_row(
            "SELECT principal, target, request_key, state FROM intents WHERE intent_id = ?1",
            ["create-intent-1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            stored,
            (
                "creator-agent-a".into(),
                "codex-instance-1".into(),
                "request-ref-1".into(),
                "prepared".into()
            )
        );

        assert_eq!(
            writer.prepare_create_lineage_intent(&intent("payload-hash-1", "retry-task"))?,
            PrepareResult::Existing {
                intent_id: "create-intent-1".into(),
                task_id: "task-1".into(),
            }
        );
        assert_eq!(
            writer.prepare_create_lineage_intent(&intent("different-payload", "conflict-task"))?,
            PrepareResult::Conflict {
                intent_id: "create-intent-1".into(),
                task_id: "task-1".into(),
            }
        );
        Ok(())
    }

    #[test]
    fn admitted_parent_is_stored_separately_from_creator_and_is_immutable() -> Result<()> {
        let mut writer = Writer::temporary()?;
        let intent = intent("payload-hash-1", "task-1");
        writer.prepare_create_lineage_intent(&intent)?;
        let before_admission = AdmittedCreateLineage {
            intent_id: "create-intent-1",
            session_ref: "native-session-1",
            parent_ref: Some("native-parent-9"),
            now: "admitted-at",
        };
        assert_eq!(
            writer.record_admitted_create_lineage(&before_admission)?,
            RecordLineageResult::NotAdmitted
        );
        writer.connection.execute(
            "UPDATE intents SET state = 'admitted', native_receipt = 'receipt' WHERE intent_id = ?1",
            ["create-intent-1"],
        )?;

        assert_eq!(
            writer.record_admitted_create_lineage(&before_admission)?,
            RecordLineageResult::Recorded
        );
        let stored: (Option<String>, Option<String>) = writer.connection.query_row(
            "SELECT creator_ref, parent_ref FROM lineage WHERE session_ref = ?1",
            ["native-session-1"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            stored,
            (
                Some("creator-agent-a".into()),
                Some("native-parent-9".into())
            )
        );
        assert_eq!(
            writer.record_admitted_create_lineage(&before_admission)?,
            RecordLineageResult::Existing
        );
        let conflicting_parent = AdmittedCreateLineage {
            parent_ref: Some("different-parent"),
            ..before_admission
        };
        assert_eq!(
            writer.record_admitted_create_lineage(&conflicting_parent)?,
            RecordLineageResult::Conflict
        );
        Ok(())
    }

    #[test]
    fn creator_survives_restart_before_receipt_and_unknown_parent_stays_unknown() -> Result<()> {
        use rusqlite::{Connection, functions::FunctionFlags};

        let path = std::env::temp_dir().join(format!(
            "herder-lineage-restart-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let open = || -> Result<Writer> {
            let connection = Connection::open(&path)?;
            connection.pragma_update(None, "foreign_keys", true)?;
            connection.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_| Ok(super::super::WRITER_VERSION),
            )?;
            Ok(Writer { connection })
        };

        let mut first = open()?;
        first.connection.execute_batch(super::super::SCHEMA)?;
        assert!(matches!(
            first.prepare_create_lineage_intent(&intent("payload-hash-1", "task-1"))?,
            PrepareResult::Created { .. }
        ));
        drop(first);

        // Reopen the same durable store as a fresh process would, then attach
        // admission evidence without changing the creator recorded pre-dispatch.
        let mut restarted = open()?;
        restarted.connection.execute(
            "UPDATE intents SET state = 'admitted', native_receipt = 'receipt-after-restart' WHERE intent_id = ?1",
            ["create-intent-1"],
        )?;
        assert_eq!(
            restarted.record_admitted_create_lineage(&AdmittedCreateLineage {
                intent_id: "create-intent-1",
                session_ref: "native-session-after-restart",
                parent_ref: None,
                now: "admitted-at",
            })?,
            RecordLineageResult::Recorded
        );
        let stored: (String, Option<String>, Option<String>) =
            restarted.connection.query_row(
                "SELECT i.principal, l.creator_ref, l.parent_ref FROM intents i JOIN lineage l ON l.session_ref = ?1 WHERE i.intent_id = ?2",
                params!["native-session-after-restart", "create-intent-1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        assert_eq!(
            stored,
            (
                "creator-agent-a".into(),
                Some("creator-agent-a".into()),
                None
            )
        );
        Ok(())
    }
}
