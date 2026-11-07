//! Read messages only after exact ACL and scoped binding verification.
use crate::{
    adapters::codex::read::{CodexReader, NativeMessageRole},
    application::scoped_stop::ScopedAuthority,
    auth::identity::{Action, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, SessionAddress, SessionRef},
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use serde_json::{Value, json};
use std::sync::Mutex;

/// Trusted composition supplies a reader for exactly the selected instance.
pub trait ScopedMessageReader: Send {
    fn read_messages(&mut self, address: &SessionAddress) -> Result<Value, ()>;
}
impl ScopedMessageReader for CodexReader {
    fn read_messages(&mut self, address: &SessionAddress) -> Result<Value, ()> {
        if self.instance_id() != address.instance.instance_id {
            return Err(());
        }
        let page = self
            .list_messages(&address.native_session_id, None, 100)
            .map_err(|_| ())?;
        let messages:Vec<_>=page.data.into_iter().map(|m|json!({"id":m.id,"turn_id":m.turn_id,"role":match m.role {NativeMessageRole::User=>"user",NativeMessageRole::Assistant=>"assistant"},"text":m.text})).collect();
        Ok(
            json!({"messages":messages,"next_cursor":page.next_cursor,"backwards_cursor":page.backwards_cursor}),
        )
    }
}
pub struct ScopedReadApplication<R> {
    authority: ScopedAuthority,
    instance: InstanceRef,
    grants: Vec<Grant>,
    reader: Mutex<R>,
}
impl<R> ScopedReadApplication<R> {
    pub fn new(
        authority: ScopedAuthority,
        instance: InstanceRef,
        grants: Vec<Grant>,
        reader: R,
    ) -> Self {
        Self {
            authority,
            instance,
            grants,
            reader: Mutex::new(reader),
        }
    }
}
impl<R: ScopedMessageReader + 'static> ApplicationPort for ScopedReadApplication<R> {
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let catalog::Request::Session(catalog::Session::Messages {
                session_ref,
                cursor,
            }) = request
            else {
                return None;
            };
            let session = SessionRef(session_ref);
            if identity
                .authorize(
                    &self.grants,
                    &PrivateResource::Session(session.clone()),
                    Action::Read,
                )
                .is_err()
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unauthorized","effect":"none"}),
                ));
            }
            if cursor.is_some() {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unsupported_cursor","effect":"none"}),
                ));
            }
            let (address, _) = match self.authority.resolve_session_read(
                identity,
                &self.grants,
                &session,
                &self.instance,
            ) {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"scope_unavailable","effect":"none"}),
                    ));
                }
            };
            let result = self
                .reader
                .lock()
                .map_err(|_| ())
                .and_then(|mut r| r.read_messages(&address));
            match result {
                Ok(page) => Some(CallToolResult::structured(
                    json!({"session_ref":session.0,"page":page}),
                )),
                Err(_) => Some(CallToolResult::structured_error(
                    json!({"code":"source_unavailable","effect":"none"}),
                )),
            }
        })
    }
}
