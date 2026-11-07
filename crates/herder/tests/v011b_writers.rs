use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn compiled_old_writer_is_fenced_and_failed_intent_rolls_back() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture = root.join("tests/v011b/Cargo.toml");
    let tmp = std::env::temp_dir().join(format!(
        "herder-v011b-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&tmp).unwrap();
    let target = tmp.join("target");
    let status = Command::new(env!("CARGO"))
        .args(["build", "--locked", "--manifest-path"])
        .arg(&fixture)
        .args(["--target-dir"])
        .arg(&target)
        .status()
        .unwrap();
    assert!(status.success());
    let db = tmp.join("test.sqlite");
    let mut old = Command::new(target.join("debug/old"))
        .arg(&db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(old.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ready");
    assert!(
        Command::new(target.join("debug/new"))
            .arg(&db)
            .status()
            .unwrap()
            .success()
    );
    writeln!(old.stdin.take().unwrap(), "write").unwrap();
    line.clear();
    out.read_line(&mut line).unwrap();
    assert!(
        line.contains("fenced: unsupported schema version for writer"),
        "{line}"
    );
    assert!(old.wait().unwrap().success());
    let connection = rusqlite::Connection::open(&db).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 2);
    let tasks: Vec<String> = connection
        .prepare("SELECT task_id FROM tasks ORDER BY task_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(tasks, ["before", "v2"]);
    let intents: i64 = connection
        .query_row("SELECT count(*) FROM intents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(intents, 0);
    drop(connection);
    std::fs::remove_dir_all(tmp).unwrap();
}
