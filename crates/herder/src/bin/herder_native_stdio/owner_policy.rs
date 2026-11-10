//! Membership evidence for an explicitly enabled local-owner policy.
//! The caller must hold the pinned authority gate and validate the store before
//! using this read-only resolver. A receipt is evidence, never itself a grant.
use herder::domain::address::{InstanceRef, SessionRef};
use rusqlite::{Connection, params};
/// True only for one consistent native-create or native-registration proof.
/// Both paths retain the pinned authority, exact principal, immutable mapping
/// and sealed HumanStop checks; registration is not a native-create claim.
pub fn is_member(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
) -> rusqlite::Result<bool> {
    herder::application::scoped_stop::registration::is_owned_session(
        db, principal, instance, generation, session,
    )
}

/// This policy is constructed only by the explicit trusted-owner launcher.
/// It never acquires the authority gate: callers may already hold that gate.
pub struct OwnerPolicy {
    pub principal: herder::auth::identity::PrincipalId,
    pub instance: InstanceRef,
    /// Provider selected by the protected owner profile. A registration proof
    /// cannot follow an instance name that has been repointed to another harness.
    pub harness: String,
    pub generation: String,
    pub db: std::path::PathBuf,
    pub gate: std::path::PathBuf,
    pub existing_sessions: Vec<herder::application::scoped_stop::enroll::ExistingSessionApproval>,
}
impl OwnerPolicy {
    /// The allowlist is loaded only from the protected launch profile. A
    /// retained enrollment receipt alone never grants access after removal.
    pub fn membership_source(&self, db: &Connection, session: &SessionRef) -> rusqlite::Result<Option<&'static str>> {
        use herder::application::scoped_stop::registration;
        // Enrollment provenance remains restricted even after allowlist removal,
        // an invalid receipt, or a contradictory public registration proof.
        if !registration::enrollment_provenance_present(
            db, &self.principal.0, &self.instance, session,
        )? {
            return registration::membership_source_for_harness(
                db, &self.principal.0, &self.instance, &self.generation, session, &self.harness,
            );
        }
        if self.harness != "chatgpt" || self.existing_sessions.is_empty()
            || registration::public_provenance_present(
                db, &self.principal.0, &self.instance, session,
            )? {
            return Ok(None);
        }
        let target = serde_json::to_string(&self.instance).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let mut stmt = db.prepare("SELECT i.request_key,i.native_receipt,b.native_session_id,h.scope_generation FROM intents i JOIN session_bindings b ON b.session_ref=?4 JOIN humanstop_sessions h ON h.session_ref=b.session_ref JOIN lineage l ON l.session_ref=b.session_ref JOIN humanstop_authority a ON a.singleton=1 WHERE i.principal=?1 AND i.target=?2 AND i.state='confirmed' AND i.payload_hash LIKE 'owner-enroll-v1:%' AND i.native_receipt IS NOT NULL AND b.node_ref=?5 AND b.instance_id=?6 AND h.authority_generation=?3 AND a.generation=?3 AND l.creator_ref=?1 AND l.parent_ref IS NULL AND l.sender_ref='owner-explicit-existing-session' AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='session:'||b.session_ref)")?;
        let rows = stmt.query_map(params![self.principal.0,target,self.generation,session.0,self.instance.node.0,self.instance.instance_id],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?;
        let mut count = 0;
        for row in rows {
            let (key, raw, native, scope_generation) = row?;
            if raw.len() > 65536 { continue }
            let Ok(receipt) = serde_json::from_str::<herder::application::scoped_stop::enroll::EnrollmentReceipt>(&raw) else { continue };
            if receipt.request_key != key || receipt.session_ref != session.0
                || receipt.native_session_id != native || receipt.scope_generation != scope_generation { continue }
            if self.existing_sessions.iter().filter(|approval|
                receipt.matches(approval, &self.instance, &self.generation)).count() == 1 {
                count += 1;
                if count > 1 { return Ok(None) }
            }
        }
        Ok((count == 1).then_some("owner-explicit-existing-session"))
    }
    pub fn is_member(&self, db: &Connection, session: &SessionRef) -> rusqlite::Result<bool> {
        Ok(self.membership_source(db, session)?.is_some())
    }


    fn grant(
        &self,
        principal: &herder::auth::identity::PrincipalId,
        instance: &InstanceRef,
        session: &SessionRef,
        action: herder::auth::identity::Action,
    ) -> Result<Option<herder::auth::identity::Grant>, ()> {
        use herder::auth::identity::{Grant, PrivateResource};
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if principal != &self.principal || instance != &self.instance {
            return Ok(None);
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.db)
            .map_err(|_| ())?;
        let dbm = file.metadata().map_err(|_| ())?;
        let gm = std::fs::symlink_metadata(&self.gate).map_err(|_| ())?;
        if !dbm.is_file()
            || !gm.is_file()
            || dbm.uid() != gm.uid()
            || dbm.nlink() != 1
            || dbm.mode() & 0o077 != 0
            || gm.mode() & 0o077 != 0
        {
            return Err(());
        }
        let c = Connection::open_with_flags(&self.db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| ())?;
        c.execute_batch("BEGIN").map_err(|_| ())?;
        let bound:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=1 AND generation=?1 AND gate_device=?2 AND gate_inode=?3 AND database_device=?4 AND database_inode=?5)",params![self.generation,i64::try_from(gm.dev()).map_err(|_|())?,i64::try_from(gm.ino()).map_err(|_|())?,i64::try_from(dbm.dev()).map_err(|_|())?,i64::try_from(dbm.ino()).map_err(|_|())?],|r|r.get(0)).map_err(|_|())?;
        let matches = bound && self.is_member(&c, session).map_err(|_| ())?;
        let named = std::fs::symlink_metadata(&self.db).map_err(|_| ())?;
        let gate_now = std::fs::symlink_metadata(&self.gate).map_err(|_| ())?;
        if !named.is_file()
            || named.dev() != dbm.dev()
            || named.ino() != dbm.ino()
            || gate_now.dev() != gm.dev()
            || gate_now.ino() != gm.ino()
        {
            return Err(());
        }
        c.execute_batch("COMMIT").map_err(|_| ())?;
        Ok(matches.then(|| Grant {
            principal: principal.clone(),
            resource: PrivateResource::Session(session.clone()),
            action,
        }))
    }
}
impl herder::application::scoped_stop::create_prompt::FreshSessionGrantPolicy for OwnerPolicy {
    fn session_write_grant(
        &self,
        p: &herder::auth::identity::PrincipalId,
        i: &InstanceRef,
        s: &SessionRef,
    ) -> Result<Option<herder::auth::identity::Grant>, ()> {
        self.grant(p, i, s, herder::auth::identity::Action::Write)
    }
    fn session_read_grant(
        &self,
        p: &herder::auth::identity::PrincipalId,
        i: &InstanceRef,
        s: &SessionRef,
    ) -> Result<Option<herder::auth::identity::Grant>, ()> {
        self.grant(p, i, s, herder::auth::identity::Action::Read)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use herder::domain::address::NodeRef;
    fn setup() -> (Connection, InstanceRef, SessionRef) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE intents(principal TEXT,target TEXT,state TEXT,payload_hash TEXT,native_receipt TEXT,request_key TEXT); CREATE TABLE session_bindings(session_ref TEXT,node_ref TEXT,instance_id TEXT,native_session_id TEXT); CREATE TABLE humanstop_sessions(session_ref TEXT,authority_generation TEXT); CREATE TABLE lineage(session_ref TEXT,creator_ref TEXT,parent_ref TEXT,sender_ref TEXT); CREATE TABLE humanstop_authority(singleton INTEGER,generation TEXT); CREATE TABLE humanstop_scopes(session_ref TEXT,scope_ref TEXT); INSERT INTO humanstop_authority VALUES(1,'g'); INSERT INTO session_bindings VALUES('s','n','i','native'); INSERT INTO humanstop_sessions VALUES('s','g'); INSERT INTO lineage VALUES('s','owner',NULL,NULL); INSERT INTO humanstop_scopes VALUES('s','global'),('s','session:s');").unwrap();
        let i = InstanceRef {
            node: NodeRef("n".into()),
            instance_id: "i".into(),
        };
        let receipt = serde_json::json!({"version":1,"request_key":"k","instance":i,"native_session_id":"native","session_ref":"s","parent_ref":null});
        c.execute(
            "INSERT INTO intents VALUES(?1,?2,'admitted','create-v1:abc',?3,'k')",
            params![
                "owner",
                serde_json::to_string(&i).unwrap(),
                receipt.to_string()
            ],
        )
        .unwrap();
        (c, i, SessionRef("s".into()))
    }
    #[test]
    fn exact_receipt_rejects_other_identity_generation_and_binding() {
        let (c, i, s) = setup();
        assert!(is_member(&c, "owner", &i, "g", &s).unwrap());
        assert!(!is_member(&c, "other", &i, "g", &s).unwrap());
        assert!(!is_member(&c, "owner", &i, "old", &s).unwrap());
        let mut other = i.clone();
        other.instance_id = "other".into();
        assert!(!is_member(&c, "owner", &other, "g", &s).unwrap());
        c.execute(
            "UPDATE session_bindings SET native_session_id='swapped'",
            [],
        )
        .unwrap();
        assert!(!is_member(&c, "owner", &i, "g", &s).unwrap());
    }
    #[test]
    fn imported_unscoped_and_ambiguous_receipts_are_denied() {
        let (c, i, s) = setup();
        c.execute("DELETE FROM intents", []).unwrap();
        assert!(!is_member(&c, "owner", &i, "g", &s).unwrap());
        let (c, i, s) = setup();
        c.execute("DELETE FROM humanstop_scopes WHERE scope_ref='global'", [])
            .unwrap();
        assert!(!is_member(&c, "owner", &i, "g", &s).unwrap());
        let (c, i, s) = setup();
        c.execute("INSERT INTO intents SELECT * FROM intents", [])
            .unwrap();
        assert!(!is_member(&c, "owner", &i, "g", &s).unwrap());
    }

    #[test]
    fn registration_membership_does_not_follow_a_reconfigured_harness() {
        use sha2::{Digest, Sha256};
        let (c, instance, session) = setup();
        let workspace: Option<herder::mcp::catalog::SessionWorkspace> = None;
        let payload = serde_json::to_vec(&(1u8, &instance, "chatgpt", "native", &workspace)).unwrap();
        let hash: String = Sha256::digest(payload).iter().map(|b| format!("{b:02x}")).collect();
        let proof = serde_json::json!({
            "version":1,"request_key":"k","instance":instance,
            "native_session_id":"native","session_ref":session.0,
            "harness":"chatgpt","authority_generation":"g","workspace":null
        });
        c.execute("UPDATE intents SET payload_hash=?1,native_receipt=?2",
            params![format!("register-v1:{hash}"),proof.to_string()]).unwrap();
        for (harness, expected) in [("chatgpt", true), ("zai", false), ("codex", false)] {
            let policy = OwnerPolicy {
                principal: herder::auth::identity::PrincipalId("owner".into()),
                instance: instance.clone(),
                harness: harness.into(),
                generation: "g".into(),
                db: std::path::PathBuf::new(),
                gate: std::path::PathBuf::new(),
                existing_sessions: Vec::new(),
            };
            assert_eq!(policy.is_member(&c, &session).unwrap(), expected);
        }
    }
    #[test]
    fn enrollment_needs_current_allowlist_and_its_distinct_receipt() {
        use herder::application::scoped_stop::enroll::{ExistingSessionApproval,EnrollmentReceipt};
        let (c,i,s)=setup();
        let public_receipt: String = c.query_row("SELECT native_receipt FROM intents", [], |r| r.get(0)).unwrap();
        c.execute_batch("ALTER TABLE humanstop_sessions ADD COLUMN scope_generation TEXT; UPDATE lineage SET sender_ref='owner-explicit-existing-session'; UPDATE humanstop_sessions SET scope_generation='scope'; DELETE FROM intents;").unwrap();
        let approval=ExistingSessionApproval{request_key:"enrollment-key".into(),native_session_id:"native".into(),account_scope:"b".repeat(64)};
        let receipt=EnrollmentReceipt{version:1,provenance:"owner-explicit-existing-session".into(),request_key:approval.request_key.clone(),instance:i.clone(),native_session_id:"native".into(),session_ref:s.0.clone(),account_scope:approval.account_scope.clone(),authority_generation:"g".into(),scope_generation:"scope".into()};
        c.execute("INSERT INTO intents VALUES(?1,?2,'confirmed','owner-enroll-v1:hash',?3,?4)",
            params!["owner",serde_json::to_string(&i).unwrap(),serde_json::to_string(&receipt).unwrap(),approval.request_key]).unwrap();
        let mut policy=OwnerPolicy{principal:herder::auth::identity::PrincipalId("owner".into()),instance:i.clone(),harness:"chatgpt".into(),generation:"g".into(),db:"/unused".into(),gate:"/unused".into(),existing_sessions:vec![approval.clone()]};
        assert!(!is_member(&c,"owner",&i,"g",&s).unwrap());
        assert_eq!(policy.membership_source(&c,&s).unwrap(),Some("owner-explicit-existing-session"));
        let public_member = || herder::application::scoped_stop::registration::is_owned_session_for_harness(
            &c, "owner", &i, "g", &s, "chatgpt",
        ).unwrap();
        assert!(!public_member());
        c.execute("INSERT INTO intents VALUES(?1,?2,'admitted','create-v1:hash',?3,'k')",
            params!["owner",serde_json::to_string(&i).unwrap(),public_receipt]).unwrap();
        assert!(!policy.is_member(&c,&s).unwrap());
        policy.existing_sessions.clear();
        assert!(!public_member());
        assert!(!policy.is_member(&c,&s).unwrap());
        c.execute("UPDATE lineage SET sender_ref=NULL",[]).unwrap();
        assert!(!public_member(), "retained enrollment pointer must prevent public fallback");
        assert!(!policy.is_member(&c,&s).unwrap());
        c.execute("UPDATE lineage SET sender_ref='owner-explicit-existing-session'",[]).unwrap();
        c.execute("DELETE FROM intents WHERE payload_hash LIKE 'owner-enroll-v1:%'",[]).unwrap();
        assert!(!public_member(), "retained lineage marker must prevent public fallback");
        policy.existing_sessions=vec![approval.clone()];
        assert!(!policy.is_member(&c,&s).unwrap());
        c.execute("DELETE FROM intents WHERE payload_hash LIKE 'create-v1:%'",[]).unwrap();
        c.execute("INSERT INTO intents VALUES(?1,?2,'confirmed','owner-enroll-v1:hash',?3,?4)",
            params!["owner",serde_json::to_string(&i).unwrap(),serde_json::to_string(&receipt).unwrap(),approval.request_key]).unwrap();
        assert!(policy.is_member(&c,&s).unwrap());
        policy.harness="zai".into();assert!(!policy.is_member(&c,&s).unwrap());
        policy.harness="chatgpt".into();
        policy.existing_sessions.clear();assert!(!policy.is_member(&c,&s).unwrap());
        policy.existing_sessions=vec![approval.clone()];policy.existing_sessions[0].account_scope="a".repeat(64);assert!(!policy.is_member(&c,&s).unwrap());
        policy.existing_sessions=vec![approval.clone()];c.execute("UPDATE intents SET state='unknown'",[]).unwrap();assert!(!policy.is_member(&c,&s).unwrap());
        c.execute("UPDATE intents SET state='confirmed'",[]).unwrap();c.execute("UPDATE humanstop_sessions SET scope_generation='swapped'",[]).unwrap();assert!(!policy.is_member(&c,&s).unwrap());
        c.execute("UPDATE humanstop_sessions SET scope_generation='scope'",[]).unwrap();c.execute("INSERT INTO intents SELECT * FROM intents",[]).unwrap();assert!(!policy.is_member(&c,&s).unwrap());
    }
}
