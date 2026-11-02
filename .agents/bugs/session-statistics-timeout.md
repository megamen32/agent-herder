# session-statistics-timeout

Description: Session statistics computation times out with 5s limit under concurrent suite and 15s when isolated
Evidence: tests/session-statistics.test.ts; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
