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
    fn validate_schema(connection: &Connection, version: i32) -> Result<()> {
        use rusqlite::OptionalExtension;
        let reference = Self::configure(Connection::open_in_memory()?, WRITER_VERSION)?;
        reference.execute_batch(&format!("BEGIN EXCLUSIVE;\n{SCHEMA}\nCOMMIT;"))?;
        reference.execute_batch(include_str!("migration_v1_v2.sql"))?;
        if version >= 3 {
            reference.execute_batch(include_str!("migration_v2_v3.sql"))?;
        }
        if version >= 4 {
            reference.execute_batch(include_str!("migration_v3_v4.sql"))?;
        }
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
    /// Check the exact v3 schema on the caller's existing connection. The
    /// caller owns the read transaction and any filesystem identity checks.
    pub fn validate_exact_v3(connection: &Connection) -> Result<()> {
        let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != 3 {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some("scoped authority requires exact schema version 3".into()),
            ));
        }
        Self::validate_schema(connection, 3)
    }
    /// Scoped authority accepts only a complete, validated v3 or v4 store.
    pub fn validate_scoped_schema(connection: &Connection) -> Result<()> {
        let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if !matches!(version, 3 | 4) {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some("scoped authority requires schema version 3 or 4".into()),
            ));
        }
        Self::validate_schema(connection, version)
    }

    /// Migrate a validated v3 store atomically. The old writer is consumed;
    /// callers must reopen to obtain the v4 writer fence. Never called by open.
    #[cfg(target_os = "linux")]
    pub fn migrate_search_v4(
        mut self,
        gate: &crate::application::target_gate::PinnedTargetGateGuard,
    ) -> Result<()> {
        use rusqlite::TransactionBehavior;
        use std::os::unix::fs::MetadataExt;
        let database: String = self.connection.query_row(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            [],
            |r| r.get(0),
        )?;
        let path = std::path::Path::new(&database);
        let meta = std::fs::symlink_metadata(path).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let (dev, ino) = gate.identity().map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !path.is_absolute()
            || path.parent() != Some(gate.directory())
            || path.canonicalize().ok().as_deref() != Some(path)
            || !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != gate.owner().map_err(|_| rusqlite::Error::InvalidQuery)?
            || meta.mode() & 0o077 != 0
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Exclusive)?;
        let version: i32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != 3 {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some("search migration requires exact v3".into()),
            ));
        }
        Self::validate_schema(&tx, 3)?;
        let bound: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=1 AND gate_device=?1 AND gate_inode=?2 AND database_device=?3 AND database_inode=?4)", params![i64::try_from(dev).map_err(|_| rusqlite::Error::InvalidQuery)?, i64::try_from(ino).map_err(|_| rusqlite::Error::InvalidQuery)?, i64::try_from(meta.dev()).map_err(|_| rusqlite::Error::InvalidQuery)?, i64::try_from(meta.ino()).map_err(|_| rusqlite::Error::InvalidQuery)?], |r| r.get(0))?;
        if !bound {
            return Err(rusqlite::Error::InvalidQuery);
        }
        tx.execute_batch(include_str!("migration_v3_v4.sql"))?;
        tx.commit()
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
        if !matches!(version, 1 | 2 | 3 | 4) {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_SCHEMA),
                Some(format!("unsupported store schema version {version}")),
            ));
        }
        if version >= 2 {
            Self::validate_schema(&connection, version)?;
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

    /// Provision only an empty, isolated v3 store while holding its protected
    /// gate. This is not a legacy cutover or permission to adopt imported rows.
    #[cfg(target_os = "linux")]
    pub fn initialize_fresh_stop_authority(
        &mut self,
        gate: &crate::application::target_gate::PinnedTargetGateGuard,
        generation: &str,
        now: &str,
    ) -> Result<bool> {
        use std::os::unix::fs::MetadataExt;
        if generation.is_empty()
            || generation.len() > 4096
            || generation.chars().any(char::is_control)
            || now.is_empty()
        {
            return Ok(false);
        }
        let database: String = self.connection.query_row(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            [],
            |r| r.get(0),
        )?;
        let path = std::path::Path::new(&database);
        let meta = std::fs::symlink_metadata(path).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !path.is_absolute()
            || path.parent() != Some(gate.directory())
            || path.canonicalize().ok().as_deref() != Some(path)
            || !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != gate.owner().map_err(|_| rusqlite::Error::InvalidQuery)?
            || meta.mode() & 0o077 != 0
        {
            return Ok(false);
        }
        let (dev, ino) = gate.identity().map_err(|_| rusqlite::Error::InvalidQuery)?;
        let dev = i64::try_from(dev).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let ino = i64::try_from(ino).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let valid: bool = tx.query_row("SELECT (SELECT user_version FROM pragma_user_version) IN (3,4) AND herder_writer_version()=(SELECT user_version FROM pragma_user_version) AND NOT EXISTS(SELECT 1 FROM tasks) AND NOT EXISTS(SELECT 1 FROM intents) AND NOT EXISTS(SELECT 1 FROM session_bindings) AND NOT EXISTS(SELECT 1 FROM lineage) AND NOT EXISTS(SELECT 1 FROM holds) AND NOT EXISTS(SELECT 1 FROM humanstop_authority) AND NOT EXISTS(SELECT 1 FROM humanstop_holds)", [], |r| r.get(0))?;
        if !valid {
            return Ok(false);
        }
        tx.execute("INSERT INTO humanstop_authority(singleton,generation,gate_device,gate_inode,database_device,database_inode,created_at) VALUES (1,?1,?2,?3,?4,?5,?6)", params![generation,dev,ino,i64::try_from(meta.dev()).map_err(|_| rusqlite::Error::InvalidQuery)?,i64::try_from(meta.ino()).map_err(|_| rusqlite::Error::InvalidQuery)?,now])?;
        tx.commit()?;
        Ok(true)
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
    fn v4_migration_wrong_version_rolls_back_without_tables() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();
        let tx = c.transaction().unwrap();
        assert!(
            tx.execute_batch(include_str!("migration_v3_v4.sql"))
                .is_err()
        );
        drop(tx);
        let version: i32 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        let count: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'session_search_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((version, count), (2, 0));
    }

    #[test]
    fn v4_migration_rolls_back_after_fts_creation_fails_later() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", 3).unwrap();
        c.execute_batch("CREATE TABLE session_search_state (existing TEXT)")
            .unwrap();
        let tx = c.transaction().unwrap();
        assert!(
            tx.execute_batch(include_str!("migration_v3_v4.sql"))
                .is_err()
        );
        drop(tx);
        let version: i32 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        let count: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='session_search_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((version, count), (3, 0));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn migrated_v4_reopens_and_fences_old_v3_writer() {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        let root = std::env::temp_dir().join(format!(
            "herder-search-v4-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _cleanup = Cleanup(root.clone());
        let path = root.join("state.db");
        let initial = Writer::create_file(&path).unwrap();
        drop(initial);
        let mut migration = Connection::open(&path).unwrap();
        for script in [
            include_str!("migration_v1_v2.sql"),
            include_str!("migration_v2_v3.sql"),
        ] {
            let tx = migration.transaction().unwrap();
            tx.execute_batch(script).unwrap();
            tx.commit().unwrap();
        }
        let gate_path = root.join("gate");
        let gate_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&gate_path)
            .unwrap();
        let meta = gate_file.metadata().unwrap();
        let gate =
            crate::application::target_gate::acquire_pinned(&gate_path, meta.dev(), meta.ino())
                .unwrap();
        let mut provision = Writer::open_file(&path).unwrap();
        assert!(
            provision
                .initialize_fresh_stop_authority(&gate, "generation", "now")
                .unwrap()
        );
        provision
            .insert_task("kept", "p", "prepared", "now")
            .unwrap();
        drop(provision);
        let old = Writer::open_file(&path).unwrap();
        Writer::open_file(&path)
            .unwrap()
            .migrate_search_v4(&gate)
            .unwrap();
        assert!(
            old.insert_task("old-write", "p", "prepared", "now")
                .is_err()
        );
        drop(old);
        let mut fresh = Writer::open_file(&path).expect("valid v4 should reopen");
        fresh
            .insert_task("new-write", "p", "prepared", "now")
            .unwrap();
        let kept: i64 = fresh
            .connection
            .query_row("SELECT count(*) FROM tasks WHERE task_id='kept'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, 1);
        let address = crate::domain::address::SessionAddress {
            instance: crate::domain::address::InstanceRef {
                node: crate::domain::address::NodeRef("n".into()),
                instance_id: "i".into(),
            },
            native_session_id: "native".into(),
        };
        crate::search::index::update_session(
            fresh.connection_mut(),
            &address,
            "snapshot",
            "hello indexed",
            false,
        )
        .unwrap();
        let count: i64 = fresh
            .connection
            .query_row(
                "SELECT count(*) FROM session_search_fts WHERE session_search_fts MATCH 'indexed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(fresh);
        migration
            .execute_batch("DROP TRIGGER v4_search_state_update_fence")
            .unwrap();
        assert!(
            Writer::open_file(&path).is_err(),
            "missing v4 fence must fail schema identity"
        );
    }

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
