# Context-mode-backed transcript retrieval

## Task Layer

Description: Preserve the upstream `mksglu/context-mode` source under `mcp/originals/` and make Agent Herder return only relevant, bounded transcript context for an explicit query or an agent-lead context need.

Severity: CORE

Workflow:

1. L — inspect upstream Context Mode and the current transcript API; identify a decoupled retrieval seam. Required: 5–15 minutes.
2. L — write a failing regression test for query-driven transcript context and deterministic bounded fallback. Required: 5–15 minutes.
3. L — implement the local Context Mode-compatible retrieval adapter and expose it through the MCP contract without transferring transcript storage or coupling to Context Mode's SQLite internals. Required: 10–25 minutes.
4. L — run focused and package validation; document the user-facing query behavior. Required: 5–15 minutes.

Acceptance:

- `mcp/originals/context-mode` is a clean clone of `https://github.com/mksglu/context-mode`.
- A transcript request with `query` returns ranked, nearby context rather than the full transcript.
- A request without `query` remains bounded and backward compatible.
- Focused regression tests and the project's normal validation pass.
- The code does not import, mutate, or depend on Context Mode's private persistent database.

## On Start

started (UTC+3): 2026-07-30T17:20:00+03:00
Executor: L (/root)
PID: n/a
Harness: codex
session identifier: current Codex task
Next action: Map transcript-search seams, then add a failing retrieval regression.
