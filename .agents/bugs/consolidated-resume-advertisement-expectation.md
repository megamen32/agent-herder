# consolidated-resume-advertisement-expectation

Description: Legacy test expects resume_after_status/cancel in tools/list despite action facade
Evidence: tests/resume-after-mcp.test.ts; fixed PR25 worktree with old tools/call unchanged; 59/59 focused green
Blocks: tool-consolidation-PR25 guarded production release
Status: fixed
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
- 2026-11-02: Fixed in c6f7ba9, with focused test proof; pending full release verification.

- 2026-11-02: Full-suite verified SHA 71f8fa2: 4318 passed, 14 skipped, 0 failed/unhandled. Exact full receipt in .catalog-release-all.log; status/history preserved, no record deleted.
