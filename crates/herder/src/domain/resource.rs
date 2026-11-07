//! Resource identity, location and ownership are independent concepts.
//! These are data types only: authority storage and access checks belong to the
//! resource service, and a reference must never contain credentials.
use super::address::{Authorization, Availability, NodeRef, SessionRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ResourceRef(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceScope {
    Global,
    Project { project_ref: String },
    Node { node_ref: NodeRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "name",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResourceKind {
    Workspace,
    Deployment,
    Device,
    Plan,
    Other(String),
}

/// References are identifiers only, never embedded secrets or executable code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub node_ref: NodeRef,
    pub route_ref: Option<String>,
    pub availability: Availability,
    /// Timestamp supplied by the observer, not a claim expiry.
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceDescriptor {
    resource_ref: ResourceRef,
    pub scope: ResourceScope,
    pub kind: ResourceKind,
    pub external_ref: String,
    pub authority_ref: String,
    pub attachment: Option<Attachment>,
    pub revision: u64,
}

impl ResourceDescriptor {
    pub fn new(
        resource_ref: ResourceRef,
        scope: ResourceScope,
        kind: ResourceKind,
        external_ref: String,
        authority_ref: String,
        attachment: Option<Attachment>,
        revision: u64,
    ) -> Self {
        Self {
            resource_ref,
            scope,
            kind,
            external_ref,
            authority_ref,
            attachment,
            revision,
        }
    }

    pub fn resource_ref(&self) -> &ResourceRef {
        &self.resource_ref
    }
}

/// A read of the sole authoritative owner record, separate from the descriptor.
/// A claim ID is an identifier, not a credential or an authorization decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceClaim {
    pub resource_ref: ResourceRef,
    pub principal_ref: String,
    pub session_ref: Option<SessionRef>,
    pub claim_id: String,
    pub purpose: String,
    pub acquired_at: String,
    pub expires_at: Option<String>,
}

/// Scope describes discovery; only an explicit authorization permits access.
pub fn access_allowed(_scope: &ResourceScope, authorization: Authorization) -> bool {
    authorization == Authorization::Authorized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(node: &str, availability: Availability) -> Attachment {
        Attachment {
            node_ref: NodeRef(node.into()),
            route_ref: Some("device-route".into()),
            availability,
            observed_at: "2026-11-07T00:00:00Z".into(),
        }
    }
    fn phone() -> ResourceDescriptor {
        ResourceDescriptor::new(
            ResourceRef("phone-1".into()),
            ResourceScope::Global,
            ResourceKind::Device,
            "stable-device-id".into(),
            "storage-1".into(),
            Some(attachment("node-a", Availability::Available)),
            1,
        )
    }
    #[test]
    fn moving_phone_preserves_identity_and_claim_even_when_unavailable() {
        let mut phone = phone();
        let claim = ResourceClaim {
            resource_ref: phone.resource_ref().clone(),
            principal_ref: "principal".into(),
            session_ref: Some(SessionRef("session".into())),
            claim_id: "claim-1".into(),
            purpose: "device work".into(),
            acquired_at: "2026-11-07T00:00:00Z".into(),
            expires_at: None,
        };
        let before = claim.clone();
        phone.attachment = Some(attachment("node-b", Availability::Unavailable));
        phone.revision += 1;
        let roundtrip: ResourceDescriptor =
            serde_json::from_str(&serde_json::to_string(&phone).unwrap()).unwrap();
        assert_eq!(roundtrip.resource_ref(), &before.resource_ref);
        assert_eq!(roundtrip.external_ref, "stable-device-id");
        assert_eq!(claim, before);
        assert_eq!(
            roundtrip.attachment.unwrap().availability,
            Availability::Unavailable
        );
    }
    #[test]
    fn global_scope_does_not_grant_access() {
        assert!(!access_allowed(
            &ResourceScope::Global,
            Authorization::Denied
        ));
        assert!(!access_allowed(
            &ResourceScope::Global,
            Authorization::Unknown
        ));
        assert!(access_allowed(
            &ResourceScope::Global,
            Authorization::Authorized
        ));
    }
    #[test]
    fn authority_is_independent_of_attachment_and_scope() {
        let mut phone = phone();
        phone.attachment = None;
        phone.scope = ResourceScope::Node {
            node_ref: NodeRef("node-b".into()),
        };
        assert_eq!(phone.authority_ref, "storage-1");
        phone.attachment = Some(attachment("node-c", Availability::Unknown));
        assert_eq!(phone.authority_ref, "storage-1");
    }
}
