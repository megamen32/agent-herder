# alltests-opencode-recovery

Description: Full project test suite observed 1 failed test(s) in tests/opencode-recovery.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/opencode-recovery.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- OpenCode native recovery controls > sends to a direct session id that is absent from the list response

Observed first errors:
- AssertionError: expected { ok: false, …(4) } to match object { ok: true, …(4) }

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused previously RED 1 test; after matching current shared durable delivery contract, tests/opencode-recovery.test.ts passes within final focused 5-file 46/46 run. Direct session ID still resolves for read/recovery; ordinary automatic MCP coordination without an owner durable job registry now explicitly refuses native queue, without lost/duplicated input. Other recovery paths verified by same file.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
