# Coordination is not task activation

Ordinary `send_message` (omitted/false `humanRequested`) sends only into an
active native turn. An inactive/completed target returns `skipped_inactive` and
receives no input, new turn or deferred debt. Queue mode controls waiting; it
is not permission to wake a completed agent. Sender/provenance fields do not
change activation authority. An explicit human new task/send/resume keeps the
existing `humanRequested=true` path.

For `deliver`, omitted activation is `if_running` for an existing target,
including a matched named target. A **newly created named target** still
receives its initial task. Explicit `activation=always`, `new_or_resume` and
explicit `activation=defer` retain their deliberate task-launch/retention
semantics; they are not ordinary report delivery. No text classifier infers a
human request or a new task. Refresh cached MCP tool schemas: the old declared
`activation=always` default is removed, and the backend resolves omission.

After budget, provenance, inbox and context awaits, the handler rereads native
activity. It then requires an adapter's supported `sendActiveMessage` contract:
no idle start/resume or future-turn enqueue fallback. Codex app-server implements
it through existing serialized/durable admission and `turn/steer` with verified
`expectedTurnId`. Explicit native rejection may refresh once; an ended turn
returns no-admission, never `thread/resume` or `turn/start`. Lost/unknown receipts
are never replayed. A late manual Stop is reread immediately before steer.

The shared helper refuses missing/unknown observations and transports without
supported current-turn admission instead of using their ordinary queue/start
API. At this release the positive native contract is Codex app-server. Other
transports' active coordination is reported unsupported; explicit task delivery
is preserved. This limitation protects against waking a target during the final
native race and is not claimed as cross-harness steering acceptance.

Earlier receipt reconciliation requires the dedicated pure
`getCoordinationMessageAdmission` contract. Codex implements it using its durable
receipt files without transport initialization/load/resume. Generic
`getMessageAdmission` must not be used: legacy ZCode may call `resumeSession`
while reading an inactive session. Earlier accepted/unknown input IDs return
receipt-only outcomes; no new message, native control or deferred entry is added.

Existing deferred inputs are preserved on a definite active-delivery refusal.
Only already accepted or unknown native admission uses existing cleanup rules.
Ordinary reports never add a new deferred entry after a busy/no-active error.

## Failure shield and checks

Verified real RED: Root's own completed Codex fixture received one automatic
status report and incorrectly started a second turn. The source cause was both
unguarded registered delivery and `turn/steer` no-active refresh falling through
to idle `thread/resume`/`turn/start`.

Fast unit/focused integration (expected 10 seconds, maximum 30):
`coordination-idle-admission.test.ts` exercises the actual registered in-memory
MCP handler with isolated adapters; `registered-codex-delivery.test.ts` exercises
registered handlers against an owned fake native Unix socket. Shields cover
inactive/completed/permission/unknown states, context-await completion, native
no-active rejection, positive current-turn steering, explicit human/new named
launches, dedicated pure receipt reconciliation and uncertain admission without
replay or deferred debt. The Unix socket remains inside the bounded temp lease.

Final ordinary release includes direct named/provenance/budget/schema
regressions and TypeScript under the aggregate 180-second deadline. Source GREEN
is separate from Root's actual same-fixture runtime acceptance; no production
native session/send/resume/stop or Herder restart is performed by the source
executor. Root owns reviewed installation and real consumer verification.
