#![cfg(unix)]
use herder::auth::identity::{OAuthAuthority, OAuthPolicy};
use herder_http::authority_channel::AuthorityChannel;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
fn policy() -> OAuthPolicy {
    OAuthPolicy {
        issuer: "issuer".into(),
        audience: "audience".into(),
        required_scope: "owner".into(),
    }
}
async fn read_request(stream: &mut UnixStream) -> Value {
    let n = stream.read_u32().await.unwrap() as usize;
    let mut data = vec![0; n];
    stream.read_exact(&mut data).await.unwrap();
    serde_json::from_slice(&data).unwrap()
}
async fn reply(stream: &mut UnixStream, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    stream.write_u32(bytes.len() as u32).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
}
#[tokio::test]
async fn verified_and_denied_responses_are_ordered_and_not_cached() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let authority =
        AuthorityChannel::from_authenticated_stream(client, Duration::from_secs(1)).unwrap();
    let task = tokio::spawn(async move {
        for i in 0..2 {
            let req = read_request(&mut server).await;
            assert_eq!(req["bearer"], "opaque-test");
            assert_eq!(req["required_scope"], "owner");
            if i == 0 {
                reply(&mut server,json!({"version":1,"status":"verified","subject":"alice","issuer":"issuer","audience":"audience","scopes":["owner"],"expires_at_ms":u64::MAX})).await;
            } else {
                reply(&mut server, json!({"version":1,"status":"denied"})).await;
            }
        }
    });
    let first = authority
        .verify("opaque-test", &policy())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.subject, "alice");
    assert!(
        authority
            .verify("opaque-test", &policy())
            .await
            .unwrap()
            .is_none()
    );
    task.await.unwrap();
}
#[tokio::test]
async fn timeout_quarantines_channel_and_discards_late_reply() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let authority =
        AuthorityChannel::from_authenticated_stream(client, Duration::from_millis(70)).unwrap();
    let task = tokio::spawn(async move {
        let _ = read_request(&mut server).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let mut byte = [0];
        assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    });
    assert!(authority.verify("token", &policy()).await.is_err());
    assert!(authority.verify("token", &policy()).await.is_err());
    task.await.unwrap();
}
#[tokio::test]
async fn cancellation_closes_inflight_channel_and_prevents_reuse() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let authority = Arc::new(
        AuthorityChannel::from_authenticated_stream(client, Duration::from_secs(2)).unwrap(),
    );
    let cloned = authority.clone();
    let task = tokio::spawn(async move { cloned.verify("token", &policy()).await });
    let _ = read_request(&mut server).await;
    task.abort();
    let _ = task.await;
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).await.unwrap(), 0);
    assert!(authority.verify("token", &policy()).await.is_err());
}
#[tokio::test]
async fn malformed_or_oversized_frames_quarantine_channel() {
    for bytes in [
        b"{\"version\":1,\"status\":\"denied\",\"extra\":1}".to_vec(),
        vec![],
    ] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let authority =
            AuthorityChannel::from_authenticated_stream(client, Duration::from_secs(1)).unwrap();
        let task = tokio::spawn(async move {
            let _ = read_request(&mut server).await;
            if bytes.is_empty() {
                server.write_u32(16385).await.unwrap()
            } else {
                server.write_u32(bytes.len() as u32).await.unwrap();
                server.write_all(&bytes).await.unwrap();
            }
        });
        assert!(authority.verify("token", &policy()).await.is_err());
        assert!(authority.verify("token", &policy()).await.is_err());
        task.await.unwrap();
    }
}
