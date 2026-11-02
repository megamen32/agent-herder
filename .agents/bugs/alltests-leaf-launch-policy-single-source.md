# alltests-leaf-launch-policy-single-source

Description: Full project test suite observed 1 failed test(s) in tests/leaf-launch-policy-single-source.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/leaf-launch-policy-single-source.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- the rule of the owner about leaves is written once > names the closed providers and the allowed families once

Observed first errors:
- AssertionError: expected [ [ 'minimax', …(2) ], …(2) ] to deeply equal [ [ 'minimax', …(2) ], …(1) ]

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused initial RED 3 failures/49 assertions; after preserving server-pinned incident profile and UI validation, rerun 49/49 PASS in 3 files. Arbitrary local incident overrides are tested as HTTP400 with no saved-policy corruption; canonical profile save/reload is positive. Leaf family test updated to include already-authorized zcode-start/zcode-individual source family, without changing runtime admission.
