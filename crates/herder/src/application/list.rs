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
}

/// An independently supplied observation, not a property inferred from records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceAvailability {
    pub instance: InstanceRef,
    pub availability: Availability,
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
            },
            InstanceAvailability {
                instance: instance("b"),
                availability: Availability::Unknown,
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
}
