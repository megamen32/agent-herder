# alltests-launch-policy-settings

Description: Full project test suite observed 1 failed test(s) in tests/launch-policy-settings.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/launch-policy-settings.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- new session launch policy settings > saves a hand-typed incident model through the production validation

Observed first errors:
- Error: incident execution model must be omniroute/glm-5.3-flash-minimax-m3.1

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused initial RED 3 failures/49 assertions; after preserving server-pinned incident profile and UI validation, rerun 49/49 PASS in 3 files. Arbitrary local incident overrides are tested as HTTP400 with no saved-policy corruption; canonical profile save/reload is positive. Leaf family test updated to include already-authorized zcode-start/zcode-individual source family, without changing runtime admission.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
