# session-statistics-timeout

Description: Session statistics computation times out with 5s limit under concurrent suite and 15s when isolated
Evidence: tests/session-statistics.test.ts; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: fixed_fixture
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: Test now stubs native DB paths so it never parses real OpenCode/ZCode files; Codex fixture adds matching successful output receipts and asserts truthful medium confidence with unavailable sources. Isolated focused suite 7 files, 33/33 passed; broader suite pending.
