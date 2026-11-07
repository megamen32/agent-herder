//! Isolated file-lock/barrier fixture only. Not a production authority, task
//! store, native adapter, or proof that every stop/submit writer uses the gate.
#[path = "../src/application/target_gate.rs"]
mod target_gate;
use rusqlite::Connection;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "herder-gate-fixture-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        File::create(path.join("gate")).unwrap();
        let db = Connection::open(path.join("fixture.db")).unwrap();
        db.execute_batch("CREATE TABLE fixture(state TEXT NOT NULL, held INTEGER NOT NULL, writes INTEGER NOT NULL, interrupt_requested INTEGER NOT NULL); INSERT INTO fixture VALUES('prepared',0,0,0)").unwrap();
        Self(path)
    }
    fn db(&self) -> Connection {
        Connection::open(self.0.join("fixture.db")).unwrap()
    }
    fn gate(&self) -> File {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.0.join("gate"))
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn spawn_stop(root: &Path) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_stop_child", "--nocapture"])
        .env("HERDER_TEST_GATE_ROOT", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    (child, input, output)
}
fn signal(out: &mut BufReader<ChildStdout>, expected: &str) {
    let mut s = String::new();
    loop {
        s.clear();
        assert_ne!(
            out.read_line(&mut s).unwrap(),
            0,
            "child ended before signal"
        );
        if s.trim() == expected {
            break;
        }
    }
}
fn stop(child: &mut Child, input: &mut ChildStdin, out: &mut BufReader<ChildStdout>) {
    writeln!(input, "go").unwrap();
    input.flush().unwrap();
    signal(out, "STOPPED");
    assert!(child.wait().unwrap().success());
}
#[test]
fn fixture_stop_child() {
    let Some(root) = std::env::var_os("HERDER_TEST_GATE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("gate"))
        .unwrap();
    let guard = match target_gate::try_acquire(file) {
        Ok(g) => {
            println!("ACQUIRED");
            g
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            println!("BUSY");
            std::io::stdout().flush().unwrap();
            let mut s = String::new();
            std::io::stdin().read_line(&mut s).unwrap();
            target_gate::try_acquire(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(root.join("gate"))
                    .unwrap(),
            )
            .unwrap()
        }
        Err(e) => panic!("{e}"),
    };
    println!("STOP_READY");
    std::io::stdout().flush().unwrap();
    let mut s = String::new();
    std::io::stdin().read_line(&mut s).unwrap();
    let db = Connection::open(root.join("fixture.db")).unwrap();
    db.execute(
        "UPDATE fixture SET held=1,interrupt_requested=CASE WHEN writes>0 THEN 1 ELSE 0 END",
        [],
    )
    .unwrap();
    drop(db);
    drop(guard);
    println!("STOPPED");
    std::io::stdout().flush().unwrap();
}
#[test]
fn stop_before_claim_survives_reopen_and_denies_fake_submit() {
    let f = Fixture::new();
    let (mut child, mut input, mut output) = spawn_stop(&f.0);
    signal(&mut output, "ACQUIRED");
    signal(&mut output, "STOP_READY");
    stop(&mut child, &mut input, &mut output);
    let gate = target_gate::try_acquire(f.gate()).unwrap();
    let db = f.db();
    let held: i64 = db
        .query_row("SELECT held FROM fixture", [], |r| r.get(0))
        .unwrap();
    assert_eq!(held, 1);
    if held == 0 {
        db.execute("UPDATE fixture SET writes=writes+1", [])
            .unwrap();
    }
    assert_eq!(
        db.query_row("SELECT writes FROM fixture", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(db);
    drop(gate);
    assert_eq!(
        f.db()
            .query_row("SELECT held FROM fixture", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn stop_between_claim_and_handoff_denies_fake_submit() {
    let f = Fixture::new();
    f.db()
        .execute("UPDATE fixture SET state='claimed'", [])
        .unwrap();
    let (mut child, mut input, mut output) = spawn_stop(&f.0);
    signal(&mut output, "ACQUIRED");
    signal(&mut output, "STOP_READY");
    stop(&mut child, &mut input, &mut output);
    let _gate = target_gate::try_acquire(f.gate()).unwrap();
    let db = f.db();
    let held: i64 = db
        .query_row("SELECT held FROM fixture", [], |r| r.get(0))
        .unwrap();
    if held == 0 {
        db.execute("UPDATE fixture SET writes=writes+1", [])
            .unwrap();
    } else {
        db.execute("UPDATE fixture SET state='cancelled'", [])
            .unwrap();
    }
    let result: (String, i64) = db
        .query_row("SELECT state,writes FROM fixture", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(result, ("cancelled".into(), 0));
}
#[test]
fn handoff_wins_stop_requests_interrupt_and_unknown_never_retries() {
    use std::{io::Read, os::unix::net::UnixStream};
    let f = Fixture::new();
    let gate = target_gate::try_acquire(f.gate()).unwrap();
    let db = f.db();
    let (mut child, mut input, mut output) = spawn_stop(&f.0);
    signal(&mut output, "BUSY");
    // A test transport really receives bytes while the stop process is blocked.
    // This is not a Codex wire or evidence of model admission.
    let (mut writer, mut receiver) = UnixStream::pair().unwrap();
    writer.write_all(b"input").unwrap();
    let mut received = [0; 5];
    receiver.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"input");
    db.execute("UPDATE fixture SET state='unknown',writes=1", [])
        .unwrap();
    drop(gate);
    writeln!(input, "retry").unwrap();
    input.flush().unwrap();
    signal(&mut output, "STOP_READY");
    stop(&mut child, &mut input, &mut output);
    drop(db);
    let db = f.db();
    let result: (String, i64, i64, i64) = db
        .query_row(
            "SELECT state,writes,held,interrupt_requested FROM fixture",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(result, ("unknown".into(), 1, 1, 1));
}
