# alltests-opencode-user-queue

Description: Full project test suite observed 1 failed test(s) in tests/opencode-user-queue.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/opencode-user-queue.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- acknowledges OpenCode async admission while the native model response remains unfinished

Observed first errors:
- AssertionError: expected 400 to be 202 // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED HTTP400 instead of 202, GREEN 1/1. Fixture now uses persistent HerderJobRegistry at isolated jobs.json, same durable-once admission requirement as production. Native v1 async prompt 204 admission returns HTTP202 before model completion, retains single inputId and replay same job; no sends duplicated.
