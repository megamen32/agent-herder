//! Explicit owner enrollment of an existing native ChatGPT conversation.
//! Only the protected local launcher may supply an approval; this is not an MCP
//! discovery/import operation. Enrollment records no native creation or send.
use super::{GateError, ScopedAuthority, ScopeGenerationIssuer};
use crate::{
    application::target::SessionRefIssuer,
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::address::InstanceRef,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExistingSessionApproval {
    pub request_key: String,
    pub native_session_id: String,
    pub account_scope: String,
}
fn exact_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096
        && !value.chars().any(char::is_control)
        && !value.contains(['*', '?'])
}
impl ExistingSessionApproval {
    pub fn valid(&self) -> bool {
        exact_text(&self.request_key) && exact_text(&self.native_session_id)
            && !self.native_session_id.starts_with("draft:")
            && !self.native_session_id.to_ascii_lowercase().starts_with("chatgpt::draft%3a")
            && !self.native_session_id.starts_with("chatgpt::draft:")
            && self.account_scope.len() == 64
            && self.account_scope.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentReceipt {
    pub version: u8,
    pub provenance: String,
    pub request_key: String,
    pub instance: InstanceRef,
    pub native_session_id: String,
    pub session_ref: String,
    pub account_scope: String,
    pub authority_generation: String,
    pub scope_generation: String,
}
impl EnrollmentReceipt {
    pub fn matches(&self, approval: &ExistingSessionApproval, instance: &InstanceRef, generation: &str) -> bool {
        self.version == 1 && self.provenance == "owner-explicit-existing-session"
            && approval.valid() && self.request_key == approval.request_key
            && self.native_session_id == approval.native_session_id
            && self.account_scope == approval.account_scope
            && self.instance == *instance && self.authority_generation == generation
            && exact_text(&self.session_ref) && exact_text(&self.scope_generation)
    }
}

impl ScopedAuthority {
    /// The native callback only reads the exact account-pinned adapter and must
    /// prove one canonical list ID and the same getSession ID. No native write
    /// is allowed. The protected approval and pinned gate are distinct grants.
    pub fn enroll_existing_session<I: SessionRefIssuer, G: ScopeGenerationIssuer>(
        &self, identity: &ConnectionIdentity, grants: &[Grant], instance: &InstanceRef,
        approval: &ExistingSessionApproval, issuer: &I, generations: &G,
        verify_native: impl FnOnce() -> Result<(), ()>,
    ) -> Result<EnrollmentReceipt, GateError> {
        if !approval.valid()
            || [&instance.node.0, &instance.instance_id].iter().any(|s| !exact_text(s)) {
            return Err(GateError::Invalid);
        }
        let Caller::Principal(principal) = identity.caller() else { return Err(GateError::Invalid) };
        let target = serde_json::to_string(instance).map_err(|_| GateError::Invalid)?;
        identity.authorize(grants, &PrivateResource::Resource(format!("instance:{target}")), Action::Write)
            .map_err(|_| GateError::Invalid)?;
        let (_gate, mut writer) = self.lock()?;
        let global_held: bool = writer.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL) OR EXISTS(SELECT 1 FROM holds WHERE session_ref='global' AND released_at IS NULL)",
            [], |r| r.get(0)).map_err(|_| GateError::Store)?;
        if global_held { return Err(GateError::Invalid) }
        let digest = |bytes: Vec<u8>| Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let payload = format!("owner-enroll-v1:{}", digest(
            serde_json::to_vec(&(1u8, &principal.id.0, instance, approval, &self.generation)).map_err(|_| GateError::Invalid)?));
        let previous: Option<(String, String, Option<String>)> = writer.connection().query_row(
            "SELECT payload_hash,state,native_receipt FROM intents WHERE principal=?1 AND target=?2 AND request_key=?3",
            params![principal.id.0,target,approval.request_key],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_| GateError::Store)?;
        if let Some((hash, state, raw)) = previous {
            if hash != payload || state != "confirmed" { return Err(GateError::Invalid) }
            let receipt: EnrollmentReceipt = serde_json::from_str(raw.as_deref().ok_or(GateError::Invalid)?)
                .map_err(|_| GateError::Invalid)?;
            if !receipt.matches(approval, instance, &self.generation)
                || !exact_enrollment_binding(writer.connection(), &principal.id.0, &receipt)?
                || enrollment_held_or_unsettled(writer.connection(), &receipt.session_ref)? {
                return Err(GateError::Invalid);
            }
            verify_native().map_err(|_| GateError::Unavailable)?;
            return Ok(receipt);
        }
        // Never allocate a fresh alias around an existing stop/unknown outcome.
        let already_bound: bool = writer.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM session_bindings WHERE node_ref=?1 AND instance_id=?2 AND native_session_id=?3)",
            params![instance.node.0,instance.instance_id,approval.native_session_id], |r| r.get(0)).map_err(|_| GateError::Store)?;
        if already_bound { return Err(GateError::Invalid) }
        verify_native().map_err(|_| GateError::Unavailable)?;
        let session = issuer.issue().map_err(|_| GateError::Unavailable)?;
        let generation = generations.issue().map_err(|_| GateError::Unavailable)?;
        if !exact_text(&session.0) || !exact_text(&generation)
            || enrollment_held_or_unsettled(writer.connection(), &session.0)? { return Err(GateError::Invalid) }
        let receipt = EnrollmentReceipt {
            version: 1, provenance: "owner-explicit-existing-session".into(),
            request_key: approval.request_key.clone(), instance: instance.clone(),
            native_session_id: approval.native_session_id.clone(), session_ref: session.0.clone(),
            account_scope: approval.account_scope.clone(), authority_generation: self.generation.clone(),
            scope_generation: generation.clone(),
        };
        let intent = format!("owner-enroll:{}", digest(serde_json::to_vec(&(&principal.id.0, instance, &approval.request_key))
            .map_err(|_| GateError::Invalid)?));
        let task = format!("task:{intent}");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| GateError::Unavailable)?.as_millis().to_string();
        // No native mutation precedes this transaction. A failed transaction can
        // be retried; an existing tuple is checked above and is never replayed.
        let tx = writer.connection_mut().transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        tx.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at,expires_at,result_json) VALUES(?1,?2,'completed',?3,?3,NULL,?4)",
            params![task,principal.id.0,now,serde_json::to_string(&receipt).map_err(|_|GateError::Invalid)?]).map_err(|_|GateError::Store)?;
        tx.execute("INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,native_receipt,created_at,updated_at,retain_until) VALUES(?1,?2,?3,?4,?5,?6,'confirmed',?7,?8,?8,'9999-12-31T23:59:59Z')",
            params![intent,task,principal.id.0,target,approval.request_key,payload,serde_json::to_string(&receipt).map_err(|_|GateError::Invalid)?,now]).map_err(|_|GateError::Store)?;
        tx.execute("INSERT INTO session_bindings(session_ref,node_ref,instance_id,native_session_id) VALUES(?1,?2,?3,?4)",
            params![session.0,instance.node.0,instance.instance_id,approval.native_session_id]).map_err(|_|GateError::Store)?;
        // creator_ref is the Herder enrollment owner, not a claim about who
        // created the native conversation. sender_ref marks that provenance.
        tx.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,sender_ref,created_at) VALUES(?1,?2,NULL,'owner-explicit-existing-session',?3)",
            params![session.0,principal.id.0,now]).map_err(|_|GateError::Store)?;
        tx.execute("INSERT INTO humanstop_scopes(session_ref,scope_ref) VALUES(?1,'global'),(?1,?2)",
            params![session.0,format!("session:{}",session.0)]).map_err(|_|GateError::Store)?;
        tx.execute("INSERT INTO humanstop_sessions(session_ref,authority_generation,scope_generation,created_at) VALUES(?1,?2,?3,?4)",
            params![session.0,self.generation,generation,now]).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_|GateError::Store)?;
        Ok(receipt)
    }
}
fn exact_enrollment_binding(db: &rusqlite::Connection, principal: &str, receipt: &EnrollmentReceipt) -> Result<bool, GateError> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM session_bindings b JOIN humanstop_sessions h ON h.session_ref=b.session_ref JOIN lineage l ON l.session_ref=b.session_ref WHERE b.session_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 AND b.native_session_id=?4 AND h.authority_generation=?5 AND h.scope_generation=?6 AND l.creator_ref=?7 AND l.parent_ref IS NULL AND l.sender_ref='owner-explicit-existing-session' AND EXISTS(SELECT 1 FROM humanstop_scopes s WHERE s.session_ref=b.session_ref AND s.scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes s WHERE s.session_ref=b.session_ref AND s.scope_ref='session:'||b.session_ref))",
        params![receipt.session_ref,receipt.instance.node.0,receipt.instance.instance_id,receipt.native_session_id,receipt.authority_generation,receipt.scope_generation,principal], |r|r.get(0)).map_err(|_|GateError::Store)
}
fn enrollment_held_or_unsettled(db: &rusqlite::Connection, session: &str) -> Result<bool, GateError> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE released_at IS NULL AND (scope_ref IN ('global',?1) OR scope_ref IN (SELECT scope_ref FROM humanstop_scopes WHERE session_ref=?2))) OR EXISTS(SELECT 1 FROM holds WHERE released_at IS NULL AND session_ref IN ('global',?1,?2)) OR EXISTS(SELECT 1 FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id WHERE i.target=?2 AND (i.state IN ('prepared','dispatching','unknown') OR d.phase IN ('claimed','handing_off')))",
        params![format!("session:{session}"),session], |r| r.get(0)).map_err(|_|GateError::Store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{application::target::{RegistryUnavailable, SessionRefIssuer}, application::target_gate::acquire_pinned,
        auth::identity::{PrincipalId,VerifiedPrincipal},domain::address::{NodeRef,SessionRef},store::{Writer,intents::NewIntent}};
    use rusqlite::{Connection,functions::FunctionFlags};
    use std::{cell::Cell,fs::{self,OpenOptions},os::unix::fs::{MetadataExt,OpenOptionsExt,PermissionsExt},path::PathBuf};
    struct Fixture { root:PathBuf, db:PathBuf, gate:PathBuf }
    impl Drop for Fixture { fn drop(&mut self) { let _=fs::remove_dir_all(&self.root); } }
    impl Fixture {
        fn new() -> Self {
            let root=std::env::temp_dir().join(format!("herder-owner-enrollment-{}-{}",std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&root).unwrap();fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
            let db=root.join("state.db");let gate=root.join("gate");
            drop(Writer::create_file(&db).unwrap());
            let mut c=Connection::open(&db).unwrap();
            c.create_scalar_function("herder_writer_version",0,FunctionFlags::SQLITE_UTF8|FunctionFlags::SQLITE_DETERMINISTIC,|_|Ok(1)).unwrap();
            let tx=c.transaction().unwrap();tx.execute_batch(include_str!("../../store/migration_v1_v2.sql")).unwrap();tx.commit().unwrap();
            let tx=c.transaction().unwrap();tx.execute_batch(include_str!("../../store/migration_v2_v3.sql")).unwrap();tx.commit().unwrap();drop(c);
            let file=OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&gate).unwrap();
            let m=file.metadata().unwrap();let guard=acquire_pinned(&gate,m.dev(),m.ino()).unwrap();
            assert!(Writer::open_file(&db).unwrap().initialize_fresh_stop_authority(&guard,"authority","now").unwrap());
            drop(guard);drop(file);Self {root,db,gate}
        }
        fn authority(&self)->ScopedAuthority {ScopedAuthority::new(self.db.clone(),self.gate.clone(),"authority".into()).unwrap()}
        fn counts(&self)->(i64,i64,i64) {Connection::open(&self.db).unwrap().query_row("SELECT (SELECT count(*) FROM tasks),(SELECT count(*) FROM intents),(SELECT count(*) FROM session_bindings)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()}
        fn hold(&self, scope:&str) {Writer::open_file(&self.db).unwrap().connection().execute("INSERT INTO humanstop_holds(scope_ref,reason,created_at,released_at) VALUES(?1,'owner STOP','now',NULL)",[scope]).unwrap();}
    }
    struct Id;
    impl SessionRefIssuer for Id {fn issue(&self)->Result<SessionRef,RegistryUnavailable>{Ok(SessionRef("session:approved".into()))}}
    impl ScopeGenerationIssuer for Id {fn issue(&self)->Result<String,()>{Ok("scope-approved".into())}}
    fn instance()->InstanceRef{InstanceRef{node:NodeRef("node".into()),instance_id:"profile-1".into()}}
    fn approval()->ExistingSessionApproval{ExistingSessionApproval{request_key:"owner-key".into(),native_session_id:"dot~conversation".into(),account_scope:"b".repeat(64)}}
    fn identity()->ConnectionIdentity{ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal{id:PrincipalId("owner".into())}),None)}
    fn grants()->Vec<Grant>{vec![Grant{principal:PrincipalId("owner".into()),resource:PrivateResource::Resource(format!("instance:{}",serde_json::to_string(&instance()).unwrap())),action:Action::Write}]}
    fn enroll(f:&Fixture)->Result<EnrollmentReceipt,GateError>{f.authority().enroll_existing_session(&identity(),&grants(),&instance(),&approval(),&Id,&Id,||Ok(()))}
    #[test]
    fn explicit_enrollment_is_atomic_idempotent_and_separate_from_creation() {
        let f=Fixture::new();let checks=Cell::new(0);
        let run=||f.authority().enroll_existing_session(&identity(),&grants(),&instance(),&approval(),&Id,&Id,||{checks.set(checks.get()+1);Ok(())});
        let receipt=run().unwrap();assert_eq!(receipt,run().unwrap());assert_eq!(checks.get(),2);assert_eq!(f.counts(),(1,1,1));
        assert!(receipt.matches(&approval(),&instance(),"authority"));
        let c=Connection::open(&f.db).unwrap();
        let row:(String,String,i64)=c.query_row("SELECT payload_hash,state,(SELECT count(*) FROM humanstop_scopes) FROM intents",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert!(row.0.starts_with("owner-enroll-v1:"));assert_eq!(row.1,"confirmed");assert_eq!(row.2,2);
    }
    #[test]
    fn permission_native_failure_and_old_generation_have_no_effect() {
        let f=Fixture::new();
        assert_eq!(f.authority().enroll_existing_session(&identity(),&[],&instance(),&approval(),&Id,&Id,||panic!("no authority")),Err(GateError::Invalid));
        assert_eq!(f.authority().enroll_existing_session(&identity(),&grants(),&instance(),&approval(),&Id,&Id,||Err(())),Err(GateError::Unavailable));
        assert_eq!(ScopedAuthority::new(f.db.clone(),f.gate.clone(),"old".into()).unwrap().enroll_existing_session(&identity(),&grants(),&instance(),&approval(),&Id,&Id,||panic!("old generation")),Err(GateError::Unavailable));
        assert_eq!(f.counts(),(0,0,0));
    }
    #[test]
    fn global_and_session_stops_cannot_be_evaded_by_reenrollment() {
        let f=Fixture::new();f.hold("global");assert_eq!(enroll(&f),Err(GateError::Invalid));assert_eq!(f.counts(),(0,0,0));
        let f=Fixture::new();let r=enroll(&f).unwrap();f.hold(&format!("session:{}",r.session_ref));
        assert_eq!(enroll(&f),Err(GateError::Invalid));
        let mut a=approval();a.request_key="new-key".into();
        assert_eq!(f.authority().enroll_existing_session(&identity(),&grants(),&instance(),&a,&Id,&Id,||panic!("cannot alias stopped session")),Err(GateError::Invalid));
        assert_eq!(f.counts(),(1,1,1));
    }
    #[test]
    fn key_changes_and_unknown_delivery_do_not_allocate_an_alias() {
        let f=Fixture::new();let r=enroll(&f).unwrap();
        let mut a=approval();a.native_session_id="other".into();
        assert_eq!(f.authority().enroll_existing_session(&identity(),&grants(),&instance(),&a,&Id,&Id,||panic!("conflicting key")),Err(GateError::Invalid));
        let mut w=Writer::open_file(&f.db).unwrap();
        w.prepare_intent(&NewIntent{intent_id:"pending",task_id:"pending-task",principal:"owner",target:&r.session_ref,request_key:"pending-key",payload_hash:"send-v1:hash",now:"now",retain_until:"later"}).unwrap();
        w.connection().execute("UPDATE intents SET state='unknown' WHERE intent_id='pending'",[]).unwrap();
        assert_eq!(enroll(&f),Err(GateError::Invalid));assert_eq!(f.counts(),(2,2,1));
    }
    #[test]
    fn database_collision_rolls_back_every_enrollment_record() {
        let f=Fixture::new();
        Writer::open_file(&f.db).unwrap().connection().execute("INSERT INTO session_bindings(session_ref,node_ref,instance_id,native_session_id) VALUES('session:approved','node','profile-1','unrelated')",[]).unwrap();
        assert_eq!(enroll(&f),Err(GateError::Store));assert_eq!(f.counts(),(0,0,1));
    }
    #[test]
    fn approvals_are_exact_and_not_native_draft_aliases() {
        assert!(approval().valid());
        for native in ["", "*", "native?", "draft:already-sent", "chatgpt::draft%3Aalready-sent", "chatgpt::draft:alias", "native\nother"] {
            let mut a=approval();a.native_session_id=native.into();assert!(!a.valid());
        }
        let mut a=approval();a.account_scope="Z".repeat(64);assert!(!a.valid());
    }
}
