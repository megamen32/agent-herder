# alltests-integrator-fleet-http

Description: Full project test suite observed 1 failed test(s) in tests/integrator-fleet-http.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/integrator-fleet-http.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- owner HTTP scoped Fleet session routes > keeps transcript, message, resume, and stop on the per-request scoped port; ordinary routes stay unchanged

Observed first errors:
- AssertionError: expected [ 200, 202 ] to include 400

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN 2 files 5/5 tests. Both scoped/ordinary HTTP test servers now provide true isolated persistent HerderJobRegistry; no production gate bypass. Native admission once, replay stable id, scoped owner routing and STOP no-wake receipts passed. In-memory non-durable registry previously correctly rejected native dispatch.
