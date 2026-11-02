# alltests-opencode-v2-protocol

Description: Full project test suite observed 6 failed test(s) in tests/opencode-v2-protocol.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/opencode-v2-protocol.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- reads the selected V2 session mode and only its exact pending requests
- reads v2 permission requests as pending session input
- resolves the exact OpenCode combo ID into its complete configured OmniRoute provider leaves
- recursively resolves nested configured OmniRoute combos and fails closed on incomplete trees
- controls v2 turns, lineage, recovery, permissions and models
- keeps a combo route verifiable when another enabled mapping serves the same combo under an unrelated name

Observed first errors:
- AssertionError: expected { target: { …(3) }, …(6) } to match object { target: { …(2) }, …(3) }
- AssertionError: expected false to be true // Object.is equality
- AssertionError: expected null to deeply equal { nativeHarness: 'opencode', …(4) }
- AssertionError: expected null to match object { resolvedProviderLeaves: [ …(2) ] }
- AssertionError: expected false to be true // Object.is equality

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
