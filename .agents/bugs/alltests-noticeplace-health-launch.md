# alltests-noticeplace-health-launch

Description: Full project test suite observed 1 failed test(s) in tests/noticeplace-health-launch.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/noticeplace-health-launch.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Notice Place health-launch HTTP admission > rejects a model outside the selected combo omniroute/minimax-combo-m3.1

Observed first errors:
- AssertionError: expected 200 to be 400 // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
