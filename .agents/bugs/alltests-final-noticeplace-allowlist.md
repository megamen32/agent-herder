# alltests-final-noticeplace-allowlist

Description: Full project 503-file acceptance failed noticeplace-health-observer-contract assertion expecting a singleton incident allowlist, but current exact signed HTTP admission and canonical model policy intentionally authorize two exact combos.
Evidence: tests/noticeplace-health-observer-contract.test.ts:239; .catalog-final-all.log: FAIL; observed 2 exact models, expected singleton. Verify both admission/rejection and update test or source with evidence.
Blocks: PR25 final all-suite acceptance and guarded release
Status: fixed_pending_full_suite
History:
- 2026-11-02: Captured from a single full-suite run: 503 files, 4314 passed, 2 failed, 14 skipped; no unhandled errors. Must retain record and resolve with focused RED→GREEN before final combined rerun.

- 2026-11-02: Focused RED from full suite (expected singleton, actual 2 exact signed incident routes), then GREEN: tests/noticeplace-health-observer-contract.test.ts and tests/permission-control-notice.test.ts 27/27. Source INCIDENT_MODELS and NOTICEPLACE_HEALTH_MODELS already derive the exact two-route contract. Updated test asserts equal sets, exact GLM+MiniMax and MiniMax combos; all provider substitution/unknown routes still refused. No runtime policy or permissions changed.
