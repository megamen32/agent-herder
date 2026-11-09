use herder::auth::identity::{
    Action, Caller, ConnectionIdentity, Grant, IdentityError, PrincipalId, PrivateResource,
    VerifiedPrincipal, VerifiedSelfBinding,
};
use herder::domain::address::SessionRef;

fn principal(name: &str) -> Caller {
    Caller::Principal(VerifiedPrincipal {
        id: PrincipalId(name.into()),
    })
}

#[test]
fn target_grants_are_independent_of_self_but_never_of_principal() {
    let a = SessionRef("a".into());
    let b = SessionRef("b".into());
    let grants = vec![
        Grant {
            principal: PrincipalId("alice".into()),
            resource: PrivateResource::Session(a.clone()),
            action: Action::Read,
        },
        Grant {
            principal: PrincipalId("bob".into()),
            resource: PrivateResource::Session(b.clone()),
            action: Action::Read,
        },
    ];
    let alice = ConnectionIdentity::new(principal("alice"), None);
    let bob = ConnectionIdentity::new(principal("bob"), None);
    let unknown = ConnectionIdentity::new(Caller::Unknown, None);
    assert!(
        alice
            .authorize(&grants, &PrivateResource::Session(a.clone()), Action::Read)
            .is_ok()
    );
    assert_eq!(
        alice.authorize(&grants, &PrivateResource::Session(b.clone()), Action::Read),
        Err(IdentityError::Unauthorized)
    );
    assert!(
        bob.authorize(&grants, &PrivateResource::Session(b.clone()), Action::Read)
            .is_ok()
    );
    assert_eq!(
        bob.authorize(&grants, &PrivateResource::Session(a.clone()), Action::Read),
        Err(IdentityError::Unauthorized)
    );
    assert_eq!(
        unknown.authorize(&grants, &PrivateResource::Session(a.clone()), Action::Read),
        Err(IdentityError::Unauthorized)
    );
    assert_eq!(
        alice.authorize(&grants, &PrivateResource::Session(a), Action::Write),
        Err(IdentityError::Unauthorized)
    );
    assert_eq!(
        alice.require_self(None),
        Err(IdentityError::SelfBindingRequired)
    );
    let forged = ConnectionIdentity::new(
        principal("alice"),
        Some(VerifiedSelfBinding {
            principal: PrincipalId("bob".into()),
            session: b.clone(),
        }),
    );
    assert_eq!(
        forged.require_self(None),
        Err(IdentityError::SelfBindingMismatch)
    );
    let bound = ConnectionIdentity::new(
        principal("bob"),
        Some(VerifiedSelfBinding {
            principal: PrincipalId("bob".into()),
            session: b.clone(),
        }),
    );
    assert_eq!(bound.require_self(None), Ok(&b));
    assert_eq!(
        bound.require_self(Some(&SessionRef("a".into()))),
        Err(IdentityError::SelfBindingMismatch)
    );
}

#[tokio::test]
async fn wire_connections_enforce_target_acl_and_self_before_application() {
    use herder::mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort, NativeServer},
    };
    use rmcp::{ServiceExt, model::CallToolResult};
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    struct App {
        grants: Vec<Grant>,
        contexts: AtomicUsize,
    }
    impl ApplicationPort for App {
        fn call<'a>(
            &'a self,
            identity: &'a ConnectionIdentity,
            request: catalog::Request,
        ) -> ApplicationFuture<'a> {
            Box::pin(async move {
                match request {
                    catalog::Request::Session(catalog::Session::Recent { session_ref, .. }) => {
                        let resource = PrivateResource::Session(SessionRef(session_ref.clone()));
                        if identity
                            .authorize(&self.grants, &resource, Action::Read)
                            .is_err()
                        {
                            return Some(CallToolResult::structured_error(
                                json!({"code":"unauthorized","effect":"none"}),
                            ));
                        }
                        Some(CallToolResult::structured(json!({"target":session_ref})))
                    }
                    catalog::Request::Session(catalog::Session::Context { session_ref: None }) => {
                        self.contexts.fetch_add(1, Ordering::SeqCst);
                        Some(CallToolResult::structured(
                            json!({"self":identity.require_self(None).unwrap().0}),
                        ))
                    }
                    _ => None,
                }
            })
        }
    }
    async fn exchange(
        identity: ConnectionIdentity,
        app: Arc<App>,
        expected_target: &str,
        foreign_target: &str,
        expected_self: Option<&str>,
        expected_error: &str,
    ) {
        let server = NativeServer::with_connection_identity(identity, app);
        let (client, io) = tokio::io::duplex(65536);
        let task =
            tokio::spawn(async move { server.serve(io).await.unwrap().waiting().await.unwrap() });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28", "io.modelcontextprotocol/clientCapabilities":{}, "caller":"spoofed", "session_ref":foreign_target});
        for (id, args) in [
            (1, json!({"action":"recent","session_ref":expected_target})),
            (2, json!({"action":"recent","session_ref":foreign_target})),
            (3, json!({"action":"context"})),
        ] {
            let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"_meta":meta,"name":"session","arguments":args}});
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let result: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            match id {
                1 => assert_eq!(
                    result["result"]["structuredContent"]["target"],
                    expected_target
                ),
                2 => {
                    assert_eq!(
                        result["result"]["structuredContent"]["code"],
                        "unauthorized"
                    );
                    assert_eq!(result["result"]["structuredContent"]["effect"], "none");
                }
                3 => {
                    if let Some(session) = expected_self {
                        assert_eq!(result["result"]["structuredContent"]["self"], session);
                    } else {
                        assert_eq!(
                            result["result"]["structuredContent"]["code"],
                            expected_error
                        );
                        assert_eq!(result["result"]["structuredContent"]["effect"], "none");
                    }
                }
                _ => unreachable!(),
            }
        }
        drop(write);
        drop(lines);
        task.await.unwrap();
    }
    let app = Arc::new(App {
        grants: vec![
            Grant {
                principal: PrincipalId("alice".into()),
                resource: PrivateResource::Session(SessionRef("a".into())),
                action: Action::Read,
            },
            Grant {
                principal: PrincipalId("bob".into()),
                resource: PrivateResource::Session(SessionRef("b".into())),
                action: Action::Read,
            },
        ],
        contexts: AtomicUsize::new(0),
    });
    exchange(
        ConnectionIdentity::new(principal("alice"), None),
        app.clone(),
        "a",
        "b",
        None,
        "self_binding_required",
    )
    .await;
    exchange(
        ConnectionIdentity::new(
            principal("bob"),
            Some(VerifiedSelfBinding {
                principal: PrincipalId("alice".into()),
                session: SessionRef("a".into()),
            }),
        ),
        app.clone(),
        "b",
        "a",
        None,
        "self_binding_mismatch",
    )
    .await;
    exchange(
        ConnectionIdentity::new(
            principal("bob"),
            Some(VerifiedSelfBinding {
                principal: PrincipalId("bob".into()),
                session: SessionRef("b".into()),
            }),
        ),
        app.clone(),
        "b",
        "a",
        Some("b"),
        "",
    )
    .await;
    assert_eq!(app.contexts.load(Ordering::SeqCst), 1);
}
