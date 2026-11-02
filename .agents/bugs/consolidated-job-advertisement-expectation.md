# consolidated-job-advertisement-expectation

Description: Legacy test expects job_list in tools/list despite intended consolidated job facade
Evidence: tests/mcp2-control-plane.test.ts; fixed PR25 worktree with direct call compatibility asserted; 59/59 focused green
Blocks: tool-consolidation-PR25 guarded production release
Status: fixed
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
- 2026-11-02: Fixed in c6f7ba9, with focused test proof; pending full release verification.
