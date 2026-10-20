# Integrator progress evidence projection

`buildIntegratorProgress` is a pure read model for a future dashboard join. It normalizes the existing `SessionDetails`/`AgentSession`, `SessionMessageView[]`, `SessionLifecycleSnapshot`, `HarnessEvent[]` and `HerderJob[]` types. Harness events must match both harness and session ID; jobs must match the exact owner session ID. Additional provider waits and blocks are accepted only as explicit timestamped receipts because those have no common native type yet. It does not call a model/provider, schedule work, restart a session or choose a fallback.

## States

| State | Evidence required |
| --- | --- |
| `queued` | A durable Herder job receipt whose state is `queued`. |
| `active_progress` | A timestamped running session/lifecycle/harness turn observation, or a transcript assistant/tool row compatible with fresh running/current-turn evidence. |
| `externally_waiting` | An explicit human/provider wait receipt with reason and receipt ID. |
| `blocked` | An explicit block receipt with reason and receipt ID. |
| `terminal` | A timestamped native `turn.completed`, `turn.failed` or `session.deleted` event; a stopped/error session snapshot with valid activity time; or an ended lifecycle receipt. A child Herder job's completed/failed/cancelled/interrupted state is not session termination evidence. |
| `stale_running` | Running evidence older than the caller's `staleAfterMs`, or a stale running session snapshot. This describes the evidence age only; it does not mean dead. |
| `unknown` | No usable evidence, invalid/far-future timestamps, or a permission flag without a timestamped permission receipt. |

The newest valid timestamped observation wins; fixed state priority does not let an older terminal/block/wait receipt mask later activity. When the running native session snapshot exposes `meta.nativeActiveTurnId`, a matching turn wins over another identified turn only when their timestamps are within the configured clock-skew window. This avoids letting a slightly skewed old-turn terminal event mask the current turn while still allowing clearly later observations to win. Equal-time evidence without a turn distinction uses state priority (terminal/block/wait before progress). The result carries the chosen source, normalized observation time, optional native receipt/turn ID, reason and age. Timestamps farther than the configured future-skew tolerance (30 seconds by default) are ignored. Non-finite `now`, negative/non-finite staleness thresholds, and invalid tolerance produce `unknown`.

## Current integration boundary

The repository currently has concrete lifecycle-hook (`start`, `turn-start`, `turn-end`, `end`), native harness turn/session events, native message timestamps and durable Herder job timestamps. A current `running` session snapshot is active while its `lastActivity` remains inside the staleness window; once older, it is `stale_running`. Transcript rows count as progress only with fresh running evidence and compatible turn/time scope; old transcript rows cannot revive a stopped session. A typed `permission.requested` event, or a `needs_input` session carrying its permission ID and activity timestamp, is an external wait. A bare boolean without a permission ID or valid time remains `unknown`. There is no common normalized provider-wait or general blocked source; these require an explicit timestamped receipt. A stopped/error snapshot without valid activity time is not accepted as terminal evidence. Invalid/non-finite clock or threshold inputs fail closed to `unknown`.

This source slice is not wired into the Agent Herder dashboard/runtime. A future join must pass the exact native receipt and timestamp, preserve the existing source identity, and keep `unknown` default-deny. It must not turn elapsed time, wall-clock freshness or a model claim into proof that a session died or completed.
