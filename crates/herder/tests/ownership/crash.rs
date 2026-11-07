use super::*;
use crate::domain::address::{Availability, NodeRef, SessionRef};
use crate::domain::resource::{Attachment, ResourceDescriptor, ResourceKind};
use crate::ownership::manifest::{AuthorityRoute, ResourceMarker, StorageId, StorageMarker};
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture() -> (std::path::PathBuf, StorageAuthority) {
    let root = std::env::temp_dir().join(format!(
        "herder-crash-claim-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let resource_dir = root.join("resources/r");
    fs::create_dir_all(&resource_dir).unwrap();
    let authority = StorageAuthority {
        storage_id: StorageId("storage-crash-test".into()),
        authority_node: NodeRef("node-a".into()),
        root: root.clone(),
        schema: "v1".into(),
        route: AuthorityRoute::Local,
    };
    fs::write(
        root.join("storage.json"),
        serde_json::to_vec(&StorageMarker {
            schema: "v1".into(),
            storage_id: authority.storage_id.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    fs::write(
        resource_dir.join("resource.json"),
        serde_json::to_vec(&ResourceMarker {
            schema: "v1".into(),
            storage_id: authority.storage_id.clone(),
            resource_ref: ResourceRef("r".into()),
            scope: ResourceScope::Global,
            descriptor: Some(ResourceDescriptor::new(
                ResourceRef("r".into()),
                ResourceScope::Global,
                ResourceKind::Device,
                "physical-device-crash-test".into(),
                authority.storage_id.0.clone(),
                Some(Attachment {
                    node_ref: NodeRef("node-a".into()),
                    route_ref: Some("device-route".into()),
                    availability: Availability::Available,
                    observed_at: "2026-11-07T00:00:00Z".into(),
                }),
                1,
            )),
        })
        .unwrap(),
    )
    .unwrap();
    (root, authority)
}

fn requested(claim_id: &str) -> ResourceClaim {
    ResourceClaim {
        resource_ref: ResourceRef("r".into()),
        principal_ref: "crash-test-principal".into(),
        session_ref: Some(SessionRef("crash-test-session".into())),
        claim_id: claim_id.into(),
        purpose: "crash recovery test".into(),
        acquired_at: "2026-11-07T00:00:00Z".into(),
        expires_at: None,
    }
}

fn inject(point: u8) {
    OWNER_WRITE_FAILPOINT.with(|failpoint| failpoint.set(point));
}

fn has_no_temp_files(resource_dir: &Path) -> bool {
    fs::read_dir(resource_dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    })
}

#[test]
fn failure_before_rename_leaves_no_owner_or_temp_and_same_nonce_can_retry() {
    let (root, authority) = fixture();
    let resource_ref = ResourceRef("r".into());
    let request = requested("01234567-89ab-4cde-8fab-0123456789ab");
    let resource_dir = root.join("resources/r");
    inject(FAIL_BEFORE_RENAME);

    assert!(
        claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            request.clone(),
        )
        .is_err()
    );
    assert!(!resource_dir.join("owner.json").exists());
    assert!(has_no_temp_files(&resource_dir));
    assert_eq!(
        claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            request,
        )
        .unwrap(),
        ClaimOutcome::Acquired
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failure_after_rename_or_directory_sync_leaves_one_complete_replayable_owner() {
    for failpoint in [
        FAIL_AFTER_RENAME,
        FAIL_BEFORE_DIRECTORY_SYNC,
        FAIL_AFTER_DIRECTORY_SYNC,
    ] {
        let (root, authority) = fixture();
        let resource_ref = ResourceRef("r".into());
        let request = requested("fedcba98-7654-4321-8abc-fedcba987654");
        let resource_dir = root.join("resources/r");
        inject(failpoint);

        assert!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                request.clone(),
            )
            .is_err()
        );
        let owner: OwnerRecord =
            serde_json::from_slice(&fs::read(resource_dir.join("owner.json")).unwrap()).unwrap();
        assert_eq!(owner.claim, request);
        assert!(has_no_temp_files(&resource_dir));
        assert_eq!(
            claim(
                &authority,
                &resource_ref,
                Authorization::Authorized,
                request,
            )
            .unwrap(),
            ClaimOutcome::AlreadyOwned
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn release_failure_before_unlink_preserves_owner_and_after_unlink_reports_unknown() {
    for (failpoint, owner_remains) in [
        (FAIL_BEFORE_OWNER_UNLINK, true),
        (FAIL_AFTER_OWNER_UNLINK, false),
    ] {
        let (root, authority) = fixture();
        let resource_ref = ResourceRef("r".into());
        let request = requested("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            request.clone(),
        )
        .unwrap();

        inject(failpoint);
        assert!(release(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            &request.claim_id,
        )
        .is_err());
        assert_eq!(
            resource_dir_owner_exists(&root),
            owner_remains,
            "unlink failpoint {failpoint}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn claim_cleans_abandoned_owner_temps_under_guard_before_writing() {
    let (root, authority) = fixture();
    let resource_ref = ResourceRef("r".into());
    let resource_dir = root.join("resources/r");
    fs::write(resource_dir.join(".owner-abandoned.tmp"), b"partial").unwrap();

    assert_eq!(
        claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            requested("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
        )
        .unwrap(),
        ClaimOutcome::Acquired
    );
    assert!(has_no_temp_files(&resource_dir));
    fs::remove_dir_all(root).unwrap();
}

fn resource_dir_owner_exists(root: &Path) -> bool {
    root.join("resources/r/owner.json").exists()
}

#[test]
fn owner_guard_inode_survives_claim_renew_and_release() {
    use std::os::unix::fs::MetadataExt;

    let (root, authority) = fixture();
    let resource_ref = ResourceRef("r".into());
    let resource_dir = root.join("resources/r");
    let request = requested("cccccccc-dddd-4eee-8fff-000000000000");
    let guard_path = resource_dir.join("guard.lock");

    claim(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        request.clone(),
    )
    .unwrap();
    let initial = fs::metadata(&guard_path).unwrap();
    renew(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        &request.claim_id,
        Some("2030-01-01T00:00:00Z".into()),
    )
    .unwrap();
    release(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        &request.claim_id,
    )
    .unwrap();
    let final_guard = fs::metadata(&guard_path).unwrap();

    assert_eq!((initial.dev(), initial.ino()), (final_guard.dev(), final_guard.ino()));
    assert!(!resource_dir.join("owner.json").exists());
    fs::remove_dir_all(root).unwrap();
}
