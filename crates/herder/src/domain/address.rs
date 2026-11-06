//! Scoped identities and independent capability observations.
use serde::{Deserialize, Serialize};

/// A configured node's stable identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeRef(pub String);

/// Instance identifiers are scoped to a node, not globally unique.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstanceRef {
    pub node: NodeRef,
    pub instance_id: String,
}

/// The complete native identity of a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAddress {
    pub instance: InstanceRef,
    pub native_session_id: String,
}

/// An opaque reference issued by Herder; consumers must not parse its contents.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionRef(pub String);

/// Versions describe the adapter and its capability contract independently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityVersion {
    pub adapter_version: String,
    pub capability_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authorization {
    Authorized,
    Denied,
    Unknown,
}

/// One capability as observed for a specific caller and instance.
/// An unavailable instance does not change the adapter's declared support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub name: String,
    pub version: CapabilityVersion,
    pub supported: Support,
    pub available: Availability,
    pub authorized: Authorization,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn address(node: &str, instance: &str, native: &str) -> SessionAddress {
        SessionAddress {
            instance: InstanceRef {
                node: NodeRef(node.into()),
                instance_id: instance.into(),
            },
            native_session_id: native.into(),
        }
    }

    #[test]
    fn identity_includes_node_and_instance_even_for_equal_native_ids() {
        let a = address("node-a", "profile-1", "native-1");
        let other_instance = address("node-a", "profile-2", "native-1");
        let other_node = address("node-b", "profile-1", "native-1");
        assert_ne!(a, other_instance);
        assert_ne!(a, other_node);
        assert_eq!(
            HashSet::from([a.clone(), other_instance, other_node]).len(),
            3
        );
        let encoded = serde_json::to_string(&a).unwrap();
        assert_eq!(serde_json::from_str::<SessionAddress>(&encoded).unwrap(), a);
    }

    #[test]
    fn offline_does_not_remove_support_or_grant_authorization() {
        let mut capability = Capability {
            name: "deliver.current".into(),
            version: CapabilityVersion {
                adapter_version: "2.1".into(),
                capability_version: "1".into(),
            },
            supported: Support::Supported,
            available: Availability::Available,
            authorized: Authorization::Denied,
        };
        capability.available = Availability::Unavailable;
        let decoded: Capability =
            serde_json::from_str(&serde_json::to_string(&capability).unwrap()).unwrap();
        assert_eq!(decoded.supported, Support::Supported);
        assert_eq!(decoded.available, Availability::Unavailable);
        assert_eq!(decoded.authorized, Authorization::Denied);
        assert_eq!(decoded.version.capability_version, "1");
        assert_eq!(decoded.version.adapter_version, "2.1");
    }

    #[test]
    fn unknown_is_not_conflated_with_unsupported_or_denied() {
        assert_ne!(Support::Unknown, Support::Unsupported);
        assert_ne!(Availability::Unknown, Availability::Unavailable);
        assert_ne!(Authorization::Unknown, Authorization::Denied);
    }
}
