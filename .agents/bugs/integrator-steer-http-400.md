# integrator-steer-http-400

Description: Exact bound-session POST /api/sessions/codex/exact-id/... returns HTTP 400 instead of 200/202
Evidence: tests/integrator-session-route.test.ts:85; clean origin/main 4a97225 isolated failure; fixture POST expected admission
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
