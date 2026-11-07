use herder::{application::target_gate::acquire_pinned, store::Writer};
use rusqlite::{Connection, functions::FunctionFlags};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
// Match the protected profile path policy before creating any authority files.
fn validate_protected_root(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let uid = unsafe { libc::geteuid() };
    if path.canonicalize()?.as_os_str() != path.as_os_str() {
        return Err("protected root must be canonical, without symlinks".into());
    }
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor)?;
        if !meta.is_dir() || (meta.uid() != uid && meta.uid() != 0) || meta.mode() & 0o022 != 0 {
            return Err("untrusted protected root or ancestor".into());
        }
    }
    let root = fs::symlink_metadata(path)?;
    if root.uid() != uid || root.mode() & 0o077 != 0 {
        return Err("protected root must be caller-owned and private".into());
    }
    Ok(())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protected = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("protected home required")?,
    );
    if !protected.is_absolute()
        || protected.file_name().and_then(|s| s.to_str()) != Some("herder-owner-home")
    {
        return Err("unexpected protected root".into());
    }
    validate_protected_root(&protected)?;
    let authority = protected.join("authority");
    fs::DirBuilder::new().mode(0o700).create(&authority)?;
    let db = authority.join("state.db");
    let gate_path = authority.join("gate");
    let seed_path = authority.join("seed.json");
    let gate = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&gate_path)?;
    let gm = gate.metadata()?;
    let pin = acquire_pinned(&gate_path, gm.dev(), gm.ino())?;
    drop(Writer::create_file(&db)?);
    let conn = Connection::open(&db)?;
    conn.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(1i32),
    )?;
    conn.execute_batch(include_str!(
        "../../../../crates/herder/src/store/migration_v1_v2.sql"
    ))?;
    conn.create_scalar_function(
        "herder_writer_version",
        0,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(2i32),
    )?;
    conn.execute_batch(include_str!(
        "../../../../crates/herder/src/store/migration_v2_v3.sql"
    ))?;
    drop(conn);
    let mut writer = Writer::open_file(&db)?;
    let generation = format!(
        "ahap-owner-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    if !writer.initialize_fresh_stop_authority(&pin, &generation, "fixture-initialized")? {
        return Err("fresh authority initialization refused".into());
    }
    writer.migrate_search_v4(&pin)?;
    drop(pin);
    drop(gate);
    let seed = serde_json::json!({"database":db,"gate":gate_path,"generation":generation,"profile_seed":seed_path});
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true).mode(0o600);
    use std::io::Write;
    write!(opts.open(&seed_path)?, "{seed}")?;
    println!("{seed}");
    Ok(())
}
