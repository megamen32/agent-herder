use rusqlite::{Connection, Result, functions::FunctionFlags, params};
use std::path::Path;

pub mod intents;
pub mod lineage;
mod session_bindings;

const WRITER_VERSION: i32 = 1;
const SCHEMA: &str = include_str!("schema.sql");

/// A fenced v1 SQLite writer.
pub struct Writer {
    connection: Connection,
}

impl Writer {
    /// Verify required definitions, including the old fences and the v2
    /// immutability triggers. An integer version alone is not a schema identity.
    fn validate_v2_schema(connection: &Connection) -> Result<()> {
        use rusqlite::OptionalExtension;
        let reference = Self::configure(Connection::open_in_memory()?, WRITER_VERSION)?;
        reference.execute_batch(&format!("BEGIN EXCLUSIVE;\n{SCHEMA}\nCOMMIT;"))?;
        reference.execute_batch(include_str!("migration_v1_v2.sql"))?;
        let mut stmt=reference.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (kind, name, sql) = row?;
            let actual: Option<Option<String>> = connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type=?1 AND name=?2",
                    params![kind, name],
                    |r| r.get(0),
                )
                .optional()?;
            if actual != Some(sql) {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                    Some(format!("v2 store schema mismatch: {kind} {name}")),
                ));
            }
        }
        let count_sql = "SELECT count(*) FROM sqlite_schema WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%'";
        let expected: i64 = reference.query_row(count_sql, [], |r| r.get(0))?;
        let actual: i64 = connection.query_row(count_sql, [], |r| r.get(0))?;
        if expected != actual {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some("unexpected v2 schema objects".into()),
            ));
        }
        Ok(())
    }
    fn configure(connection: Connection, version: i32) -> Result<Connection> {
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            move |_| Ok(version),
        )?;
        Ok(connection)
    }

    /// Create a new file only. Never overwrite or bootstrap an existing database.
    pub fn create_file(path: &Path) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        drop(options.open(path)?);
        let connection = Self::configure(
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?,
            WRITER_VERSION,
        )?;
        connection.execute_batch(&format!("BEGIN EXCLUSIVE;\n{SCHEMA}\nCOMMIT;"))?;
        Ok(Self { connection })
    }

    /// Open an existing supported database without creating or migrating it.
    pub fn open_file(path: &Path) -> Result<Self> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if !matches!(version, 1 | 2) {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some(format!("unsupported store schema version {version}")),
            ));
        }
        if version == 2 {
            Self::validate_v2_schema(&connection)?;
        }
        let connection = Self::configure(connection, version)?;
        Ok(Self { connection })
    }

    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Create a fresh database; this constructor never opens persistent state.
    pub fn temporary() -> Result<Self> {
        let connection = Self::configure(Connection::open_in_memory()?, WRITER_VERSION)?;
        connection.execute_batch(&format!("BEGIN EXCLUSIVE;\n{SCHEMA}\nCOMMIT;"))?;
        Ok(Self { connection })
    }

    pub fn insert_task(
        &self,
        task_id: &str,
        principal: &str,
        status: &str,
        now: &str,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO tasks(task_id, principal, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![task_id, principal, status, now],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_rejects_partial_v2_even_when_number_is_two() {
        let path = std::env::temp_dir().join(format!(
            "herder-partial-v2-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let w = Writer::create_file(&path).unwrap();
        w.insert_task("keep", "p", "prepared", "now").unwrap();
        drop(w);
        let c = Connection::open(&path).unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();
        drop(c);
        assert!(Writer::open_file(&path).is_err());
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM tasks WHERE task_id='keep'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.pragma_update(None, "user_version", 1).unwrap();
        c.execute_batch(include_str!("migration_v1_v2.sql"))
            .unwrap();
        assert!(Writer::open_file(&path).is_ok());
        c.execute_batch("DROP TRIGGER v2_no_replace_session_bindings")
            .unwrap();
        assert!(Writer::open_file(&path).is_err());
        c.execute_batch("CREATE TRIGGER v2_no_replace_session_bindings BEFORE INSERT ON session_bindings BEGIN SELECT 1; END;").unwrap();
        assert!(Writer::open_file(&path).is_err());
    }

    #[test]
    fn file_writer_refuses_unknown_version_and_preserves_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "herder-fence-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let w = Writer::create_file(&path).unwrap();
        w.insert_task("one", "p", "prepared", "now").unwrap();
        assert!(Writer::create_file(&path).is_err());
        let external = Connection::open(&path).unwrap();
        external.pragma_update(None, "user_version", 3).unwrap();
        assert!(w.insert_task("two", "p", "prepared", "now").is_err());
        drop(w);
        drop(external);
        assert!(Writer::open_file(&path).is_err());
        let external = Connection::open(&path).unwrap();
        let count: i64 = external
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn matching_writer_writes_and_version_change_fences_existing_connection() -> Result<()> {
        let writer = Writer::temporary()?;
        let version: i32 =
            writer
                .connection
                .query_row("SELECT herder_writer_version()", [], |row| row.get(0))?;
        assert_eq!(version, 1);
        writer.insert_task("good", "p", "working", "now")?;
        writer.connection.pragma_update(None, "user_version", 2)?;
        let error = writer
            .insert_task("bad", "p", "working", "now")
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported schema version for writer"),
            "{error}"
        );
        let count: i64 = writer
            .connection
            .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))?;
        assert_eq!(count, 1);
        Ok(())
    }

    #[test]
    fn unregistered_connection_cannot_write() -> Result<()> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(&format!("BEGIN EXCLUSIVE;\n{SCHEMA}\nCOMMIT;"))?;
        let error = connection
            .execute(
                "INSERT INTO tasks VALUES ('bad', 'p', 'working', 'now', 'now', NULL, NULL)",
                [],
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("herder_writer_version"),
            "{error}"
        );
        let count: i64 =
            connection.query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))?;
        assert_eq!(count, 0);
        Ok(())
    }
}
