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
