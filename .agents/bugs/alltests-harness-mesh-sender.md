# alltests-harness-mesh-sender

Description: Full project test suite observed 5 failed test(s) in tests/harness-mesh-sender.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/harness-mesh-sender.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- declared mesh sender API (focused integration; expected 3s, maximum 30s) > publishes and carries structured meshSender through the registered MCP SDK tool
- declared mesh sender API (focused integration; expected 3s, maximum 30s) > budgets the full host/harness/native address: 2 senders x6, pair7 rejected, target12
- declared mesh sender API (focused integration; expected 3s, maximum 30s) > declares a MiniMax sender without local lookup, fake native ID or human origin
- declared mesh sender API (focused integration; expected 3s, maximum 30s) > preserves human STOP and never replays native UNKNOWN
- declared mesh sender API (focused integration; expected 3s, maximum 30s) > keeps legacy checked native attribution and explicit human callers unchanged

Observed first errors:
- TypeError: Cannot read properties of undefined (reading '1')
- AssertionError: expected '{"ok":false,"delivery":"not_attempted…' to contain 'Native admission receipt'
- TypeError: Cannot read properties of undefined (reading '1')
- AssertionError: expected '{"ok":false,"delivery":"not_attempted…' to contain 'cannot be replayed safely'
- TypeError: Cannot read properties of undefined (reading '1')

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN: 8/8 passed across tests/harness-mesh-sender.test.ts and tests/harness-mesh-zcode-delivery.test.ts. Test owner ingress uses trustedMeshIngressForOwnerStdio, persistent HerderJobRegistry and real UserMessageDelivery; unauthenticated SDK send refuses, authenticated native send succeeds. Native UNKNOWN recorded durably, reusing same inputId returns same initial budget receipt and performs no second native send; ZCode accepts only official V4 proof and refuses unauthorized ingress. No production guards changed.

- 2026-11-02: Full-suite verified SHA 71f8fa2 (source tree): 503 files, 499 passed, 4 skipped; 4332 tests, 4318 passed, 14 skipped; exit=0, 0 failures, 0 unhandled errors. Evidence .catalog-release-all.log, plus previous per-cluster RED/isolated GREEN in this record. Resolution retained with full history.
