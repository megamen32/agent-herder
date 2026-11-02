# alltests-codex-app-server

Description: Full project test suite observed 18 failed test(s) in tests/codex-app-server.test.ts. Fix native cause or correct stale fixture only with independently verified semantics. Do not skip/disable tests or relax safeguards.
Evidence: isolated worktree origin/main=4a97225, branch commits through 5132ed9; .catalog-alltests.log, grep exact 'FAIL  tests/codex-app-server.test.ts'. Full-suite result 103 failed / 4211 passed / 1 unhandled rejection.
Cases:
- Codex app-server adapter > records a late deferred H34 reservation UNKNOWN and never starts a thread after abort
- Codex app-server adapter > materializes once into the H34 journal and restores the accepted same ID with fresh scope proof
- Codex app-server adapter > refuses materialized UNKNOWN operation reuse before any native create
- Codex app-server adapter > keeps project policy constructor-only and refuses shared or caller-overridden transports
- Codex app-server adapter > keeps ephemeral project thread naming in adapter memory without metadata RPCs
- Codex app-server adapter > rejects foreign project resume and recover before native RPC and preserves owned provenance
- Codex app-server adapter > rejects a stale project root before initializing or resuming
- Codex app-server adapter > refuses foreign project history reads before transcript access, initialization, or RPC
- Codex app-server adapter > refuses owned project history reads after the bound root becomes stale
- Codex app-server adapter > permits owned project history reads while the bound root remains current
- Codex app-server adapter > scoped cold session listing never delegates to the global transcript index
- Codex app-server adapter > scoped ready session listing returns only in-memory owned IDs
- Codex app-server adapter > stale project root empties scoped session listing before readiness or reads
- Codex app-server adapter > scoped named lookup ignores foreign index candidates before native reads
- Codex app-server adapter > stale project root empties scoped named lookup before readiness or reads
- Codex app-server adapter > scoped collection reads preserve positive access to locally owned threads
- Codex app-server adapter > resolves only server-owned current project scope, homes, root identity, and native version
- Codex app-server adapter > uses fresh native state for an owned ephemeral thread before its first rollout exists

Observed first errors:
- Error: Test timed out in 15000ms.
- Error: materialized Codex current scope is unavailable
- Error: ENOENT: no such file or directory, stat '/tmp/agent-herder-vitest-wfiwUo/codex-home'
- Error: cannot resolve the Codex executable for the process-local sandbox profile
- Error: cannot resolve the Codex executable for the process-local sandbox profile

Blocks: PR25 merge/release until all suite failures are resolved or exact gated blocker is recorded.
Status: open
History:
- 2026-11-02: Confirmed in full 503-file suite, counted and registered before repairs. No unrelated owned code changed by this record.
