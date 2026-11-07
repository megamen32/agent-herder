// Temporary integration harness until the owner registers application::target.
use herder::{application, auth, domain, store};
#[path = "../src/application/target.rs"]
mod target;

use auth::identity::{
    Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal,
};
use domain::adapter::{
    Admission, DispatchPlan, NativeReceipt, NativeSessionControl, NativeSessionReader, Observation,
    ReadError, RequestKey, SendCommand, SendMode, SessionActivity, SessionSnapshot, SubmitError,
};
use domain::address::{
    Authorization, Availability, Capability, CapabilityVersion, InstanceRef, NodeRef,
    SessionAddress, SessionRef, Support,
};
use std::cell::Cell;
use target::{DeliverRequest, RegistryUnavailable, SessionRegistry, TargetError};

fn address(node: &str) -> SessionAddress {
    SessionAddress {
        instance: InstanceRef {
            node: NodeRef(node.into()),
            instance_id: "profile".into(),
        },
        native_session_id: "native".into(),
    }
}
struct Registry {
    address: SessionAddress,
    offline: bool,
}
impl SessionRegistry for Registry {
    fn resolve(&self, session: &SessionRef) -> Result<Option<SessionAddress>, RegistryUnavailable> {
        if self.offline {
            Err(RegistryUnavailable)
        } else if session.0 == "opaque" {
            Ok(Some(self.address.clone()))
        } else {
            Ok(None)
        }
    }
}
struct Fake {
    reads: Cell<usize>,
    sends: Cell<usize>,
    snapshot_address: SessionAddress,
}
impl NativeSessionReader for Fake {
    async fn snapshot(&self, _: &SessionAddress) -> Result<SessionSnapshot, ReadError> {
        self.reads.set(self.reads.get() + 1);
        Ok(SessionSnapshot {
            address: self.snapshot_address.clone(),
            human_stop: false,
            activity: SessionActivity::Idle,
            capabilities: vec![Capability {
                name: "deliver.start".into(),
                version: CapabilityVersion {
                    adapter_version: "1".into(),
                    capability_version: "1".into(),
                },
                supported: Support::Supported,
                available: Availability::Available,
                authorized: Authorization::Authorized,
            }],
        })
    }
    async fn reconcile(&self, _: &NativeReceipt) -> Result<Observation, ReadError> {
        panic!("not used")
    }
}
impl NativeSessionControl for Fake {
    async fn submit(
        &self,
        plan: DispatchPlan,
        _: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        assert_eq!(key.0, "key");
        self.sends.set(self.sends.get() + 1);
        Ok(Admission {
            receipt: NativeReceipt {
                target: plan.target,
                native_id: "fake-turn".into(),
            },
        })
    }
}

fn request(session: &SessionRef) -> DeliverRequest<'_> {
    DeliverRequest {
        session,
        intent_id: "i",
        task_id: "t",
        request_key: "key",
        message: "fixture",
        command: SendCommand {
            mode: SendMode::Start,
        },
        now: "now",
        retain_until: "later",
    }
}

#[tokio::test]
async fn delivery_requires_authority_exact_instance_and_snapshot_before_fake_submit() {
    let a = address("node-a");
    let b = address("node-b");
    let registry = Registry {
        address: a.clone(),
        offline: false,
    };
    let session = SessionRef("opaque".into());
    let other = SessionRef("foreign".into());
    let identity = ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId("p".into()),
        }),
        None,
    );
    let grants = [
        Grant {
            principal: PrincipalId("p".into()),
            resource: PrivateResource::Session(session.clone()),
            action: Action::Write,
        },
        Grant {
            principal: PrincipalId("p".into()),
            resource: PrivateResource::Session(other.clone()),
            action: Action::Write,
        },
    ];
    let native = Fake {
        reads: Cell::new(0),
        sends: Cell::new(0),
        snapshot_address: a.clone(),
    };
    let mut writer = store::Writer::temporary().unwrap();
    assert_eq!(
        target::deliver(
            &registry,
            &a.instance,
            &identity,
            &[],
            &mut writer,
            &native,
            request(&session)
        )
        .await,
        Err(TargetError::Unauthorized)
    );
    assert_eq!(
        target::deliver(
            &registry,
            &a.instance,
            &identity,
            &grants,
            &mut writer,
            &native,
            request(&other)
        )
        .await,
        Err(TargetError::NotFound)
    );
    assert_eq!(
        target::deliver(
            &registry,
            &b.instance,
            &identity,
            &grants,
            &mut writer,
            &native,
            request(&session)
        )
        .await,
        Err(TargetError::WrongInstance)
    );
    let offline = Registry {
        address: a.clone(),
        offline: true,
    };
    assert_eq!(
        target::deliver(
            &offline,
            &a.instance,
            &identity,
            &grants,
            &mut writer,
            &native,
            request(&session)
        )
        .await,
        Err(TargetError::RegistryUnavailable)
    );
    assert_eq!(native.reads.get(), 0);
    assert_eq!(native.sends.get(), 0);
    let wrong = Fake {
        reads: Cell::new(0),
        sends: Cell::new(0),
        snapshot_address: b.clone(),
    };
    assert_eq!(
        target::deliver(
            &registry,
            &a.instance,
            &identity,
            &grants,
            &mut writer,
            &wrong,
            request(&session)
        )
        .await,
        Err(TargetError::SnapshotMismatch)
    );
    assert_eq!(wrong.sends.get(), 0);
    assert_eq!(
        target::verify_created_target(&registry, &session, &a.instance, &b),
        Err(TargetError::CreateReceiptMismatch)
    );
    assert_eq!(
        target::verify_created_target(&registry, &session, &a.instance, &a),
        Ok(a.clone())
    );
    assert!(matches!(
        target::deliver(
            &registry,
            &a.instance,
            &identity,
            &grants,
            &mut writer,
            &native,
            request(&session)
        )
        .await,
        Ok(application::reconcile::DurableDispatch::Admitted(_))
    ));
    assert_eq!(
        target::deliver(
            &registry,
            &a.instance,
            &identity,
            &grants,
            &mut writer,
            &native,
            request(&session)
        )
        .await,
        Ok(application::reconcile::DurableDispatch::NotClaimed)
    );
    assert_eq!(native.sends.get(), 1);
}
