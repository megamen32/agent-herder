# Deterministic broken-session recovery

Crash recovery and the LLM autopilot have separate entrypoints. `recoverPending()`
uses native failure/disconnect evidence, owner admission and same-session control;
it never calls a completion judge. `runAutopilotCycle()` owns semantic planning
and notifications. The existing lifecycle clock starts these independently, so an
offline or stalled provider cannot block native recovery. No new timer is required.

A provider-wide transport exit fans out only to persisted active root-turn
identities that preceded that exact event. Native starts received while the event
waits for I/O fence obsolete fanout. A subscription access error remains
observation loss. Cold ZCode terminal evidence can convert a matching pre-crash
active identity, while preserving a newer identity or any accepted/queued admission.

An interrupted Codex turn is eligible only with existing same-turn disconnect
proof and no human-stop fence. Interrupted/idle/completed inventory alone supplies
no such proof. Recovery re-reads native state before resume and before send:
a newly active turn, permission request, explicit stop, forget, identity change
or unavailable read holds delivery. Owner resource/stdio gates still apply.

## Verification and activation

The regression suite first reproduced missed global disconnect, missed matching
cold failure, an accidental LLM call, interrupted disconnect exclusion and
native start/stop/forget races. Focused validation on 2026-10-08 passed 63 tests:
14 broken-session tests, 32 launcher tests and 17 admission tests. Tests use
one worker and CPU, a 256 MiB Node heap and a 40-second wall bound; fixtures
never launch an app, database, native session or LLM.

Source publication does not hot-reload the existing controller. Its shared
ZCode SDK owns stdio; controller exit currently disposes native process trees.
Do not restart that controller while native owning-host/current-state evidence
is unavailable. A bounded one-shot observer may attach to the existing Codex
Unix websocket; it must not become a second writer of the controller's mutable
unfinished ledger. Real recovery needs a scoped receipt and a native turn
readback. A queued/accepted reply alone is insufficient.

At 2026-10-08 12:35 UTC the canonical `autopilot-live` ledger had a cabinet
active-turn identity without a recovery cause, and no Airlock recovery row.
Those observations do not prove process death or authorize a fabricated cause.
Runtime activation and a real recovery canary remain separate required work.

A finite native observer is available as
`node --max-old-space-size=128 scripts/deterministic-native-watch.mjs <existing-id> [<existing-id>]`.
It attaches to the existing Unix socket with the same read protocol as the adapter
(`initialize`, `thread/read`, `thread/turns/list`), keeps only native identities/status,
and exits after at most six checks/40 seconds. It has no prompt/resume/stop API,
LLM import, shared-ledger write or timer installation. Apply the existing project
outer budget, CPU1 and a 45-second external timeout; its RSS guard is 128 MiB.
Three focused observer tests passed, including unavailable/unknown metadata and
non-finite reserve values. An initial full-adapter import exceeded this soft RSS
guard; that import was removed before the successful canary.

Actual 2026-10-08 12:55:09 UTC canary: six checks in 26.04 seconds, measured process
peak 99,584 KiB, zero LLM calls and native controls. Cabinet and delivery remained
idle with interrupted latest turns, without an exact durable recovery cause,
so both stayed HOLD. Compact receipt:
`.tmp/broken-session-continuator/native-watch.json`.
Fresh UID soft/hard spare were 88,111,931,392/98,849,349,632 bytes; host available
35,853,639,680 bytes; memory PSI some/full zero. These numbers are observations,
not case admission. The native watcher has run; the cached controller recovery
module has not been hot-loaded. Real deterministic recovery is still unproven.
