# Hermes health remediation initialization stall

Original request: complete the health remediation business path. The permitted
attempt 3 reached Hermes but stalled at `Initializing agent` after one bounded
shell step; supervisor stopped it and NoticePlace containment prevented a
second external launch.

Objective: establish the root cause and make the Hermes runtime fail fast on
absence of useful progress, producing a bounded terminal record. Do not claim
that fail-fast alone repairs the underlying infrastructure signal.

Business canary: a Hermes job that emits initialization-only output and then
stops progressing is converted to a terminal stalled/error result with its
session trace; it cannot silently keep a remediation delivery alive.

Confirmed scope: Agent-Herder Hermes adapter/session supervision and focused
tests. No Hermes chat launch, no Telegram send, no delivery requeue, no
production deploy/restart, no secret access.

Initial active estimate: 20 minutes.

## План (Russian)

1. Собрать bounded evidence о CLI/child/process состоянии и найти stall seam.
2. Написать failing regression для initialization-only progress.
3. Исправить fail-fast supervision, проверить и заревьюить до нового canary.

## Execution log (English)

- 2026-08-11: Attempt 3 session
  `hermes-job-6c0b139a-5950-4333-9fc0-d794eb0a276f` had 27 output messages
  ending at `Initializing agent` / one 0.4-second shell step. Its useful
  fingerprint and last activity remained unchanged for over one minute while
  status stayed running. Supervisor stop succeeded. No strict terminal
  remediation receipt was produced.
- 2026-08-11: Red first: a fake health job emitting only `Initializing agent`
  stayed running after its configured useful-progress deadline.
- 2026-08-11: Added a bounded useful-progress watchdog (default 120 seconds,
  capped by the hard job deadline). Initialization/decorative output does not
  reset it; substantive output does. Stall terminates the child and records
  termination reason `stalled` with last useful activity metadata. Green:
  Hermes adapter, HTTP API, and session detail tests -> 18 passed; `tsc
  --noEmit` -> exit 0.

## Review (English)

- Verified the changed Hermes adapter behavior against the stated business
  canary with focused tests: `tests/hermes-adapter.test.ts`,
  `tests/http-api.test.ts`, and `tests/mcp-definitions.test.ts` all passed
  under `npx vitest run --root . --config vitest.config.ts ...`.
- The initialization-only stall path now converts to a terminal `stalled`
  result with session metadata, and the watchdog is cleared on finish/cancel
  so it does not leak timers across job lifecycle transitions.
- No direct regressions were found in the touched paths that would block the
  Hermes health remediation objective.

Verdict: APPROVE
