# Completion stability and unattended session grants

Owner: Codex chat 01a10b3f-b648-74d0-8265-023d1ae85312.

User authorization 2026-10-06: prevent continuation of already completed tasks;
Agent Herder must give full grant access immediately to sessions it creates for
unattended work. This authorizes native full-access creation settings, superseding
the earlier permission-preservation assumption for those new sessions. Existing
unrelated native chats are not blanket changed. Same-ID continuation remains the
accepted contract; do not enable rollover or create duplicate business sessions.

## Preflight

Repo clean main at 356aeae (latest ops change: output reservation 1024,
concurrency one). Live Herder PID 3556171. State settings presently global disabled,
watchdog disabled, zero enabled overrides; preserve these settings. Inventory has
214 rows, zero durable unfinished rows, no assessment failures. False-resume
history needs correlation, not inference from a stopped native turn.

Named creation through deliver/new_or_resume passes no permission mode. Codex
thread/start does not pass approval/sandbox; ZCode automation passes yolo but
native effective permission contract needs verification. No installed core edits.

## Shared budget and ownership

Measured host 36 GiB available, UID 30.1/44 GiB, memory PSI zero. Existing Herder
limits: RAM soft/hard 1/2 GiB, swap512 MiB, CPU4cores, tasks512. Focused tests and
builds share /run/user/1000/agent-herder/heavy-check.lock; one worker, soft/hard
1/2 GiB, no swap, CPU2cores, tasks128, IOWeight10, timeout120s, scope150s. No
containers/GPU/dependency install; use existing tests and cleanup bounded fixtures.

Continuity worker owns launcher + tests; grants worker adapters/types + focused
tests; root named creation/cache-handoff callers + tests, integration and live
isolated consumer proof; independent explorer reviews completion/grant deltas.

Completion requires native full-grant creation proof, completed-task no-resume
proof and new-user-request wake proof, reviewed clean synchronized remote main,
Herder-only rollout, settings preserved. Never claim semantics from unit tests
alone; record exact external/native limitations when a canary fails.

## Confirmed path and source repair

The completed-session skip required unchanged native metadata and no urgency.
Native turn.completed/failed always queued urgency and could mark a fresh pending
row despite an earlier completed assessment. With identical transcript but
status/time/title changes, a new false unfinished verdict could send continuation.
9e2ff58 closes completed tasks by current semantic evidence, preserving new user
work. fce735f conditionally discards only the exact nonaccepted snapshot inside
one serialized mutation; a concurrent native event/new admission survives the
asynchronous history read. Launcher suite 156/156; independent review clear.

Live known completed entries at preflight: sess_92cc95b6-a821-44b1-ae13-f046bc85fe90
and sess_5539f292-1ef6-4d48-bc83-7c98e363b93a, both stopped, confidence0.99, no
active unfinished row. No business session was woken or changed for this proof.

5824135 passes fullAccess:true through all named creation routes and cache handoff
(33 focused tests). a7e6186 maps native permissions for ZCode (yolo), Codex
(never + danger-full-access; returned policy is checked on create/resume), and
OpenCode (permission-specific allow-all ruleset on POST/session, no global PATCH).
Installed/live OpenCode schemas confirm per-session permission support. ZCode
41/41, focused Codex grant/rehydration 1/1, OpenCode grant 1/1, build passed.

Broader Codex suite exposes an existing readonly-rollout status failure twice:
expected idle, actual running even though descriptor probe sees no writer.
Separate Codex worker ran the exact current-head test four times: 4/4 passed,
no source or fixture change. The earlier failure is not currently reproducible;
the final affected-suite pass must still include that real descriptor test.

Native grant proof and final deployed identity still pending. The supported named
MCP creation targets in this task are Codex, ZCode and OpenCode; no promise about
other optional harness permission APIs is made. Original automation settings must
remain disabled/off as observed; this task is not permission to wake all work.
