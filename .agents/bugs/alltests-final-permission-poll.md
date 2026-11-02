# alltests-final-permission-poll

Description: Full project acceptance detected one extra permission read during partial native inventory retry in existing permission notice poll.
Evidence: tests/permission-control-notice.test.ts:235; .catalog-final-all.log; expected permissionReads unchanged from admission, actual +1. Verify native permission poll semantics, timing and race; do not suppress or disable polling.
Blocks: PR25 final all-suite acceptance and guarded release
Status: resolved_false_positive_pending_full_suite
History:
- 2026-11-02: Captured from a single full-suite run: 503 files, 4314 passed, 2 failed, 14 skipped; no unhandled errors. Must retain record and resolve with focused RED→GREEN before final combined rerun.

- 2026-11-02: Focused combined 27/27 passed. The original 1050ms wall-clock sample races with asynchronous initial native permission reconciliation: full suite may finish one already-in-flight exact read after recording the accepted baseline. The independent initial/late permission reader is required to discover fresh native permission requests, and no additional Notice external POST occurred. Strengthened test invariant: exactly one shared native listSessions poll, 0..1 finishing native permission probes (bounded), one Notice POST total and one durable accepted record. No production polling code changed, no sends repeated, no tests skipped.
