use std::io::{self, BufRead, Write};

// Compile the pinned original V011A implementation; current modules have newer dependencies.
mod store {
    include!("../../frozen-v011a/mod.rs");

    impl Writer {
        pub fn test_file(path: &str) -> Result<Self> {
            let connection = Connection::open(path)?;
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

        pub fn rollback_partial(&self) -> Result<()> {
            self.connection.execute_batch("BEGIN")?;
            self.insert_task("rolled-back", "p", "working", "now")?;
            self.connection.execute(
                "INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,created_at,updated_at,retain_until) VALUES ('i','rolled-back','p','t','k','h','prepared','now','now','later')", [],
            )?;
            // An error after both inserts must roll back both rows.
            let failure = self.connection.execute(
                "INSERT INTO intents(intent_id,task_id,principal,target,request_key,payload_hash,state,created_at,updated_at,retain_until) VALUES ('duplicate','rolled-back','p','t','k','h','prepared','now','now','later')", [],
            );
            assert!(failure.is_err());
            self.connection.execute_batch("ROLLBACK")
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("database path");
    let writer = store::Writer::test_file(&path)?;
    writer.insert_task("before", "p", "working", "now")?;
    writer.rollback_partial()?;
    println!("ready");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    assert_eq!(line.trim(), "write");
    let error = writer
        .insert_task("after", "p", "working", "now")
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("unsupported schema version for writer"),
        "{error}"
    );
    println!("fenced: {error}");
    Ok(())
}
