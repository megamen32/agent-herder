//! Bounded client for a channel already authenticated by its embedding owner.
//! This module does not authenticate a Unix socket path, fd number, UID, or peer.
use herder::auth::identity::{OAuthAuthority, OAuthPolicy, VerifiedOAuthGrant};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::Mutex,
    time::timeout,
};

const MAX_FRAME: usize = 16 * 1024;
const MAX_BEARER: usize = 4096;

/// A single ordered channel. The caller MUST establish and authenticate its
/// authority and exclusive ownership out-of-band; no untrusted input is proof.
/// On timeout, cancellation, EOF or malformed data the channel is permanently
/// quarantined. A trusted owner must establish a new channel to recover.
pub struct AuthorityChannel {
    stream: Mutex<Option<UnixStream>>,
    timeout: Duration,
}

impl AuthorityChannel {
    pub fn from_authenticated_stream(
        stream: UnixStream,
        timeout: Duration,
    ) -> Result<Self, &'static str> {
        if timeout.is_zero() || timeout > Duration::from_secs(3) {
            return Err("invalid authority timeout");
        }
        Ok(Self {
            stream: Mutex::new(Some(stream)),
            timeout,
        })
    }

    async fn exchange(
        &self,
        bearer: &str,
        policy: &OAuthPolicy,
    ) -> Result<Option<VerifiedOAuthGrant>, ()> {
        if bearer.is_empty() || bearer.len() > MAX_BEARER {
            return Err(());
        }
        let request=serde_json::to_vec(&json!({"version":1,"bearer":bearer,"issuer":policy.issuer,"audience":policy.audience,"required_scope":policy.required_scope})).map_err(|_|())?;
        if request.len() > MAX_FRAME {
            return Err(());
        }
        timeout(self.timeout, async {
            let mut guard = self.stream.lock().await;
            // Ownership moves out of the mutex. Dropping this future closes the
            // in-flight stream and prevents any late reply reaching another call.
            let mut stream = guard.take().ok_or(())?;
            stream
                .write_u32(request.len() as u32)
                .await
                .map_err(|_| ())?;
            stream.write_all(&request).await.map_err(|_| ())?;
            stream.flush().await.map_err(|_| ())?;
            let size = stream.read_u32().await.map_err(|_| ())? as usize;
            if size == 0 || size > MAX_FRAME {
                return Err(());
            }
            let mut bytes = vec![0; size];
            stream.read_exact(&mut bytes).await.map_err(|_| ())?;
            let result = parse_response(&bytes)?;
            *guard = Some(stream);
            Ok(result)
        })
        .await
        .map_err(|_| ())?
    }
}

fn parse_response(bytes: &[u8]) -> Result<Option<VerifiedOAuthGrant>, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let obj = value.as_object().ok_or(())?;
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(());
    }
    match obj.get("status").and_then(Value::as_str) {
        Some("denied") if obj.len() == 2 => Ok(None),
        Some("verified") if obj.len() == 7 => {
            let text = |key: &str| {
                obj.get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or(())
            };
            let scopes = obj
                .get("scopes")
                .and_then(Value::as_array)
                .ok_or(())?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(VerifiedOAuthGrant {
                subject: text("subject")?,
                issuer: text("issuer")?,
                audience: text("audience")?,
                scopes,
                expires_at_ms: obj.get("expires_at_ms").and_then(Value::as_u64).ok_or(())?,
            }))
        }
        _ => Err(()),
    }
}

impl OAuthAuthority for AuthorityChannel {
    fn verify<'a>(
        &'a self,
        bearer: &'a str,
        policy: &'a OAuthPolicy,
    ) -> Pin<Box<dyn Future<Output = Result<Option<VerifiedOAuthGrant>, ()>> + Send + 'a>> {
        Box::pin(self.exchange(bearer, policy))
    }
}
