# alltests-user-message-http

Description: Full project test suite observed 4 failed test(s) in tests/user-message-http.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/user-message-http.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- registered HTTP human delivery route > acknowledges queue immediately, forwards native identity once after idle, and exposes its receipt
- registered HTTP human delivery route > cancels waiting human input on explicit stop rather than waking the chat afterwards
- registered HTTP human delivery route > honors a later native stop even when it did not arrive through the web stop route
- registered HTTP human delivery route > does not revive old queued intent when a different newer human input releases the stop

Observed first errors:
- AssertionError: expected 400 to be 202 // Object.is equality
- AssertionError: expected { Object (error) } to match object { ok: false, nonRetryable: true }
- AssertionError: expected { Object (error) } to match object { ok: false, nonRetryable: true }
- AssertionError: expected { Object (error) } to match object { ok: false, nonRetryable: true }

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
