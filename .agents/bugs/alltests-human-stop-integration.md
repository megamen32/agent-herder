# alltests-human-stop-integration

Description: Full project test suite observed 2 failed test(s) in tests/human-stop-integration.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/human-stop-integration.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- MCP native admission acknowledgement > keeps native input admission without a turn ID for ZCode guide and queue
- MCP native admission acknowledgement > returns verified turn and input identity for explicit steer

Observed first errors:
- AssertionError: expected '{"ok":false,"delivery":"not_attempted…' to contain 'Native admission receipt: {"admitted"…'
- AssertionError: expected '{"ok":false,"delivery":"not_attempted…' to contain 'Native admission receipt: {"admitted"…'

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED 2/16 → GREEN 16/16 in tests/human-stop-integration.test.ts. Native steer and queue each carry distinct stable inputId to isolated durable-once HerderJobRegistry; readback waits for completed job and checks actual native admitted/input identity, no invented turnId for ZCode, exact Codex turnId and one call; STOP coverage intact.
