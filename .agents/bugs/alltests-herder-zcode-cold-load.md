# alltests-herder-zcode-cold-load

Description: Full project test suite observed 2 failed test(s) in tests/herder-zcode-cold-load.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/herder-zcode-cold-load.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- ZCode exact cold load before V4 admission > loads the same ID without a prompt before issuing one command
- ZCode exact cold load before V4 admission > loads a confirmed unavailable workspace runtime before the first input

Observed first errors:
- AssertionError: expected { ok: false, inputId: 'one', …(5) } to match object { ok: true, admitted: true }
- AssertionError: expected { ok: false, inputId: 'one', …(5) } to match object { ok: true, admitted: true }

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED 2/4, GREEN 5/5. Current native session/resume has no CAS to prove unchanged queue/turn before first input: both unloaded scenarios now explicitly assert notSubmitted=true, nonRetryable=true, admission:not_submitted, only readSession, zero resume/send. Added positive test on already-loaded exact session proving one supported V4 guide and no implicit resume; wrong identity/transport refusal unchanged. No safety downgrade.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
