# alltests-r40-incident-policy

Description: Full project test suite observed 2 failed test(s) in tests/r40-incident-policy.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/r40-incident-policy.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Notice Place incident subscription policy > keeps the incident route separate from ordinary launch defaults
- Notice Place incident subscription policy > refuses OmniRoute, provider substitutions and fallback models

Observed first errors:
- AssertionError: expected 'omniroute/glm-5.3-flash-minimax-m3.1' to be 'minimax-coding-plan/MiniMax-M3.1-Flash' // Object.is equality
- AssertionError: expected [Function] to throw an error

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN evidence: tests/hand-model-routes.test.ts, tests/r40-incident-policy.test.ts and tests/noticeplace-health-launch.test.ts, 35/35 pass (first run 33/34 and second 35/35). Both explicitly approved incident combo IDs are now tested for admission, with non-approved provider, padded and substituted model routes still refused. NoticePlace model list now reuses the exact HTTP allowlist INCIDENT_MODELS; canonical incident profile remains fixed to GLM-5.3 Flash+MiniMax, no prefix-only incident permission.
