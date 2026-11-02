# alltests-zcode-workspace-lifecycle

Description: Full project test suite observed 17 failed test(s) in tests/zcode-workspace-lifecycle.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/zcode-workspace-lifecycle.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- native workspace lifecycle, not SDK disconnection > automatically persists exact owner before loss, then a NEW launcher claims SAME SID without a checkpoint
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with surviving-sdk
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with detached-child
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with manual-hold
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with new-desktop
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with pending-input
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with missing-terminal
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with success
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with cancel-before-proof
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with new-tool
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with unknown-tool
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with manualcancel-before-death
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with unknown-exit
- native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with legacy-no-proof
- native workspace lifecycle, not SDK disconnection > persists pre-death native identity and automatically claims SAME SID without terminal row
- native workspace lifecycle, not SDK disconnection > observes exact own active turn before CLI death despite missing legacy events/turn_usage
- hooks primary native begin and successful final outcome > keeps hook-primary tracking and durable active through generic model completion until verified Stop success

Observed first errors:
- TypeError: Cannot read properties of undefined (reading 'activeNativeOwner')
- FAIL  tests/zcode-workspace-lifecycle.test.ts > native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with detached-child
- FAIL  tests/zcode-workspace-lifecycle.test.ts > native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with manual-hold
- FAIL  tests/zcode-workspace-lifecycle.test.ts > native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with new-desktop
- FAIL  tests/zcode-workspace-lifecycle.test.ts > native workspace lifecycle, not SDK disconnection > refuses parent-crash adoption with pending-input

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
