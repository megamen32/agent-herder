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
