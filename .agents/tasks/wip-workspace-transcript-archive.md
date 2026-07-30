# Workspace-scoped canonical transcript archive

## Task Layer

Description: On every transcript request, atomically export the full requested session and in-workspace lineage to CWD-scoped archive files. Return an actionable archive/navigation card when inline context exceeds the configurable budget; enforce age/size retention by last modification time.

Severity: CORE

Workflow:

1. L — map current session lineage and CWD boundary behavior; define archive manifest and configuration. Required: 10–20 minutes.
2. L — add failing archive, overwrite, workspace-boundary, navigation-card, and retention tests. Required: 15–30 minutes.
3. L — implement atomic archive export plus manifest, per-CWD config, direct query/regex/date navigation, and cleanup. Required: 25–50 minutes.
4. L — run focused/full tests and build; document environment variables and archive use. Required: 10–20 minutes.

Acceptance:

- Default archive root is `.agent-herder/transcripts` under the MCP process CWD; relative overrides remain inside that CWD.
- Every successful transcript request atomically overwrites the target's canonical archive and exports reachable in-workspace parent/child lineage.
- Archive manifests name exported and CWD-excluded lineage sessions, with stable paths and modification metadata.
- Above the inline budget, MCP returns a compact card explaining exact `get_transcript` query/regex/date requests and archive paths.
- Retention uses last modification time and defaults to 100 MiB / 3 days, configurable by environment variables.
- Tests prove export, lineage, overwrite, CWD scope, response card, and retention behavior.

## On Start

started (UTC+3): 2026-07-30T17:35:00+03:00
Executor: L (/root)
PID: n/a
Harness: codex
session identifier: current Codex task
Next action: Add a failing workspace-scoped archive regression against the existing transcript handler.
