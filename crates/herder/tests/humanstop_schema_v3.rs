//! Candidate schema and version fences only; no live migration or gate proof.
use herder::{application::target::SessionRegistry, domain::address::SessionRef, store::Writer};
use rusqlite::{Connection, functions::FunctionFlags};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn connection(path: &PathBuf, version: i32) -> Connection {
    let c = Connection::open(path).unwrap();
    c.pragma_update(None, "foreign_keys", true).unwrap();
    c.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |_| Ok(version),
    )
    .unwrap();
    c
}
fn fixture() -> Fixture {
    let f = Fixture(std::env::temp_dir().join(format!(
            "herder-humanstop-v3-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    drop(Writer::create_file(&f.0).unwrap());
    let mut c = connection(&f.0, 1);
    let t = c.transaction().unwrap();
    t.execute_batch(include_str!("../src/store/migration_v1_v2.sql"))
        .unwrap();
    t.commit().unwrap();
    f
}
#[test]
fn v3_exact_schema_is_fenced_and_existing_mappings_remain_readable() {
    let f = fixture();
    let old = Writer::open_file(&f.0).unwrap();
    let mut c = connection(&f.0, 2);
    c.execute(
        "INSERT INTO session_bindings VALUES ('existing','node','instance','native')",
        [],
    )
    .unwrap();
    let t = c.transaction().unwrap();
    t.execute_batch(include_str!("../src/store/migration_v2_v3.sql"))
        .unwrap();
    t.commit().unwrap();
    assert!(old.insert_task("old", "p", "prepared", "n").is_err());
    assert!(old.resolve(&SessionRef("existing".into())).is_err());
    let new = Writer::open_file(&f.0).unwrap();
    assert_eq!(
        new.resolve(&SessionRef("existing".into()))
            .unwrap()
            .unwrap()
            .native_session_id,
        "native"
    );
    new.insert_task("new", "p", "prepared", "n").unwrap();
    drop(new);
    drop(old);
    drop(c);
    let c = connection(&f.0, 3);
    c.execute_batch("DROP TRIGGER v3_scope_after_seal").unwrap();
    assert!(Writer::open_file(&f.0).is_err());
}
#[test]
fn sealed_scope_and_authority_are_immutable_and_fenced() {
    let f = fixture();
    let mut c = connection(&f.0, 2);
    let t = c.transaction().unwrap();
    t.execute_batch(include_str!("../src/store/migration_v2_v3.sql"))
        .unwrap();
    t.commit().unwrap();
    drop(c);
    let mut c = connection(&f.0, 3);
    c.execute(
        "INSERT INTO session_bindings VALUES ('fresh','node','instance','native')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO humanstop_authority VALUES (1,'generation',1,2,3,4,'now')",
        [],
    )
    .unwrap();
    let t = c.transaction().unwrap();
    t.execute("INSERT INTO humanstop_scopes VALUES ('fresh','global')", [])
        .unwrap();
    t.execute(
        "INSERT INTO humanstop_scopes VALUES ('fresh','session:fresh')",
        [],
    )
    .unwrap();
    t.execute(
        "INSERT INTO humanstop_sessions VALUES ('fresh','generation','scope-generation','now')",
        [],
    )
    .unwrap();
    t.commit().unwrap();
    assert!(
        c.execute("INSERT INTO humanstop_scopes VALUES ('fresh','late')", [])
            .is_err()
    );
    assert!(
        c.execute(
            "INSERT OR REPLACE INTO humanstop_sessions VALUES ('fresh','generation','scope-generation','now')",
            []
        )
        .is_err()
    );
    assert!(
        c.execute(
            "INSERT OR REPLACE INTO humanstop_authority VALUES (1,'generation',9,9,3,4,'now')",
            []
        )
        .is_err()
    );
    assert!(
        c.execute("UPDATE humanstop_authority SET gate_inode=3", [])
            .is_err()
    );
    let stale = connection(&f.0, 2);
    assert!(
        stale
            .execute(
                "INSERT INTO humanstop_holds VALUES ('global','stop','now',NULL)",
                []
            )
            .is_err()
    );
    assert!(
        stale
            .execute(
                "INSERT INTO humanstop_sessions VALUES ('other','generation','scope-other','now')",
                []
            )
            .is_err()
    );
}
