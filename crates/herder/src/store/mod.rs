use rusqlite::{Connection, Result, functions::FunctionFlags, params};

pub mod intents;
pub mod lineage;

const WRITER_VERSION: i32 = 1;
const SCHEMA: &str = include_str!("schema.sql");

/// A v1 writer backed by an isolated, temporary in-memory database.
pub struct Writer {
    connection: Connection,
}

impl Writer {
    /// Create a fresh database; this constructor never opens persistent state.
    pub fn temporary() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.create_scalar_function(
            "herder_writer_version",
            0,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |_| Ok(WRITER_VERSION),
        )?;
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
