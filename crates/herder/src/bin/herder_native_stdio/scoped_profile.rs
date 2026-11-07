//! Trusted local launch profile for an already provisioned scoped authority.
//! Opening does not migrate, create a database, or authorize an MCP caller.
use herder::{
    application::{scoped_stop::ScopedAuthority, target_gate::acquire_pinned},
    store::Writer,
};
use serde::Deserialize;
use std::{
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    database: PathBuf,
    gate: PathBuf,
    generation: String,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "invalid or untrusted scoped launch profile",
    )
}

/// The profile is a local protected file, not MCP arguments or request metadata.
/// Its authority remains subject to the normal generation and hold rechecks.
pub fn open(path: &Path) -> Result<ScopedAuthority, Box<dyn std::error::Error>> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let uid = unsafe { geteuid() };
    let parent = path.parent().ok_or_else(invalid)?;
    let dir = parent.metadata()?;
    if !path.is_absolute()
        || parent.canonicalize()? != parent
        || !dir.is_dir()
        || dir.uid() != uid
        || dir.mode() & 0o077 != 0
    {
        return Err(invalid().into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(0x20000)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != uid
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.len() > 16384
    {
        return Err(invalid().into());
    }
    let mut json = String::new();
    (&mut file).take(16385).read_to_string(&mut json)?;
    if json.len() > 16384 {
        return Err(invalid().into());
    }
    let p: Profile = serde_json::from_str(&json)?;
    if p.database.parent() != Some(parent)
        || p.gate.parent() != Some(parent)
        || p.generation.is_empty()
        || p.generation.len() > 4096
        || p.generation.chars().any(char::is_control)
    {
        return Err(invalid().into());
    }
    let gm = std::fs::symlink_metadata(&p.gate)?;
    let _guard = acquire_pinned(&p.gate, gm.dev(), gm.ino())?;
    let dm = std::fs::symlink_metadata(&p.database)?;
    if !dm.is_file()
        || dm.uid() != uid
        || dm.nlink() != 1
        || dm.mode() & 0o077 != 0
        || p.database.canonicalize()? != p.database
    {
        return Err(invalid().into());
    }
    let _writer = Writer::open_file(&p.database)?;
    // Read the immutable authority binding from the same SQLite store while
    // holding its pinned gate. No registry or alternate state is created.
    let db = rusqlite::Connection::open_with_flags(
        &p.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let row: (String, i64, i64, i64, i64) = db.query_row("SELECT generation,gate_device,gate_inode,database_device,database_inode FROM humanstop_authority WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if row
        != (
            p.generation.clone(),
            gm.dev().try_into()?,
            gm.ino().try_into()?,
            dm.dev().try_into()?,
            dm.ino().try_into()?,
        )
    {
        return Err(invalid().into());
    }
    ScopedAuthority::new(p.database, p.gate, p.generation).map_err(|_| invalid().into())
}
