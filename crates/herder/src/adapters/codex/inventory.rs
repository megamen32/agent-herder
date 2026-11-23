//! Read-only catalog of persisted Codex thread metadata in one trusted owner profile.
//! Ordered by stable native ID so changes to activity time don't move rows between pages.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, params_from_iter, types::Value as SqlValue,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

fn open_state(home: &Path) -> Result<Connection, String> {
    let mut newest: Option<(u32, PathBuf)> = None;
    for entry in fs::read_dir(home).map_err(|_| "inventory_store_unavailable")? {
        let entry = entry.map_err(|_| "inventory_store_unavailable")?;
        let name = entry.file_name();
        let version = name
            .to_str()
            .and_then(|s| s.strip_prefix("state_"))
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.parse::<u32>().ok());
        if let Some(version) = version
            && newest
                .as_ref()
                .is_none_or(|(current, _)| version > *current)
        {
            newest = Some((version, entry.path()));
        }
    }
    let (_, path) = newest.ok_or("inventory_store_unavailable")?;
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "inventory_store_unavailable")?;
    db.busy_timeout(Duration::from_millis(250))
        .map_err(|_| "inventory_store_unavailable")?;
    Ok(db)
}

fn cursor_scope(
    home: &Path,
    project: Option<&str>,
    updated_since_ms: Option<i64>,
    archived: Option<bool>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"codex-inventory-by-id-v1\0");
    digest.update(home.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(
        json!([project, updated_since_ms, archived])
            .to_string()
            .as_bytes(),
    );
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn read_cursor(cursor: &str, scope: &str) -> Result<String, String> {
    if cursor.len() > 4096 {
        return Err("invalid_cursor".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "invalid_cursor")?;
    let (observed, id): (String, String) =
        serde_json::from_slice(&bytes).map_err(|_| "invalid_cursor")?;
    if observed != scope || id.is_empty() || id.len() > 512 {
        return Err("invalid_cursor".into());
    }
    Ok(id)
}

fn source_metadata(raw: Option<String>) -> (Option<String>, Option<String>) {
    let Some(raw) = raw else { return (None, None) };
    if !raw.starts_with('{') {
        return (Some(raw), None);
    }
    let source: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let Some(agent) = source.get("subagent").or_else(|| source.get("subAgent")) else {
        return (Some("unknown".into()), None);
    };
    if let Some(spawn) = agent
        .get("thread_spawn")
        .or_else(|| agent.get("threadSpawn"))
    {
        let parent = spawn
            .get("parent_thread_id")
            .or_else(|| spawn.get("parentThreadId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        return (Some("subAgentThreadSpawn".into()), parent);
    }
    let kind = match agent.as_str() {
        Some("review") => "subAgentReview",
        Some("compact") => "subAgentCompact",
        _ if agent.get("other").is_some() => "subAgentOther",
        _ => "subAgent",
    };
    (Some(kind.into()), None)
}

pub fn list_metadata(
    home: &Path,
    cursor: Option<&str>,
    limit: usize,
    project: Option<&str>,
    updated_since_ms: Option<i64>,
    archived: Option<bool>,
) -> Result<Value, String> {
    if !(1..=200).contains(&limit) {
        return Err("invalid_limit".into());
    }
    if updated_since_ms.is_some_and(|since| since < 0) {
        return Err("invalid_inventory_filter".into());
    }
    let scope = cursor_scope(home, project, updated_since_ms, archived);
    let last = cursor.map(|c| read_cursor(c, &scope)).transpose()?;
    let db = open_state(home)?;
    let columns: HashSet<String> = db
        .prepare("PRAGMA table_info(threads)")
        .and_then(|mut s| s.query_map([], |r| r.get(1))?.collect())
        .map_err(|_| "inventory_schema_unavailable")?;
    if !["id", "archived", "cwd"]
        .iter()
        .all(|c| columns.contains(*c))
    {
        return Err("inventory_schema_unavailable".into());
    }
    let optional = |column: &'static str| {
        if columns.contains(column) {
            column
        } else {
            "NULL"
        }
    };
    let seconds = optional("updated_at");
    let millis = optional("updated_at_ms");
    let updated = format!(
        "COALESCE({millis}, CASE WHEN {seconds} BETWEEN -99999999999 AND 99999999999 THEN {seconds}*1000 ELSE {seconds} END)"
    );
    let mut sql = format!(
        "SELECT id, archived, cwd, {updated}, {}, {}, {}, substr(COALESCE({}, {}),1,160) FROM threads",
        optional("model_provider"),
        optional("source"),
        optional("model"),
        optional("name"),
        optional("title")
    );
    let since_condition = format!("{updated} >= ?");
    let mut conditions = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    if let Some(id) = last {
        conditions.push("id < ?");
        params.push(id.into());
    }
    if let Some(project) = project {
        conditions.push("cwd = ?");
        params.push(project.to_owned().into());
    }
    if let Some(since) = updated_since_ms {
        if seconds == "NULL" && millis == "NULL" {
            return Err("inventory_schema_unavailable".into());
        }
        conditions.push(&since_condition);
        params.push(since.into());
    }
    if let Some(archived) = archived {
        conditions.push("archived = ?");
        params.push(i64::from(archived).into());
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    params.push(((limit + 1) as i64).into());
    let mut stmt = db
        .prepare(&sql)
        .map_err(|_| "inventory_schema_unavailable")?;
    let mut rows = stmt
        .query(params_from_iter(params))
        .map_err(|_| "inventory_read_failed")?;
    let mut sessions = Vec::with_capacity(limit);
    let mut last_id = String::new();
    let mut more = false;
    while let Some(row) = rows.next().map_err(|_| "inventory_read_failed")? {
        if sessions.len() == limit {
            more = true;
            break;
        }
        let id: String = row.get(0).map_err(|_| "inventory_invalid_thread_id")?;
        if id.is_empty() || id.len() > 512 {
            return Err("inventory_invalid_thread_id".into());
        }
        let string = |i| {
            row.get::<_, Option<String>>(i)
                .map_err(|_| "inventory_read_failed")
        };
        let archived: bool = row.get(1).map_err(|_| "inventory_read_failed")?;
        let updated_at_ms: Option<i64> = row.get(3).map_err(|_| "inventory_read_failed")?;
        let (source, parent) = source_metadata(string(5)?);
        sessions.push(
            json!({"native_session_id":id,"archived":archived,"cwd":string(2)?,
            "updated_at_ms":updated_at_ms,"model_provider":string(4)?,"source":source,
            "parent_thread_id":parent,"model":string(6)?,"title":string(7)?}),
        );
        last_id = id;
    }
    let next = if more {
        Some(URL_SAFE_NO_PAD.encode(json!([scope, last_id]).to_string()))
    } else {
        None
    };
    Ok(
        json!({"sessions":sessions,"next_cursor":next,"complete":!more,"source":"codex_state_db","order":"native_id_desc"}),
    )
}

/// Filter a live controller snapshot through the same DB without opening rollout files.
pub fn unindexed_ids(home: &Path, ids: &[String]) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut db = open_state(home)?;
    let tx = db.transaction().map_err(|_| "inventory_read_failed")?;
    let mut stmt = tx
        .prepare("SELECT 1 FROM threads WHERE id = ?")
        .map_err(|_| "inventory_schema_unavailable")?;
    let mut missing = Vec::new();
    for id in ids {
        if stmt
            .query_row([id], |_| Ok(()))
            .optional()
            .map_err(|_| "inventory_read_failed")?
            .is_none()
        {
            missing.push(id.clone());
        }
    }
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let home = std::env::temp_dir().join(format!(
                "herder-inventory-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&home).unwrap();
            Fixture(home)
        }
        fn database(&self, name: &str) -> Connection {
            Connection::open(self.0.join(name)).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_archived_and_nonarchived_and_binds_keyset_cursor() {
        let fixture = Fixture::new();
        let db = fixture.database("state_5.sqlite");
        db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,cwd TEXT,source TEXT,model_provider TEXT,updated_at INTEGER,updated_at_ms INTEGER);
          INSERT INTO threads VALUES('c',0,'/a','vscode','one',1,1500),('b',1,'/a','cli','two',1700000000000,NULL),('a',0,'/b','exec','three',3,NULL);").unwrap();
        let first = list_metadata(&fixture.0, None, 1, None, None, None).unwrap();
        assert_eq!(first["sessions"][0]["native_session_id"], "c");
        assert_eq!(first["sessions"][0]["updated_at_ms"], 1500);
        let next = first["next_cursor"].as_str().unwrap();
        db.execute("UPDATE threads SET updated_at_ms=999999 WHERE id='a'", [])
            .unwrap();
        let rest = list_metadata(&fixture.0, Some(next), 2, None, None, None).unwrap();
        assert_eq!(rest["sessions"][0]["native_session_id"], "b");
        assert_eq!(rest["sessions"][0]["archived"], true);
        assert_eq!(rest["sessions"][0]["updated_at_ms"], 1700000000000i64);
        assert_eq!(rest["sessions"][1]["native_session_id"], "a");
        assert_eq!(rest["complete"], true);
        assert!(rest["next_cursor"].is_null());
        let filtered = list_metadata(&fixture.0, None, 20, None, Some(2000), Some(false)).unwrap();
        assert_eq!(filtered["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["sessions"][0]["native_session_id"], "a");
        assert!(list_metadata(&fixture.0, Some(next), 20, None, Some(2000), Some(false)).is_err());
        let project_rows = list_metadata(&fixture.0, None, 2, Some("/a"), None, None).unwrap();
        assert_eq!(project_rows["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(project_rows["complete"], true);
        assert!(list_metadata(&fixture.0, Some(next), 2, Some("/a"), None, None).is_err());
        assert!(list_metadata(&fixture.0, Some("garbage"), 2, None, None, None).is_err());
        assert!(list_metadata(&fixture.0, None, 0, None, None, None).is_err());
        assert_eq!(
            unindexed_ids(&fixture.0, &["a".into(), "new".into()]).unwrap(),
            vec!["new"]
        );
    }

    #[test]
    fn reads_latest_compatible_index_without_rollouts_or_optional_columns() {
        let fixture = Fixture::new();
        fixture
            .database("state_5.sqlite")
            .execute_batch("CREATE TABLE stale(id TEXT)")
            .unwrap();
        let db = fixture.database("state_10.sqlite");
        db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,cwd TEXT,source TEXT,updated_at INTEGER)").unwrap();
        db.execute(
            "INSERT INTO threads VALUES('child',0,'/x',?,1700000001)",
            [r#"{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}"#],
        )
        .unwrap();
        let page = list_metadata(&fixture.0, None, 40, None, None, None).unwrap();
        let row = &page["sessions"][0];
        assert_eq!(row["source"], "subAgentThreadSpawn");
        assert_eq!(row["parent_thread_id"], "parent");
        assert_eq!(row["updated_at_ms"], 1700000001000i64);
        assert!(row["title"].is_null());
        fixture
            .database("state_11.sqlite")
            .execute_batch("CREATE TABLE changed(id TEXT)")
            .unwrap();
        assert!(list_metadata(&fixture.0, None, 40, None, None, None).is_err());
    }
}
