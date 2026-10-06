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

## Accepted launch-policy and link integration

The user requires a web-owned initial-launch policy, separate from continuation.
Canonical GET/PUT /api/automation/launch-policy returns version1, allowedHarnesses,
preferredHarness and models per harness. b61dc5b stores it separately under the
existing state directory, rejects missing/corrupt policy with503, and validates
writes before an atomic0600 replacement. 000105c adds separate web controls.
5dbd7e5 rejects native model control characters and accepts at most256 characters
consistently with the named-launch HTTP boundary. Current explicit operator
selection: Codex/ZCode, preferredCodex, models gpt-5.6-sol and
account:zai-individual-coding-plan/GLM-5.3-Flash$high. No service defaults, model
fallbacks or continuation toggles may override it. Empty allowlist disables
initial automated launch. The operator configuration must be saved explicitly
at rollout; a missing policy is never execution authority.

Neighbor Codex chat01a10bc5-6c86-7011-9962-e1bbd2285921 owns Notice Place producer
and client/tests. It acknowledged dynamic policy reads before each diagnosis,
planner, remediation and quota recovery, with visible URL in message body as
well as button. Its reviewed/pushed0cffab5 adds legacy URL compatibility and
preserves historical deep-link selection when absent from the quick active list;
root verified16/16 UI tests. Actual user notification5607 points to
inc_d5a3cd1ee5864096916519c8352bf114 and historical OpenCode session
ses_eeff33290ffelR252khDht84ma; preserving that old link does not authorize new
OpenCode jobs. New automatic selection follows the centralized web policy.

## Native grants and inspection proof

Existing shared Codex daemon4019392 remained running. New isolated canary
01a1101a-6609-7ec3-b41f-ba0fe2c878dc was created through committed Herder named
creation. A fresh client before its first prompt reported native approvalPolicy
never and sandbox.type dangerFullAccess. No business session was prompted.
Inspection exposed native model:null before first prompt;3e095cb omits unknown
models from public serialization rather than inventing one;29/29 adapter tests.

Initial isolated ZCode probe returned collaboration mode build. That field is
not the permission grant: native settings.permission.mode is separate.3578d65
uses supported setMode yolo when necessary and rejects unconfirmed full access.
44/44 adapter tests. The corrected isolated native canary
sess_1ccff967-7088-4dcd-8eb1-cb0c0120bdad returned collaborationMode build,
permissionMode yolo and needsPermission false. The older empty diagnostic
sess_3d1cbe31-03e7-4eb9-b3c3-e4889a490690 was not found by fresh raw native read;
no business-session durability claim is inferred from an empty test session.
Native evidence is in /tmp/agent-herder-native-grants-0wjeuxjg/evidence.json;
root owns bounded fixtures and cleanup. Final live Herder/policy/web/Notice Place
acceptance still pending; do not claim rollout from these source-native probes.

## Final source checks and publication

Final affected10-file run passed275/276; the only failure was a UI test matching
old wording that falsely implied manual creations were blocked too. Root made
the wording explicitly automatic and updated that content assertion; focused
UI file then passed5/5. All nine other files were green. Independent review
cleared the external Notice Place consumer after verifying its current source
reads latest policy/model before each automatic stage and fails closed without
fallback. Root's earlier eight-file regression pass was276/276; separate
historical-link UI16/16, currentpolicy4/4, launcher156/156, ZCode44/44 and native
Codex29/29 passed. No entire-repository test-suite success is claimed.

The backend worker accidentally ran76 files despite its intended filter. Three
unrelated failures were readonlyCodex descriptor status, concurrent Stop hook
(child exited null), and cross-process named find/create (child exited null).
Current focused/affected Codex and named suites passed afterward; the exact
readonly case also passed4/4 independently. Root checks the remaining exact
concurrency case separately under the shared guard rather than repeating the
broad run or treating process termination as a proven product defect.

## Live rollout and additional zero-turn continuity repair

cf2d982 was built and deployed at07:53:43UTC. The initially absent launch policy
returned503; explicit operator PUT saved the exact requested Codex/ZCode policy,
then GET returned200. The peer reports saving those same values through the UI
and a matching API read. Initial-launch policy stays separate from existing
continuation; global continuation/watchdog/rollover/pin transfer remainfalse,
with zero enabled overrides. No business sessions were activated.

The real named Codex write unexpectedly created a second task-owned canary:
native thread/list omits zero-turn threads after the process cache expires.
9a7299a adds parameterized read-only native SQLite name/CWD lookup, excludes
archived rows and confirms hidden IDs through thread/read. Independent review
CLEAR; Codex plus named-session suites49/49 and bounded full build passed.
9a7299a was pushed/fetched clean and deployed at08:08:00UTC, HerderPID1051892,
active/NRestarts0. Shared native Codex daemon4019392 remained alive throughout.
The frontend bytes remain index-DDzVHon6.js/index-DK8SxC-O.css.

Live MCP agent_info on old zero-turn01a1101a now succeeds without model field;
native unknown model is not fabricated. Root archived ONLY that own empty probe
after thread/read proved exact fixture CWD and zero turns, preserving its grant
evidence above. The task-owned writing session01a11036-e2e7-72a2-9d01-323e2990f4b7
created codex.txt outside its CWD with exact HERDER_CODEX_FULL_ACCESS_OK_20261006.
After the final restart, the same named HTTPnew-or-resume returnedcreatedfalse
and that identical ID/modelgpt-5.6-sol; native assistant replied exactly
HERDER_CODEX_SAME_ID_OK_20261006. No permission request was required.

The actual deployed ZCode canarysess_eb89671b-ba76-41fc-ae75-20727bdfcdf7
created zcode.txt outside its CWD with exact HERDER_ZCODE_FULL_ACCESS_OK_20261006.
Herder reported permissionModeyolo, needsPermissionfalse, no pending request IDs.
Its selected route was the explicit GLM-5.3-Flash$high policy model. Stopped status
after a finished bounded write is not alone evidence of interruption.

Independent read-only native verification confirms Codex approval_modenever,
sandbox_policy disabled, two task_started/task_complete pairs and persisted
marker replies. ZCode native task row is completed, permissionyolo, and its
transcript contains the matching user plus assistant response; the adapter maps
that persisted completed task to stopped. Thus this short control turn finished
successfully. Both outside marker file contents were independently checked.
Root removed only those exact verified marker files and their empty owned
directory after recording the proof; native session workspaces remain intact.

Final real Notice Place diagnosis/planner notification and exact-chat browser
acceptance are owned by peer01a10bc5-6c86-7011-9962-e1bbd2285921 and still pending.
The earlier external MiniMax bulk-plan capacity boundary is not declared fixed
from local repairs or these native canaries; no reliable bulk completion totals
or whole-repository-suite success are claimed.
