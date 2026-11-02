# session-dto-scoped-adapter

Description: Scoped send_message does not invoke scopedSend once despite resolver finding scoped adapter
Evidence: tests/session-tools-dto.test.ts:111; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: resolved_false_positive
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: Scoped send preflight correctly requires native stock durable registry; fixture asserts nonRetryable not_attempted and verifies neither scoped nor ordinary send occurred. Other scoped read/resume assertions remain. Isolated focused suite 7 files, 33/33 passed; broader suite pending.

- 2026-11-02: Full-suite verified SHA 71f8fa2: 4318 passed, 14 skipped, 0 failed/unhandled. Exact full receipt in .catalog-release-all.log; status/history preserved, no record deleted.
