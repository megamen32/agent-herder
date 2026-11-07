//! Membership evidence for an explicitly enabled local-owner policy.
//! The caller must hold the pinned authority gate and validate the store before
//! using this read-only resolver. A receipt is evidence, never itself a grant.
use herder::domain::address::{InstanceRef, SessionRef};
use rusqlite::{Connection, params};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateReceipt {
    version: u8,
    request_key: String,
    instance: InstanceRef,
    native_session_id: String,
    session_ref: String,
    parent_ref: Option<String>,
}

/// True only for one consistent, atomically recorded fresh root belonging to
/// this principal and instance under the currently pinned authority generation.
pub fn is_member(
    db: &Connection,
    principal: &str,
    instance: &InstanceRef,
    generation: &str,
    session: &SessionRef,
) -> rusqlite::Result<bool> {
    if [
        principal,
        generation,
        &session.0,
        &instance.node.0,
        &instance.instance_id,
    ]
    .iter()
    .any(|s| s.is_empty() || s.len() > 4096 || s.chars().any(char::is_control))
    {
        return Ok(false);
    }
    let target = serde_json::to_string(instance).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt=db.prepare("SELECT i.request_key,i.native_receipt,b.native_session_id FROM intents i JOIN session_bindings b ON b.session_ref=?4 JOIN humanstop_sessions h ON h.session_ref=b.session_ref JOIN lineage l ON l.session_ref=b.session_ref JOIN humanstop_authority a ON a.singleton=1 WHERE i.principal=?1 AND i.target=?2 AND i.state IN ('admitted','confirmed') AND i.payload_hash LIKE 'create-v1:%' AND i.native_receipt IS NOT NULL AND b.node_ref=?5 AND b.instance_id=?6 AND h.authority_generation=?3 AND a.generation=?3 AND l.creator_ref=?1 AND l.parent_ref IS NULL AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes x WHERE x.session_ref=b.session_ref AND x.scope_ref='session:'||b.session_ref)")?;
    let rows = stmt.query_map(
        params![
            principal,
            target,
            generation,
            session.0,
            instance.node.0,
            instance.instance_id
        ],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )?;
    let mut matches = 0;
    for row in rows {
        let (key, raw, native) = row?;
        if raw.len() > 65536 {
            continue;
        }
        let Ok(receipt) = serde_json::from_str::<CreateReceipt>(&raw) else {
            continue;
        };
        if receipt.version == 1
            && receipt.request_key == key
            && !key.is_empty()
            && receipt.instance == *instance
            && receipt.native_session_id == native
            && !native.is_empty()
            && receipt.session_ref == session.0
            && receipt.parent_ref.is_none()
        {
            matches += 1;
            if matches > 1 {
                return Ok(false);
            }
        }
    }
    Ok(matches == 1)
}

/// This policy is constructed only by the explicit trusted-owner launcher.
/// It never acquires the authority gate: callers may already hold that gate.
pub struct OwnerPolicy {
    pub principal: herder::auth::identity::PrincipalId,
    pub instance: InstanceRef,
    pub generation: String,
    pub db: std::path::PathBuf,
    pub gate: std::path::PathBuf,
}
impl OwnerPolicy {
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
        let matches = bound
            && is_member(&c, &principal.0, instance, &self.generation, session).map_err(|_| ())?;
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
}
