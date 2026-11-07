//! Authorized application reads over the canonical durable resource registry.
//!
//! This layer deliberately owns no cache or secondary store. MCP and other
//! consumers pass the same authority and receive the same descriptor revision.
use crate::auth::identity::{Action, ConnectionIdentity, Grant, PrivateResource};
use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceDescriptor, ResourceRef};
use crate::ownership::{manifest::StorageAuthority, resource as registry};
use std::io;

#[derive(Debug)]
pub enum ResourceReadError {
    Unauthorized,
    Registry(io::Error),
}

/// Read one descriptor only when this authenticated connection has an exact
/// read grant for its stable resource reference.
pub fn get(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
) -> Result<ResourceDescriptor, ResourceReadError> {
    if !identity
        .authorize(
            grants,
            &PrivateResource::Resource(resource_ref.0.clone()),
            Action::Read,
        )
        .is_ok()
    {
        return Err(ResourceReadError::Unauthorized);
    }
    registry::get(authority, resource_ref, Authorization::Authorized)
        .map_err(ResourceReadError::Registry)
}

/// Return only descriptors for which the caller has an exact read grant.
/// Enumeration uses the same durable registry; scope and attachment never
/// imply authorization. No result is derived from an independent cache.
pub fn list(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    authority: &StorageAuthority,
) -> Result<Vec<ResourceDescriptor>, ResourceReadError> {
    let crate::auth::identity::Caller::Principal(principal) = identity.caller() else {
        return Err(ResourceReadError::Unauthorized);
    };
    let mut permitted_refs: Vec<ResourceRef> = grants
        .iter()
        .filter(|grant| grant.principal == principal.id && grant.action == Action::Read)
        .filter_map(|grant| match &grant.resource {
            PrivateResource::Resource(resource_ref) => Some(ResourceRef(resource_ref.clone())),
            PrivateResource::Session(_) => None,
        })
        .collect();
    permitted_refs.sort_by(|left, right| left.0.cmp(&right.0));
    permitted_refs.dedup();
    if permitted_refs.is_empty() {
        return Err(ResourceReadError::Unauthorized);
    }
    // Read only explicitly granted identities. This keeps a malformed or
    // inaccessible unrelated marker from blocking authorized resources, while
    // preserving errors for every granted reference (including missing ones).
    permitted_refs
        .iter()
        .map(|resource_ref| {
            registry::get(authority, resource_ref, Authorization::Authorized)
                .map_err(ResourceReadError::Registry)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::identity::{Caller, PrincipalId, VerifiedPrincipal};
    use crate::domain::address::{Availability, NodeRef};
    use crate::domain::resource::{Attachment, ResourceClaim, ResourceKind, ResourceScope};
    use crate::ownership::{
        claim,
        manifest::{AuthorityRoute, StorageId, StorageMarker},
    };
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture() -> (
        std::path::PathBuf,
        StorageAuthority,
        ResourceRef,
        ResourceRef,
    ) {
        let root = std::env::temp_dir().join(format!(
            "herder-application-resources-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let authority = StorageAuthority {
            storage_id: StorageId("resource-app-test".into()),
            authority_node: NodeRef("local-test-node".into()),
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
        let first = ResourceRef("device-a".into());
        let second = ResourceRef("device-b".into());
        for resource_ref in [&first, &second] {
            registry::register_or_update(
                &authority,
                ResourceDescriptor::new(
                    resource_ref.clone(),
                    ResourceScope::Global,
                    ResourceKind::Device,
                    format!("external:{}", resource_ref.0),
                    authority.storage_id.0.clone(),
                    None,
                    0,
                ),
                Authorization::Authorized,
                None,
            )
            .unwrap();
        }
        (root, authority, first, second)
    }

    fn identity(id: &str) -> ConnectionIdentity {
        ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal {
                id: PrincipalId(id.into()),
            }),
            None,
        )
    }

    fn grant(principal: &str, resource: &ResourceRef) -> Grant {
        Grant {
            principal: PrincipalId(principal.into()),
            resource: PrivateResource::Resource(resource.0.clone()),
            action: Action::Read,
        }
    }

    #[test]
    fn list_get_enforce_exact_grants_and_reads_preserve_claim_across_reconnect() {
        let (root, authority, first, second) = fixture();
        let grants = [grant("alice", &first)];
        let first_identity = identity("alice");
        assert_eq!(list(&first_identity, &grants, &authority).unwrap().len(), 1);
        assert!(matches!(
            get(&first_identity, &grants, &authority, &second),
            Err(ResourceReadError::Unauthorized)
        ));
        assert!(matches!(
            list(&identity("bob"), &grants, &authority),
            Err(ResourceReadError::Unauthorized)
        ));

        claim::claim(
            &authority,
            &first,
            Authorization::Authorized,
            ResourceClaim {
                resource_ref: first.clone(),
                principal_ref: "alice".into(),
                session_ref: None,
                claim_id: "123e4567-e89b-42d3-a456-426614174000".into(),
                purpose: "test".into(),
                acquired_at: "before-read".into(),
                expires_at: None,
            },
        )
        .unwrap();
        let before = authority
            .read_owner_bytes(&first, Authorization::Authorized)
            .unwrap()
            .unwrap();
        assert_eq!(
            get(&first_identity, &grants, &authority, &first)
                .unwrap()
                .revision,
            1
        );

        // A new connection identity for the same principal sees the same durable
        // descriptor and owner record; reading never claims or releases anything.
        let reconnected = identity("alice");
        assert_eq!(list(&reconnected, &grants, &authority).unwrap().len(), 1);
        assert_eq!(
            authority
                .read_owner_bytes(&first, Authorization::Authorized)
                .unwrap()
                .unwrap(),
            before
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_ignores_corrupt_markers_outside_the_callers_grants() {
        let (root, authority, first, second) = fixture();
        fs::write(
            authority
                .root
                .join("resources")
                .join(&second.0)
                .join("resource.json"),
            b"{ corrupt unauthorized marker",
        )
        .unwrap();

        let allowed = list(&identity("alice"), &[grant("alice", &first)], &authority);
        assert_eq!(allowed.unwrap()[0].resource_ref(), &first);
        fs::remove_dir_all(authority.root.join("resources").join(&first.0)).unwrap();
        assert!(matches!(
            list(&identity("alice"), &[grant("alice", &first)], &authority),
            Err(ResourceReadError::Registry(error)) if error.kind() == std::io::ErrorKind::NotFound
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_availability_changes_preserve_identity_visibility_and_owner() {
        let (root, authority, resource_ref, _) = fixture();
        let grants = [grant("alice", &resource_ref)];
        let identity = identity("alice");
        claim::claim(
            &authority,
            &resource_ref,
            Authorization::Authorized,
            ResourceClaim {
                resource_ref: resource_ref.clone(),
                principal_ref: "alice".into(),
                session_ref: None,
                claim_id: "123e4567-e89b-42d3-a456-426614174001".into(),
                purpose: "availability independent from ownership".into(),
                acquired_at: "before-disconnect".into(),
                expires_at: None,
            },
        )
        .unwrap();
        let owner_before = authority
            .read_owner_bytes(&resource_ref, Authorization::Authorized)
            .unwrap()
            .unwrap();

        let mut descriptor =
            registry::get(&authority, &resource_ref, Authorization::Authorized).unwrap();
        assert_eq!(descriptor.revision, 1);
        assert_eq!(
            get(&identity, &grants, &authority, &resource_ref)
                .unwrap()
                .resource_ref(),
            &resource_ref
        );
        descriptor.attachment = Some(Attachment {
            node_ref: NodeRef("device-node-a".into()),
            route_ref: Some("transport-route".into()),
            availability: Availability::Available,
            observed_at: "observation-available-before-disconnect".into(),
        });
        descriptor = registry::register_or_update(
            &authority,
            descriptor,
            Authorization::Authorized,
            Some(1),
        )
        .unwrap();
        assert_eq!(descriptor.revision, 2);
        assert!(
            list(&identity, &grants, &authority)
                .unwrap()
                .iter()
                .any(|item| item.resource_ref() == &resource_ref)
        );
        assert_eq!(
            get(&identity, &grants, &authority, &resource_ref)
                .unwrap()
                .attachment
                .as_ref()
                .unwrap()
                .availability,
            Availability::Available
        );
        assert_eq!(
            authority
                .read_owner_bytes(&resource_ref, Authorization::Authorized)
                .unwrap()
                .unwrap(),
            owner_before
        );
        for (revision, node, availability) in [
            (2, "device-node-b", Availability::Unavailable),
            (3, "device-node-c", Availability::Available),
        ] {
            descriptor.attachment = Some(Attachment {
                node_ref: NodeRef(node.into()),
                route_ref: Some("transport-route".into()),
                availability,
                observed_at: format!("observation-{revision}"),
            });
            descriptor = registry::register_or_update(
                &authority,
                descriptor,
                Authorization::Authorized,
                Some(revision),
            )
            .unwrap();
            assert_eq!(descriptor.revision, revision + 1);
            assert!(
                list(&identity, &grants, &authority)
                    .unwrap()
                    .iter()
                    .any(|item| item.resource_ref() == &resource_ref)
            );
            let read = get(&identity, &grants, &authority, &resource_ref).unwrap();
            assert_eq!(read.resource_ref(), &resource_ref);
            assert_eq!(read.external_ref, descriptor.external_ref);
            assert_eq!(read.attachment, descriptor.attachment);
            assert_eq!(
                authority
                    .read_owner_bytes(&resource_ref, Authorization::Authorized)
                    .unwrap()
                    .unwrap(),
                owner_before
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
