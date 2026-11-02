# session-remote-human-origin

Description: Remote human-requested local message hits undefined .http instead of preserving user origin
Evidence: tests/session-remote-routing.test.ts; clean origin/main 4a97225 isolated failure
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
