# alltests-opencode-v2-protocol

Description: Full project test suite observed 6 failed test(s) in tests/opencode-v2-protocol.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/opencode-v2-protocol.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- reads the selected V2 session mode and only its exact pending requests
- reads v2 permission requests as pending session input
- resolves the exact OpenCode combo ID into its complete configured OmniRoute provider leaves
- recursively resolves nested configured OmniRoute combos and fails closed on incomplete trees
- controls v2 turns, lineage, recovery, permissions and models
- keeps a combo route verifiable when another enabled mapping serves the same combo under an unrelated name

Observed first errors:
- AssertionError: expected { target: { …(3) }, …(6) } to match object { target: { …(2) }, …(3) }
- AssertionError: expected false to be true // Object.is equality
- AssertionError: expected null to deeply equal { nativeHarness: 'opencode', …(4) }
- AssertionError: expected null to match object { resolvedProviderLeaves: [ …(2) ] }
- AssertionError: expected false to be true // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: RED 6/31 failures, GREEN 31/31. Scoped native V2 permission fixture now lists exact matching session requests, readback checks real fullAuto mode, interrupt?resume=false, and distinct model/read-management credentials. Native permission write asserted by exact path rather than first unrelated inbox PATCH. Parentless authenticated mixed-leg combo keeps distinct actual provider leaves; conflicting routes/aliases still refused.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
