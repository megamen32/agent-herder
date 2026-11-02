# workplace-projection-order

Description: Workplace projection sessions order may be reversed /two,/one vs /one,/two
Evidence: tests/workplace-projection-sessions.test.ts:82; appeared in 107-file full parallel run but passed isolated comparison: possible nondeterministic ordering; needs reproducible classification
Blocks: tool-consolidation-PR25 guarded production release
Status: resolved_false_positive
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.

- 2026-11-02: No guaranteed order contract between equal lastActivity timestamps; test now checks exact byId hostId and cwd mapping for both sessions; order-independent invariant preserved. Isolated focused suite 7 files, 33/33 passed; broader suite pending.
