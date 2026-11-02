# workplace-projection-order

Description: Workplace projection sessions order may be reversed /two,/one vs /one,/two
Evidence: tests/workplace-projection-sessions.test.ts:82; appeared in 107-file full parallel run but passed isolated comparison: possible nondeterministic ordering; needs reproducible classification
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
