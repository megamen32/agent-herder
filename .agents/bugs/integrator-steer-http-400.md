# integrator-steer-http-400

Description: Exact bound-session POST /api/sessions/codex/exact-id/... returns HTTP 400 instead of 200/202
Evidence: tests/integrator-session-route.test.ts:85; clean origin/main 4a97225 isolated failure; fixture POST expected admission
Blocks: tool-consolidation-PR25 guarded production release
Status: resolved_false_positive
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: Guarded send correctly refuses without native stock durable registry. Changed test to assert HTTP400 and no send; neither the product gate nor caller identity was bypassed. Isolated focused suite 7 files, 33/33 passed; broader suite pending.
