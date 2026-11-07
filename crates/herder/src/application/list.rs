//! Pure listing of caller-supplied cached snapshots and availability observations.
use std::num::NonZeroUsize;

use crate::domain::{
    adapter::SessionSnapshot,
    address::{Availability, InstanceRef},
};

/// Project references are stable identifiers, not display names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedSession {
    pub project_ref: Option<String>,
    pub snapshot: SessionSnapshot,
    /// Time this cached record was observed, if known; it is not a live read.
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceCoverage {
    Complete,
    Incomplete,
    Unknown,
}

/// An independently supplied observation, not a property inferred from records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceAvailability {
    pub instance: InstanceRef,
    pub availability: Availability,
    pub observed_at: Option<String>,
    /// Coverage of the source enumeration, independently of cached records.
    pub coverage: SourceCoverage,
}

/// Owns one filtered view, so later cache changes cannot shift its offsets.
#[derive(Debug, Clone)]
pub struct SessionListSnapshot {
    sessions: Vec<CachedSession>,
    availability: Vec<InstanceAvailability>,
    missing_sources: Vec<InstanceRef>,
    coverage_complete: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SnapshotPage<'a> {
    pub sessions: Vec<&'a CachedSession>,
    pub availability: Vec<&'a InstanceAvailability>,
    pub missing_sources: Vec<&'a InstanceRef>,
    pub coverage_complete: bool,
    pub next_offset: Option<usize>,
}

impl SessionListSnapshot {
    /// `expected_sources` must be the caller's authoritative source inventory.
    /// Coverage is conservative and applies to every page, not just its records.
    pub fn new(
        sessions: &[CachedSession],
        availability: &[InstanceAvailability],
        expected_sources: &[InstanceRef],
        project_ref: Option<&str>,
        instance: Option<&InstanceRef>,
    ) -> Self {
        let sessions: Vec<CachedSession> = sessions
            .iter()
            .filter(|record| {
                project_ref.is_none_or(|project| record.project_ref.as_deref() == Some(project))
                    && instance.is_none_or(|wanted| &record.snapshot.address.instance == wanted)
            })
            .cloned()
            .collect();
        let availability: Vec<_> = availability
            .iter()
            .filter(|o| instance.is_none_or(|wanted| &o.instance == wanted))
            .cloned()
            .collect();
        let expected: Vec<_> = expected_sources
            .iter()
            .filter(|s| instance.is_none_or(|wanted| *s == wanted))
            .collect();
        let missing_sources: Vec<_> = expected
            .iter()
            .filter(|source| !availability.iter().any(|o| &o.instance == **source))
            .map(|source| (*source).clone())
            .collect();
        let coverage_complete = !expected.is_empty()
            && missing_sources.is_empty()
            && sessions
                .iter()
                .all(|s| expected.contains(&&s.snapshot.address.instance))
            && availability.iter().all(|o| {
                expected.contains(&&o.instance)
                    && o.availability == Availability::Available
                    && o.coverage == SourceCoverage::Complete
                    && o.observed_at.is_some()
            });
        Self {
            sessions,
            availability,
            missing_sources,
            coverage_complete,
        }
    }

    pub fn page(&self, offset: usize, limit: NonZeroUsize) -> SnapshotPage<'_> {
        let mut remaining = self.sessions.iter().skip(offset);
        let sessions: Vec<_> = remaining.by_ref().take(limit.get()).collect();
        let next_offset = if remaining.next().is_some() {
            offset.checked_add(sessions.len())
        } else {
            None
        };
        SnapshotPage {
            sessions,
            availability: self.availability.iter().collect(),
            missing_sources: self.missing_sources.iter().collect(),
            coverage_complete: self.coverage_complete,
            next_offset,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SessionPage<'a> {
    pub sessions: Vec<&'a CachedSession>,
    /// Observations are independent of pagination and the project filter.
    pub availability: Vec<&'a InstanceAvailability>,
    pub next_offset: Option<usize>,
}

/// Filter exact project and complete node-scoped instance identities, then page
/// in input order. Offsets apply to that filtered sequence; callers must retain
/// the same cache view and filters between pages. No native state is accessed.
pub fn list_cached_sessions<'a>(
    sessions: &'a [CachedSession],
    availability: &'a [InstanceAvailability],
    project_ref: Option<&str>,
    instance: Option<&InstanceRef>,
    offset: usize,
    limit: NonZeroUsize,
) -> SessionPage<'a> {
    let mut matches = sessions
        .iter()
        .filter(|record| {
            project_ref.is_none_or(|project| record.project_ref.as_deref() == Some(project))
                && instance.is_none_or(|wanted| &record.snapshot.address.instance == wanted)
        })
        .skip(offset);
    let page: Vec<_> = matches.by_ref().take(limit.get()).collect();
    let next_offset = if matches.next().is_some() {
        offset.checked_add(page.len())
    } else {
        None
    };
    SessionPage {
        sessions: page,
        availability: availability
            .iter()
            .filter(|observation| instance.is_none_or(|wanted| &observation.instance == wanted))
            .collect(),
        next_offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        adapter::SessionActivity,
        address::{NodeRef, SessionAddress},
    };

    fn instance(node: &str) -> InstanceRef {
        InstanceRef {
            node: NodeRef(node.into()),
            instance_id: "same-name".into(),
        }
    }

    fn record(project: &str, node: &str, native_id: &str) -> CachedSession {
        CachedSession {
            project_ref: Some(project.into()),
            observed_at: None,
            snapshot: SessionSnapshot {
                address: SessionAddress {
                    instance: instance(node),
                    native_session_id: native_id.into(),
                },
                human_stop: false,
                activity: SessionActivity::Unknown,
                capabilities: vec![],
            },
        }
    }

    #[test]
    fn filters_full_identity_before_pagination_without_conflating_names() {
        let records = vec![
            record("p1", "a", "same"),
            record("p1", "b", "same"),
            record("p2", "a", "same"),
            record("p1", "a", "next"),
        ];
        let limit = NonZeroUsize::new(1).unwrap();
        let a = instance("a");
        let first = list_cached_sessions(&records, &[], Some("p1"), Some(&a), 0, limit);
        assert_eq!(first.sessions, vec![&records[0]]);
        assert_eq!(first.next_offset, Some(1));
        let second = list_cached_sessions(
            &records,
            &[],
            Some("p1"),
            Some(&a),
            first.next_offset.unwrap(),
            limit,
        );
        assert_eq!(second.sessions, vec![&records[3]]);
        assert_eq!(second.next_offset, None);
        assert!(
            list_cached_sessions(&records, &[], Some("p1"), Some(&a), usize::MAX, limit)
                .sessions
                .is_empty()
        );
        assert_eq!(
            list_cached_sessions(&records, &[], Some("p2"), None, 0, limit).sessions,
            vec![&records[2]]
        );
    }

    #[test]
    fn availability_is_independent_of_cached_records_and_project() {
        let records = vec![record("p1", "a", "s")];
        let observations = vec![
            InstanceAvailability {
                instance: instance("a"),
                availability: Availability::Unavailable,
                observed_at: None,
                coverage: SourceCoverage::Unknown,
            },
            InstanceAvailability {
                instance: instance("b"),
                availability: Availability::Unknown,
                observed_at: None,
                coverage: SourceCoverage::Unknown,
            },
        ];
        let limit = NonZeroUsize::new(2).unwrap();
        let result = list_cached_sessions(&records, &observations, Some("p1"), None, 0, limit);
        assert_eq!(result.sessions, vec![&records[0]]);
        assert_eq!(
            result.availability,
            vec![&observations[0], &observations[1]]
        );
        let b = instance("b");
        let empty =
            list_cached_sessions(&records, &observations, Some("missing"), Some(&b), 0, limit);
        assert!(empty.sessions.is_empty());
        assert_eq!(empty.availability, vec![&observations[1]]);
        assert_eq!(empty.next_offset, None);
        assert!(
            list_cached_sessions(&records, &[], None, Some(&b), 0, limit)
                .availability
                .is_empty()
        );
    }

    #[test]
    fn snapshot_pages_keep_cached_timestamps_and_report_offline_and_missing_sources() {
        let mut records = vec![record("p1", "a", "one"), record("p1", "a", "two")];
        records[0].observed_at = Some("old".into());
        let observations = vec![InstanceAvailability {
            instance: instance("a"),
            availability: Availability::Unavailable,
            observed_at: Some("offline-check".into()),
            coverage: SourceCoverage::Incomplete,
        }];
        let snapshot = SessionListSnapshot::new(
            &records,
            &observations,
            &[instance("a"), instance("b")],
            Some("p1"),
            None,
        );
        records.clear();
        let first = snapshot.page(0, NonZeroUsize::new(1).unwrap());
        assert_eq!(first.sessions[0].observed_at.as_deref(), Some("old"));
        assert_eq!(
            first.availability[0].availability,
            Availability::Unavailable
        );
        assert_eq!(
            first.availability[0].observed_at.as_deref(),
            Some("offline-check")
        );
        assert!(!first.coverage_complete);
        assert_eq!(first.missing_sources, vec![&instance("b")]);
        let next = snapshot.page(first.next_offset.unwrap(), NonZeroUsize::new(1).unwrap());
        assert_eq!(next.sessions[0].snapshot.address.native_session_id, "two");
        assert_eq!(next.next_offset, None);
        assert!(!next.coverage_complete);
    }

    #[test]
    fn coverage_requires_explicit_complete_observations_for_filtered_inventory() {
        let records = vec![
            record("p1", "a", "one"),
            record("p1", "b", "two"),
            record("p2", "a", "three"),
        ];
        let mut observations = vec![InstanceAvailability {
            instance: instance("a"),
            availability: Availability::Available,
            observed_at: Some("now".into()),
            coverage: SourceCoverage::Complete,
        }];
        let sources = vec![instance("a"), instance("b")];
        let limit = NonZeroUsize::new(10).unwrap();
        let snapshot = SessionListSnapshot::new(
            &records,
            &observations,
            &sources,
            Some("p1"),
            Some(&instance("a")),
        );
        let page = snapshot.page(0, limit);
        assert!(page.coverage_complete);
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].snapshot.address.native_session_id, "one");
        assert!(
            !SessionListSnapshot::new(&records, &observations, &sources, None, None)
                .page(0, limit)
                .coverage_complete
        );
        observations[0].observed_at = None;
        assert!(
            !SessionListSnapshot::new(
                &records,
                &observations,
                &sources,
                None,
                Some(&instance("a"))
            )
            .page(0, limit)
            .coverage_complete
        );
        assert!(
            !SessionListSnapshot::new(&[], &[], &[], None, None)
                .page(0, limit)
                .coverage_complete
        );
        assert!(snapshot.page(usize::MAX, limit).sessions.is_empty());
    }
}
