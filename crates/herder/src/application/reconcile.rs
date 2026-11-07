//! Readback of a dispatching intent never grants permission to submit again.
use crate::domain::adapter::{NativeReceipt, NativeSessionReader, Observation};

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
}
