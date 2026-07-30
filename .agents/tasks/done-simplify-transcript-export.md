# Simplify transcript export navigation

## Task Layer

Description: Replace Agent Herder's internal transcript retrieval/ranking with one raw `export_transcript` MCP tool that always returns a compact filesystem navigation card.

Severity: CORE

Workflow:

1. L — preserve the pushed complex archive checkpoint and write failing compatibility/export-card tests. Required: 5–15 minutes.
2. L — remove internal Context Mode-style retrieval and expose the raw-export-only MCP contract. Required: 15–30 minutes.
3. L — document precise filesystem navigation and verify package tests/build. Required: 10–20 minutes.

Acceptance:

- `export_transcript` exports raw source and lineage, then always returns a compact navigation card.
- No internal query ranking, regex/date selector, or token-budget behavior remains in Agent Herder.
- The card tells an agent exactly how to inspect first/last lines, fixed text, regex, and timestamps using ordinary workspace tools.
- Existing raw archive CWD/security/retention guarantees remain covered.

## On Start

started (UTC+3): 2026-07-30T18:35:00+03:00
Executor: L (/root)
PID: n/a
Harness: codex
session identifier: current Codex task
## Result

Completed (UTC+3): 2026-07-30T18:44:00+03:00

- Removed `get_transcript`, `search_transcripts`, `summarize_session`, Context
  Mode-style ranking, query/regex/date selectors, built-in transcript
  summarization, and inline token-budget configuration.
- Added the sole transcript MCP surface: `export_transcript(sessionId, harness?)`.
  It exports the raw source and recursively discovered in-CWD parent/child
  lineage, then always returns a navigation card with `sed`, `tail`, literal
  `rg`, regex `rg`, and timestamp `rg` examples.
- Preserved raw-only archival, atomic overwrite, manifest, 100 MiB / 3-day
  mtime retention, and partial-source labelling. Lineage now rejects a foreign
  harness and resolves CWDs before containment checks, so an outward symlink
  cannot be archived as if it belonged to the MCP CWD.
- Verification: focused 14 tests passed; `npm run build` passed; full suite 35
  tests passed; deprecated-surface scan and `git diff --check` passed.

Independent Critic: PASS — confirmed `export_transcript` is the only
transcript-facing MCP tool; no retrieval/search/ranking/token-budget or
summarizer surface remains. Verified realpath CWD containment and
foreign-harness rejection regressions.

Next action: Move this task to done and commit/push the user-authorized
checkpoint.
