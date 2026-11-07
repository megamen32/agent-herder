//! Authorization decisions over evidence supplied by a trusted authentication boundary.
//!
//! This module does not authenticate transports or verify credentials. In particular,
//! MCP client metadata, request fields, a node credential, and parent relationships
//! are not evidence of a caller or a session binding.
use crate::domain::address::SessionRef;
use std::{
    future::Future,
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};

/// Stable identifier assigned by the authentication authority, not by the request.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PrincipalId(pub String);

/// A claim verified by an authentication boundary outside this module.
/// Never populate this from client-provided sender or session fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPrincipal {
    pub id: PrincipalId,
}

/// The transport may be authenticated as a node without identifying its caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    Unknown,
    NodeCredential,
    Principal(VerifiedPrincipal),
}

/// Server-side evidence binding a principal to exactly one opaque session reference.
/// The issuer must verify the binding independently of request arguments and lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSelfBinding {
    pub principal: PrincipalId,
    pub session: SessionRef,
}

/// Connection-scoped evidence supplied exclusively by a trusted boundary.
/// Neither constructor arguments may be derived from request fields or metadata.
#[derive(Debug, Clone)]
pub struct ConnectionIdentity {
    caller: Caller,
    self_binding: Option<VerifiedSelfBinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    Unauthorized,
    SelfBindingRequired,
    SelfBindingMismatch,
}

impl ConnectionIdentity {
    pub fn new(caller: Caller, self_binding: Option<VerifiedSelfBinding>) -> Self {
        Self {
            caller,
            self_binding,
        }
    }

    pub fn caller(&self) -> &Caller {
        &self.caller
    }

    /// Exact target permissions do not require or imply a self binding.
    pub fn authorize(
        &self,
        grants: &[Grant],
        resource: &PrivateResource,
        action: Action,
    ) -> Result<(), IdentityError> {
        if permits(&self.caller, grants, resource, action) {
            Ok(())
        } else {
            Err(IdentityError::Unauthorized)
        }
    }

    /// A claimed self is a consistency check only, never proof of identity.
    pub fn require_self(&self, claimed: Option<&SessionRef>) -> Result<&SessionRef, IdentityError> {
        if !matches!(self.caller, Caller::Principal(_)) {
            return Err(IdentityError::Unauthorized);
        }
        let binding = self
            .self_binding
            .as_ref()
            .ok_or(IdentityError::SelfBindingRequired)?;
        resolve_self(&self.caller, binding, claimed).ok_or(IdentityError::SelfBindingMismatch)
    }
}

/// A successful response from the existing authority, over a trusted boundary.
/// This is not deserializable from an MCP request or client metadata.
#[derive(Debug, Clone)]
pub struct VerifiedOAuthGrant {
    pub subject: String,
    pub issuer: String,
    pub audience: String,
    pub scopes: Vec<String>,
    /// Unix milliseconds, matching the existing token store's clock.
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct OAuthPolicy {
    pub issuer: String,
    pub audience: String,
    pub required_scope: String,
}

/// Must consult the authoritative store, including revocation, on every call.
/// An error means the authority is unavailable; neither error nor None permits access.
pub trait OAuthAuthority: Send + Sync {
    fn verify<'a>(
        &'a self,
        bearer: &'a str,
        policy: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>>;
}

/// Call once for each HTTP MCP request, including requests on existing sessions.
/// Never cache its result as authority for a subsequent request.
pub async fn authenticate_oauth_request(
    authority: &dyn OAuthAuthority,
    bearer: &str,
    policy: &OAuthPolicy,
) -> Result<ConnectionIdentity, IdentityError> {
    if bearer.is_empty()
        || policy.issuer.is_empty()
        || policy.audience.is_empty()
        || policy.required_scope.is_empty()
    {
        return Err(IdentityError::Unauthorized);
    }
    let grant = authority
        .verify(bearer, policy)
        .await
        .map_err(|_| IdentityError::Unauthorized)?
        .ok_or(IdentityError::Unauthorized)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| IdentityError::Unauthorized)?
        .as_millis();
    if grant.subject.trim().is_empty()
        || grant.issuer != policy.issuer
        || grant.audience != policy.audience
        || !grant.scopes.contains(&policy.required_scope)
        || u128::from(grant.expires_at_ms) <= now
    {
        return Err(IdentityError::Unauthorized);
    }
    Ok(ConnectionIdentity::new(
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId(grant.subject),
        }),
        None,
    ))
}

/// Resolve self solely from trusted evidence. A claimed sender must match the
/// binding; an absent claim does not create or change a binding.
pub fn resolve_self<'a>(
    caller: &Caller,
    binding: &'a VerifiedSelfBinding,
    claimed_sender: Option<&SessionRef>,
) -> Option<&'a SessionRef> {
    let Caller::Principal(principal) = caller else {
        return None;
    };
    if principal.id != binding.principal
        || claimed_sender.is_some_and(|sender| sender != &binding.session)
    {
        return None;
    }
    Some(&binding.session)
}

/// Private resources are named exactly; no parent or prefix grants are implied.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PrivateResource {
    Session(SessionRef),
    Resource(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Read,
    Write,
    Subscribe,
}

/// A grant is trusted policy data, never an incoming request claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub principal: PrincipalId,
    pub resource: PrivateResource,
    pub action: Action,
}

/// Exact-match authorization. Absence of a grant or verified principal denies.
/// Call this again for each read, polling, subscription and proxy request.
pub fn permits(
    caller: &Caller,
    grants: &[Grant],
    resource: &PrivateResource,
    action: Action,
) -> bool {
    let Caller::Principal(principal) = caller else {
        return false;
    };
    grants.iter().any(|grant| {
        grant.principal == principal.id && grant.resource == *resource && grant.action == action
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(id: &str) -> Caller {
        Caller::Principal(VerifiedPrincipal {
            id: PrincipalId(id.into()),
        })
    }

    #[test]
    fn self_requires_verified_principal_and_exact_binding() {
        let binding = VerifiedSelfBinding {
            principal: PrincipalId("alice".into()),
            session: SessionRef("session-a".into()),
        };
        let claimed = SessionRef("session-a".into());
        let spoofed = SessionRef("session-b".into());
        assert_eq!(
            resolve_self(&principal("alice"), &binding, None),
            Some(&claimed)
        );
        assert_eq!(
            resolve_self(&principal("alice"), &binding, Some(&claimed)),
            Some(&claimed)
        );
        assert_eq!(
            resolve_self(&principal("alice"), &binding, Some(&spoofed)),
            None
        );
        assert_eq!(
            resolve_self(&principal("bob"), &binding, Some(&claimed)),
            None
        );
        assert_eq!(
            resolve_self(&Caller::NodeCredential, &binding, Some(&claimed)),
            None
        );
        assert_eq!(resolve_self(&Caller::Unknown, &binding, None), None);
    }

    #[test]
    fn private_access_requires_exact_principal_resource_and_action() {
        let session = PrivateResource::Session(SessionRef("parent".into()));
        let child = PrivateResource::Session(SessionRef("child".into()));
        let resource = PrivateResource::Resource("parent/transcript".into());
        let grant = Grant {
            principal: PrincipalId("alice".into()),
            resource: session.clone(),
            action: Action::Read,
        };
        let grants = [grant];
        assert!(permits(
            &principal("alice"),
            &grants,
            &session,
            Action::Read
        ));
        assert!(!permits(&principal("alice"), &[], &session, Action::Read));
        assert!(!permits(&principal("bob"), &grants, &session, Action::Read));
        assert!(!permits(
            &Caller::NodeCredential,
            &grants,
            &session,
            Action::Read
        ));
        assert!(!permits(&Caller::Unknown, &grants, &session, Action::Read));
        assert!(!permits(&principal("alice"), &grants, &child, Action::Read));
        assert!(!permits(
            &principal("alice"),
            &grants,
            &resource,
            Action::Read
        ));
        assert!(!permits(
            &principal("alice"),
            &grants,
            &session,
            Action::Write
        ));
        assert!(!permits(
            &principal("alice"),
            &grants,
            &session,
            Action::Subscribe
        ));
    }
}
