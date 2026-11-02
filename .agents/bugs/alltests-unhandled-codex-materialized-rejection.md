# alltests-unhandled-codex-materialized-rejection

Description: Vitest catches one unhandled rejection from CodexAppServerAdapter.reserveMaterializedOperation when current scope unavailable. Need regression proof and no guard bypass.
Evidence: .catalog-alltests.log Unhandled Rejection: materialized Codex current scope is unavailable; src/adapters/codex-app-server.ts:1260.
Blocks: PR25 full-cycle test green.
Status: fixed
History:
- 2026-11-02: Captured from full suite without replaying native operation.

- 2026-11-02: Isolated codex-app-server.test.ts 74/74 green with zero unhandled rejections after matching on-disk fixture home. Full combined suite still to be rechecked.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
