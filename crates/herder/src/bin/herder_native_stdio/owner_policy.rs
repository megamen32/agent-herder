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
}
impl OwnerPolicy {
    pub fn is_member(&self, db: &Connection, session: &SessionRef) -> rusqlite::Result<bool> {
        herder::application::scoped_stop::registration::is_owned_session_for_harness(
            db, &self.principal.0, &self.instance, &self.generation, session, &self.harness,
        )
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
        c.execute_batch("CREATE TABLE intents(principal TEXT,target TEXT,state TEXT,payload_hash TEXT,native_receipt TEXT,request_key TEXT); CREATE TABLE session_bindings(session_ref TEXT,node_ref TEXT,instance_id TEXT,native_session_id TEXT); CREATE TABLE humanstop_sessions(session_ref TEXT,authority_generation TEXT); CREATE TABLE lineage(session_ref TEXT,creator_ref TEXT,parent_ref TEXT); CREATE TABLE humanstop_authority(singleton INTEGER,generation TEXT); CREATE TABLE humanstop_scopes(session_ref TEXT,scope_ref TEXT); INSERT INTO humanstop_authority VALUES(1,'g'); INSERT INTO session_bindings VALUES('s','n','i','native'); INSERT INTO humanstop_sessions VALUES('s','g'); INSERT INTO lineage VALUES('s','owner',NULL); INSERT INTO humanstop_scopes VALUES('s','global'),('s','session:s');").unwrap();
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
            };
            assert_eq!(policy.is_member(&c, &session).unwrap(), expected);
        }
    }
}
