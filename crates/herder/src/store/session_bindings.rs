//! Read-only candidate v2 mapping. Native-create provenance and its only
//! authorized writer are a separate integration; this module cannot insert.
use crate::{
    application::target::{RegistryUnavailable, SessionRegistry},
    domain::address::{InstanceRef, NodeRef, SessionAddress, SessionRef},
    store::Writer,
};

impl SessionRegistry for Writer {
    fn resolve(&self, session: &SessionRef) -> Result<Option<SessionAddress>, RegistryUnavailable> {
        if session.0.is_empty() || session.0.len() > 4096 || session.0.chars().any(char::is_control)
        {
            return Err(RegistryUnavailable);
        }
        let (schema, writer, node, instance, native): (i32, i32, Option<String>, Option<String>, Option<String>) = self.connection().query_row(
            "SELECT (SELECT user_version FROM pragma_user_version), herder_writer_version(), b.node_ref, b.instance_id, b.native_session_id FROM (SELECT 1) LEFT JOIN session_bindings b ON b.session_ref = ?1",
            [&session.0], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
        ).map_err(|_| RegistryUnavailable)?;
        if !matches!(schema, 2 | 3) || schema != writer {
            return Err(RegistryUnavailable);
        }
        match (node, instance, native) {
            (None, None, None) => Ok(None),
            (Some(node), Some(instance), Some(native))
                if [&node, &instance, &native].iter().all(|s| {
                    !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)
                }) =>
            {
                Ok(Some(SessionAddress {
                    instance: InstanceRef {
                        node: NodeRef(node),
                        instance_id: instance,
                    },
                    native_session_id: native,
                }))
            }
            _ => Err(RegistryUnavailable),
        }
    }
}
