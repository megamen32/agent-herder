# Task: Codex lineage and hidden empty messages

## Original request

When Reasoning and Tools are disabled, empty Agent/Tool rows remain in the
chat. More importantly, Herder does not detect native Codex child sessions.
Verify whether Codex sessions with children exist and make them visible.

## Objective

Hide messages with no visible parts and derive Codex parent/child lineage from
Codex's persisted native rollout metadata.

## Business canary

The live Codex session list exposes parent/child relationships for native
`parent_thread_id` records, and a chat with hidden Reasoning/Tools contains no
empty role-only rows.

## Confirmed scope

- Codex adapter metadata parsing and SessionSupervisor lineage projection.
- React chat rendering only.

## Explicit exclusions

- No changes to Codex data, transport protocol, or unrelated dirty files.

## Initial estimate

- Optimistic: 35 minutes.
- Likely: 75 minutes.
- Pessimistic: 150 minutes.

## Discovery and implementation evidence — 2026-08-09

- Native Codex inspection found 1,558 rollout files and 5 unique non-self
  `parent_thread_id` relations matching 3 indexed live sessions. The previous
  Herder snapshot exposed none because Codex metadata was not parsed and
  lineage depended only on Herder-recorded spawn events.
- Codex adapter now extracts `parent_thread_id`, `thread_source`, and agent
  role from `session_meta`; app-server mode enriches thread/list results from
  the same native rollout store.
- SessionSupervisor projects valid Codex native parents into
  `meta.parentSessionKey` and resolves native children in details. Self-parent
  metadata is explicitly ignored.
- React now omits role-only messages when their Reasoning/Tools content is
  hidden.
- Full suite: 26 files, 94 tests passed. Live service active after restart.
- Live API: 2,129 Codex sessions, 3 real children, 0 self-references. Mobile
  chat canary: 1 rendered message, 0 empty articles.
