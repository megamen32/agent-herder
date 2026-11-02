# alltests-project-model-delivery-gate

Description: Full project test suite observed 3 failed test(s) in tests/project-model-delivery-gate.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/project-model-delivery-gate.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- the model gate of a delivery > lets a delivery into a project without a route through
- the model gate of a mesh delivery > refuses the delivery, names the project and the model, and never retries it
- the model gate of a mesh delivery > delivers into a project that allows the model

Observed first errors:
- AssertionError: expected "vi.fn()" to be called at least once
- AssertionError: expected 'authenticated_mesh_ingress_required' to contain 'model_not_permitted_for_project'
- AssertionError: expected 'not_attempted' to be 'admitted' // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: RED 3/13 failures, GREEN 13/13. Positive agent delivery has process-owned durable HerderJobRegistry and genuine UserMessageDelivery, trusted mesh ingress and confirmed native hostId; steer declared only when fixture supports it. Denied model & corrupt policy remain fail closed. Successful native input receipt and no-replay checked.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
