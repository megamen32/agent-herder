# FIXQ core — source GREEN

Completed 2026-11-08 00:16 MSK. Scoped commit `561951ccd55b17f0e4dd09918037b9e520bc9fd9`; no push.

## Contract

Only the locally configured and initialize-validated harness `codex`, on the actual RPC call `createSession`, may produce `AhapError::CodexCreateQuotaNotSubmitted`. Remote `data.method` cannot select this path. Existing JSON-RPC version, exact response ID, exclusive result/error and error structure checks run first. Require exactly three response-frame fields, exactly three error fields, integer error code -32000, string message, and exactly these eight data fields:

```json
{"outcome":"not_submitted","admitted":false,"notSubmitted":true,"retryable":false,"code":"codex_quota_guard","method":"createSession","operation":"thread/start","reason":"below_reserve"}
```

Allowlisted reasons: `provider_denied`, `below_reserve`, `quota_unknown`, `quota_snapshot_expired`, `quota_policy_unavailable`. Contract matches the current Codex wrapper introduced by commit `b102a0b6`; no wire extension required. Unknown extensions fail closed.

The typed error maps to `SubmitError::DefinitelyNotSent` with the fixed safe reason `Codex quota guard rejected thread/start before native submission`. No remote diagnostic text is forwarded. Other harnesses, other actual methods, incomplete or contradictory payloads, wrong response IDs, ambiguous frames and lost transport remain UNKNOWN.

## Owned source

- `crates/herder/src/adapters/ahap.rs`: strict typed RPC classification using local call context.
- `crates/herder/src/adapters/ahap_opencode.rs`: typed error mapping to fixed safe DefinitelyNotSent reason.
- `tests/ahap_v1_reuse.rs`: fake subprocess contract cases, exact single-RPC assertions.

## Verification

RED before production fix:

```sh
cargo test --manifest-path crates/herder/Cargo.toml --lib fixq_ -- --nocapture
```

Result: positive quota case failed with OutcomeUnknown; two negative-boundary tests passed.

GREEN after final source edits:

```sh
cargo test --manifest-path crates/herder/Cargo.toml --lib ahap -- --nocapture
```

Result: 32 passed, 0 failed. Includes all five allowed reasons, missing/null data fields, contradictory values and unrecognized fields, wrong code, actual-method/harness boundaries, disconnect, wrong RPC ID and ambiguous frame checks.

Existing persistence/no-replay regression:

```sh
cargo test --manifest-path crates/herder/Cargo.toml --test scoped_stop_gate create_prompt_success_and_unknown_create_are_never_replayed -- --exact
```

Result: 1 passed, 0 failed (36 filtered). Final `git diff --check` passed; commit paths verified as only the three owned paths.

## Limits and handoff

No persisted UNKNOWN attempt was changed or reclassified. No ledger code changed. Tests used isolated fake AHAP subprocesses and temporary DB state; no native send/replay or deployment performed. Native quota integration remains CI-owned. The scoped commit is available in the shared worktree; no push was performed. Canonical evidence is this file, outside the source commit.
