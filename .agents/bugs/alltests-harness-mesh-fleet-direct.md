# alltests-harness-mesh-fleet-direct

Description: Full project test suite observed 1 failed test(s) in tests/harness-mesh-fleet-direct.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/harness-mesh-fleet-direct.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- owner direct route local logic only > keeps personal Mac in native discovery while workspace mutation scope stays separate

Observed first errors:
- AssertionError: expected '#!/usr/bin/env node\nimport { isMainE…' to contain 'registerWorkspaceTools(server, { tran…'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN evidence: native Codex discovery 23/23 across 2 files, fleet machine/transport/stop 50/50 across 3 files. Test now verifies real workspace registration with read-only locateTransport that includes Mac and mutation transport excluding Mac; no access widened.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
