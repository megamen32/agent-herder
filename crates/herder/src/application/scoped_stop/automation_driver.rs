//! One bounded coordinator for all authenticated owner automation modules.
use crate::auth::identity::ConnectionIdentity;
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Weak},
    time::Duration,
};

pub const MAX_AUTOMATION_OWNERS: usize = 64;

/// An idle scan is only a hint. It never takes the authority's exclusive gate
/// and never opens a writer. A stale positive is revalidated by the ordinary
/// reconciliation gates; a stale negative only delays a later scan.
pub(crate) fn has_rule_hint(authority: &super::ScopedAuthority, scope: &str) -> bool {
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    fn read(authority: &super::ScopedAuthority, scope: &str) -> Option<bool> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&authority.db)
            .ok()?;
        let db = file.metadata().ok()?;
        let gate = fs::symlink_metadata(&authority.gate).ok()?;
        if !db.is_file()
            || db.nlink() != 1
            || db.uid() != unsafe { libc::geteuid() }
            || db.mode() & 0o077 != 0
            || !gate.is_file()
            || gate.nlink() != 1
            || gate.uid() != db.uid()
            || gate.mode() & 0o077 != 0
        {
            return None;
        }
        let conn = rusqlite::Connection::open_with_flags(
            &authority.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        conn.busy_timeout(Duration::ZERO).ok()?;
        crate::store::Writer::validate_scoped_schema(&conn).ok()?;
        let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=1 AND generation=?1 AND gate_device=?2 AND gate_inode=?3 AND database_device=?4 AND database_inode=?5)",
            rusqlite::params![authority.generation,i64::try_from(gate.dev()).ok()?,i64::try_from(gate.ino()).ok()?,i64::try_from(db.dev()).ok()?,i64::try_from(db.ino()).ok()?],|r|r.get(0)).ok()?;
        if !bound {
            return None;
        }
        let present=conn.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE scope=?1 AND substr(setting_key,1,5)='rule:')",[scope],|r|r.get(0)).ok()?;
        let named = fs::symlink_metadata(&authority.db).ok()?;
        let gate_now = fs::symlink_metadata(&authority.gate).ok()?;
        if (named.dev(), named.ino()) != (db.dev(), db.ino())
            || (gate_now.dev(), gate_now.ino()) != (gate.dev(), gate.ino())
        {
            return None;
        }
        Some(present)
    }
    read(authority, scope).unwrap_or(false)
}

pub trait AutomationTick: Send + Sync + 'static {
    fn tick<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

pub struct AutomationOwner {
    identity: ConnectionIdentity,
    modules: Vec<Weak<dyn AutomationTick>>,
}
impl AutomationOwner {
    pub fn new(identity: ConnectionIdentity, modules: Vec<Arc<dyn AutomationTick>>) -> Self {
        Self {
            identity,
            modules: modules.iter().map(Arc::downgrade).collect(),
        }
    }
}

/// Each configured owner has at most one in-flight tick. A slow native reader
/// cannot block another owner; native reads must use their bounded blocking port.
pub fn start(owners: Vec<AutomationOwner>) -> io::Result<()> {
    if owners.is_empty() || owners.len() > MAX_AUTOMATION_OWNERS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid automation owner count",
        ));
    }
    tokio::spawn(async move {
        let mut slots: Vec<_> = owners
            .into_iter()
            .map(|owner| (owner, None::<tokio::task::JoinHandle<()>>))
            .collect();
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let mut alive = false;
            for (owner, running) in &mut slots {
                if running.as_ref().is_some_and(|task| !task.is_finished()) {
                    alive = true;
                    continue;
                }
                if let Some(done) = running.take() {
                    let _ = done.await;
                }
                let modules: Vec<_> = owner.modules.iter().filter_map(Weak::upgrade).collect();
                if modules.is_empty() {
                    continue;
                }
                alive = true;
                let identity = owner.identity.clone();
                *running = Some(tokio::spawn(async move {
                    for module in modules {
                        module.tick(&identity).await;
                    }
                }));
            }
            if !alive {
                break;
            }
        }
    });
    Ok(())
}
