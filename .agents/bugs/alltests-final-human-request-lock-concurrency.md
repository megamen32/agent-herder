# alltests-final-human-request-lock-concurrency

Description: Five concurrent Human Request resume attempts on the same durable request can exhaust the registry's very short proper-lockfile retry window under normal 503-file suite load. Native admission must remain atomic and one-time; no bypass or unbounded lock waiting.
Evidence: .catalog-final-all2.log, tests/human-request-native-unavailable.test.ts:40. HumanRequestLockUnavailableError ELOCKED at src/human-request/registry.ts:736; 4315/4330 tests passed, one failed, 14 skipped, no unhandled errors.
Blocks: PR25 all-suite acceptance and guarded release
Status: fixed
History:
- 2026-11-02: Confirmed in full suite at 9d3de58. Registering before fix. Implement bounded lock contention regression with observable RED→GREEN, retain fail-closed semantics and one native resume.

- 2026-11-02: Deterministic focused RED in .catalog-lock-red.log: held interprocess lock for 225ms, 4x10ms old retries cannot acquire; test fails. Increased only finite lock retry window to 40 x 25ms (~1s bound), preserving exclusive proper-lockfile lock, 30s stale threshold, and atomically serialized durable resume. Focused GREEN in .catalog-lock-final.log: 7/7 passed including five concurrent resumes, short lock handoff, and permanently-held lock refusing with HumanRequestLockUnavailableError and zero native sends. No retry of unknown admission, no weakened permission or confirmation gate. Full project recheck pending.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
