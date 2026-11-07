use rusqlite::{OptionalExtension, Result, TransactionBehavior, params};

use super::Writer;

/// Caller-provided hash must describe the canonical payload for this request.
pub struct NewIntent<'a> {
    pub intent_id: &'a str,
    pub task_id: &'a str,
    pub principal: &'a str,
    pub target: &'a str,
    pub request_key: &'a str,
    pub payload_hash: &'a str,
    pub now: &'a str,
    pub retain_until: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PrepareResult {
    Created { intent_id: String, task_id: String },
    Existing { intent_id: String, task_id: String },
    Conflict { intent_id: String, task_id: String },
}

impl Writer {
    /// Claim the sole right to dispatch a prepared intent. False includes missing
    /// or already claimed intents; in particular, unknown outcomes are never retried.
    pub fn claim_dispatch(&self, intent_id: &str, now: &str) -> Result<bool> {
        Ok(self.connection.execute(
            "UPDATE intents SET state = 'dispatching', updated_at = ?2 WHERE intent_id = ?1 AND state = 'prepared'",
            params![intent_id, now],
        )? == 1)
    }

    /// Atomically record the task and prepared intent, or resolve an existing key.
    pub fn prepare_intent(&mut self, intent: &NewIntent<'_>) -> Result<PrepareResult> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, String)> = tx.query_row(
            "SELECT intent_id, task_id, payload_hash FROM intents WHERE principal = ?1 AND target = ?2 AND request_key = ?3",
            params![intent.principal, intent.target, intent.request_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        if let Some((intent_id, task_id, payload_hash)) = existing {
            return Ok(if payload_hash == intent.payload_hash {
                PrepareResult::Existing { intent_id, task_id }
            } else {
                PrepareResult::Conflict { intent_id, task_id }
            });
        }
        tx.execute(
            "INSERT INTO tasks(task_id, principal, status, created_at, updated_at) VALUES (?1, ?2, 'prepared', ?3, ?3)",
            params![intent.task_id, intent.principal, intent.now],
        )?;
        tx.execute(
            "INSERT INTO intents(intent_id, task_id, principal, target, request_key, payload_hash, state, created_at, updated_at, retain_until) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7, ?7, ?8)",
            params![intent.intent_id, intent.task_id, intent.principal, intent.target, intent.request_key, intent.payload_hash, intent.now, intent.retain_until],
        )?;
        tx.commit()?;
        Ok(PrepareResult::Created {
            intent_id: intent.intent_id.into(),
            task_id: intent.task_id.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_duplicate_prepare_dispatches_once_and_unknown_is_not_replayed() -> Result<()> {
        use rusqlite::{Connection, functions::FunctionFlags};
        use std::sync::{
            Arc, Barrier,
            atomic::{AtomicUsize, Ordering},
        };
        use std::time::Duration;

        let path = std::env::temp_dir().join(format!(
            "herder-prepare-race-{}-{}.sqlite",
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
            connection.busy_timeout(Duration::from_secs(10))?;
            connection.pragma_update(None, "foreign_keys", true)?;
            connection.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_| Ok(super::super::WRITER_VERSION),
            )?;
            Ok(Writer { connection })
        };
        let mut observer = open()?;
        observer.connection.execute_batch(super::super::SCHEMA)?;
        const N: usize = 8;
        let start = Arc::new(Barrier::new(N));
        let prepared = Arc::new(Barrier::new(N));
        let submits = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..N)
            .map(|n| {
                let mut writer = open().unwrap();
                let start = Arc::clone(&start);
                let prepared = Arc::clone(&prepared);
                let submits = Arc::clone(&submits);
                std::thread::spawn(move || {
                    let intent_id = format!("intent-{n}");
                    let task_id = format!("task-{n}");
                    start.wait();
                    let result = writer.prepare_intent(&NewIntent {
                        intent_id: &intent_id,
                        task_id: &task_id,
                        principal: "p",
                        target: "target",
                        request_key: "key",
                        payload_hash: "hash",
                        now: "now",
                        retain_until: "later",
                    });
                    // All threads reach the barrier even on error, so failures do not hang the test.
                    prepared.wait();
                    let result = result.unwrap();
                    let canonical_id = match &result {
                        PrepareResult::Created { intent_id, .. }
                        | PrepareResult::Existing { intent_id, .. } => intent_id,
                        PrepareResult::Conflict { .. } => panic!("identical payload conflicted"),
                    };
                    let claimed = writer.claim_dispatch(canonical_id, "dispatch").unwrap();
                    if claimed {
                        submits.fetch_add(1, Ordering::SeqCst);
                    }
                    (result, claimed)
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|(r, _)| matches!(r, PrepareResult::Created { .. }))
                .count(),
            1
        );
        assert_eq!(results.iter().filter(|(_, claimed)| *claimed).count(), 1);
        assert_eq!(submits.load(Ordering::SeqCst), 1);
        let (canonical_intent, canonical_task) = match &results[0].0 {
            PrepareResult::Created { intent_id, task_id }
            | PrepareResult::Existing { intent_id, task_id } => (intent_id, task_id),
            _ => unreachable!(),
        };
        for (result, _) in &results {
            match result {
                PrepareResult::Created { intent_id, task_id }
                | PrepareResult::Existing { intent_id, task_id } => {
                    assert_eq!((intent_id, task_id), (canonical_intent, canonical_task));
                }
                _ => panic!("unexpected conflict"),
            }
        }
        let conflict = observer.prepare_intent(&NewIntent {
            intent_id: "other",
            task_id: "other",
            principal: "p",
            target: "target",
            request_key: "key",
            payload_hash: "different",
            now: "now",
            retain_until: "later",
        })?;
        assert_eq!(
            conflict,
            PrepareResult::Conflict {
                intent_id: canonical_intent.clone(),
                task_id: canonical_task.clone()
            }
        );
        let counts: (i64, i64) = observer.connection.query_row(
            "SELECT (SELECT count(*) FROM intents), (SELECT count(*) FROM tasks)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(counts, (1, 1));
        observer.connection.execute(
            "UPDATE intents SET state = 'unknown' WHERE intent_id = ?1",
            [canonical_intent],
        )?;
        let retry = observer.prepare_intent(&NewIntent {
            intent_id: "retry",
            task_id: "retry",
            principal: "p",
            target: "target",
            request_key: "key",
            payload_hash: "hash",
            now: "later",
            retain_until: "later",
        })?;
        assert_eq!(
            retry,
            PrepareResult::Existing {
                intent_id: canonical_intent.clone(),
                task_id: canonical_task.clone()
            }
        );
        if observer.claim_dispatch(canonical_intent, "retry")? {
            submits.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(submits.load(Ordering::SeqCst), 1);
        Ok(())
    }

    #[test]
    fn dispatch_claim_has_one_winner_and_unknown_is_never_claimed() -> Result<()> {
        use rusqlite::{Connection, functions::FunctionFlags};
        use std::sync::{Arc, Barrier};
        use std::time::Duration;

        let path = std::env::temp_dir().join(format!(
            "herder-cas-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let open = || -> Result<Writer> {
            let connection = Connection::open(&path)?;
            connection.busy_timeout(Duration::from_secs(10))?;
            connection.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |_| Ok(1),
            )?;
            Ok(Writer { connection })
        };
        let mut writer = open()?;
        writer.connection.execute_batch(super::super::SCHEMA)?;
        writer.prepare_intent(&NewIntent {
            intent_id: "i",
            task_id: "t",
            principal: "p",
            target: "target",
            request_key: "key",
            payload_hash: "hash",
            now: "created",
            retain_until: "later",
        })?;
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let writer = open().unwrap();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    writer.claim_dispatch("i", "claimed").unwrap()
                })
            })
            .collect();
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        assert!(!writer.claim_dispatch("i", "again")?);
        assert!(!writer.claim_dispatch("missing", "again")?);
        let (state, updated): (String, String) = writer.connection.query_row(
            "SELECT state, updated_at FROM intents WHERE intent_id = 'i'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(
            (state.as_str(), updated.as_str()),
            ("dispatching", "claimed")
        );
        writer.connection.execute(
            "UPDATE intents SET state = 'unknown' WHERE intent_id = 'i'",
            [],
        )?;
        assert!(!writer.claim_dispatch("i", "retry")?);
        let state: String = writer.connection.query_row(
            "SELECT state FROM intents WHERE intent_id = 'i'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(state, "unknown");
        drop(writer);
        std::fs::remove_file(path).unwrap();
        Ok(())
    }

    #[test]
    fn key_matches_payload_and_conflicts_without_creating_extra_tasks() -> Result<()> {
        let mut writer = Writer::temporary()?;
        let mut request = NewIntent {
            intent_id: "i1",
            task_id: "t1",
            principal: "p",
            target: "target",
            request_key: "key",
            payload_hash: "hash1",
            now: "now",
            retain_until: "later",
        };
        assert_eq!(
            writer.prepare_intent(&request)?,
            PrepareResult::Created {
                intent_id: "i1".into(),
                task_id: "t1".into()
            }
        );
        request.intent_id = "i2";
        request.task_id = "t2";
        assert_eq!(
            writer.prepare_intent(&request)?,
            PrepareResult::Existing {
                intent_id: "i1".into(),
                task_id: "t1".into()
            }
        );
        request.payload_hash = "hash2";
        assert_eq!(
            writer.prepare_intent(&request)?,
            PrepareResult::Conflict {
                intent_id: "i1".into(),
                task_id: "t1".into()
            }
        );
        let (tasks, intents): (i64, i64) = writer.connection.query_row(
            "SELECT (SELECT count(*) FROM tasks), (SELECT count(*) FROM intents)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!((tasks, intents), (1, 1));
        request.target = "other";
        assert!(matches!(
            writer.prepare_intent(&request)?,
            PrepareResult::Created { .. }
        ));
        Ok(())
    }

    #[test]
    fn insert_failure_rolls_back_task() -> Result<()> {
        let mut writer = Writer::temporary()?;
        let mut request = NewIntent {
            intent_id: "i",
            task_id: "t1",
            principal: "p",
            target: "a",
            request_key: "k",
            payload_hash: "h",
            now: "now",
            retain_until: "later",
        };
        writer.prepare_intent(&request)?;
        request.task_id = "t2";
        request.target = "b";
        assert!(writer.prepare_intent(&request).is_err());
        let count: i64 = writer.connection.query_row(
            "SELECT count(*) FROM tasks WHERE task_id = 't2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(())
    }
}
