//! Readback of a dispatching intent never grants permission to submit again.
use crate::domain::adapter::{NativeReceipt, NativeSessionReader, Observation};
use crate::domain::address::SessionAddress;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

/// SHA-256 of canonical, versioned JSON for the exact native submission.
/// The intent must be prepared with this value before invoking the dispatcher.
pub fn dispatch_payload_binding(
    plan: &crate::domain::adapter::DispatchPlan,
    message: &str,
) -> String {
    use crate::domain::adapter::SendMode;
    let mode = match plan.mode {
        SendMode::Current => "current",
        SendMode::Queue => "queue",
        SendMode::Start => "start",
    };
    let bytes = serde_json::to_vec(&(1u8, &plan.target, mode, &plan.expected_turn, message))
        .expect("serializing a dispatch plan cannot fail");
    let mut out = String::from("sha256-dispatch-v1:");
    for byte in sha256(&bytes) {
        use std::fmt::Write;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).into()
}

#[derive(Debug, PartialEq, Eq)]
pub enum DurableDispatch {
    Admitted(NativeReceipt),
    /// A verified hold won the gate before the native handoff: no send occurred.
    StoppedBeforeHandoff,
    /// The native control proved no submission occurred; the key remains consumed.
    DefinitelyNotSent,
    Unknown,
    NotClaimed,
}

impl crate::store::Writer {
    /// Uses this writer's fenced connection; the target binding must be authoritative.
    pub async fn dispatch_once<C: crate::domain::adapter::NativeSessionControl>(
        &mut self,
        binding: &ReceiptBinding<'_>,
        plan: crate::domain::adapter::DispatchPlan,
        message: &str,
        now: &str,
        control: &C,
    ) -> rusqlite::Result<DurableDispatch> {
        dispatch_once(self.connection_mut(), binding, plan, message, now, control).await
    }

    /// Only call after the previous dispatcher is known to have stopped.
    pub fn recover_missing_receipt(
        &mut self,
        intent_id: &str,
        now: &str,
    ) -> rusqlite::Result<MissingReceiptRecovery> {
        recover_missing_receipt(self.connection_mut(), intent_id, now)
    }

    pub fn load_native_receipt(
        &self,
        binding: &ReceiptBinding<'_>,
    ) -> rusqlite::Result<StoredReceipt> {
        load_native_receipt(self.connection(), binding)
    }
}

/// Claim the exact stored intent before a single call to the supplied control.
/// Requires the authoritative target resolution and a control implementation
/// whose returned admission belongs to this invocation. On any uncertainty no
/// second send is attempted. Callers must never run crash recovery while a
/// previous dispatcher is still active for this intent.
pub async fn dispatch_once<C: crate::domain::adapter::NativeSessionControl>(
    connection: &mut Connection,
    binding: &ReceiptBinding<'_>,
    plan: crate::domain::adapter::DispatchPlan,
    message: &str,
    now: &str,
    control: &C,
) -> rusqlite::Result<DurableDispatch> {
    let _ = (connection, plan, message, now, control);
    if !valid_binding(binding) {
        return Ok(DurableDispatch::NotClaimed);
    }
    // Unguarded callers, including pre-v3/imported targets, cannot submit.
    // ScopedAuthority::claim + handoff is the only authorized path.
    Err(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_AUTH),
        Some("scoped HumanStop authority is required".into()),
    ))
}

/// The caller must resolve target_ref to address from an authoritative mapping;
/// neither this type nor the opaque target column establishes that mapping.
#[derive(Clone, Copy)]
pub struct ReceiptBinding<'a> {
    pub intent_id: &'a str,
    pub principal: &'a str,
    pub target_ref: &'a str,
    pub request_key: &'a str,
    pub address: &'a SessionAddress,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReceiptEnvelope {
    version: u8,
    intent_id: String,
    principal: String,
    target_ref: String,
    request_key: String,
    address: SessionAddress,
    native_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreReceipt {
    Stored,
    AlreadyStored,
    Mismatch,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoredReceipt {
    Found(NativeReceipt),
    Unknown,
}

fn valid_binding(b: &ReceiptBinding<'_>) -> bool {
    [
        b.intent_id,
        b.principal,
        b.target_ref,
        b.request_key,
        &b.address.instance.node.0,
        &b.address.instance.instance_id,
        &b.address.native_session_id,
    ]
    .iter()
    .all(|v| !v.is_empty() && v.len() <= 4096)
}

fn envelope(b: &ReceiptBinding<'_>, receipt: &NativeReceipt) -> Option<ReceiptEnvelope> {
    if !valid_binding(b)
        || receipt.target != *b.address
        || receipt.native_id.is_empty()
        || receipt.native_id.len() > 4096
    {
        return None;
    }
    Some(ReceiptEnvelope {
        version: 1,
        intent_id: b.intent_id.into(),
        principal: b.principal.into(),
        target_ref: b.target_ref.into(),
        request_key: b.request_key.into(),
        address: b.address.clone(),
        native_id: receipt.native_id.clone(),
    })
}

fn decode_receipt(raw: &str, b: &ReceiptBinding<'_>) -> Option<NativeReceipt> {
    if raw.len() > 65536 || !valid_binding(b) {
        return None;
    }
    let value: ReceiptEnvelope = serde_json::from_str(raw).ok()?;
    if value.version != 1
        || value.intent_id != b.intent_id
        || value.principal != b.principal
        || value.target_ref != b.target_ref
        || value.request_key != b.request_key
        || value.address != *b.address
        || value.native_id.is_empty()
        || value.native_id.len() > 4096
    {
        return None;
    }
    Some(NativeReceipt {
        target: value.address,
        native_id: value.native_id,
    })
}

/// Save a receipt only for the exact durable intent; never replace existing evidence.
/// The caller supplies a fenced writer connection, an authoritatively resolved
/// binding and the actual receipt of this request. This format is not a signature
/// and cannot establish native origin or bind an untrusted receipt to a request.
pub fn store_native_receipt(
    connection: &mut Connection,
    b: &ReceiptBinding<'_>,
    receipt: &NativeReceipt,
    now: &str,
) -> rusqlite::Result<StoreReceipt> {
    let Some(expected) = envelope(b, receipt) else {
        return Ok(StoreReceipt::Mismatch);
    };
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<Option<String>> = tx.query_row(
        "SELECT native_receipt FROM intents WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND state IN ('dispatching','admitted','unknown')",
        params![b.intent_id, b.principal, b.target_ref, b.request_key], |row| row.get(0)).optional()?;
    let result = match row {
        None => StoreReceipt::Mismatch,
        Some(Some(raw)) => {
            if decode_receipt(&raw, b).as_ref() == Some(receipt) {
                StoreReceipt::AlreadyStored
            } else {
                StoreReceipt::Mismatch
            }
        }
        Some(None) => {
            let raw = serde_json::to_string(&expected)
                .expect("receipt envelope contains only strings and an integer");
            if raw.len() > 65536 {
                StoreReceipt::Mismatch
            } else {
                tx.execute("UPDATE intents SET native_receipt=?2, updated_at=?3 WHERE intent_id=?1 AND native_receipt IS NULL", params![b.intent_id, raw, now])?;
                StoreReceipt::Stored
            }
        }
    };
    tx.commit()?;
    Ok(result)
}

/// A missing, invalid or differently bound receipt is UNKNOWN, never evidence to resend.
pub fn load_native_receipt(
    connection: &Connection,
    b: &ReceiptBinding<'_>,
) -> rusqlite::Result<StoredReceipt> {
    if !valid_binding(b) {
        return Ok(StoredReceipt::Unknown);
    }
    let raw: Option<Option<String>> = connection.query_row(
        "SELECT native_receipt FROM intents WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND state IN ('dispatching','admitted','unknown','confirmed','rejected')",
        params![b.intent_id, b.principal, b.target_ref, b.request_key], |row| row.get(0)).optional()?;
    Ok(
        match raw.flatten().and_then(|raw| decode_receipt(&raw, b)) {
            Some(receipt) => StoredReceipt::Found(receipt),
            None => StoredReceipt::Unknown,
        },
    )
}

/// Read back only the exact stored receipt; this interface cannot submit.
pub async fn reconcile_stored_receipt<R: NativeSessionReader>(
    connection: &Connection,
    b: &ReceiptBinding<'_>,
    reader: &R,
) -> rusqlite::Result<Reconciliation> {
    Ok(match load_native_receipt(connection, b)? {
        StoredReceipt::Found(receipt) => reconcile_dispatching(reader, Some(&receipt)).await,
        StoredReceipt::Unknown => Reconciliation::Unknown,
    })
}

/// A recovery result is never permission to dispatch again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingReceiptRecovery {
    Unknown,
    /// A stored receipt requires the separately bound read-only reconciliation path.
    ReceiptNeedsDecoding,
    NotFound,
    NotRecoverable,
}

/// Persist UNKNOWN for interrupted admissions lacking a stored receipt.
/// The caller must provide the store's fenced writer connection after ensuring
/// that no dispatcher for this intent remains active. This is not a native
/// lookup: the current reader port cannot query by request key. Stored receipt
/// bytes are left untouched and require an authoritative binding to decode.
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

    // The three dispatch/restart cases now run under scoped authority in
    // tests/scoped_stop_gate.rs, retaining their original names and checks.

    #[test]
    fn sha256_matches_standard_vectors() {
        fn hex(data: &[u8]) -> String {
            sha256(data).iter().map(|b| format!("{b:02x}")).collect()
        }
        assert_eq!(
            hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&vec![b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[tokio::test]
    async fn stored_receipt_is_bound_to_intent_address_and_corruption_is_unknown() {
        use rusqlite::functions::FunctionFlags;
        let mut c = Connection::open_in_memory().unwrap();
        c.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8,
            |_| Ok(1),
        )
        .unwrap();
        c.execute_batch(include_str!("../store/schema.sql"))
            .unwrap();
        c.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('t','p','prepared','a','a')", []).unwrap();
        c.execute("INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,created_at,updated_at,retain_until) VALUES ('i','t','p','target','key','hash','dispatching','a','a','later')", []).unwrap();
        let r = receipt();
        let binding = ReceiptBinding {
            intent_id: "i",
            principal: "p",
            target_ref: "target",
            request_key: "key",
            address: &r.target,
        };
        assert_eq!(
            store_native_receipt(&mut c, &binding, &r, "now").unwrap(),
            StoreReceipt::Stored
        );
        assert_eq!(
            store_native_receipt(&mut c, &binding, &r, "later").unwrap(),
            StoreReceipt::AlreadyStored
        );
        assert_eq!(
            load_native_receipt(&c, &binding).unwrap(),
            StoredReceipt::Found(r.clone())
        );
        let mut foreign = r.clone();
        foreign.target.instance.node.0 = "other".into();
        let wrong = ReceiptBinding {
            address: &foreign.target,
            ..binding
        };
        assert_eq!(
            load_native_receipt(&c, &wrong).unwrap(),
            StoredReceipt::Unknown
        );
        assert_eq!(
            store_native_receipt(&mut c, &binding, &foreign, "later").unwrap(),
            StoreReceipt::Mismatch
        );
        let reader = Fake {
            calls: Cell::new(0),
            result: Ok(Observation::Confirmed { receipt: r.clone() }),
        };
        assert_eq!(
            reconcile_stored_receipt(&c, &wrong, &reader).await.unwrap(),
            Reconciliation::Unknown
        );
        assert_eq!(reader.calls.get(), 0);
        let wrong_key = ReceiptBinding {
            request_key: "another",
            ..binding
        };
        assert_eq!(
            load_native_receipt(&c, &wrong_key).unwrap(),
            StoredReceipt::Unknown
        );
        let encoded: String = c
            .query_row(
                "SELECT native_receipt FROM intents WHERE intent_id='i'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut future: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        future["version"] = 2.into();
        c.execute(
            "UPDATE intents SET native_receipt=?1 WHERE intent_id='i'",
            [future.to_string()],
        )
        .unwrap();
        assert_eq!(
            reconcile_stored_receipt(&c, &binding, &reader)
                .await
                .unwrap(),
            Reconciliation::Unknown
        );
        assert_eq!(reader.calls.get(), 0);
        c.execute(
            "UPDATE intents SET native_receipt = '{bad' WHERE intent_id='i'",
            [],
        )
        .unwrap();
        assert_eq!(
            reconcile_stored_receipt(&c, &binding, &reader)
                .await
                .unwrap(),
            Reconciliation::Unknown
        );
        assert_eq!(reader.calls.get(), 0);
        assert_eq!(
            store_native_receipt(&mut c, &binding, &r, "later").unwrap(),
            StoreReceipt::Mismatch
        );
        let persisted: String = c
            .query_row(
                "SELECT native_receipt FROM intents WHERE intent_id='i'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted, "{bad");
    }

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
        let r = receipt();
        let binding = ReceiptBinding {
            intent_id: "i",
            principal: "p",
            target_ref: "target",
            request_key: "key",
            address: &r.target,
        };
        assert_eq!(
            store_native_receipt(&mut c, &binding, &r, "restart").unwrap(),
            StoreReceipt::Stored
        );
        drop(c);
        c = open();
        assert_eq!(
            load_native_receipt(&c, &binding).unwrap(),
            StoredReceipt::Found(r.clone())
        );
        c.execute(
            "UPDATE intents SET native_receipt=NULL WHERE intent_id='i'",
            [],
        )
        .unwrap();
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
