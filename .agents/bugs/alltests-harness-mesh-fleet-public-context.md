# alltests-harness-mesh-fleet-public-context

Description: Full project test suite observed 1 failed test(s) in tests/harness-mesh-fleet-public-context.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/harness-mesh-fleet-public-context.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- verified public owner context > does not construct a peer transport when the owner cookie fails verification on roomhacker-server-100

Observed first errors:
- AssertionError: expected "vi.fn()" to be called with arguments: [ 401, Anything ]

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
