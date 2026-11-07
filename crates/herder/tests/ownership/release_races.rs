use crate::domain::address::{Authorization, NodeRef};
use crate::domain::resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope};
use crate::ownership::claim;
use crate::ownership::manifest::{AuthorityRoute, ResourceMarker, StorageAuthority, StorageId, StorageMarker};
use crate::ownership::release_receipt::{self, spawn_with_execution_lock};
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
fn reproduces_effect_from_admitted_request_after_owner_changes() {
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

    claim::release(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        old_claim_id,
    )
    .unwrap();
    claim::claim(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        request(&resource_ref, "principal-new", new_claim_id),
    )
    .unwrap();

    let effect_path = root.join("effect.txt");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("printf x >> \"$1\"")
        .arg("release-effect")
        .arg(&effect_path);
    let mut child = spawn_with_execution_lock(&mut command, &lock).unwrap();
    assert!(child.wait().unwrap().success());

    assert_eq!(fs::read_to_string(effect_path).unwrap(), "x");
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
