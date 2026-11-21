use super::{
    MAX_AGE_MS, MAX_STARTS_PER_TICK, PAGE_SIZE, Scan, SessionRecovery, now_ms, recent, utc_now,
};
use crate::application::scoped_stop::GateError;
use crate::application::scoped_stop::registration::{BoundedSessionProbe, RegistrationRequest};
use crate::auth::identity::{ConnectionIdentity, Grant, PrincipalId};
use crate::domain::{
    adapter::ReadError,
    address::{SessionAddress, SessionRef},
};
use rusqlite::{OptionalExtension, params};
use std::{
    collections::{BTreeSet, VecDeque},
    sync::Arc,
    time::Instant,
};

/// A page from this owner's native instance, ordered by last activity.
pub struct RecoveryPage {
    /// Native ID and Unix milliseconds of last activity.
    pub sessions: Vec<(String, u64)>,
    pub next_cursor: Option<String>,
}

impl RecoveryPage {
    fn recent_window(mut self, now: u64) -> Self {
        let oldest = now.saturating_sub(MAX_AGE_MS);
        // Both native indices order by updated time across pages. Only a
        // nonempty page wholly below the time window proves the end of it.
        if !self.sessions.is_empty() && self.sessions.iter().all(|(_, t)| *t < oldest) {
            self.next_cursor = None;
        }
        self.sessions.retain(|(_, t)| (oldest..=now).contains(t));
        self
    }
}

pub trait RecoveryListing: BoundedSessionProbe + Send + Sync {
    fn list_recent(&self, cursor: Option<&str>, limit: u32) -> Result<RecoveryPage, ReadError>;
    /// Prove the ID is missing on this instance or outside its native namespace.
    /// An unavailable reader cannot release the compatibility writer.
    fn confirms_absence(&self, native_id: &str) -> bool;
}

#[derive(Clone)]
pub struct RecoveryDiscovery {
    listing: Arc<dyn RecoveryListing>,
    grants: Vec<Grant>,
}

impl RecoveryDiscovery {
    pub fn new(listing: Arc<dyn RecoveryListing>, grants: Vec<Grant>) -> Self {
        Self { listing, grants }
    }
}

#[derive(Default)]
pub(super) struct NativePages {
    cursor: Option<String>,
    pending: VecDeque<(String, u64)>,
    cursor_failures: u8,
    ticks_since_head: u8,
}

impl NativePages {
    fn in_progress(&self) -> bool {
        !self.pending.is_empty() || self.cursor.is_some()
    }

    fn tick(
        &mut self,
        list: impl FnMut(Option<&str>) -> Result<RecoveryPage, ReadError>,
        deadline: Instant,
        visit: impl FnMut(&str, u64) -> bool,
    ) {
        // Recheck the head during a long sweep. Its page and budget never
        // replace the saved cursor or the unprocessed suffix of the regular scan.
        if self.in_progress() && self.ticks_since_head >= 4 {
            self.ticks_since_head = 0;
            Self::default().visit(list, 1, deadline, visit);
        } else {
            self.ticks_since_head = if self.in_progress() {
                self.ticks_since_head + 1
            } else {
                0
            };
            self.visit(list, 4, deadline, visit);
        }
    }

    fn visit(
        &mut self,
        mut list: impl FnMut(Option<&str>) -> Result<RecoveryPage, ReadError>,
        page_budget: usize,
        deadline: Instant,
        mut visit: impl FnMut(&str, u64) -> bool,
    ) {
        let mut pages = 0;
        let mut inspected = 0;
        while Instant::now() < deadline && inspected < PAGE_SIZE {
            if let Some((id, updated)) = self.pending.pop_front() {
                inspected += 1;
                if visit(&id, updated) || !self.in_progress() {
                    return;
                }
                continue;
            }
            if pages == page_budget {
                return;
            }
            let Ok(mut page) = list(self.cursor.as_deref()) else {
                // Retry the same page after a busy reader. A repeatedly rejected
                // cursor (e.g. after a native restart) needs a fresh traversal.
                self.cursor_failures += 1;
                if self.cursor_failures >= 3 {
                    self.cursor = None;
                    self.cursor_failures = 0;
                }
                return;
            };
            self.cursor_failures = 0;
            pages += 1;
            if page.sessions.len() > PAGE_SIZE as usize {
                self.cursor = None;
                return;
            }
            self.cursor = page
                .next_cursor
                .filter(|v| !v.is_empty() && Some(v) != self.cursor.as_ref());
            page.sessions
                .sort_by_key(|(_, updated)| std::cmp::Reverse(*updated));
            self.pending = page.sessions.into();
            if !self.in_progress() {
                return;
            }
        }
    }
}

impl SessionRecovery {
    pub(super) fn recover_cohort(
        &self,
        identity: &ConnectionIdentity,
        principal: &PrincipalId,
        ids: &BTreeSet<String>,
        offset: &mut usize,
        deadline: Instant,
        start_limit: u32,
    ) {
        let mut starts = 0;
        for id in ids.iter().skip(*offset).take(PAGE_SIZE as usize) {
            if Instant::now() >= deadline || starts >= start_limit {
                break;
            }
            *offset += 1;
            if self
                .recover_listed(identity, principal, id)
                .unwrap_or(false)
            {
                starts += 1;
            }
        }
        if *offset == ids.len() {
            *offset = 0;
        }
    }

    pub(super) fn discover_scope(
        &self,
        identity: &ConnectionIdentity,
        principal: &PrincipalId,
        scan: &mut Scan,
        deadline: Instant,
    ) {
        let ids = self
            .profile
            .legacy_handoff
            .as_ref()
            .and_then(|h| h.cohort());
        let Some(ids) = ids else {
            self.discover(
                identity,
                principal,
                &mut scan.native,
                deadline,
                MAX_STARTS_PER_TICK,
            );
            return;
        };
        // Each source keeps its own cursor and half the starts. A slow native
        // operation can overrun its deadline, so alternate who gets to go first.
        let now = Instant::now();
        let halfway = now + deadline.saturating_duration_since(now) / 2;
        let half = MAX_STARTS_PER_TICK / 2;
        let native_first = scan.workspaces_first;
        scan.workspaces_first = !native_first;
        if native_first {
            self.discover(identity, principal, &mut scan.native, halfway, half);
        }
        self.recover_cohort(
            identity,
            principal,
            ids,
            &mut scan.cohort_offset,
            if native_first { deadline } else { halfway },
            MAX_STARTS_PER_TICK - half,
        );
        if !native_first {
            self.discover(identity, principal, &mut scan.native, deadline, half);
        }
    }

    fn discover(
        &self,
        identity: &ConnectionIdentity,
        principal: &PrincipalId,
        scan: &mut NativePages,
        deadline: Instant,
        start_limit: u32,
    ) {
        let listing = self.discovery.listing.as_ref();
        if listing.instance() != self.control.instance()
            || listing.harness() != self.control.harness()
        {
            return;
        }
        let mut starts = 0;
        let Some(now) = now_ms() else { return };
        let exact = self
            .profile
            .legacy_handoff
            .as_ref()
            .and_then(|h| h.cohort());
        let visit = |id: &str, updated| {
            // Explicit IDs have their own cursor, including IDs absent from
            // the native recent page.
            if !exact.is_some_and(|ids| ids.contains(id))
                && recent(updated)
                && self
                    .recover_listed(identity, principal, id)
                    .unwrap_or(false)
            {
                starts += 1;
            }
            starts >= start_limit
        };
        scan.tick(
            |cursor| {
                listing
                    .list_recent(cursor, PAGE_SIZE)
                    .map(|p| p.recent_window(now))
            },
            deadline,
            visit,
        );
    }

    fn recover_listed(
        &self,
        identity: &ConnectionIdentity,
        principal: &PrincipalId,
        id: &str,
    ) -> Result<bool, GateError> {
        let Some(handoff) = &self.profile.legacy_handoff else {
            return Ok(false);
        };
        let probe = self.discovery.listing.as_ref();
        if probe.instance() != self.control.instance() || probe.harness() != self.control.harness()
        {
            return Ok(false);
        }
        let address = SessionAddress {
            instance: self.control.instance().clone(),
            native_session_id: id.into(),
        };
        if !handoff
            .owns_native(probe.harness(), &address)
            .map_err(|_| GateError::Unavailable)?
        {
            return Ok(false);
        }
        // A registered target still reconciles outstanding receipts even while
        // a stop is held. The ordinary recover path revalidates its owner grants.
        let registered = {
            let (_gate, writer) = self.authority.lock()?;
            writer.connection().query_row(
                "SELECT session_ref FROM session_bindings WHERE node_ref=?1 AND instance_id=?2 AND native_session_id=?3",
                params![address.instance.node.0, address.instance.instance_id, id], |row| row.get(0).map(SessionRef),
            ).optional().map_err(|_| GateError::Store)?
        };
        if let Some(session) = registered {
            return self.recover(identity, principal, &session);
        }
        let session = match self.waits.recovery_binding(identity, &address)? {
            Some(session) => session,
            None => {
                let Some((_, boundary)) = self.eligible_boundary(&address)? else {
                    return Ok(false);
                };
                // The ordinary gate requires a verified binding for every native parent.
                for ancestor in &boundary.ancestors {
                    if ancestor.address.instance != address.instance {
                        return Err(GateError::Invalid);
                    }
                    if self
                        .waits
                        .recovery_binding(identity, &ancestor.address)?
                        .is_none()
                    {
                        self.register_discovered(identity, &ancestor.address)?;
                    }
                }
                self.register_discovered(identity, &address)?
            }
        };
        self.recover(identity, principal, &session)
    }

    fn register_discovered(
        &self,
        identity: &ConnectionIdentity,
        address: &SessionAddress,
    ) -> Result<SessionRef, GateError> {
        let harness = self.control.harness();
        if self
            .profile
            .legacy_handoff
            .as_ref()
            .is_none_or(|h| !h.owns_native(harness, address).unwrap_or(false))
            || self
                .profile
                .recovery_held(harness, &address.native_session_id, None)
        {
            return Err(GateError::Unavailable);
        }
        let key = format!("{harness}-recovery-register:{}", address.native_session_id);
        let now = utc_now().map_err(|_| GateError::Unavailable)?;
        self.authority
            .register_existing(
                identity,
                &self.discovery.grants,
                self.discovery.listing.as_ref(),
                RegistrationRequest {
                    native_session_id: &address.native_session_id,
                    workspace: None,
                    request_key: &key,
                    now: &now,
                },
            )
            .map(|r| SessionRef(r.session_ref))
            .map_err(|_| GateError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn only_an_entirely_old_native_page_ends_the_recent_window() {
        let now = MAX_AGE_MS + 100;
        let page = |times: &[u64]| {
            RecoveryPage {
                sessions: times.iter().map(|t| (t.to_string(), *t)).collect(),
                next_cursor: Some("next".into()),
            }
            .recent_window(now)
        };
        let mixed = page(&[now + 1, 100, 99]);
        assert_eq!(mixed.sessions, [("100".into(), 100)]);
        assert!(mixed.next_cursor.is_some());
        assert!(page(&[]).next_cursor.is_some());
        assert!(page(&[99, 98]).next_cursor.is_none());
    }

    #[test]
    fn busy_reader_and_start_limit_preserve_the_page_tail_while_new_activity_is_rechecked() {
        let mut scan = NativePages::default();
        let mut busy = true;
        let mut visited = Vec::new();
        for tick in 0..30 {
            scan.tick(
                |cursor| {
                    let first = cursor.unwrap_or("0").parse::<u64>().unwrap();
                    if first == 4 && busy {
                        busy = false;
                        return Err(ReadError("reader busy".into()));
                    }
                    // Return a page in tie-breaker order; the newer row must be tried first.
                    let newest = if first == 0 && tick > 0 {
                        "fresh".into()
                    } else {
                        first.to_string()
                    };
                    Ok(RecoveryPage {
                        sessions: vec![
                            ((first + 1).to_string(), 99 - first),
                            (newest, 100 - first),
                        ],
                        next_cursor: (first < 16).then(|| (first + 2).to_string()),
                    })
                },
                Instant::now() + Duration::from_secs(1),
                |id, _| {
                    visited.push(id.to_owned());
                    true // The tick's last available start.
                },
            );
            if visited.last().map(String::as_str) == Some("17") {
                break;
            }
        }
        let fresh = visited.iter().position(|id| id == "fresh").unwrap();
        assert!(fresh > 0 && fresh < visited.len() - 1);
        let numbered: Vec<_> = visited
            .iter()
            .filter_map(|id| id.parse::<u64>().ok())
            .collect();
        assert_eq!(numbered, (0..18).collect::<Vec<_>>());
    }

    #[test]
    fn empty_pages_yield_at_the_page_budget_and_continue_with_the_saved_cursor() {
        let mut scan = NativePages::default();
        let mut requests = Vec::new();
        let mut found = Vec::new();
        for _ in 0..3 {
            scan.tick(
                |cursor| {
                    let page = cursor.unwrap_or("0").parse::<usize>().unwrap();
                    requests.push(page);
                    Ok(RecoveryPage {
                        sessions: if page == 9 {
                            vec![("late".into(), 1)]
                        } else {
                            vec![]
                        },
                        next_cursor: (page < 9).then(|| (page + 1).to_string()),
                    })
                },
                Instant::now() + Duration::from_secs(1),
                |id, _| {
                    found.push(id.to_owned());
                    false
                },
            );
        }
        assert_eq!(requests, (0..10).collect::<Vec<_>>());
        assert_eq!(found, ["late"]);
        assert!(!scan.in_progress());
    }
}
