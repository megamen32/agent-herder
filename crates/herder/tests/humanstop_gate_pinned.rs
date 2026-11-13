#![cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "../src/application/target_gate.rs"]
mod target_gate;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, symlink},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn pinned_gate_rejects_replaced_linked_or_public_inode_and_serializes() {
    let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "herder-pinned-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let _dir = Dir(path.clone());
    let gate = path.join("gate");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&gate)
        .unwrap();
    let m = file.metadata().unwrap();
    let (dev, ino) = (m.dev(), m.ino());
    let guard = target_gate::acquire_pinned(&gate, dev, ino).unwrap();
    assert_eq!(
        target_gate::acquire_pinned(&gate, dev, ino)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(guard);
    assert!(target_gate::acquire_pinned(&gate, dev, ino + 1).is_err());
    let link = path.join("hardlink");
    fs::hard_link(&gate, &link).unwrap();
    assert!(target_gate::acquire_pinned(&gate, dev, ino).is_err());
    fs::remove_file(&link).unwrap();
    let symlink_path = path.join("symbolic");
    symlink(&gate, &symlink_path).unwrap();
    assert!(target_gate::acquire_pinned(&symlink_path, dev, ino).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(target_gate::acquire_pinned(&gate, dev, ino).is_err());
}

#[test]
fn guard_drop_unlocks_even_when_descriptor_was_inherited() {
    let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "herder-gate-dup-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    let _dir = Dir(path.clone());
    let gate = path.join("gate");
    let descriptor = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&gate)
        .unwrap();
    let inherited = descriptor.try_clone().unwrap();
    let guard = target_gate::try_acquire(descriptor).unwrap();
    drop(guard);
    let independent = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&gate)
        .unwrap();
    assert!(
        target_gate::try_acquire(independent).is_ok(),
        "released guard must not leave inherited descriptor holding the lock"
    );
    drop(inherited);
}
