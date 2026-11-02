# alltests-project-runtime-policy

Description: Full project test suite observed 6 failed test(s) in tests/project-runtime-policy.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/project-runtime-policy.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- native Codex project runtime policy > uses a process-owned, default-isolated Codex config without touching global integrations
- native Codex project runtime policy > adds live hosted search only when the trusted project policy explicitly opts in
- native Codex project runtime policy > emits explicit per-id app, MCP and plugin denies without exposing the ids elsewhere
- native Codex project runtime policy > uses the native dotted-key form for safe MCP ids
- native Codex project runtime policy > rejects malformed IDs before constructing a process argument list
- native Codex project runtime policy > requires the exact closed filesystem profile in effective config readback

Observed first errors:
- Error: cannot resolve the Codex executable for the process-local sandbox profile
- Error: cannot resolve the Codex executable for the process-local sandbox profile
- Error: cannot resolve the Codex executable for the process-local sandbox profile
- Error: cannot resolve the Codex executable for the process-local sandbox profile
- AssertionError: expected [Function] to throw error including 'invalid MCP server isolation id' but got 'cannot resolve the Codex executable f…'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
