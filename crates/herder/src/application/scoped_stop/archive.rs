//! Archive through the existing native adapter; durable keys share the authority store.
use super::{ScopedAuthority, GateError, scope_identity_valid, scope_held};
use crate::{application::reconcile::ReceiptBinding, auth::identity::{Caller, ConnectionIdentity, Grant}, domain::address::{InstanceRef, SessionRef}, store::intents::{NewIntent, PrepareResult}};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

impl ScopedAuthority {
    /// Native callback is bounded and must never retry. The authority gate covers
    /// identity/STOP validation, dispatch and receipt persistence, as for send.
    pub fn archive_session(
        &self, identity: &ConnectionIdentity, grants: &[Grant], session: &SessionRef,
        instance: &InstanceRef, request_key: &str,
        native: impl FnOnce(&str) -> Result<Value, ()>,
    ) -> Result<Value, GateError> {
        if request_key.is_empty() || request_key.len() > 4096 || request_key.chars().any(char::is_control) {
            return Ok(json!({"code":"invalid_request","effect":"none"}));
        }
        let Caller::Principal(principal) = identity.caller() else { return Err(GateError::Invalid) };
        let (address, generation) = self.resolve_session(identity, grants, session, instance)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| GateError::Unavailable)?.as_millis().to_string();
        let digest = |v: Value| Sha256::digest(v.to_string().as_bytes()).iter().map(|b|format!("{b:02x}")).collect::<String>();
        let intent = format!("archive:{}", digest(json!([principal.id.0,session.0,request_key])));
        let task = format!("task:{intent}");
        let payload = format!("archive-v1:{}", digest(json!([address, self.generation])));
        let binding = ReceiptBinding { intent_id:&intent, principal:&principal.id.0, target_ref:&session.0, request_key, address:&address };
        let (_gate, mut writer) = self.lock_wait()?;
        if !scope_identity_valid(writer.connection(), &binding, &generation, &self.generation)? { return Err(GateError::Invalid); }
        // Replay returns its retained result, including UNKNOWN; no second RPC.
        let previous: Option<(String,Option<String>)> = writer.connection().query_row(
            "SELECT i.payload_hash,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.principal=?1 AND i.target=?2 AND i.request_key=?3",
            params![principal.id.0,session.0,request_key], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|GateError::Store)?;
        if let Some((hash,result)) = previous {
            if hash != payload { return Ok(json!({"code":"request_key_conflict","effect":"none"})); }
            return Ok(result.and_then(|r|serde_json::from_str(&r).ok()).unwrap_or_else(||json!({"session_ref":session.0,"code":"archive_outcome_unknown","effect":"unknown"})));
        }
        if scope_held(writer.connection(), &binding)? {
            return Ok(json!({"code":"human_stop","effect":"none"}));
        }
        let prepared = writer.prepare_intent(&NewIntent { intent_id:&intent,task_id:&task,principal:&principal.id.0,target:&session.0,request_key,payload_hash:&payload,now:&now,retain_until:"9999-12-31T23:59:59Z" }).map_err(|_|GateError::Store)?;
        if !matches!(prepared,PrepareResult::Created{..}) || !writer.claim_dispatch(&intent,&now).map_err(|_|GateError::Store)? { return Err(GateError::Unavailable); }
        let receipt = native(&address.native_session_id);
        let confirmed = receipt.as_ref().is_ok_and(|r| r.get("ok")==Some(&Value::Bool(true)) && r.get("sessionId").and_then(Value::as_str)==Some(address.native_session_id.as_str()));
        let result = if confirmed { json!({"session_ref":session.0,"archived":true,"effect":"confirmed"}) }
            else { json!({"session_ref":session.0,"archived":false,"code":"archive_outcome_unknown","effect":"unknown"}) };
        let tx = writer.connection_mut().transaction().map_err(|_|GateError::Store)?;
        tx.execute("UPDATE intents SET state=?2,updated_at=?3 WHERE intent_id=?1",params![intent,if confirmed {"confirmed"}else{"unknown"},now]).map_err(|_|GateError::Store)?;
        tx.execute("UPDATE tasks SET status='completed',result_json=?2,updated_at=?3 WHERE task_id=?1",params![task,result.to_string(),now]).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_|GateError::Store)?;
        Ok(result)
    }
}
