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

/// Trusted composition supplies an exhaustive inventory and exact opaque bindings.
/// An unavailable source stays in `sources` with no observation or an explicit
/// unavailable observation; cache contents do not establish availability.
#[derive(Clone)]
pub struct ListSource {
    pub node_ref: String,
    pub instance_ref: String,
    pub instance: InstanceRef,
    /// Exact server-issued ACL resource for this instance, never a request claim.
    pub acl_resource: String,
    pub observation: Option<InstanceAvailability>,
}

#[derive(Clone)]
pub struct ListRecord {
    pub session_ref: crate::domain::address::SessionRef,
    pub cached: CachedSession,
}

#[derive(Clone)]
pub struct ListInventory {
    pub sources: Vec<ListSource>,
    pub records: Vec<ListRecord>,
}

/// Implemented by the authoritative composition layer, not client metadata.
/// Return a pre-collected snapshot without making native calls. Return an error
/// when the inventory cannot be obtained; an empty inventory is not evidence of
/// fleet-wide completeness. Sources are authorized before data is returned.
pub trait ListInventoryPort: Send + Sync + 'static {
    fn snapshot(&self) -> Result<ListInventory, ()>;
}

#[derive(Clone, PartialEq, Eq)]
struct ListFilter {
    project: Option<String>,
    node: Option<String>,
    instance: Option<String>,
}

struct ListCursor {
    principal: crate::auth::identity::PrincipalId,
    filter: ListFilter,
    sources: Vec<ListSource>,
    records: Vec<ListRecord>,
    view: SessionListSnapshot,
    created: std::time::Instant,
}

/// ApplicationPort for `sessions/list`. Inventory and policy are injected by
/// trusted server composition. Cursors bind a frozen view, caller and filters.
pub struct ListApplication<P: ListInventoryPort> {
    inventory: P,
    grants: Vec<crate::auth::identity::Grant>,
    page_size: NonZeroUsize,
    next: std::sync::atomic::AtomicU64,
    cursors: std::sync::Mutex<std::collections::HashMap<String, ListCursor>>,
}

impl<P: ListInventoryPort> ListApplication<P> {
    pub fn new(
        inventory: P,
        grants: Vec<crate::auth::identity::Grant>,
        page_size: NonZeroUsize,
    ) -> Self {
        Self {
            inventory,
            grants,
            page_size,
            next: std::sync::atomic::AtomicU64::new(0),
            cursors: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn allowed(
        &self,
        identity: &crate::auth::identity::ConnectionIdentity,
        sources: &[ListSource],
        records: &[ListRecord],
    ) -> bool {
        use crate::auth::identity::{Action, PrivateResource};
        sources.iter().all(|s| {
            identity
                .authorize(
                    &self.grants,
                    &PrivateResource::Resource(s.acl_resource.clone()),
                    Action::Read,
                )
                .is_ok()
        }) && records.iter().all(|r| {
            identity
                .authorize(
                    &self.grants,
                    &PrivateResource::Session(r.session_ref.clone()),
                    Action::Read,
                )
                .is_ok()
        })
    }
}

impl<P: ListInventoryPort> crate::mcp::transport::ApplicationPort for ListApplication<P> {
    fn call<'a>(
        &'a self,
        identity: &'a crate::auth::identity::ConnectionIdentity,
        request: crate::mcp::catalog::Request,
    ) -> crate::mcp::transport::ApplicationFuture<'a> {
        use crate::auth::identity::Caller;
        use crate::mcp::catalog::{Request, Sessions};
        use rmcp::model::CallToolResult;
        use serde_json::json;
        Box::pin(async move {
            let Request::Sessions(Sessions::List {
                project_ref,
                node_ref,
                instance_ref,
                cursor,
            }) = request
            else {
                return None;
            };
            let fail = |code: &str| {
                Some(CallToolResult::structured_error(
                    json!({"code":code,"effect":"none"}),
                ))
            };
            let Caller::Principal(principal) = identity.caller() else {
                return fail("unauthorized");
            };
            let filter = ListFilter {
                project: project_ref,
                node: node_ref,
                instance: instance_ref,
            };
            let mut stored = match self.cursors.lock() {
                Ok(value) => value,
                Err(_) => return fail("source_unavailable"),
            };
            stored.retain(|_, state| state.created.elapsed() < std::time::Duration::from_secs(300));
            let (key, offset) = if let Some(cursor) = cursor {
                let Some((key, offset)) = cursor.split_once(':') else {
                    return fail("invalid_cursor");
                };
                let Ok(offset) = offset.parse::<usize>() else {
                    return fail("invalid_cursor");
                };
                (key.to_owned(), offset)
            } else {
                if stored.len() >= 128 {
                    return fail("capacity_exceeded");
                }
                let inventory = match self.inventory.snapshot() {
                    Ok(value) => value,
                    Err(_) => return fail("source_unavailable"),
                };
                // Reject malformed or ambiguous trusted mappings rather than risk cross-instance access.
                let mut native = std::collections::HashSet::new();
                let mut refs = std::collections::HashSet::new();
                let mut acl_refs = std::collections::HashSet::new();
                let mut nodes = std::collections::HashMap::new();
                let mut reverse_nodes = std::collections::HashMap::new();
                for s in &inventory.sources {
                    if s.node_ref.is_empty()
                        || s.instance_ref.is_empty()
                        || s.acl_resource.is_empty()
                        || !native.insert(s.instance.clone())
                        || !refs.insert(s.instance_ref.clone())
                        || !acl_refs.insert(s.acl_resource.clone())
                        || nodes
                            .insert(s.node_ref.clone(), s.instance.node.clone())
                            .is_some_and(|old| old != s.instance.node)
                        || reverse_nodes
                            .insert(s.instance.node.clone(), s.node_ref.clone())
                            .is_some_and(|old| old != s.node_ref)
                        || s.observation
                            .as_ref()
                            .is_some_and(|o| o.instance != s.instance)
                    {
                        return fail("source_unavailable");
                    }
                }
                let mut session_refs = std::collections::HashSet::new();
                let mut addresses = std::collections::HashSet::new();
                for r in &inventory.records {
                    if r.session_ref.0.is_empty()
                        || r.cached.snapshot.address.native_session_id.is_empty()
                        || !session_refs.insert(r.session_ref.clone())
                        || !addresses.insert(r.cached.snapshot.address.clone())
                        || !native.contains(&r.cached.snapshot.address.instance)
                    {
                        return fail("source_unavailable");
                    }
                }
                let sources: Vec<_> = inventory
                    .sources
                    .into_iter()
                    .filter(|s| {
                        filter.node.as_ref().is_none_or(|n| n == &s.node_ref)
                            && filter
                                .instance
                                .as_ref()
                                .is_none_or(|i| i == &s.instance_ref)
                    })
                    .collect();
                // Unknown requested refs and contradictory filters reveal no inventory detail.
                if (filter.node.is_some() || filter.instance.is_some()) && sources.is_empty() {
                    return fail("unauthorized");
                }
                let source_records: Vec<_> = inventory
                    .records
                    .into_iter()
                    .filter(|r| {
                        sources
                            .iter()
                            .any(|s| s.instance == r.cached.snapshot.address.instance)
                    })
                    .collect();
                // Check the whole source before filtering: project guesses must
                // not reveal the presence of a session lacking an exact grant.
                if !self.allowed(identity, &sources, &source_records) {
                    return fail("unauthorized");
                }
                let records: Vec<_> = source_records
                    .into_iter()
                    .filter(|r| {
                        filter
                            .project
                            .as_ref()
                            .is_none_or(|p| r.cached.project_ref.as_ref() == Some(p))
                    })
                    .collect();
                let expected: Vec<_> = sources.iter().map(|s| s.instance.clone()).collect();
                let observations: Vec<_> = sources
                    .iter()
                    .filter_map(|s| s.observation.clone())
                    .collect();
                let cached: Vec<_> = records.iter().map(|r| r.cached.clone()).collect();
                let view = SessionListSnapshot::new(&cached, &observations, &expected, None, None);
                let key = self
                    .next
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    .to_string();
                stored.insert(
                    key.clone(),
                    ListCursor {
                        principal: principal.id.clone(),
                        filter: filter.clone(),
                        sources,
                        records,
                        view,
                        created: std::time::Instant::now(),
                    },
                );
                (key, 0)
            };
            let Some(state) = stored.get(&key) else {
                return fail("invalid_cursor");
            };
            if state.principal != principal.id
                || state.filter != filter
                || !self.allowed(identity, &state.sources, &state.records)
            {
                return fail("unauthorized");
            }
            if offset > 0 && (offset >= state.records.len() || offset % self.page_size.get() != 0) {
                return fail("invalid_cursor");
            }
            let page = state.view.page(offset, self.page_size);
            let items: Vec<_> = page.sessions.iter().filter_map(|s| state.records.iter().find(|r| &r.cached == *s).and_then(|r| state.sources.iter().find(|source| source.instance == r.cached.snapshot.address.instance).map(|source| json!({"session_ref":r.session_ref.0,"project_ref":r.cached.project_ref,"node_ref":source.node_ref,"instance_ref":source.instance_ref,"observed_at":r.cached.observed_at})))).collect();
            if items.len() != page.sessions.len() {
                return fail("source_unavailable");
            }
            let coverage: Vec<_> = state.sources.iter().map(|source| json!({"node_ref":source.node_ref,"instance_ref":source.instance_ref,"availability":source.observation.as_ref().map(|o| o.availability),"observed_at":source.observation.as_ref().and_then(|o| o.observed_at.as_ref()),"coverage":source.observation.as_ref().map(|o| match o.coverage { SourceCoverage::Complete => "complete", SourceCoverage::Incomplete => "incomplete", SourceCoverage::Unknown => "unknown" })})).collect();
            let next_cursor = page.next_offset.map(|next| format!("{key}:{next}"));
            let missing: Vec<_> = state
                .sources
                .iter()
                .filter(|s| s.observation.is_none())
                .map(|s| json!({"node_ref":s.node_ref,"instance_ref":s.instance_ref}))
                .collect();
            let result = json!({"sessions":items,"sources":coverage,"missing_sources":missing,"coverage_complete":page.coverage_complete,"next_cursor":next_cursor});
            if offset == 0 && page.next_offset.is_none() {
                stored.remove(&key);
            }
            Some(CallToolResult::structured(result))
        })
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
