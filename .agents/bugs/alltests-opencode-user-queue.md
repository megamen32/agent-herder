# alltests-opencode-user-queue

Description: Full project test suite observed 1 failed test(s) in tests/opencode-user-queue.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/opencode-user-queue.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- acknowledges OpenCode async admission while the native model response remains unfinished

Observed first errors:
- AssertionError: expected 400 to be 202 // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED HTTP400 instead of 202, GREEN 1/1. Fixture now uses persistent HerderJobRegistry at isolated jobs.json, same durable-once admission requirement as production. Native v1 async prompt 204 admission returns HTTP202 before model completion, retains single inputId and replay same job; no sends duplicated.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
