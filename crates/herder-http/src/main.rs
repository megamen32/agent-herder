//! Bounded, fail-closed launcher until an authenticated authority seam exists.
use herder::{
    auth::identity::{ConnectionIdentity, OAuthAuthority, OAuthPolicy, VerifiedOAuthGrant},
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use std::{future::Future, net::SocketAddr, pin::Pin, sync::Arc};
struct Unavailable;
impl OAuthAuthority for Unavailable {
    fn verify<'a>(
        &'a self,
        _: &'a str,
        _: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>> {
        Box::pin(async { Err(()) })
    }
}
struct Unconnected;
impl ApplicationPort for Unconnected {
    fn call<'a>(&'a self, _: &'a ConnectionIdentity, _: catalog::Request) -> ApplicationFuture<'a> {
        Box::pin(async { None })
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let address: SocketAddr = match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(addr), None) if flag == "--listen" => addr.parse()?,
        _ => return Err("usage: herder-http --listen 127.0.0.1:PORT".into()),
    };
    if !address.ip().is_loopback() {
        return Err("only loopback is allowed without a configured authority".into());
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!(
        "herder-http: listening on {}; authority and application unavailable; all requests denied",
        listener.local_addr()?
    );
    let router = herder_http::router(
        Arc::new(Unavailable),
        OAuthPolicy {
            issuer: "unavailable".into(),
            audience: "unavailable".into(),
            required_scope: "unavailable".into(),
        },
        Arc::new(Unconnected),
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
