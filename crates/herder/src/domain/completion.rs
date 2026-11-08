//! Pure decisions for turning a durable child completion into one parent wake.
//!
//! The caller must load authoritative lineage and HumanStop state before calling
//! this function, and persist the returned state/effect admission before I/O.
use super::address::SessionRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionState {
    /// Durable event keys already consumed, including events suppressed by a
    /// stop. The application layer persists this state before dispatch.
    pub processed_events: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildCompletion {
    pub event_id: String,
    pub child: SessionRef,
    pub parent: Option<SessionRef>,
    pub confirmed: bool,
    pub parent_stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionEffect {
    WakeParent {
        parent: SessionRef,
        request_key: String,
        source_child: SessionRef,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionDecision {
    IgnoredUnconfirmed,
    IgnoredNoParent,
    SuppressedByHumanStop,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionTransition {
    pub state: CompletionState,
    pub effects: Vec<CompletionEffect>,
    pub decision: Option<CompletionDecision>,
}

/// Admit a single wake only for a confirmed completion with known parent lineage.
/// The stable key binds the effect to this exact child event; callers must treat
/// an already admitted or UNKNOWN effect as non-replayable.
pub fn transition_completion(
    state: &CompletionState,
    event: &ChildCompletion,
) -> CompletionTransition {
    let unchanged = |decision| CompletionTransition {
        state: state.clone(),
        effects: Vec::new(),
        decision: Some(decision),
    };
    if !event.confirmed || event.event_id.is_empty() {
        return unchanged(CompletionDecision::IgnoredUnconfirmed);
    }
    if state.processed_events.iter().any(|key| key == &event.event_id) {
        return unchanged(CompletionDecision::Duplicate);
    }
    let mut next_state = state.clone();
    next_state.processed_events.push(event.event_id.clone());
    let Some(parent) = event.parent.as_ref() else {
        return CompletionTransition {
            state: next_state,
            effects: Vec::new(),
            decision: Some(CompletionDecision::IgnoredNoParent),
        };
    };
    if event.parent_stopped {
        return CompletionTransition {
            state: next_state,
            effects: Vec::new(),
            decision: Some(CompletionDecision::SuppressedByHumanStop),
        };
    }
    let request_key = format!("child-completion:{}", event.event_id);
    CompletionTransition {
        state: next_state,
        effects: vec![CompletionEffect::WakeParent {
            parent: parent.clone(),
            request_key,
            source_child: event.child.clone(),
        }],
        decision: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> ChildCompletion {
        ChildCompletion {
            event_id: "completed:child-7:v1".into(),
            child: SessionRef("child-7".into()),
            parent: Some(SessionRef("parent-2".into())),
            confirmed: true,
            parent_stopped: false,
        }
    }

    #[test]
    fn confirmed_child_completion_emits_one_stable_parent_wake() {
        let transition = transition_completion(&CompletionState { processed_events: vec![] }, &event());
        assert_eq!(transition.effects, vec![CompletionEffect::WakeParent {
            parent: SessionRef("parent-2".into()),
            request_key: "child-completion:completed:child-7:v1".into(),
            source_child: SessionRef("child-7".into()),
        }]);
        assert_eq!(transition.state.processed_events, vec!["completed:child-7:v1"]);
        assert_eq!(transition.decision, None);
    }

    #[test]
    fn unknown_duplicate_and_human_stop_never_emit_wake() {
        let state = CompletionState { processed_events: vec![] };
        let mut unknown = event();
        unknown.confirmed = false;
        assert_eq!(transition_completion(&state, &unknown).decision, Some(CompletionDecision::IgnoredUnconfirmed));
        let duplicate = CompletionState { processed_events: vec!["completed:child-7:v1".into()] };
        assert_eq!(transition_completion(&duplicate, &event()).decision, Some(CompletionDecision::Duplicate));
        let mut stopped = event();
        stopped.parent_stopped = true;
        assert_eq!(transition_completion(&state, &stopped).decision, Some(CompletionDecision::SuppressedByHumanStop));
        assert!(transition_completion(&state, &stopped).effects.is_empty());
    }

    #[test]
    fn root_completion_and_empty_event_do_not_create_effects() {
        let state = CompletionState { processed_events: vec![] };
        let mut root = event();
        root.parent = None;
        assert_eq!(transition_completion(&state, &root).decision, Some(CompletionDecision::IgnoredNoParent));
        let mut invalid = event();
        invalid.event_id.clear();
        assert_eq!(transition_completion(&state, &invalid).decision, Some(CompletionDecision::IgnoredUnconfirmed));
    }
}
