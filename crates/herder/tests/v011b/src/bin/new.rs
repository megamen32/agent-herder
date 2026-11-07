use rusqlite::{Connection, functions::FunctionFlags};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("database path");
    let connection = Connection::open(path)?;
    connection.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(2),
    )?;
    // Synthetic V2 migration: preserve the real V1 guards, raise the version atomically.
    connection.execute_batch("BEGIN EXCLUSIVE; PRAGMA user_version = 2; COMMIT;")?;
    connection.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES ('v2','p','working','now','now')", [])?;
    Ok(())
}
