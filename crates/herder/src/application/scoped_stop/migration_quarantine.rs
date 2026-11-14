//! Read-only quarantine in the existing scoped authority settings.
//! The reviewed cutover imports sealed evidence after writer drain. This module
//! never imports, resumes, releases, clears HumanStop, or infers success from TTL.
use super::{GateError, ScopedAuthority};
use crate::domain::address::{InstanceRef, SessionAddress};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const SCOPE: &str = "migration:legacy";
pub const KEY: &str = "quarantine:v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Hold {
    pub node_ref: String,
    pub instance_ref: String,
    /// None is an explicit reviewed hold on this profile, never the fleet.
    pub native_session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome { Accepted, NotSubmitted, Unknown }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub record_ref: String,
    pub source_path: String,
    pub source_sha256: String,
    pub record_sha256: String,
    pub request_keys: Vec<String>,
    pub outcome: Outcome,
    pub holds: Vec<Hold>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub version: u8,
    pub kind: String,
    pub epoch: String,
    pub authority_generation: String,
    pub node_ref: String,
    pub instance_ref: String,
    pub writer_drain_sha256: String,
    pub inventory_sha256: String,
    pub sources: Vec<Source>,
    pub records: Vec<Record>,
}
#[derive(Clone, Debug)]
pub struct Decision {
    pub blocked: bool,
    pub reason: &'static str,
    pub record_refs: Vec<String>,
    pub proof: Value,
}
fn exact(v: &str) -> bool {
    !v.is_empty() && v.len() <= 4096 && v.trim() == v && !v.chars().any(char::is_control)
}
fn hash(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn digest(v: &[u8]) -> String { Sha256::digest(v).iter().map(|b| format!("{b:02x}")).collect() }

impl Snapshot {
    pub fn validate(&self, generation: &str, required_epoch: Option<&str>, instance: &InstanceRef) -> Result<(), GateError> {
        if self.version != 1 || self.kind != "herder-legacy-quarantine"
            || !exact(&self.epoch) || self.epoch.len() > 128 || self.authority_generation != generation
            || required_epoch.is_some_and(|e| e != self.epoch)
            || self.node_ref != instance.node.0 || self.instance_ref != instance.instance_id
            || !hash(&self.writer_drain_sha256) || !hash(&self.inventory_sha256)
            || self.sources.is_empty() || self.sources.len() > 20000 || self.records.len() > 20000 {
            return Err(GateError::Invalid);
        }
        let mut sources = BTreeSet::new();
        let mut inventory = Vec::new();
        for s in &self.sources {
            if !exact(&s.path) || !std::path::Path::new(&s.path).is_absolute()
                || !hash(&s.sha256) || !sources.insert(s.path.clone()) { return Err(GateError::Invalid); }
            inventory.push(format!("{}\0{}\n", s.path, s.sha256));
        }
        inventory.sort();
        if digest(inventory.concat().as_bytes()) != self.inventory_sha256 { return Err(GateError::Invalid); }
        let mut records = BTreeSet::new();
        for r in &self.records {
            if !exact(&r.record_ref) || !records.insert(&r.record_ref) || !hash(&r.record_sha256)
                || !self.sources.iter().any(|s| s.path == r.source_path && s.sha256 == r.source_sha256)
                || r.request_keys.is_empty() || r.request_keys.len() > 32
                || r.request_keys.iter().any(|k| !exact(k))
                || r.holds.len() > 64
                || matches!(r.outcome, Outcome::Unknown) && r.holds.is_empty()
                || !matches!(r.outcome, Outcome::Unknown) && !r.holds.is_empty() {
                return Err(GateError::Invalid);
            }
            for h in &r.holds {
                if !exact(&h.node_ref) || !exact(&h.instance_ref)
                    || h.native_session_id.as_ref().is_some_and(|n| !exact(n) || n == "*") {
                    return Err(GateError::Invalid);
                }
            }
        }
        Ok(())
    }
}

/// The caller holds the pinned authority gate. Records reserve keys regardless
/// of principal or aliases; a new principal cannot resurrect an old send.
pub fn check_locked(c: &Connection, generation: &str, required_epoch: Option<&str>,
    instance: &InstanceRef, native: Option<&str>, key: Option<&str>) -> Result<Decision, GateError> {
    let raw: Option<String> = c.query_row(
        "SELECT value_json FROM settings WHERE scope=?1 AND setting_key=?2",
        params![SCOPE, KEY], |r| r.get(0)).optional().map_err(|_| GateError::Store)?;
    let Some(raw) = raw else {
        if required_epoch.is_some() { return Err(GateError::Unavailable); }
        return Ok(Decision { blocked: false, reason: "no_migration_quarantine", record_refs: vec![],
            proof: json!({"version":1,"configured":false,"authority_generation":generation,
                "node_ref":instance.node.0,"instance_ref":instance.instance_id,"required_epoch":required_epoch}) });
    };
    if raw.len() > 16 * 1024 * 1024 { return Err(GateError::Invalid); }
    let snapshot: Snapshot = serde_json::from_str(&raw).map_err(|_| GateError::Invalid)?;
    snapshot.validate(generation, required_epoch, instance)?;
    let mut refs = Vec::new();
    let mut reserved = false;
    for record in &snapshot.records {
        let key_matches = key.is_some_and(|k| record.request_keys.iter().any(|v| v == k));
        let target_matches = record.holds.iter().any(|h| h.node_ref == instance.node.0
            && h.instance_ref == instance.instance_id
            && h.native_session_id.as_deref().is_none_or(|id| native == Some(id)));
        if key_matches || target_matches {
            reserved |= key_matches;
            refs.push(record.record_ref.clone());
        }
    }
    Ok(Decision { blocked: !refs.is_empty(),
        reason: if reserved { "legacy_request_key_reserved" } else if !refs.is_empty() { "legacy_target_quarantined" } else { "migration_scope_clear" },
        record_refs: refs,
        proof: json!({"version":1,"configured":true,"epoch":snapshot.epoch,
            "authority_generation":generation,"node_ref":instance.node.0,"instance_ref":instance.instance_id,
            "required_epoch":required_epoch,"snapshot_sha256":digest(raw.as_bytes()),
            "writer_drain_sha256":snapshot.writer_drain_sha256,"inventory_sha256":snapshot.inventory_sha256}) })
}
impl ScopedAuthority {
    pub fn migration_decision(&self, instance: &InstanceRef, native: Option<&str>, key: Option<&str>) -> Result<Decision, GateError> {
        let (_gate, writer) = self.lock()?;
        check_locked(writer.connection(), &self.generation, self.migration_epoch.as_deref(), instance, native, key)
    }
    pub(super) fn migration_for_address(&self, c: &Connection, target: &SessionAddress, key: &str) -> Result<Decision, GateError> {
        check_locked(c, &self.generation, self.migration_epoch.as_deref(), &target.instance,
            Some(&target.native_session_id), Some(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::NodeRef;
    fn fixture() -> (Connection, InstanceRef, Snapshot) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings(scope TEXT,setting_key TEXT,value_json TEXT,PRIMARY KEY(scope,setting_key));").unwrap();
        let instance = InstanceRef { node: NodeRef("node".into()), instance_id: "profile".into() };
        let source = Source { path: "/sealed/jobs.json".into(), sha256: "a".repeat(64) };
        let s = Snapshot { version:1,kind:"herder-legacy-quarantine".into(),epoch:"epoch".into(),
            authority_generation:"generation".into(),node_ref:"node".into(),instance_ref:"profile".into(),
            writer_drain_sha256:"d".repeat(64), inventory_sha256:digest(format!("{}\0{}\n",source.path,source.sha256).as_bytes()),
            sources:vec![source.clone()],records:vec![Record { record_ref:"legacy-job".into(),source_path:source.path,
                source_sha256:source.sha256,record_sha256:"b".repeat(64),request_keys:vec!["old".into(),"compat-resume:v1:old".into()],
                outcome:Outcome::Unknown,holds:vec![Hold{node_ref:"node".into(),instance_ref:"profile".into(),native_session_id:Some("old-native".into())}]}] };
        (c,instance,s)
    }
    fn install(c:&Connection,s:&Snapshot) {
        c.execute("INSERT OR REPLACE INTO settings VALUES(?1,?2,?3)",params![SCOPE,KEY,serde_json::to_string(s).unwrap()]).unwrap();
    }
    #[test] fn unknown_is_scoped_and_all_old_aliases_stay_reserved() {
        let (c,i,s)=fixture(); install(&c,&s);
        for key in ["old","compat-resume:v1:old"] {
            assert!(check_locked(&c,"generation",Some("epoch"),&i,Some("new-native"),Some(key)).unwrap().blocked);
        }
        assert!(check_locked(&c,"generation",Some("epoch"),&i,Some("old-native"),Some("new")).unwrap().blocked);
        assert!(!check_locked(&c,"generation",Some("epoch"),&i,Some("new-native"),Some("new")).unwrap().blocked);
        assert!(check_locked(&c,"generation",Some("epoch"),&i,Some("old-native"),None).unwrap().blocked);
    }
    #[test] fn completed_keys_are_reserved_without_holding_unrelated_work() {
        let (c,i,mut s)=fixture(); s.records[0].outcome=Outcome::NotSubmitted;s.records[0].holds.clear();install(&c,&s);
        assert!(check_locked(&c,"generation",Some("epoch"),&i,Some("old-native"),Some("old")).unwrap().blocked);
        assert!(!check_locked(&c,"generation",Some("epoch"),&i,Some("old-native"),Some("fresh")).unwrap().blocked);
    }
    #[test] fn unresolved_profile_is_not_a_fleet_hold() {
        let (c,i,mut s)=fixture();s.records[0].holds[0].native_session_id=None;install(&c,&s);
        assert!(check_locked(&c,"generation",Some("epoch"),&i,Some("new-native"),None).unwrap().blocked);
        s.records[0].holds[0].instance_ref="different-profile".into();install(&c,&s);
        assert!(!check_locked(&c,"generation",Some("epoch"),&i,Some("new-native"),None).unwrap().blocked);
    }
    #[test] fn missing_stale_and_corrupt_required_evidence_refuse() {
        let (c,i,mut s)=fixture();
        assert!(check_locked(&c,"generation",Some("epoch"),&i,None,None).is_err());
        assert!(!check_locked(&c,"generation",None,&i,None,None).unwrap().blocked);
        install(&c,&s);
        assert!(check_locked(&c,"wrong",Some("epoch"),&i,None,None).is_err());
        assert!(check_locked(&c,"generation",Some("wrong"),&i,None,None).is_err());
        s.inventory_sha256="f".repeat(64);install(&c,&s);
        assert!(check_locked(&c,"generation",Some("epoch"),&i,None,None).is_err());
    }
    #[test] fn public_configuration_cannot_write_the_private_migration_scope() {
        use crate::mcp::catalog::{self, SettingTarget};
        assert!(catalog::dispatch("settings",json!({"action":"set","scope":SCOPE,"key":KEY,"value":null})).is_err());
        assert!(catalog::dispatch("automation",json!({"action":"delete","scope":SCOPE,"key":KEY,"rule_ref":KEY,"revision":1})).is_err());
        for target in [SettingTarget::Node{node_ref:SCOPE.into()}, SettingTarget::Instance{instance_ref:SCOPE.into()},
            SettingTarget::Session{session_ref:SCOPE.into()}] {
            assert!(crate::application::settings::parse_patch(target,KEY,Value::Null,1).is_err());
        }
    }
    #[test] fn unknown_without_reviewed_scope_never_disappears() {
        let (c,i,mut s)=fixture();s.records[0].holds.clear();install(&c,&s);
        assert!(check_locked(&c,"generation",Some("epoch"),&i,None,None).is_err());
    }
}
