use rusqlite::Result;

use super::{
    intents::{NewIntent, PrepareResult},
    Writer,
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
}
