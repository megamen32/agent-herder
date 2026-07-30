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
Next action: Replace handler-level retrieval test with a failing permanent export-card test.
