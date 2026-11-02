# alltests-noticeplace-health-launch

Description: Full project test suite observed 1 failed test(s) in tests/noticeplace-health-launch.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/noticeplace-health-launch.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Notice Place health-launch HTTP admission > rejects a model outside the selected combo omniroute/minimax-combo-m3.1

Observed first errors:
- AssertionError: expected 200 to be 400 // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN evidence: tests/hand-model-routes.test.ts, tests/r40-incident-policy.test.ts and tests/noticeplace-health-launch.test.ts, 35/35 pass (first run 33/34 and second 35/35). Both explicitly approved incident combo IDs are now tested for admission, with non-approved provider, padded and substituted model routes still refused. NoticePlace model list now reuses the exact HTTP allowlist INCIDENT_MODELS; canonical incident profile remains fixed to GLM-5.3 Flash+MiniMax, no prefix-only incident permission.
