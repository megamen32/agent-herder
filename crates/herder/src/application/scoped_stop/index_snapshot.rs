//! Derived search data uses the same fenced authority as session resolution.
use super::*;
use crate::{application::target::SessionRegistry, domain::address::InstanceRef, search::index};

impl ScopedAuthority {
    /// Index an observed transcript only for an exactly bound, readable session.
    /// A v3 store must be explicitly migrated by its provisioner, never by a read.
    pub fn index_transcript_snapshot(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &InstanceRef,
        snapshot_id: &str,
        content: &str,
        truncated: bool,
    ) -> Result<index::IndexOutcome, GateError> {
        identity.authorize(grants, &PrivateResource::Session(session.clone()), Action::Read)
            .map_err(|_| GateError::Invalid)?;
        let (_gate, mut writer) = self.lock()?;
        let address = writer.resolve(session).map_err(|_| GateError::Unavailable)?
            .ok_or(GateError::Invalid)?;
        if &address.instance != instance || snapshot_id.is_empty() {
            return Err(GateError::Invalid);
        }
        let valid: bool = writer.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM humanstop_sessions WHERE session_ref=?1 AND authority_generation=?2)",
            params![session.0, self.generation], |r| r.get(0))
            .map_err(|_| GateError::Store)?;
        let version: i64 = writer.connection().pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| GateError::Store)?;
        if !valid || version != 4 { return Err(GateError::Invalid); }
        index::update_session(writer.connection_mut(), &address, snapshot_id, content, truncated)
            .map_err(|_| GateError::Store)
    }
}
