# session-identity-read-announcement

Description: sessionIdentity(OpenCodeAdapter) returns null on GET and lacks announced:false on rejected announcement
Evidence: tests/session-identity.test.ts; clean origin/main 4a97225 fails two assertions
Blocks: tool-consolidation-PR25 guarded production release
Status: open
History:
- 2026-11-02: Observed; compared against clean origin/main at 4a97225 where applicable. The record is retained after resolution.
