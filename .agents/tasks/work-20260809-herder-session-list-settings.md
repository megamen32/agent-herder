# Task: session list settings

## Original request

Add session-list settings for choosing `cwd`, `project`, and `harness`, plus
sorting and folded child sessions.

## Objective

Let the Herder session list be filtered and organized without changing the
session transport or backend ownership.

## Business canary

At desktop and 390px mobile widths, the user can open list settings, select a
cwd/project/harness filter, choose a sort order, and fold/unfold child sessions
while the active chat remains usable.

## Confirmed scope

- UI controls and client-side filtering/sorting/grouping.
- Reuse existing session lineage fields where available.

## Explicit exclusions

- No changes to adapter discovery, persistence, permissions, or transport.
- No deletion or mutation of sessions.

## Initial estimate

- Optimistic: 30 minutes.
- Likely: 60 minutes.
- Pessimistic: 120 minutes.

## Implementation and verification evidence — 2026-08-09

- Added a pure session-list arrangement helper covering CWD, project-root,
  harness, and sort-by filters plus parent/child tree folding.
- Added a Sessions settings panel with CWD, Project, Harness, and Sort by
  controls. Child sessions are folded by default when lineage is available and
  can be expanded independently of selecting a session.
- Existing `/api/sessions` and `meta.parentSessionKey` data remain unchanged;
  no transport or adapter mutation was introduced.
- Focused regression: 2/2 passed.
- Full suite: 24 files, 88 tests passed.
- Live service: `agent-herder.service` active after restart.
- Live browser canary: desktop settings panel exposes four controls; selecting
  `/home/roomhacker` reduced the visible list from 300 to 291 sessions. At
  390x844 the settings panel is 238px tall, list and page have no horizontal
  or vertical document overflow, and the list remains independently scrollable.
- Current live snapshot has zero lineage children, so folding was additionally
  validated with the focused parent/child regression fixture.
