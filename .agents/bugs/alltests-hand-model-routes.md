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
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN evidence: tests/hand-model-routes.test.ts, tests/r40-incident-policy.test.ts and tests/noticeplace-health-launch.test.ts, 35/35 pass (first run 33/34 and second 35/35). Both explicitly approved incident combo IDs are now tested for admission, with non-approved provider, padded and substituted model routes still refused. NoticePlace model list now reuses the exact HTTP allowlist INCIDENT_MODELS; canonical incident profile remains fixed to GLM-5.3 Flash+MiniMax, no prefix-only incident permission.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
