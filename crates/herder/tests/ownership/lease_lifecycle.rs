use super::*;
use crate::domain::address::{NodeRef, SessionRef};
use crate::domain::resource::{ResourceDescriptor, ResourceKind};
use crate::ownership::manifest::{AuthorityRoute, StorageMarker};
use crate::ownership::{resource, release_runner::TargetExecutionLock};
use std::path::PathBuf;

const FIRST: &str = "01234567-89ab-4cde-8fab-0123456789ab";
const SECOND: &str = "fedcba98-7654-4321-8abc-fedcba987654";

struct Fixture { root: PathBuf, authority: StorageAuthority, resource: ResourceRef }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("herder-lease-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let authority = StorageAuthority { storage_id: StorageId("lease-test".into()), authority_node: NodeRef("test-node".into()), root: root.clone(), schema: "v1".into(), route: AuthorityRoute::Local };
        fs::write(root.join("storage.json"), serde_json::to_vec(&StorageMarker { schema: "v1".into(), storage_id: authority.storage_id.clone() }).unwrap()).unwrap();
        let resource = ResourceRef("test-device".into());
        resource::register_or_update(&authority, ResourceDescriptor::new(resource.clone(), ResourceScope::Global, ResourceKind::Device, "fixture-only-device".into(), authority.storage_id.0.clone(), None, 0), Authorization::Authorized, None).unwrap();
        Self { root, authority, resource }
    }
    fn request(&self, id: &str) -> ResourceClaim {
        ResourceClaim { resource_ref: self.resource.clone(), principal_ref: "alice".into(), session_ref: Some(SessionRef("session-a".into())), claim_id: id.into(), purpose: "lease regression".into(), acquired_at: format!("unix-seconds:{}", now_seconds().unwrap()), expires_at: Some(format!("unix-seconds:{}", now_seconds().unwrap() + 3600)) }
    }
    fn claim(&self, id: &str) -> io::Result<ClaimOutcome> { claim(&self.authority, &self.resource, Authorization::Authorized, self.request(id)) }
    fn expire(&self) {
        let path = self.root.join("resources/test-device/owner.json");
        let mut owner: OwnerRecord = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        owner.claim.expires_at = Some("unix-seconds:0".into());
        fs::write(path, serde_json::to_vec(&owner).unwrap()).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

#[test]
fn expiry_parses_offsets_and_rejects_invalid_calendar_values() {
    assert_eq!(parse_expiry_seconds("1970-01-01T00:00:00Z").unwrap(), 0);
    assert_eq!(parse_expiry_seconds("2026-11-13T23:00:00+03:00").unwrap(), parse_expiry_seconds("2026-11-13T20:00:00Z").unwrap());
    assert_eq!(parse_expiry_seconds("1970-01-01T00:00:01.999Z").unwrap(), 1);
    assert_eq!(parse_expiry_seconds("unix-seconds:123").unwrap(), 123);
    for bad in ["", "tomorrow", "unix-seconds:-1", "2026-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T20:00:00+24:00", "2026-11-13T20:00:00", "2026-11-13T20:00:00.Z"] {
        assert!(parse_expiry_seconds(bad).is_err(), "accepted {bad}");
    }
    assert_eq!(parse_expiry_seconds("2024-02-29T00:00:00Z").unwrap() + 86400, parse_expiry_seconds("2024-03-01T00:00:00Z").unwrap());
}

#[test]
fn expiry_boundary_blocks_renewal_and_external_effect_without_destroying_evidence() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    let mut lease = f.request(FIRST);
    lease.expires_at = Some("unix-seconds:10".into());
    assert!(ensure_live_at(&lease, 9).is_ok());
    assert_eq!(ensure_live_at(&lease, 10).unwrap_err().kind(), io::ErrorKind::TimedOut);
    f.expire();
    assert!(read_by_claim_id(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap().is_some());
    assert_eq!(renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "2099-01-01T00:00:00Z".into()).unwrap_err().kind(), io::ErrorKind::TimedOut);
    let lock = TargetExecutionLock::acquire(&f.authority, &f.resource, Authorization::Authorized).unwrap();
    assert_eq!(lock.verify_current_claim(&f.authority, Authorization::Authorized, FIRST, 1).unwrap_err().kind(), io::ErrorKind::TimedOut);
    assert!(read_by_claim_id(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap().is_some());
}

#[test]
fn expired_takeover_waits_for_effect_and_retires_the_old_generation() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    let lock = TargetExecutionLock::acquire(&f.authority, &f.resource, Authorization::Authorized).unwrap();
    f.expire();
    assert_eq!(f.claim(SECOND).unwrap(), ClaimOutcome::Busy);
    assert_eq!(f.claim(FIRST).unwrap_err().kind(), io::ErrorKind::TimedOut);
    drop(lock);
    assert_eq!(f.claim(SECOND).unwrap(), ClaimOutcome::Acquired);
    assert!(read_by_claim_id(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap().is_none());
    assert_eq!(f.claim(FIRST).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "2099-01-01T00:00:00Z".into()).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn unresolved_execution_survives_worker_lock_loss_and_blocks_takeover_and_release() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    let bound = bind_execution(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "execution-a").unwrap();
    assert_eq!(bind_execution(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "execution-a").unwrap(), bound);
    f.expire();
    assert_eq!(f.claim(SECOND).unwrap(), ClaimOutcome::Busy);
    assert_eq!(release(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap_err().kind(), io::ErrorKind::WouldBlock);
    assert!(clear_execution_binding(&f.authority, &f.resource, Authorization::Authorized, FIRST, "bob", "execution-a", "receipt-a").is_err());
    assert!(clear_execution_binding(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", "other-execution", "receipt-a").is_err());
    assert!(read_execution_binding(&f.authority, &f.resource, Authorization::Authorized).unwrap().unwrap().resolved_receipt.is_none());
    let resolved = clear_execution_binding(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", "execution-a", "receipt-a").unwrap();
    assert_eq!(resolved.resolved_receipt.as_deref(), Some("receipt-a"));
    assert_eq!(clear_execution_binding(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", "execution-a", "receipt-a").unwrap(), resolved);
    assert_eq!(f.claim(SECOND).unwrap(), ClaimOutcome::Acquired);
}

#[test]
fn renewal_checks_principal_revision_and_preserves_owner_during_bounded_handback() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    let deadline = format!("unix-seconds:{}", now_seconds().unwrap() + 120);
    assert_eq!(renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "bob", 1, deadline.clone()).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 2, deadline.clone()).unwrap_err().kind(), io::ErrorKind::WouldBlock);
    let before = read_by_claim_id(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap().unwrap();
    let after = renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, deadline.clone()).unwrap();
    assert_eq!(after.principal_ref, before.principal_ref);
    assert_eq!(after.session_ref, before.session_ref);
    assert_eq!(after.claim_id, before.claim_id);
    assert_eq!(after.expires_at, Some(deadline));
    assert!(renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "unix-seconds:0".into()).is_err());
}

#[test]
fn acquisition_retry_preserves_original_intent_after_renewal() {
    let f = Fixture::new();
    let original = f.request(FIRST);
    claim(&f.authority, &f.resource, Authorization::Authorized, original.clone()).unwrap();
    let renewed = renew_owned(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "2099-01-01T00:00:00Z".into()).unwrap();
    assert_eq!(claim(&f.authority, &f.resource, Authorization::Authorized, original.clone()).unwrap(), ClaimOutcome::AlreadyOwned);
    let mut replay = original;
    replay.acquired_at = "retry-observation-time".into();
    assert_eq!(claim_recovering_intent(&f.authority, &f.resource, Authorization::Authorized, replay.clone()).unwrap(), ClaimOutcome::AlreadyOwned);
    replay.expires_at = renewed.expires_at;
    assert_eq!(claim_recovering_intent(&f.authority, &f.resource, Authorization::Authorized, replay).unwrap_err().kind(), io::ErrorKind::InvalidInput);

    // A later generation has its own intent even though the previous metadata
    // still exists in the resource directory after release.
    release(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap();
    let next = f.request(SECOND);
    claim(&f.authority, &f.resource, Authorization::Authorized, next.clone()).unwrap();
    renew_owned(&f.authority, &f.resource, Authorization::Authorized, SECOND, "alice", 1, "2099-02-01T00:00:00Z".into()).unwrap();
    assert_eq!(claim(&f.authority, &f.resource, Authorization::Authorized, next).unwrap(), ClaimOutcome::AlreadyOwned);
}

#[test]
fn corrupted_occupancy_never_authorizes_expiry_takeover_or_release() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    let binding = bind_execution(&f.authority, &f.resource, Authorization::Authorized, FIRST, "alice", 1, "execution-a").unwrap();
    f.expire();
    let path = f.root.join("resources/test-device/execution-binding.json");
    for (field, value) in [("resource_ref", "other-resource"), ("resolved_receipt", ""), ("claim_id", "invalid-generation")] {
        let mut bad = serde_json::to_value(&binding).unwrap();
        bad[field] = value.into();
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert_eq!(f.claim(SECOND).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(release(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(read_by_claim_id(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap().is_some());
    }
}

#[test]
fn released_nonce_cannot_be_reused_after_restart_or_by_another_principal() {
    let f = Fixture::new();
    f.claim(FIRST).unwrap();
    release(&f.authority, &f.resource, Authorization::Authorized, FIRST).unwrap();
    assert_eq!(f.claim(FIRST).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    let mut stolen = f.request(FIRST);
    stolen.principal_ref = "bob".into();
    assert_eq!(claim(&f.authority, &f.resource, Authorization::Authorized, stolen).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(f.claim(SECOND).unwrap(), ClaimOutcome::Acquired);
}
