# Agent Herder Flint/Sing product-boundary decisions

Status: todo
Original request: Make Agent Herder/Flint/Sing visibly truthful and usable across all tabs, with skill discovery/add/enable, small commits, Adviser guidance, and fresh zero-context Tester business-path acceptance.
Objective: Resolve the minimum product decisions required before implementation can be decomposed without inventing a tab or skill architecture.
Business canary: A fresh Tester opens the real Agent Herder surface, traverses every defined tab, sees truthful status/error/empty states, discovers one selected skill source, adds it, enables it in the chosen scope, uses it through the real consumer path, and verifies persisted/effective state after reload.
Confirmed scope: Agent Herder worktree `/home/roomhacker/agents-projects/agent-herder/.worktrees/flint-sing-ui-complete`, based on inspected commit `28aa548`; existing UI/API/adapter seams only.
Explicit exclusions: no implementation, deployment, restart, credentials, security/ACL, database, observability, destructive reset, or claims against canonical `main` until branch is selected.
Initial estimate (optimistic / likely / pessimistic active minutes): 15 / 30 / 60
Stop when: user resolves the five boundary choices and L can publish the required technical preview.
Blocker: Adviser returned `NEEDS_REDECOMPOSITION` because current code has no tab model or skill domain and the checked branch is not canonical `main`.

## Evidence

- Current branch is `agent/session-lineage-tools` at `28aa548`; local `main` and `origin/main` differ.
- Current UI is a single dashboard with tree/detail views and adapter/session panels; there is no enumerated tab contract.
- Current API has adapter registry and session routes but no skill catalog, add/install, enable-scope, operation receipt, or reconciliation endpoint.
- Need explicit decisions for canonical branch/commit, tab inventory, first skill provider/source, add/install semantics, and enablement scope.
