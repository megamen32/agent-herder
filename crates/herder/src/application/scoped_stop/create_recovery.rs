//! Read the existing create outcome without reissuing native create.
use super::{GateError, ScopedAuthority};
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::address::{InstanceRef, SessionAddress, SessionRef},
};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveredCreate {
    Missing,
    Conflict,
    Pending,
    Unknown,
    DefinitelyNotSent {
        task_id: String,
        diagnostic: Option<String>,
    },
    Created {
        task_id: String,
        session: SessionRef,
        address: SessionAddress,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    request_key: String,
    instance: InstanceRef,
    native_session_id: String,
    session_ref: String,
    parent_ref: Option<String>,
}

impl ScopedAuthority {
    /// Exact principal, instance, request key and create payload are required.
    /// This operation performs no native action; missing or uncertain state is
    /// never evidence that retrying an earlier create is safe.
    pub fn recover_fresh_create(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        instance: &InstanceRef,
        request_key: &str,
        specification: &str,
    ) -> Result<RecoveredCreate, GateError> {
        let target = serde_json::to_string(instance).map_err(|_| GateError::Invalid)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Resource(format!("instance:{target}")),
                Action::Write,
            )
            .map_err(|_| GateError::Invalid)?;
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        if request_key.is_empty() || specification.is_empty() {
            return Err(GateError::Invalid);
        }
        let bytes =
            serde_json::to_vec(&(1u8, instance, specification)).map_err(|_| GateError::Invalid)?;
        let payload = format!(
            "create-v1:{}",
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let (_guard, writer) = self.lock()?;
        let row:Option<(String,String,String,Option<String>,Option<String>)>=writer.connection().query_row(
            "SELECT i.payload_hash,i.state,i.task_id,i.native_receipt,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.principal=?1 AND i.target=?2 AND i.request_key=?3",
            params![principal.id.0,target,request_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_|GateError::Store)?;
        let Some((stored, state, task_id, receipt, diagnostic)) = row else {
            return Ok(RecoveredCreate::Missing);
        };
        if stored != payload {
            return Ok(RecoveredCreate::Conflict);
        }
        match state.as_str() {
            "prepared" | "dispatching" => Ok(RecoveredCreate::Pending),
            "unknown" => Ok(RecoveredCreate::Unknown),
            "rejected" => {
                let valid = diagnostic
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .is_some_and(|v| {
                        v["outcome"] == "rejected" && v["native_submit"] == "definitely_not_sent"
                    });
                if valid && receipt.is_none() {
                    Ok(RecoveredCreate::DefinitelyNotSent {
                        task_id,
                        diagnostic,
                    })
                } else {
                    Ok(RecoveredCreate::Unknown)
                }
            }
            "admitted" | "confirmed" => {
                let receipt: Receipt =
                    serde_json::from_str(receipt.as_deref().ok_or(GateError::Store)?)
                        .map_err(|_| GateError::Store)?;
                if receipt.version != 1
                    || receipt.request_key != request_key
                    || receipt.instance != *instance
                    || receipt.native_session_id.is_empty()
                    || receipt.session_ref.is_empty()
                    || receipt.parent_ref.is_some()
                {
                    return Err(GateError::Store);
                }
                let valid:bool=writer.connection().query_row("SELECT EXISTS(SELECT 1 FROM session_bindings b JOIN humanstop_sessions s ON s.session_ref=b.session_ref JOIN lineage l ON l.session_ref=b.session_ref WHERE b.session_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 AND b.native_session_id=?4 AND s.authority_generation=?5 AND l.creator_ref=?6 AND l.parent_ref IS NULL AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=b.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=b.session_ref AND scope_ref='session:'||b.session_ref))",params![receipt.session_ref,instance.node.0,instance.instance_id,receipt.native_session_id,self.generation,principal.id.0],|r|r.get(0)).map_err(|_|GateError::Store)?;
                if !valid {
                    return Err(GateError::Store);
                }
                Ok(RecoveredCreate::Created {
                    task_id,
                    session: SessionRef(receipt.session_ref),
                    address: SessionAddress {
                        instance: receipt.instance,
                        native_session_id: receipt.native_session_id,
                    },
                })
            }
            _ => Err(GateError::Store),
        }
    }
}
