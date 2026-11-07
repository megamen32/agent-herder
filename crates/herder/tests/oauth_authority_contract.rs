use herder::auth::identity::{
    Caller, IdentityError, OAuthAuthority, OAuthPolicy, PrincipalId, VerifiedOAuthGrant,
    authenticate_oauth_request,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

struct Authority {
    revoked: AtomicBool,
    unavailable: AtomicBool,
    calls: AtomicUsize,
    grant: Mutex<VerifiedOAuthGrant>,
}
impl OAuthAuthority for Authority {
    fn verify<'a>(
        &'a self,
        _bearer: &'a str,
        _policy: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if self.unavailable.load(Ordering::SeqCst) {
                Err(())
            } else if self.revoked.load(Ordering::SeqCst) {
                Ok(None)
            } else {
                Ok(Some(self.grant.lock().unwrap().clone()))
            }
        })
    }
}
#[tokio::test]
async fn subject_survives_verified_grant_and_old_connection_rechecks_revocation() {
    let policy = OAuthPolicy {
        issuer: "trusted".into(),
        audience: "herder".into(),
        required_scope: "owner".into(),
    };
    let grant = VerifiedOAuthGrant {
        subject: "alice".into(),
        issuer: "trusted".into(),
        audience: "herder".into(),
        scopes: vec!["owner".into()],
        expires_at_ms: u64::MAX,
    };
    let authority = Authority {
        revoked: AtomicBool::new(false),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        grant: Mutex::new(grant.clone()),
    };
    let identity = authenticate_oauth_request(&authority, "test-credential", &policy)
        .await
        .unwrap();
    assert!(matches!(identity.caller(),Caller::Principal(p) if p.id==PrincipalId("alice".into())));
    assert_eq!(
        identity.require_self(None),
        Err(IdentityError::SelfBindingRequired)
    );
    // Reuse the same credential/connection, never the prior identity.
    authority.revoked.store(true, Ordering::SeqCst);
    assert!(matches!(
        authenticate_oauth_request(&authority, "test-credential", &policy).await,
        Err(IdentityError::Unauthorized)
    ));
    assert_eq!(authority.calls.load(Ordering::SeqCst), 2);
    authority.revoked.store(false, Ordering::SeqCst);
    authority.unavailable.store(true, Ordering::SeqCst);
    assert!(matches!(
        authenticate_oauth_request(&authority, "test-credential", &policy).await,
        Err(IdentityError::Unauthorized)
    ));
    authority.unavailable.store(false, Ordering::SeqCst);
    for bad in [
        VerifiedOAuthGrant {
            subject: " ".into(),
            ..grant.clone()
        },
        VerifiedOAuthGrant {
            issuer: "other".into(),
            ..grant.clone()
        },
        VerifiedOAuthGrant {
            audience: "other".into(),
            ..grant.clone()
        },
        VerifiedOAuthGrant {
            scopes: vec![],
            ..grant.clone()
        },
        VerifiedOAuthGrant {
            expires_at_ms: 0,
            ..grant.clone()
        },
    ] {
        *authority.grant.lock().unwrap() = bad;
        assert!(matches!(
            authenticate_oauth_request(&authority, "test-credential", &policy).await,
            Err(IdentityError::Unauthorized)
        ));
    }
}
