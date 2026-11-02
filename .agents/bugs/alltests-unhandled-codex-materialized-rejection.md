# alltests-unhandled-codex-materialized-rejection

Description: Vitest catches one unhandled rejection from CodexAppServerAdapter.reserveMaterializedOperation when current scope unavailable. Need regression proof and no guard bypass.
Evidence: .catalog-alltests.log Unhandled Rejection: materialized Codex current scope is unavailable; src/adapters/codex-app-server.ts:1260.
Blocks: PR25 full-cycle test green.
Status: open
History:
- 2026-11-02: Captured from full suite without replaying native operation.
