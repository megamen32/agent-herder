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
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN 2 files 5/5 tests. Both scoped/ordinary HTTP test servers now provide true isolated persistent HerderJobRegistry; no production gate bypass. Native admission once, replay stable id, scoped owner routing and STOP no-wake receipts passed. In-memory non-durable registry previously correctly rejected native dispatch.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
