# L06 live proof — 2026-11-04

The previously reported failure was not isolated to the lease transaction: the recorded failures also affected `coordination_note` and `session_info`, while the prior probe found no listener on `127.0.0.1:18787`. No source defect was reproduced.

Current live Agent Herder MCP readback on the authority host succeeded without restarting or changing the runtime. Three consecutive real lease cycles completed:

- cycle 1: acquire fence 22, status while held, check, release, status with no lease
- cycle 2: acquire fence 23, status while held, check, release, status with no lease
- cycle 3: acquire fence 24, status while held, check, release, status with no lease

The capability was held only in memory for each check/release and was not written to this evidence or printed. Final project status had no lease. Runtime PID 518854 remained running from the candidate release throughout the checks. No restart was performed. A worktree audit found no active harness process in the Agent Herder checkout; existing checkout WIP was preserved.

Focused source regressions passed:

`npx vitest run --root . --config vitest.config.ts tests/project-release-lease.test.ts tests/project-release-admin.test.ts`

Result: 2 files passed, 28 tests passed. Runtime `dist/project-release-lease.js` SHA-256 matched the current checkout's `dist/project-release-lease.js` (b228d89cd5dd07bb0b4bfa5337ebe9b8ff4bc4b5507729b3a3ae3208a5ebe693). The live API currently works; the historical transport outage's initiating cause cannot be reconstructed from the available evidence, and no lease transaction source change was justified.

Exact test output:

```text
Test Files  2 passed (2)
Tests       28 passed (28)
```

Exact live readback: `three real API acquire/status/check/release/status cycles succeeded; fences 22-24; final project status lease=null`.
