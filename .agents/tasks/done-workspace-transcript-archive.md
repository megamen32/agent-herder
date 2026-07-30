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
- Every request with an adapter-owned raw source atomically overwrites the target's archive and exports reachable in-workspace parent/child lineage; partial sources are marked rather than misrepresented.
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

## Result

- Added a raw-only `getRawTranscript` adapter contract with bytes, source, format, timestamp coverage, limitations, and a truthful `complete` flag. Codex CLI, Claude, and Qoder copy readable native files verbatim; OpenCode and ACP snapshots remain explicitly partial because their complete-history APIs are not verified.
- Every `get_transcript` first attempts a raw archive. The archive root is fixed beneath the MCP process CWD (`.agent-herder/transcripts` by default), and only native parent/child sessions inside that workspace are traversed. The manifest records complete/source/timestamp metadata and lineage exclusions.
- Archive writes are atomic and symlink-safe; session bundles are overwritten as a unit. Retention runs on new export, uses mtime, defaults to 100 MiB / 3 days, and evicts complete raw+manifest bundles without deleting the current export.
- The MCP result always states the archive location when available. It returns a compact query/regex/date navigation card above the configurable approximate 8,192-token budget; regex/date exploration uses raw source when available.
- Added focused coverage for raw archive metadata, overwrite, CWD exclusion, mtime retention bundles, archive-dir/harness traversal rejection, symlink protection, recursive lineage and cycles, regular-expression/date retrieval, and the handler archive path.
- Verification: `npm run build`; `npm test` — 12 files, 41 tests; `git diff --check`. Independent review approved the final implementation.

## Completion checklist

- [x] Archive is constrained to MCP process CWD and blocks symlink/path traversal.
- [x] Adapter raw source is kept separate from display transcript and complete status is explicit.
- [x] In-workspace native parent/child lineage is exported; cycles and outside-CWD sessions are safe.
- [x] Atomic replacement and mtime retention are covered.
- [x] Inline navigation and bounded context filters are documented and tested.
