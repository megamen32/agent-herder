# alltests-state-separation

Description: Full project test suite observed 1 failed test(s) in tests/state-separation.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/state-separation.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- the stop of a session is a lever of its own > holds the session and shows the truth, while the other four read their own way

Observed first errors:
- AssertionError: expected 3 to be 4 // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
