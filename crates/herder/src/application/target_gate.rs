//! A provisional interprocess lock primitive, not wired into dispatch or stop.
//!
//! Only a trusted authority may open and bind this file to a canonical scope.
//! All stop/release/dispatch writers for overlapping scopes must use the same
//! stable inode. This module does not resolve aliases, provision files, protect
//! their parent directory, or prove authority generation. None of those claims
//! can be inferred from a path, caller input, file lock, or a fresh process.
use std::{fs::File, io};

/// Owns the OS lock until dropped. Do not hold a database transaction while
/// waiting for a native submit. A released lock is not proof that an earlier
/// native write did not occur: reconcile durable UNKNOWN before any retry.
pub struct TargetGateGuard {
    _file: File,
}

/// A verified pin; unlike the raw fixture guard it cannot be constructed
/// without the inode, ownership and permission checks below.
#[cfg(target_os = "linux")]
pub struct PinnedTargetGateGuard {
    guard: TargetGateGuard,
    path: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl PinnedTargetGateGuard {
    pub(crate) fn identity(&self) -> io::Result<(u64, u64)> {
        use std::os::unix::fs::MetadataExt;
        let m = self.guard._file.metadata()?;
        Ok((m.dev(), m.ino()))
    }

    pub(crate) fn directory(&self) -> &std::path::Path {
        self.path.parent().expect("checked absolute gate path")
    }

    pub(crate) fn owner(&self) -> io::Result<u32> {
        use std::os::unix::fs::MetadataExt;
        Ok(self.guard._file.metadata()?.uid())
    }
}

/// Nonblocking acquisition; a busy or unavailable gate is not permission to
/// dispatch. `file` must be opened independently by the trusted authority for
/// each process and refer to the same permanently retained guard inode.
pub fn try_acquire(file: File) -> io::Result<TargetGateGuard> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
        std::fs::TryLockError::Error(error) => error,
    })?;
    Ok(TargetGateGuard { _file: file })
}

/// Open only a pre-provisioned, singly linked gate under a private directory.
/// Expected device/inode must be loaded from the same authoritative SQLite
/// store, never supplied by an MCP request. Linux only; callers must still
/// recheck authority and holds under the acquired guard before a native write.
#[cfg(target_os = "linux")]
pub fn acquire_pinned(
    path: &std::path::Path,
    device: u64,
    inode: u64,
) -> io::Result<PinnedTargetGateGuard> {
    acquire_pinned_inner(path, device, inode, false)
}

/// Wait for the same pinned gate, without polling, before recording a stop.
#[cfg(target_os = "linux")]
pub fn acquire_pinned_wait(
    path: &std::path::Path,
    device: u64,
    inode: u64,
) -> io::Result<PinnedTargetGateGuard> {
    acquire_pinned_inner(path, device, inode, true)
}

#[cfg(target_os = "linux")]
fn acquire_pinned_inner(
    path: &std::path::Path,
    device: u64,
    inode: u64,
    wait: bool,
) -> io::Result<PinnedTargetGateGuard> {
    use std::{
        fs::OpenOptions,
        os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    };
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let invalid = || io::Error::new(io::ErrorKind::PermissionDenied, "untrusted scoped gate");
    let parent = path.parent().ok_or_else(invalid)?;
    if !path.is_absolute()
        || parent.canonicalize()? != parent
        || path.file_name().is_none_or(|n| n.as_bytes().is_empty())
    {
        return Err(invalid());
    }
    let directory = parent.metadata()?;
    if !directory.is_dir()
        || directory.uid() != unsafe { geteuid() }
        || directory.mode() & 0o077 != 0
    {
        return Err(invalid());
    }
    // Linux O_NOFOLLOW: reject a symlink at the last component.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(0x20000)
        .open(path)?;
    let check = |metadata: std::fs::Metadata| {
        metadata.is_file()
            && metadata.uid() == unsafe { geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1
            && metadata.dev() == device
            && metadata.ino() == inode
    };
    if !check(file.metadata()?) || !check(std::fs::symlink_metadata(path)?) {
        return Err(invalid());
    }
    let guard = if wait {
        file.lock()?;
        TargetGateGuard { _file: file }
    } else {
        try_acquire(file)?
    };
    if !check(guard._file.metadata()?) || !check(std::fs::symlink_metadata(path)?) {
        return Err(invalid());
    }
    Ok(PinnedTargetGateGuard {
        guard,
        path: path.to_owned(),
    })
}
