# Task: live Codex subagent UI acceptance

## Original request

Open the user's own Codex session on the Herder website and have the tester
verify that its subagents are visible.

## Objective

Make the live UI searchable across the full cached session snapshot and show
the selected session's native subagents in a folded detail panel.

## Business canary

At the Herder site, searching the current session ID opens that exact Codex
session and displays `Subagents (N)` with clickable child rows.

## Confirmed scope

- Remove the arbitrary 300-session client cap.
- Display details.children in chat and inspector.
- Keep the existing API/cache and lineage ownership.

## Explicit exclusions

- No deletion or mutation of Codex sessions.
- No changes to unrelated dirty files.

## Initial estimate

- Optimistic: 25 minutes.
- Likely: 45 minutes.
- Pessimistic: 90 minutes.

## Implementation and live tester evidence — 2026-08-09

- Removed the client-side 300-session cap so the current historical Codex
  session is searchable by its full ID.
- Added a folded `Subagents (N)` detail panel with clickable child rows and a
  matching inspector count.
- Reused the cached Codex snapshot for detail children and passed already
  discovered child objects directly, avoiding one full rollout scan per child.
- Live tester opened `019fc677-cea3-7502-a247-443eb18e0654` on the local Herder
  site by search, then verified `Subagents 11`, 11 visible child rows after
  expansion, and inspector `SUBAGENTS 11`. First rows were Refresh notify
  documentation, Run Notify browser QA, and Implement consumer delivery chains.
- Browser canary at 1280x900 had no document overflow. Full suite before this
  UI slice: 26 files, 97 tests passed.
