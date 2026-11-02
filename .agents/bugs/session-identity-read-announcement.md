# session-identity-read-announcement

Description: sessionIdentity(OpenCodeAdapter) returns null on GET and lacks announced:false on rejected announcement
Evidence: tests/session-identity.test.ts; clean origin/main 4a97225 fails two assertions
Blocks: tool-consolidation-PR25 guarded production release
Status: fixed_fixture
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: OpenCode v2 session permission/message endpoints in the fixture now return correctly typed empty arrays; native production adapter unchanged; test passes. Isolated focused suite 7 files, 33/33 passed; broader suite pending.

- 2026-11-02: Full-suite verified SHA 71f8fa2: 4318 passed, 14 skipped, 0 failed/unhandled. Exact full receipt in .catalog-release-all.log; status/history preserved, no record deleted.
