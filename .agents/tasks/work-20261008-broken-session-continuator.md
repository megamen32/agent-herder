# Broken-session continuator TDD, 2026-10-08

Owner: root/broken_session_continuator_tdd. Existing canonical checkout only.

User requested deterministic recovery of confirmed broken existing sessions
without LLM dependency, separate from the semantic autopilot.

Implemented and focused verified: provider-wide native disconnect fanout with
generation/timestamp fencing; matching cold failure ingestion after controller
death; exact interrupted-disconnect handling; fresh native active/permission/stop/
forget checks before controls; independent no-LLM recoverPending entrypoint.
Adjacent forgotten-session audit correction was reviewed with its semantic owner.

TDD red cases were observed before each change; final focused suite 63/63.
No app/DB/LLM/native session was launched by the tests. Foreign web UI WIP remains
untouched and must not be described as a clean whole checkout.

Outstanding: safe live activation and a real native recovery canary. Shared SDK
stdio shutdown makes a controller restart unsafe without native ownership proof.
Do not mutate the shared unfinished ledger from a parallel one-shot runner.
Root performs separately authorized manual recoveries; exact owner admission,
fresh resource/stdio gates and same native turn readback remain mandatory.

Published core: `30dcb974c989ac1d31eec3a379103bea657d3f95`.
Published finite observer: `98cb8aa3a93b8640699b7ca8a0478cd4abacf1fe`.
Three observer tests PASS. Actual UnixWS read-only canary completed six checks
in 26.04s, measured peak RSS 99,584KiB; zero controls/LLM/shared-ledger writes.
Cabinet and delivery latest native turns are interrupted/idle with no exact
durable recovery cause: HOLD. Receipt is
`.tmp/broken-session-continuator/native-watch.json`.

Full goal remains unfinished. Smallest next action: bind verified OOMd death of
session-71098.scope to each exact owning native turn/generation, then fresh
owner/case and reserve admission, activate the published recovery entrypoint
without disposing shared SDK sessions, and read back the recovered native turn.
Global OOMd death and idle inventory alone cannot supply per-turn evidence.
Current fresh memory observation no longer has the prior numeric UID deficit;
this does not bypass any case, lifecycle, stdio or explicit human-stop gate.

### Actual manual owner-route recovery, 2026-10-08 13:57 UTC

User-authorized delivery01a11b29 continuation was performed through the existing
live Herder HTTP owner after the separate thin-client operation had an uncertain
receipt. The old intent was preserved, never cleared/replayed. A new local
operation/inputId was exclusively claimed before one POST, under fresh same-turn
idle/empty native+deferred queue/humanStopfalse/reserve checks. The HTTP request
timed out at25s because the loaded controller still waits for completion; there
was no HTTP/native replay. Readback used a fresh bounded RPC connection, since
the pre-POST connection had reached its own25s absolute deadline.

Actual new turn01a11bcb-3547-70f3-bdde-bf1d7723972b is inProgress; the new operation
marker binds to native userMessage msg_01a11bcb-3c41-79b0-8dff-1238e1dddb80.
Native exec/output pairs at13:55:03 and13:56:16, plus current-turn events13:56:52,
prove that the delivery session resumed actual work. Own compact receipt:
.tmp/broken-session-continuator/owner-acdff548222e1778f60fcef969d39e5be30f485f7d01d9ab923bebccf933f60c.json.
No conversations, secrets or request body copies were stored in project receipts.

The full4-target checkpoint merges native identities and compact app cursors
without replacing the registry with partial wait responses:
.tmp/broken-session-continuator/four-session-checkpoint.json. Airlock, infrareview
and delivery are active with fresh tool activity; cabinet remains the reserved
automatic canary, interrupted/idle with no fabricated failure cause. Native queues0.

Source control slice6fd6db0 and exact rejection diagnostic fix48ff74b are published;
8control+3observer tests passed. This proves explicit manual recovery, not automatic
process-death recovery or product completion. The next automatic step still needs
exact scope-death to native-turn/generation binding, fresh owning admission and
safe activation of the no-LLM recovery entrypoint without disposing shared SDK runs.
PG/build/push/deploy were not granted by the manual session continuation.
