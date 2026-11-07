# FIXQ: typed Codex quota refusal in AHAP wrapper

Source result ready for core integration. Commit `b102a0b6` (not published).

Owned committed paths:
- `src/ahap-codex-runner.ts`
- `tests/ahap-codex-runner.test.ts`

The wrapper classifies only `cause instanceof CodexQuotaBlockedError`, method
`createSession`, operation `thread/start`, and an allowlisted decision.reason.
Allowed reasons: `provider_denied`, `below_reserve`, `quota_snapshot_expired`,
`quota_unknown`, `quota_policy_unavailable`. Unknown reason stays UNKNOWN.

Wire contract: JSON-RPC error code `-32000`, static sanitized message, data:
```json
{"outcome":"not_submitted","admitted":false,"notSubmitted":true,"retryable":false,"code":"codex_quota_guard","method":"createSession","operation":"thread/start","reason":"<allowlisted reason>"}
```
No raw exception text, quota snapshot, window metadata or credentials are emitted.
Other exceptions, duck-typed quota errors, another operation and another mutation
retain UNKNOWN; every test checks exactly one adapter call, no automatic replay.

## RED to GREEN

Command: `npx vitest run tests/ahap-codex-runner.test.ts -t FIXQ --reporter=verbose`

- RED before source edit: 5 failed, 5 passed, 8 skipped. Each real typed refusal
  incorrectly produced generic UNKNOWN. See `fixq-wrapper-red.log`.
- GREEN after edit: 10 passed, 8 skipped, 1.31s. See `fixq-wrapper-green.log`.
- Scoped `git diff --check`: exit 0.
- Commit contains only the two owned paths above.

Existing native/socket tests deliberately were not run: this slice uses typed
exceptions and in-memory AHAP streams only. Original Codex UNKNOWN was neither
read as a new submission nor replayed. No native process, model, quota-policy,
adapter, core, runtime or deployment change. Singer owns core-reader integration;
this evidence proves source wrapper behavior, not installed consumer acceptance.
