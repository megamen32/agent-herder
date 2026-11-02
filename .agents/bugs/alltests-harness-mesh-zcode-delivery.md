# alltests-harness-mesh-zcode-delivery

Description: Full project test suite observed 2 failed test(s) in tests/harness-mesh-zcode-delivery.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/harness-mesh-zcode-delivery.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- advertises and routes only verified official ZCode V4 admission, retaining accepted input without requiring a fabricated turnId
- never replays an uncertain official ZCode input or enables an unsupported adapter

Observed first errors:
- AssertionError: expected { state: 'not_attempted', …(3) } to match object { state: 'admitted', …(2) }
- AssertionError: expected { state: 'not_attempted', …(3) } to match object { state: 'unknown', retryable: false }

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: fixed_pending_full_suite
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.

- 2026-11-02: Focused RED→GREEN: 8/8 passed across tests/harness-mesh-sender.test.ts and tests/harness-mesh-zcode-delivery.test.ts. Test owner ingress uses trustedMeshIngressForOwnerStdio, persistent HerderJobRegistry and real UserMessageDelivery; unauthenticated SDK send refuses, authenticated native send succeeds. Native UNKNOWN recorded durably, reusing same inputId returns same initial budget receipt and performs no second native send; ZCode accepts only official V4 proof and refuses unauthorized ingress. No production guards changed.
