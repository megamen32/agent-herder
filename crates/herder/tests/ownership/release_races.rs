use crate::domain::address::{Authorization, NodeRef};
use crate::domain::resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope};
use crate::ownership::claim;
use crate::ownership::manifest::{AuthorityRoute, ResourceMarker, StorageAuthority, StorageId, StorageMarker};
use crate::ownership::release_receipt::{self, spawn_admitted, ReceiptStatus};
use crate::ownership::release_runner::TargetExecutionLock;
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture() -> (std::path::PathBuf, StorageAuthority, ResourceRef) {
    let root = std::env::temp_dir().join(format!(
        "herder-release-race-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let resource_ref = ResourceRef("target-a".into());
    let resource_dir = root.join("resources/target-a");
    fs::create_dir_all(&resource_dir).unwrap();
    let authority = StorageAuthority {
        storage_id: StorageId("storage-race".into()),
        authority_node: NodeRef("node-a".into()),
        root: root.clone(),
        schema: "v1".into(),
        route: AuthorityRoute::Local,
    };
    fs::write(
        root.join("storage.json"),
        serde_json::to_vec(&StorageMarker {
            schema: authority.schema.clone(),
            storage_id: authority.storage_id.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    let descriptor = ResourceDescriptor::new(
        resource_ref.clone(),
        ResourceScope::Global,
        ResourceKind::Deployment,
        "isolated-file-effect".into(),
        authority.storage_id.0.clone(),
        None,
        1,
    );
    fs::write(
        resource_dir.join("resource.json"),
        serde_json::to_vec(&ResourceMarker {
            schema: authority.schema.clone(),
            storage_id: authority.storage_id.clone(),
            resource_ref: resource_ref.clone(),
            scope: ResourceScope::Global,
            descriptor: Some(descriptor),
        })
        .unwrap(),
    )
    .unwrap();
    (root, authority, resource_ref)
}

fn request(resource_ref: &ResourceRef, principal: &str, claim_id: &str) -> ResourceClaim {
    ResourceClaim {
        resource_ref: resource_ref.clone(),
        principal_ref: principal.into(),
        session_ref: None,
        claim_id: claim_id.into(),
        purpose: "isolated file effect".into(),
        acquired_at: "test-time".into(),
        expires_at: None,
    }
}

#[test]
fn rejects_admitted_effect_after_owner_changes_before_spawn() {
    let (root, authority, resource_ref) = fixture();
    let old_claim_id = "12345678-1234-4234-8234-123456789abc";
    let new_claim_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    claim::claim(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        request(&resource_ref, "principal-old", old_claim_id),
    )
    .unwrap();
    let lock = TargetExecutionLock::acquire(
        &authority,
        &resource_ref,
        Authorization::Authorized,
    )
    .unwrap();
    let admission = release_receipt::admit(
        &authority,
        &lock,
        Authorization::Authorized,
        old_claim_id,
        1,
        "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        &"a".repeat(64),
    )
    .unwrap();
    assert!(admission.newly_admitted);

    let effect_path = root.join("effect.txt");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("printf x >> \"$1\"")
        .arg("release-effect")
        .arg(&effect_path);
    let worker_authority = authority.clone();
    let worker_resource = resource_ref.clone();
    let (released_tx, released_rx) = std::sync::mpsc::channel();
    let release_worker = std::thread::spawn(move || {
        claim::release(
            &worker_authority,
            &worker_resource,
            Authorization::Authorized,
            old_claim_id,
        )
        .unwrap();
        claim::claim(
            &worker_authority,
            &worker_resource,
            Authorization::Authorized,
            request(&worker_resource, "principal-new", new_claim_id),
        )
        .unwrap();
        released_tx.send(()).unwrap();
    });
    assert!(released_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    drop(lock);
    released_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    release_worker.join().unwrap();

    let replacement_lock = TargetExecutionLock::acquire(
        &authority,
        &resource_ref,
        Authorization::Authorized,
    )
    .unwrap();
    assert_eq!(
        spawn_admitted(
            &authority,
            &replacement_lock,
            Authorization::Authorized,
            1,
            &admission,
            &mut command,
        )
        .unwrap_err()
        .kind(),
        std::io::ErrorKind::PermissionDenied
    );

    assert!(!effect_path.exists());
    assert_eq!(
        claim::read_by_claim_id(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            new_claim_id,
        )
        .unwrap()
        .unwrap()
        .principal_ref,
        "principal-new"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn confirmed_request_key_replays_as_readback_without_second_effect() {
    let (root, authority, resource_ref) = fixture();
    let claim_id = "87654321-4321-4321-8321-cba987654321";
    let request_key = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    claim::claim(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        request(&resource_ref, "principal-a", claim_id),
    )
    .unwrap();
    let lock = TargetExecutionLock::acquire(
        &authority,
        &resource_ref,
        Authorization::Authorized,
    )
    .unwrap();
    let first = release_receipt::admit(
        &authority,
        &lock,
        Authorization::Authorized,
        claim_id,
        1,
        request_key,
        &"c".repeat(64),
    )
    .unwrap();
    assert!(first.newly_admitted);

    let effect_path = root.join("effect.txt");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("printf x >> \"$1\"")
        .arg("release-effect")
        .arg(&effect_path);
    let mut child = spawn_admitted(
        &authority,
        &lock,
        Authorization::Authorized,
        1,
        &first,
        &mut command,
    )
    .unwrap();
    assert!(child.wait().unwrap().success());
    release_receipt::finish_under_lock(
        &authority,
        &lock,
        request_key,
        ReceiptStatus::Confirmed,
    )
    .unwrap();

    let replay = release_receipt::admit(
        &authority,
        &lock,
        Authorization::Authorized,
        claim_id,
        1,
        request_key,
        &"c".repeat(64),
    )
    .unwrap();
    assert!(!replay.newly_admitted);
    assert_eq!(replay.receipt.status, ReceiptStatus::Confirmed);
    assert_eq!(
        release_receipt::resolve_after_lock(&authority, &lock, request_key)
            .unwrap()
            .status,
        ReceiptStatus::Confirmed
    );

    let mut retry = Command::new("/bin/sh");
    retry
        .arg("-c")
        .arg("printf x >> \"$1\"")
        .arg("release-effect")
        .arg(&effect_path);
    assert_eq!(
        spawn_admitted(
            &authority,
            &lock,
            Authorization::Authorized,
            1,
            &replay,
            &mut retry,
        )
        .unwrap_err()
        .kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(fs::read_to_string(effect_path).unwrap(), "x");
    fs::remove_dir_all(root).unwrap();
}
