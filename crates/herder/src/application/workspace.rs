//! MCP-facing operations over the shared durable workspace ownership library.
//!
//! The offline CLI and this application module use the same resource markers
//! and `owner.json`; this layer adds connection ACL and verified principal
//! checks without introducing another ownership store.
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        address::Authorization,
        resource::{ResourceClaim, ResourceDescriptor, ResourceRef},
    },
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
    ownership::{
        claim::{self, ClaimOutcome},
        manifest::StorageAuthority,
        resource as registry,
    },
};
use rmcp::model::CallToolResult;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub enum WorkspaceError {
    Unauthorized,
    NotOwner,
    Ownership(io::Error),
}

/// Authenticated mutations over the one canonical descriptor and owner store.
/// Read operations remain with the resource application's filtered registry.
pub struct WorkspaceApplication {
    authority: StorageAuthority,
    grants: Vec<Grant>,
}

impl WorkspaceApplication {
    pub fn new(authority: StorageAuthority, grants: Vec<Grant>) -> Self {
        Self { authority, grants }
    }

    fn handle_resource(
        &self,
        identity: &ConnectionIdentity,
        request: catalog::Resource,
    ) -> Option<CallToolResult> {
        match request {
            catalog::Resource::Register { resource_ref, scope, kind, external_ref, authority_ref, attachment } => {
                let descriptor = ResourceDescriptor::new(resource_ref, scope, kind, external_ref, authority_ref, attachment, 0);
                Some(match register_resource(identity, &self.grants, &self.authority, descriptor) {
                    Ok(descriptor) => CallToolResult::structured(json!({"status":"registered", "resource":descriptor})),
                    Err(error) => workspace_error(error),
                })
            }
            catalog::Resource::Update { resource_ref, revision, scope, kind, external_ref, attachment } => {
                let descriptor = ResourceDescriptor::new(resource_ref, scope, kind, external_ref, self.authority.storage_id.0.clone(), attachment, revision);
                Some(match update_resource(identity, &self.grants, &self.authority, descriptor, revision) {
                    Ok(descriptor) => CallToolResult::structured(json!({"status":"updated", "resource":descriptor})),
                    Err(error) => workspace_error(error),
                })
            }
            catalog::Resource::Renew { resource_ref, claim_id, expires_at } => {
                Some(match renew_resource(identity, &self.grants, &self.authority, &resource_ref, &claim_id, expires_at) {
                    Ok(claim) => CallToolResult::structured(json!({"status":"renewed", "resource_ref":resource_ref, "claim":claim})),
                    Err(error) => workspace_error(error),
                })
            }
            catalog::Resource::Claim {
                resource_ref,
                purpose,
                request_key,
                expires_at,
            } => {
                let claim_id = claim_id_for(identity, &self.authority, &resource_ref, &request_key);
                Some(match claim_id {
                    Ok(claim_id) => match claim_resource(
                        identity,
                        &self.grants,
                        &self.authority,
                        &resource_ref,
                        &request_key,
                        purpose,
                        expires_at,
                    ) {
                        Ok(outcome) => CallToolResult::structured(json!({
                            "resource_ref": resource_ref,
                            "claim_id": claim_id,
                            "status": claim_status(outcome)
                        })),
                        Err(error) => workspace_error(error),
                    },
                    Err(error) => workspace_error(error),
                })
            }
            catalog::Resource::Release {
                resource_ref,
                claim_id,
            } => Some(
                match release_resource(
                    identity,
                    &self.grants,
                    &self.authority,
                    &resource_ref,
                    &claim_id,
                ) {
                    Ok(()) => CallToolResult::structured(json!({
                        "resource_ref": resource_ref,
                        "claim_id": claim_id,
                        "status": "released"
                    })),
                    Err(error) => workspace_error(error),
                },
            ),
            _ => None,
        }
    }
}

impl ApplicationPort for WorkspaceApplication {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            match request {
                catalog::Request::Resource(resource) => self.handle_resource(identity, resource),
                _ => None,
            }
        })
    }
}

fn claim_id_for(
    identity: &ConnectionIdentity,
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    request_key: &str,
) -> Result<String, WorkspaceError> {
    let principal = principal(identity)?;
    if request_key.is_empty() || request_key.len() > 4096 {
        return Err(WorkspaceError::Ownership(io::Error::new(io::ErrorKind::InvalidInput, "acquisition request key is required")));
    }
    let mut hash = Sha256::new();
    for part in [
        authority.storage_id.0.as_str(),
        resource_ref.0.as_str(),
        principal.as_str(),
        request_key,
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    let mut digest = hash.finalize()[..16].to_vec();
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    let encoded: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &encoded[0..8],
        &encoded[8..12],
        &encoded[12..16],
        &encoded[16..20],
        &encoded[20..32]
    ))
}

fn claim_status(outcome: ClaimOutcome) -> &'static str {
    match outcome {
        ClaimOutcome::Acquired => "acquired",
        ClaimOutcome::AlreadyOwned => "already_owned",
        ClaimOutcome::Busy => "busy",
    }
}

fn workspace_error(error: WorkspaceError) -> CallToolResult {
    let message = match error {
        WorkspaceError::Unauthorized => "resource write is not authorized".to_owned(),
        WorkspaceError::NotOwner => "claim belongs to another principal".to_owned(),
        WorkspaceError::Ownership(error) => error.to_string(),
    };
    CallToolResult::error(vec![rmcp::model::ContentBlock::text(message)])
}

pub fn register_resource(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    descriptor: ResourceDescriptor,
) -> Result<ResourceDescriptor, WorkspaceError> {
    require_write(identity, grants, descriptor.resource_ref())?;
    registry::register_or_update(authority, descriptor, Authorization::Authorized, None)
        .map_err(WorkspaceError::Ownership)
}

pub fn update_resource(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    descriptor: ResourceDescriptor,
    expected_revision: u64,
) -> Result<ResourceDescriptor, WorkspaceError> {
    require_write(identity, grants, descriptor.resource_ref())?;
    registry::register_or_update(authority, descriptor, Authorization::Authorized, Some(expected_revision))
        .map_err(WorkspaceError::Ownership)
}

/// Renew only a claim belonging to the authenticated principal. Possessing its
/// identifier or a write grant for the resource does not impersonate its owner.
pub fn renew_resource(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    claim_id: &str,
    expires_at: String,
) -> Result<ResourceClaim, WorkspaceError> {
    let principal_ref = require_write(identity, grants, resource_ref)?;
    let current = claim::read_by_claim_id(authority, resource_ref, Authorization::Authorized, claim_id)
        .map_err(WorkspaceError::Ownership)?
        .ok_or_else(|| WorkspaceError::Ownership(io::Error::new(io::ErrorKind::NotFound, "claim is not current")))?;
    if current.principal_ref != principal_ref { return Err(WorkspaceError::NotOwner); }
    let descriptor = registry::get(authority, resource_ref, Authorization::Authorized)
        .map_err(WorkspaceError::Ownership)?;
    claim::renew_owned(authority, resource_ref, Authorization::Authorized, claim_id, &principal_ref, descriptor.revision, expires_at)
        .map_err(WorkspaceError::Ownership)
}

/// Establish a renewal delegation only from an authenticated, authorized owner.
pub fn bind_resource_execution(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    claim_id: &str,
    expected_revision: u64,
    execution_ref: &str,
) -> Result<claim::ExecutionBinding, WorkspaceError> {
    let principal_ref = require_write(identity, grants, resource_ref)?;
    claim::bind_execution(authority, resource_ref, Authorization::Authorized, claim_id, &principal_ref, expected_revision, execution_ref)
        .map_err(WorkspaceError::Ownership)
}

/// Claim a registered resource in the canonical file ownership library.
/// Principal identity is always taken from the trusted connection, never from
/// request data. Retries use the library's intent recovery semantics.
pub fn claim_resource(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    request_key: &str,
    purpose: String,
    expires_at: Option<String>,
) -> Result<ClaimOutcome, WorkspaceError> {
    let principal_ref = require_write(identity, grants, resource_ref)?;
    let claim_id = claim_id_for(identity, authority, resource_ref, request_key)?;
    let acquired_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceError::Ownership(io::Error::other("system clock unavailable")))?
        .as_secs();
    let requested = ResourceClaim {
        resource_ref: resource_ref.clone(),
        principal_ref,
        session_ref: None,
        claim_id,
        purpose,
        acquired_at: format!("unix-seconds:{acquired_at}"),
        expires_at,
    };
    claim::claim_recovering_intent(
        authority,
        resource_ref,
        Authorization::Authorized,
        requested,
    )
    .map_err(WorkspaceError::Ownership)
}

/// Release only the current claim owned by the authenticated principal. The
/// shared library still checks the exact claim ID while holding its file lock.
pub fn release_resource(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    claim_id: &str,
) -> Result<(), WorkspaceError> {
    let principal_ref = require_write(identity, grants, resource_ref)?;
    let current =
        claim::read_by_claim_id(authority, resource_ref, Authorization::Authorized, claim_id)
            .map_err(WorkspaceError::Ownership)?
            .ok_or_else(|| {
                WorkspaceError::Ownership(io::Error::new(
                    io::ErrorKind::NotFound,
                    "claim is not current",
                ))
            })?;
    if current.principal_ref != principal_ref {
        return Err(WorkspaceError::NotOwner);
    }
    claim::release(authority, resource_ref, Authorization::Authorized, claim_id)
        .map_err(WorkspaceError::Ownership)
}

/// Read the current owner only with an exact resource read grant. This is the
/// same durable owner record observed by the offline ownership CLI.
pub fn read_claim(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    claim_id: &str,
) -> Result<Option<ResourceClaim>, WorkspaceError> {
    identity
        .authorize(
            grants,
            &PrivateResource::Resource(resource_ref.0.clone()),
            Action::Read,
        )
        .map_err(|_| WorkspaceError::Unauthorized)?;
    claim::read_by_claim_id(authority, resource_ref, Authorization::Authorized, claim_id)
        .map_err(WorkspaceError::Ownership)
}

fn require_write(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    resource_ref: &ResourceRef,
) -> Result<String, WorkspaceError> {
    let principal = principal(identity)?;
    identity
        .authorize(
            grants,
            &PrivateResource::Resource(resource_ref.0.clone()),
            Action::Write,
        )
        .map_err(|_| WorkspaceError::Unauthorized)?;
    Ok(principal)
}

fn principal(identity: &ConnectionIdentity) -> Result<String, WorkspaceError> {
    match identity.caller() {
        Caller::Principal(principal) => Ok(principal.id.0.clone()),
        Caller::Unknown | Caller::NodeCredential => Err(WorkspaceError::Unauthorized),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::identity::{PrincipalId, VerifiedPrincipal},
        cli::ownership,
        domain::{
            address::NodeRef,
            resource::{ResourceDescriptor, ResourceKind, ResourceScope},
        },
        ownership::{
            manifest::{AuthorityRoute, StorageId, StorageMarker},
            resource as registry,
        },
    };
    use std::{
        fs,
        path::PathBuf,
        sync::{Arc, Barrier},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    const CLI_CLAIM_ID: &str = "123e4567-e89b-42d3-a456-426614174102";

    struct Fixture {
        root: PathBuf,
        authority_path: PathBuf,
        authority: StorageAuthority,
        resource_ref: ResourceRef,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "herder-workspace-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            // The offline CLI requires an owner-controlled authority root.
            // Do not let a group-writable test-runner umask invalidate it.
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            }
            #[cfg(not(unix))]
            fs::create_dir(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let authority = StorageAuthority {
                storage_id: StorageId("workspace-test-storage".into()),
                authority_node: NodeRef("workspace-test-node".into()),
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
            let resource_ref = ResourceRef("fixture-resource".into());
            registry::register_or_update(
                &authority,
                ResourceDescriptor::new(
                    resource_ref.clone(),
                    ResourceScope::Global,
                    ResourceKind::Workspace,
                    "fixture:resource".into(),
                    authority.storage_id.0.clone(),
                    None,
                    0,
                ),
                Authorization::Authorized,
                None,
            )
            .unwrap();
            let authority_path = root.join("authority.json");
            fs::write(&authority_path, serde_json::to_vec(&authority).unwrap()).unwrap();
            Self {
                root,
                authority_path,
                authority,
                resource_ref,
            }
        }

        fn cli(&self, action: &str, claim_id: &str) -> Result<serde_json::Value, String> {
            let mut args = vec![
                action.into(),
                "--authority".into(),
                self.authority_path.to_string_lossy().into_owned(),
                "--resource".into(),
                self.resource_ref.0.clone(),
            ];
            if action == "claim" {
                args.extend([
                    "--claim-id".into(),
                    claim_id.into(),
                    "--purpose".into(),
                    "test ownership race".into(),
                ]);
            }
            ownership::execute(&args)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn identity(principal: &str) -> ConnectionIdentity {
        ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal {
                id: PrincipalId(principal.into()),
            }),
            None,
        )
    }

    fn grant(principal: &str, resource: &ResourceRef, action: Action) -> Grant {
        Grant {
            principal: PrincipalId(principal.into()),
            resource: PrivateResource::Resource(resource.0.clone()),
            action,
        }
    }

    #[test]
    fn mcp_application_and_offline_cli_race_for_the_same_file_owner() {
        let fixture = Arc::new(Fixture::new());
        let barrier = Arc::new(Barrier::new(3));
        let mcp_fixture = Arc::clone(&fixture);
        let mcp_barrier = Arc::clone(&barrier);
        let mcp = thread::spawn(move || {
            mcp_barrier.wait();
            claim_resource(
                &identity("mcp-principal"),
                &[grant(
                    "mcp-principal",
                    &mcp_fixture.resource_ref,
                    Action::Write,
                )],
                &mcp_fixture.authority,
                &mcp_fixture.resource_ref,
                "mcp-test-request".into(),
                "MCP test claim".into(),
                None,
            )
            .unwrap()
        });
        let cli_fixture = Arc::clone(&fixture);
        let cli_barrier = Arc::clone(&barrier);
        let cli = thread::spawn(move || {
            cli_barrier.wait();
            cli_fixture.cli("claim", CLI_CLAIM_ID).unwrap()
        });
        barrier.wait();
        let mcp_result = mcp.join().unwrap();
        let cli_result = cli.join().unwrap();
        let mcp_won = mcp_result == ClaimOutcome::Acquired;
        let cli_won = cli_result["status"] == "acquired";
        assert_ne!(
            mcp_won, cli_won,
            "exactly one consumer must acquire the shared owner"
        );
        assert!(matches!(
            mcp_result,
            ClaimOutcome::Acquired | ClaimOutcome::Busy
        ));
        assert!(cli_result["status"] == "acquired" || cli_result["status"] == "busy");

        let owner_id = if mcp_won {
            claim_id_for(
                &identity("mcp-principal"),
                &fixture.authority,
                &fixture.resource_ref,
                "mcp-test-request",
            )
            .unwrap()
        } else {
            CLI_CLAIM_ID.to_owned()
        };
        let reopened_authority: StorageAuthority =
            serde_json::from_slice(&fs::read(&fixture.authority_path).unwrap()).unwrap();
        let owner = crate::ownership::claim::read_by_claim_id(
            &reopened_authority,
            &fixture.resource_ref,
            Authorization::Authorized,
            &owner_id,
        )
        .unwrap();
        assert!(
            owner.is_some(),
            "winner remains readable from the reopened authority"
        );
        let status = fixture.cli("status", "ignored").unwrap();
        assert_eq!(status["status"], "owned");
    }

    #[test]
    fn only_claim_owner_can_release_and_missing_exact_acl_denies() {
        let fixture = Fixture::new();
        let alice = identity("alice");
        let alice_grants = [grant("alice", &fixture.resource_ref, Action::Write)];
        assert_eq!(
            claim_resource(
                &alice,
                &alice_grants,
                &fixture.authority,
                &fixture.resource_ref,
                "alice-request".into(),
                "owned by alice".into(),
                None,
            )
            .unwrap(),
            ClaimOutcome::Acquired,
        );
        let bob = identity("bob");
        let bob_grants = [grant("bob", &fixture.resource_ref, Action::Write)];
        assert!(matches!(
            release_resource(
                &bob,
                &bob_grants,
                &fixture.authority,
                &fixture.resource_ref,
                &claim_id_for(
                    &alice,
                    &fixture.authority,
                    &fixture.resource_ref,
                    "alice-request"
                )
                .unwrap()
            ),
            Err(WorkspaceError::NotOwner)
        ));
        assert!(matches!(
            release_resource(
                &bob,
                &[],
                &fixture.authority,
                &fixture.resource_ref,
                &claim_id_for(
                    &alice,
                    &fixture.authority,
                    &fixture.resource_ref,
                    "alice-request"
                )
                .unwrap()
            ),
            Err(WorkspaceError::Unauthorized)
        ));
        release_resource(
            &alice,
            &alice_grants,
            &fixture.authority,
            &fixture.resource_ref,
            &claim_id_for(
                &alice,
                &fixture.authority,
                &fixture.resource_ref,
                "alice-request",
            )
            .unwrap(),
        )
        .unwrap();
        assert!(fixture.cli("status", "ignored").unwrap()["status"] == "free");
    }

    #[tokio::test]
    async fn registered_generic_resource_reaches_authenticated_mutation_dispatch() {
        let fixture = Fixture::new();
        let resource_ref = ResourceRef("new-build-slot".into());
        let alice = identity("alice");
        let alice_grants = vec![grant("alice", &resource_ref, Action::Write)];
        let app = WorkspaceApplication::new(fixture.authority.clone(), alice_grants.clone());
        let register = catalog::Resource::Register {
            resource_ref: resource_ref.clone(), scope: ResourceScope::Global,
            kind: ResourceKind::Other("build_slot".into()), external_ref: "fixture:build-slot".into(),
            authority_ref: fixture.authority.storage_id.0.clone(), attachment: None,
        };
        let denied = WorkspaceApplication::new(fixture.authority.clone(), vec![])
            .call(&alice, catalog::Request::Resource(register.clone())).await.unwrap();
        assert_eq!(denied.is_error, Some(true));
        let created = app.call(&alice, catalog::Request::Resource(register)).await.unwrap();
        assert_ne!(created.is_error, Some(true));
        assert_eq!(registry::get(&fixture.authority, &resource_ref, Authorization::Authorized).unwrap().revision, 1);
        let update = catalog::Resource::Update {
            resource_ref: resource_ref.clone(), revision: 1, scope: ResourceScope::Global,
            kind: ResourceKind::Other("build_slot".into()), external_ref: "fixture:build-slot".into(), attachment: None,
        };
        assert_ne!(app.call(&alice, catalog::Request::Resource(update.clone())).await.unwrap().is_error, Some(true));
        assert_eq!(app.call(&alice, catalog::Request::Resource(update)).await.unwrap().is_error, Some(true));
        claim_resource(&alice, &alice_grants, &fixture.authority, &resource_ref, "build-request", "test build".into(), None).unwrap();
        let claim_id = claim_id_for(&alice, &fixture.authority, &resource_ref, "build-request").unwrap();
        let renew = catalog::Resource::Renew { resource_ref: resource_ref.clone(), claim_id: claim_id.clone(), expires_at: "2099-01-01T00:00:00Z".into() };
        let bob = identity("bob");
        let bob_app = WorkspaceApplication::new(fixture.authority.clone(), vec![grant("bob", &resource_ref, Action::Write)]);
        assert_eq!(bob_app.call(&bob, catalog::Request::Resource(renew.clone())).await.unwrap().is_error, Some(true));
        assert_ne!(app.call(&alice, catalog::Request::Resource(renew)).await.unwrap().is_error, Some(true));
        let current = claim::read_by_claim_id(&fixture.authority, &resource_ref, Authorization::Authorized, &claim_id).unwrap().unwrap();
        assert_eq!(current.principal_ref, "alice");
        assert_eq!(current.expires_at.as_deref(), Some("2099-01-01T00:00:00Z"));
    }
}
