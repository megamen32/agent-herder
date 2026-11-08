# Bounded Codex completion hook

## Owned result

Added `scripts/v1-completion-hook.mjs` and `tests/v1-completion-hook.test.ts`.
The native Stop payload must contain its actual `session_id`, `turn_id`, and
`cwd`; the pinned Codex contract recorded in `docs/codex-parent-completion.md`
documents those fields. The hook accepts exactly one protected local mapping
for that native session and cwd, reads a protected bearer file, and submits one
JSON-RPC `tools/call` (`automation`, action `reconcile`) to the fixed shared
GPTAdmin MCP URL. It passes the mapped `child_ref`/`rule_ref` and a stable
exact native `turn_id` as `event_id`, matching Fermat's `CompletedTurnReader`
contract. Core derives its request key from rule and event IDs, with the child
session separately bound by `child_ref`. A repeated Stop for that same turn
therefore carries the same event ID; this hook does not retry. Redirects are
rejected. Timeout is configurable from 250ms to 30s (`timeout_ms`, default
5s), failures are silent, and stdout is always `{}` so native Stop is not blocked. The hook only signals
the core to reconcile; it does not claim that a child completed or that a
parent was woken.

## Local config contract

Default config path: `~/.config/agent-herder/v1-completion-hook.json`, mode
`0600`. It contains the exact fixed endpoint, `bearer_file`, optional bounded
`timeout_ms`, and a `children`
array of `{session_id,cwd,child_ref,rule_ref}` entries. The referenced bearer
file must also be mode `0600`. A missing/ambiguous mapping, absent native ID,
wrong permissions, or malformed config has no network effect. No setup was
performed against a real child mapping or credential in this worker task.

## Evidence

- `npx vitest run --root . --config vitest.config.ts tests/v1-completion-hook.test.ts` — 6 passed.
- `node --check scripts/v1-completion-hook.mjs` — passed.
- `git diff --check -- scripts/v1-completion-hook.mjs tests/v1-completion-hook.test.ts` — passed.
- CLI stdin probes with absent config and with a valid-shaped but unmapped
  identity both emitted exactly `{}` and exited successfully.
- Tests inject a fake fetch function and verify one effect, fixed URL, request
  mapping, exact native turn ID forwarding, missing/foreign/ambiguous identity
  refusal, no retry on transport error, and protected file modes.
- Read-only live gateway proof on 2026-11-08 used the existing Authorization
  header directly from `~/.codex/config.toml` without displaying it: MCP
  initialize HTTP 200 negotiated `2025-03-26`; initialized notification HTTP
  204; tools/list HTTP 200 JSON, with no session ID and no SSE response.
  Discovered `automation` input schema supports list/get/create/update/pause/
  delete; **reconcile is absent**. No tools/call or model send was made.
- The new hook itself was run against the real endpoint with an ephemeral
  `0600` config and bearer fixture: it observed `initialize:200`,
  `notifications/initialized:204`, `tools/list:200`, exited 0, and correctly
  made no `tools/call` because the live schema omits `reconcile`.
- A separate live read-only pagination audit found 15 tools on one page;
  `automation` exists and its published action variants omit `reconcile`.
- Installed Codex CLI reports `0.167.0`. The local documented/pinned Stop
  contract (`docs/codex-parent-completion.md`, pinned `rust-v0.162.1`) names
  `session_id`, `turn_id`, and `cwd`; this checkout's established Stop consumer
  reads `session_id`/`cwd` and consumes `turn_id`. No actual native Stop payload
  was captured, so runtime delivery of these fields is not claimed. Hook
  behavior is fail closed if any of these fields is absent; there is no native
  reader fallback or guessed turn identity.

## Acceptance boundary / next owner action

The shared endpoint handshake and read-only discovery are live-verified, but
the discovered schema lacks the required `reconcile` action; production
reconciliation therefore intentionally stops after discovery and makes no
write call until Core exposes it. A real local child mapping/credential and
parent consumer readback were not exercised. The hook is not registered or installed here; the
parent orchestrator remains responsible for enabling this exact hook after
Core reports green and then proving an actual parent wake with zero extra
model sends. Thus this worker result does **not** establish end-to-end autowake.
