# session-dto-scoped-adapter

Description: Scoped send_message does not invoke scopedSend once despite resolver finding scoped adapter
Evidence: tests/session-tools-dto.test.ts:111; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
