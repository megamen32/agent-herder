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
    #[serde(default)]
    owner: Option<OwnerProfile>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerProfile {
    pub principal: String,
    pub node: String,
    pub instance: String,
    pub executable: PathBuf,
    pub code_home: PathBuf,
    pub cwd: PathBuf,
}

pub struct OpenedOwner {
    pub authority: ScopedAuthority,
    pub owner: OwnerProfile,
    pub database: PathBuf,
    pub gate: PathBuf,
    pub generation: String,
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
    Ok(open_profile(path)?.0)
}

/// Explicit opt-in only; an ordinary scoped profile never establishes caller identity.
pub fn open_owner(path: &Path) -> Result<OpenedOwner, Box<dyn std::error::Error>> {
    let (authority, profile) = open_profile(path)?;
    let owner = profile.owner.ok_or_else(invalid)?;
    if [&owner.principal, &owner.node, &owner.instance]
        .iter()
        .any(|s| s.is_empty() || s.len() > 4096 || s.chars().any(char::is_control))
        || !owner.executable.is_absolute()
        || !owner.code_home.is_absolute()
        || !owner.cwd.is_absolute()
    {
        return Err(invalid().into());
    }
    Ok(OpenedOwner {
        authority,
        owner,
        database: profile.database,
        gate: profile.gate,
        generation: profile.generation,
    })
}

fn open_profile(path: &Path) -> Result<(ScopedAuthority, Profile), Box<dyn std::error::Error>> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let uid = unsafe { geteuid() };
    let parent = path.parent().ok_or_else(invalid)?;
    // Root-owned or current-user-owned ancestors must not be replaceable by
    // another user. Same-UID adversaries and concurrent chmod are out of scope.
    for ancestor in parent.ancestors() {
        let m = std::fs::symlink_metadata(ancestor)?;
        if !m.is_dir() || (m.uid() != uid && m.uid() != 0) || m.mode() & 0o022 != 0 {
            return Err(invalid().into());
        }
    }
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
        .custom_flags(0x20000 | 0x800)
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
    // O_NOFOLLOW | O_NONBLOCK prevents symlink and special-file blocking.
    let database = OpenOptions::new()
        .read(true)
        .custom_flags(0x20000 | 0x800)
        .open(&p.database)?;
    let dm = database.metadata()?;
    if !dm.is_file()
        || dm.uid() != uid
        || dm.nlink() != 1
        || dm.mode() & 0o077 != 0
        || p.database.canonicalize()? != p.database
    {
        return Err(invalid().into());
    }
    // Protected ancestors prevent other UIDs from swapping the pathname while
    // SQLite opens it. Pin the file descriptor and compare device/inode again
    // before and after the single read transaction; no same-UID claim is made.
    let db = rusqlite::Connection::open_with_flags(
        &p.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let same = || -> io::Result<bool> {
        let pinned = database.metadata()?;
        let named = std::fs::symlink_metadata(&p.database)?;
        Ok(pinned.is_file()
            && named.is_file()
            && pinned.dev() == dm.dev()
            && pinned.ino() == dm.ino()
            && named.dev() == dm.dev()
            && named.ino() == dm.ino()
            && named.nlink() == 1
            && named.uid() == uid
            && named.mode() & 0o077 == 0)
    };
    if !same()? {
        return Err(invalid().into());
    }
    db.execute_batch("BEGIN")?;
    let opened_path: String = db.query_row(
        "SELECT file FROM pragma_database_list WHERE name='main'",
        [],
        |r| r.get(0),
    )?;
    let opened_metadata = std::fs::symlink_metadata(&opened_path)?;
    if opened_metadata.dev() != dm.dev() || opened_metadata.ino() != dm.ino() {
        return Err(invalid().into());
    }
    Writer::validate_scoped_schema(&db)?;
    let row: (String, i64, i64, i64, i64) = db.query_row("SELECT generation,gate_device,gate_inode,database_device,database_inode FROM humanstop_authority WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    if row
        != (
            p.generation.clone(),
            gm.dev().try_into()?,
            gm.ino().try_into()?,
            dm.dev().try_into()?,
            dm.ino().try_into()?,
        )
        || !same()?
    {
        return Err(invalid().into());
    }
    db.execute_batch("COMMIT")?;
    let authority = ScopedAuthority::new(p.database.clone(), p.gate.clone(), p.generation.clone())
        .map_err(|_| invalid())?;
    Ok((authority, p))
}
