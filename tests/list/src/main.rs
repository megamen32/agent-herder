//! Process-level consumer of the production list application with offline fixtures.
use herder::{
    application::list::{CachedSession, InstanceAvailability, SessionListSnapshot, SourceCoverage},
    domain::{
        adapter::{SessionActivity, SessionSnapshot},
        address::{Availability, InstanceRef, NodeRef, SessionAddress},
    },
};
use serde_json::{Value, json};
use std::num::NonZeroUsize;

fn instance(node: &str, profile: &str) -> InstanceRef {
    InstanceRef {
        node: NodeRef(node.into()),
        instance_id: profile.into(),
    }
}
fn record(project: &str, source: &InstanceRef, id: &str) -> CachedSession {
    CachedSession {
        project_ref: Some(project.into()),
        observed_at: Some("cached-before-check".into()),
        snapshot: SessionSnapshot {
            address: SessionAddress {
                instance: source.clone(),
                native_session_id: id.into(),
            },
            human_stop: false,
            activity: SessionActivity::Unknown,
            capabilities: vec![],
        },
    }
}
fn source(
    source: &InstanceRef,
    availability: Availability,
    coverage: SourceCoverage,
) -> InstanceAvailability {
    InstanceAvailability {
        instance: source.clone(),
        availability,
        observed_at: Some("fixture-check".into()),
        coverage,
    }
}
fn ident(source: &InstanceRef) -> Value {
    json!({"node":source.node.0,"instance":source.instance_id})
}
fn main() {
    // Same project display basename and native session ID occur on distinct nodes
    // and profiles; opaque project refs must be compared exactly.
    let a = instance("node-a", "same-profile");
    let b = instance("node-b", "same-profile");
    let c = instance("node-a", "empty-profile");
    let d = instance("node-d", "missing-profile");
    let expected = vec![a.clone(), b.clone(), c.clone(), d.clone()];
    let records = vec![
        record("project-a/same", &a, "same-session"),
        record("project-b/same", &b, "same-session"),
        record("project-b/same", &a, "another-session"),
    ];
    let observations = vec![
        source(&a, Availability::Available, SourceCoverage::Complete),
        source(&b, Availability::Unavailable, SourceCoverage::Unknown),
        source(&c, Availability::Available, SourceCoverage::Complete),
    ];
    let selector = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let (project, target) = match selector.as_str() {
        "all" => (None, None),
        "project-b" => (Some("project-b/same"), None),
        "offline" => (None, Some(&b)),
        "empty" => (None, Some(&c)),
        "missing" => (None, Some(&d)),
        _ => {
            eprintln!("invalid scenario");
            std::process::exit(2);
        }
    };
    let view = SessionListSnapshot::new(&records, &observations, &expected, project, target);
    let mut pages = Vec::new();
    let mut offset = 0;
    loop {
        let page = view.page(offset, NonZeroUsize::new(1).unwrap());
        let sessions: Vec<_> = page.sessions.iter().map(|r| json!({"project":r.project_ref,"source":ident(&r.snapshot.address.instance),"native_id":r.snapshot.address.native_session_id,"observed_at":r.observed_at})).collect();
        let availability: Vec<_> = page.availability.iter().map(|s| json!({"source":ident(&s.instance),"availability":format!("{:?}",s.availability),"coverage":format!("{:?}",s.coverage),"observed_at":s.observed_at})).collect();
        pages.push(json!({"sessions":sessions,"sources":availability,"missing_sources":page.missing_sources.iter().map(|s| ident(s)).collect::<Vec<_>>(),"coverage_complete":page.coverage_complete,"next_offset":page.next_offset}));
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    println!(
        "{}",
        json!({"scenario":selector,"pages":pages,"source_kind":"synthetic fixtures; production application API"})
    );
}
