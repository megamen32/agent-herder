# alltests-common-settings-scope

Description: Full project test suite observed 2 failed test(s) in tests/common-settings-scope.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/common-settings-scope.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- the scope of a setting is decided in one place > places every setting of the catalog on one side of the line
- the catalog of the product and the scope of the settings agree > names every key of the environment of the catalog, common or machine

Observed first errors:
- AssertionError: expected [ …(4) ] to deeply equal []
- AssertionError: expected [ …(8) ] to deeply equal [ …(12) ]

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
