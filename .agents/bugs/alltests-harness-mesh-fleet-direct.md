# alltests-harness-mesh-fleet-direct

Description: Full project test suite observed 1 failed test(s) in tests/harness-mesh-fleet-direct.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/harness-mesh-fleet-direct.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- owner direct route local logic only > keeps personal Mac in native discovery while workspace mutation scope stays separate

Observed first errors:
- AssertionError: expected '#!/usr/bin/env node\nimport { isMainE…' to contain 'registerWorkspaceTools(server, { tran…'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN evidence: native Codex discovery 23/23 across 2 files, fleet machine/transport/stop 50/50 across 3 files. Test now verifies real workspace registration with read-only locateTransport that includes Mac and mutation transport excluding Mac; no access widened.
