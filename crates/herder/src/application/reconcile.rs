//! Readback of a dispatching intent never grants permission to submit again.
use crate::domain::adapter::{NativeReceipt, NativeSessionReader, Observation};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

/// A recovery result is never permission to dispatch again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingReceiptRecovery {
    Unknown,
    /// The store does not yet define a native_receipt encoding or reader.
    ReceiptNeedsDecoding,
    NotFound,
    NotRecoverable,
}

/// Persist UNKNOWN for interrupted admissions lacking a stored receipt.
/// The caller must provide the store's fenced writer connection after ensuring
/// that no dispatcher for this intent remains active. This is not a native
/// lookup: the current reader port cannot query by request key. Stored receipt
/// bytes are left untouched until their format and binding are defined.
pub fn recover_missing_receipt(
    connection: &mut Connection,
    intent_id: &str,
    now: &str,
) -> rusqlite::Result<MissingReceiptRecovery> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT state, native_receipt FROM intents WHERE intent_id = ?1",
            [intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let result = match row {
        None => MissingReceiptRecovery::NotFound,
        Some((state, receipt))
            if matches!(state.as_str(), "dispatching" | "admitted" | "unknown") =>
        {
            if receipt.is_some() {
                MissingReceiptRecovery::ReceiptNeedsDecoding
            } else {
                if state != "unknown" {
                    tx.execute(
                        "UPDATE intents SET state = 'unknown', updated_at = ?2 WHERE intent_id = ?1 AND state IN ('dispatching', 'admitted') AND native_receipt IS NULL",
                        params![intent_id, now],
                    )?;
                }
                MissingReceiptRecovery::Unknown
            }
        }
        Some(_) => MissingReceiptRecovery::NotRecoverable,
    };
    tx.commit()?;
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciliation {
    /// No receipt was persisted; this is not evidence that submission did not happen.
    ReceiptAbsent,
    Unknown,
    Pending(NativeReceipt),
    Rejected(NativeReceipt),
    Confirmed(NativeReceipt),
}

/// The caller must supply the receipt persisted for this intent, not one inferred
/// from a transcript or another request. This interface has no submit capability.
pub async fn reconcile_dispatching<R: NativeSessionReader>(
    reader: &R,
    receipt: Option<&NativeReceipt>,
) -> Reconciliation {
    let Some(receipt) = receipt else {
        return Reconciliation::ReceiptAbsent;
    };
    let target = &receipt.target;
    if receipt.native_id.is_empty()
        || target.native_session_id.is_empty()
        || target.instance.instance_id.is_empty()
        || target.instance.node.0.is_empty()
    {
        return Reconciliation::Unknown;
    }
    match reader.reconcile(receipt).await {
        Ok(Observation::Confirmed { receipt: observed }) if observed == *receipt => {
            Reconciliation::Confirmed(observed)
        }
        Ok(Observation::Rejected { receipt: observed }) if observed == *receipt => {
            Reconciliation::Rejected(observed)
        }
        Ok(Observation::Pending { receipt: observed }) if observed == *receipt => {
            Reconciliation::Pending(observed)
        }
        _ => Reconciliation::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::adapter::{ReadError, SessionSnapshot};
    use crate::domain::address::{InstanceRef, NodeRef, SessionAddress};
    use std::cell::Cell;

    fn receipt() -> NativeReceipt {
        NativeReceipt {
            target: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("node".into()),
                    instance_id: "instance".into(),
                },
                native_session_id: "session".into(),
            },
            native_id: "admission".into(),
        }
    }
    struct Fake {
        calls: Cell<usize>,
        result: Result<Observation, ReadError>,
    }
    impl NativeSessionReader for Fake {
        async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
            panic!("snapshot is not receipt readback")
        }
        async fn reconcile(&self, _: &NativeReceipt) -> Result<Observation, ReadError> {
            self.calls.set(self.calls.get() + 1);
            self.result.clone()
        }
    }
    #[tokio::test]
    async fn missing_unknown_and_exact_confirmed_are_distinct_and_never_send() {
        let r = receipt();
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Confirmed { receipt: r.clone() }),
        };
        assert_eq!(
            reconcile_dispatching(&f, None).await,
            Reconciliation::ReceiptAbsent
        );
        assert_eq!(f.calls.get(), 0);
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Confirmed(r.clone())
        );
        let f = Fake {
            calls: Cell::new(0),
            result: Err(ReadError("offline".into())),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Unknown
        );
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Unknown { receipt: r.clone() }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Unknown
        );
        let mut other = r.clone();
        other.target.instance.node.0 = "other-node".into();
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Confirmed { receipt: other }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Unknown
        );
        let mut other = r.clone();
        other.native_id = "different".into();
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Confirmed { receipt: other }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Unknown
        );
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Pending { receipt: r.clone() }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Pending(r.clone())
        );
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Rejected { receipt: r.clone() }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&r)).await,
            Reconciliation::Rejected(r.clone())
        );
        let mut invalid = r.clone();
        invalid.native_id.clear();
        let f = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Confirmed {
                receipt: invalid.clone(),
            }),
        };
        assert_eq!(
            reconcile_dispatching(&f, Some(&invalid)).await,
            Reconciliation::Unknown
        );
        assert_eq!(f.calls.get(), 0);
    }

    #[test]
    fn restart_persists_unknown_without_receipt_and_never_reclaims_dispatch() {
        use rusqlite::{Connection, functions::FunctionFlags};
        let path = std::env::temp_dir().join(format!(
            "herder-reconcile-{}-{}.sqlite",
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
        let open = || {
            let c = Connection::open(&path).unwrap();
            c.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8,
                |_| Ok(1),
            )
            .unwrap();
            c
        };
        let mut c = open();
        c.execute_batch(include_str!("../store/schema.sql"))
            .unwrap();
        c.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('t','p','prepared','a','a')", []).unwrap();
        c.execute("INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,created_at,updated_at,retain_until) VALUES ('i','t','p','target','key','hash','dispatching','a','a','later')", []).unwrap();
        drop(c);
        c = open();
        assert_eq!(
            recover_missing_receipt(&mut c, "i", "restart").unwrap(),
            MissingReceiptRecovery::Unknown
        );
        drop(c);
        c = open();
        let state: (String, String, String) = c
            .query_row(
                "SELECT state, request_key, updated_at FROM intents WHERE intent_id='i'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("unknown".into(), "key".into(), "restart".into()));
        assert_eq!(
            c.execute(
                "UPDATE intents SET state='dispatching' WHERE intent_id='i' AND state='prepared'",
                []
            )
            .unwrap(),
            0
        );
        assert_eq!(
            recover_missing_receipt(&mut c, "i", "again").unwrap(),
            MissingReceiptRecovery::Unknown
        );
        assert_eq!(
            recover_missing_receipt(&mut c, "missing", "again").unwrap(),
            MissingReceiptRecovery::NotFound
        );
        c.execute(
            "UPDATE intents SET state='admitted', native_receipt='opaque' WHERE intent_id='i'",
            [],
        )
        .unwrap();
        assert_eq!(
            recover_missing_receipt(&mut c, "i", "again").unwrap(),
            MissingReceiptRecovery::ReceiptNeedsDecoding
        );
        let state: String = c
            .query_row("SELECT state FROM intents WHERE intent_id='i'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "admitted");
        c.execute(
            "UPDATE intents SET state='confirmed', native_receipt=NULL WHERE intent_id='i'",
            [],
        )
        .unwrap();
        assert_eq!(
            recover_missing_receipt(&mut c, "i", "again").unwrap(),
            MissingReceiptRecovery::NotRecoverable
        );
        c.execute(
            "UPDATE intents SET state='dispatching' WHERE intent_id='i'",
            [],
        )
        .unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();
        assert!(recover_missing_receipt(&mut c, "i", "again").is_err());
        let state: String = c
            .query_row("SELECT state FROM intents WHERE intent_id='i'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "dispatching");
    }
}
