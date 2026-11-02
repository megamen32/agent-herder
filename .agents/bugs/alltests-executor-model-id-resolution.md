# alltests-executor-model-id-resolution

Description: Full project test suite observed 1 failed test(s) in tests/executor-model-id-resolution.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/executor-model-id-resolution.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- executor model id resolution > keeps the route-proof gate on the native route

Observed first errors:
- AssertionError: expected undefined to be 'opencode' // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN 4 test files, 49/49 PASS. Exact loopback OmniRoute provider-leaf proof now has separate scoped CLI read credential; no silent fallback to unauthenticated management endpoints and unknown translated catalog ID remains rejected.
