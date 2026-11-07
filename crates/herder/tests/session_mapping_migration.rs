//! Isolated v1 → v2 candidate contract; never points at the live store.
use herder::store::Writer;
use rusqlite::{Connection, functions::FunctionFlags};
use std::path::{Path, PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                "herder-mapping-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn connection(path: &Path, version: i32) -> Connection {
    let c = Connection::open(path).unwrap();
    c.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |_| Ok(version),
    )
    .unwrap();
    c
}
fn sql() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/store/migration_v1_v2.sql"
    ))
    .unwrap()
}
fn migrate(c: &mut Connection, text: &str) -> rusqlite::Result<()> {
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(text)?;
    tx.commit()
}

fn v1_state(c: &Connection) -> Vec<(String, Vec<String>)> {
    [
        "tasks", "intents", "messages", "holds", "lineage", "settings",
    ]
    .iter()
    .map(|table| {
        let mut stmt = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        (table.to_string(), rows)
    })
    .collect()
}

#[test]
fn v2_preserves_v1_state_fences_old_writer_and_mappings_are_immutable() {
    let f = Fixture::new();
    let old = Writer::create_file(&f.0).unwrap();
    old.insert_task("old-task", "p", "prepared", "then")
        .unwrap();
    let old_sql = connection(&f.0, 1);
    old_sql.execute("INSERT INTO lineage(session_ref,creator_ref,parent_ref,sender_ref,created_at) VALUES ('legacy','creator','parent','sender','then')",[]).unwrap();
    old_sql.execute_batch("INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,created_at,updated_at,retain_until) VALUES('old-intent','old-task','p','legacy','key','hash','unknown','then','then','later'); INSERT INTO messages(message_id,session_ref,direction,content_json,created_at,native_id) VALUES('m','legacy','in','{}','then','native'); INSERT INTO holds(session_ref,reason,created_at) VALUES('legacy','hold','then'); INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES('global','k','{}',1,'then');").unwrap();
    let before = v1_state(&old_sql);
    let mut c = connection(&f.0, 2);
    migrate(&mut c, &sql()).unwrap();
    assert_eq!(v1_state(&c), before);
    assert_eq!(c.query_row("SELECT creator_ref || ':' || parent_ref || ':' || sender_ref FROM lineage WHERE session_ref='legacy'",[],|r|r.get::<_,String>(0)).unwrap(),"creator:parent:sender");
    for table in [
        "tasks", "intents", "messages", "holds", "lineage", "settings",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "{table}"
        );
    }
    assert_eq!(c.query_row("SELECT state || ':' || request_key || ':' || payload_hash FROM intents WHERE intent_id='old-intent'",[],|r|r.get::<_,String>(0)).unwrap(),"unknown:key:hash");
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM tasks WHERE task_id='old-task'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert!(old.insert_task("stale", "p", "prepared", "now").is_err());
    assert!(old_sql.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('stale2','p','prepared','n','n')",[]).is_err());
    c.execute(
        "INSERT INTO session_bindings VALUES ('ref1','node1','instance','native1')",
        [],
    )
    .unwrap();
    assert!(
        c.execute(
            "INSERT OR REPLACE INTO session_bindings VALUES ('ref1','node1','instance','spoof')",
            []
        )
        .is_err()
    );
    assert!(
        c.execute(
            "INSERT OR REPLACE INTO session_bindings VALUES ('ref2','node1','instance','native1')",
            []
        )
        .is_err()
    );
    // The native id is scoped by the full node and instance identity.
    c.execute(
        "INSERT INTO session_bindings VALUES ('ref-other-node','node2','instance','native1')",
        [],
    )
    .unwrap();
    assert!(
        c.execute(
            "INSERT INTO session_bindings VALUES ('ref1','node1','instance','other')",
            []
        )
        .is_err()
    );
    assert!(
        c.execute(
            "INSERT INTO session_bindings VALUES ('ref2','node1','instance','native1')",
            []
        )
        .is_err()
    );
    assert!(
        c.execute(
            "UPDATE session_bindings SET native_session_id='spoof' WHERE session_ref='ref1'",
            []
        )
        .is_err()
    );
    assert!(
        c.execute("DELETE FROM session_bindings WHERE session_ref='ref1'", [])
            .is_err()
    );
    assert!(
        old_sql
            .execute(
                "INSERT INTO session_bindings VALUES ('stale','node','instance','native')",
                []
            )
            .is_err()
    );
    use herder::application::target::SessionRegistry;
    assert!(
        old.resolve(&herder::domain::address::SessionRef("ref1".into()))
            .is_err()
    );
    drop(c);
    drop(old_sql);
    drop(old);
    let writer = Writer::open_file(&f.0).unwrap();
    let resolved = writer
        .resolve(&herder::domain::address::SessionRef("ref1".into()))
        .unwrap()
        .unwrap();
    assert_eq!(resolved.instance.node.0, "node1");
    assert_eq!(resolved.instance.instance_id, "instance");
    assert_eq!(resolved.native_session_id, "native1");
    let mut old_reopen = connection(&f.0, 1);
    assert!(old_reopen.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('stale3','p','prepared','n','n')",[]).is_err());
    assert!(migrate(&mut old_reopen, &sql()).is_err());
}

#[test]
fn migration_failure_rolls_back_and_unknown_version_is_refused() {
    let f = Fixture::new();
    let old = Writer::create_file(&f.0).unwrap();
    old.insert_task("keep", "p", "prepared", "now").unwrap();
    let mut c = connection(&f.0, 2);
    let interrupted = format!("{}\nINSERT INTO missing_table VALUES (1);", sql());
    assert!(migrate(&mut c, &interrupted).is_err());
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='session_bindings'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM tasks WHERE task_id='keep'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.pragma_update(None, "user_version", 99).unwrap();
    assert!(migrate(&mut c, &sql()).is_err());
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
            .unwrap(),
        99
    );
    assert!(Writer::open_file(&f.0).is_err());
}
