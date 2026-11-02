# session-remote-human-origin

Description: Remote human-requested local message hits undefined .http instead of preserving user origin
Evidence: tests/session-remote-routing.test.ts; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: fixed_with_guard
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: Missing ctx on direct unit-handler invocation no longer TypeErrors (optional context), but missing durable native registry still refuses delivery. Fixture now asserts the gate and no sends. Isolated focused suite 7 files, 33/33 passed; broader suite pending.

- 2026-11-02: Full-suite verified SHA 71f8fa2: 4318 passed, 14 skipped, 0 failed/unhandled. Exact full receipt in .catalog-release-all.log; status/history preserved, no record deleted.
