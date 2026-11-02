# alltests-hand-model-routes

Description: Full project test suite observed 3 failed test(s) in tests/hand-model-routes.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/hand-model-routes.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Notice Place incident model route > allows only the direct MiniMax subscription route for incidents
- Notice Place incident model route > does not reuse the general OmniRoute health route gate for incidents
- Notice Place incident model route > keeps the default route verifiable and the provider of the incident route

Observed first errors:
- AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]
- AssertionError: expected undefined to be truthy
- AssertionError: expected 'omniroute' to be 'minimax-coding-plan' // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
