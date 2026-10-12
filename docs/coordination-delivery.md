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
API. Codex uses its native steer CAS. ZCode and OpenCode use supported current-context
hooks, not their ordinary input APIs. An exact native identity is established
before reservation: ZCode's `runtime.activeTurnId` from an existing-only read;
OpenCode V1's verified last root user message ID, used by its native loop across
model/tool steps. A new user message invalidates that context identity.

Records reuse the existing private DeferredMessageStore with an explicit active
turn scope. Regular `list`, `take`, `withDeferred` and Stop inbox paths exclude
them. Native ZCode Pre/PostToolUse returns additionalContext only with its exact
hook turn ID. OpenCode's official `experimental.chat.messages.transform` appends
transient context for the exact current root user; it calls no prompt/start API
and does not persist another native user message. The existing context route
checks current native identity and the persisted HumanStopStore after the store
lock, independently of harness-specific supervisor automation policy. A known
manual hold expires pending scoped context; clearing a hold cannot resurrect it. Unknown observations
refuse output. A successful hook offer is durably recorded once before output;
a lost response is receipt-only. Next-turn mismatch expires the old context;
no end hook is needed to prevent later delivery. Pending records expire after
five minutes, at most 64 per session/512 total. Receipt tombstones last 24 hours
and are cleaned at the next existing store write. Reservation and hook return
are **not model-observed delivery**; the returned receipt remains pending.

Hermes uses the existing authenticated AgentResume ingress and inputs ledger.
Exact task binding, native SID, Gateway owner token and native turn ID are
checked. Model phase uses public `AIAgent.redirect` and its final native model
lock. Tool phase reserves bounded exact-turn context in the same inputs row;
the official mutable `transform_tool_result` hook adds it to the existing tool
result only in that same native owner/turn, never through inject_message or an
observer-only pre_api_request mutation. The result/effects are preserved and no
new turn is requested. Pending context expires after five minutes, capped at
64 active records. Stop, unknown ownership, late completion or changed turn
refuse/drop context. Gateway-task mode is supported; legacy CLI/MCP fallback
transports remain explicit-task-only. A lost accepted receipt cannot be replayed.
The callback's returned context does not itself prove the model read it.

Primary native seams verified on server100: ZCode installed zcode-server.cjs
sendText does not require baseRevision, and guide can fall back to an ordinary
queue; legacy session/send rejects active prompts. Those APIs are deliberately
excluded from active-only delivery. OpenCode live service 1.18.32 (launcher 1.18.11 is historical)
[official prompt source](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/prompt.ts)
shows noReply saves a user row and only skips starting the loop; it is not
current-turn-only admission. Native loop context transform is the supported
plugin seam. Installed Hermes PluginContext.inject_message schedules a later
Gateway dispatch, while public redirect has a model-lock refusal and official
transform_tool_result permits replacing a string before it enters model context.
Managed native sources remain unchanged. Root installs the existing plugins and
performs actual unpredictable-code model acknowledgement tests.

Earlier receipt reconciliation requires the dedicated pure
`getCoordinationMessageAdmission` contract. Codex implements it using its durable
receipt files without transport initialization/load/resume. Generic
`getMessageAdmission` must not be used: legacy ZCode may call `resumeSession`
while reading an inactive session. Earlier accepted/unknown input IDs return
receipt-only outcomes; no new message, native control or deferred entry is added.

Existing deferred inputs are preserved on a definite active-delivery refusal.
ZCode/OpenCode reservations retain existing regular inbox entries until the strict
hook offer transfers their exact IDs; a refused or held offer preserves those
explicit instructions. Hermes copies its payload into its existing durable
inputs ledger, but its pending context receipt also leaves older regular inbox
entries intact; ordinary cleanup is deferred rather than assuming a hook offer. Technical context reservations are labelled
separately from native input admission and remain model-observation-unconfirmed.
Accepted or unknown native admission keeps the existing non-replay cleanup rules.
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

## Scoped activation (Root only)

Live OpenCode actor is 1.18.32; the other launcher reporting 1.18.11 is not that
actor. Native plugin hooks are cached per instance, so source replacement alone
is not runtime acceptance. After preserving the old configured plugin artifact,
Root can stage the frozen module under a distinct versioned file URL in the
existing plugin package (keep its relative launcher layout or existing root env),
use the supported project plugin configuration for the owned fixture, then refresh
only that idle fixture directory via `POST /instance/dispose?directory=<exact cwd>`.
The [1.18.32 official handler](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts)
disposes the current InstanceState context, and its workspace-routing query
selects the directory. This is not `/global/dispose` or a shared service restart;
Root must first independently confirm there is no other work in that exact
instance. Persisted native SID/history remain the consumer address. Versioned
module identity avoids trusting an already cached old import. No such runtime
operation is performed by the source executor.

Source check setup retains initial failures: fake-hook endpoint wiring, missing
pytest in the installed interpreter, and official Hermes bootstrap re-exec into
a different dependency selection. The final stdlib scenario runner uses a private
HERMES_HOME and the documented `HERMES_DISABLE_LAZY_INSTALLS=1` test flag; it does
not install dependencies or change the live actor. Native redirect/tool-result
implementations are still the installed primary code, not replacements.

## OpenCode native loader discriminator

The real 1.18.32 consumers did not observe scoped context: their records stayed
pending despite completed effects. This is an unresolved native consumer failure,
not a successful reservation. The tagged native loader accepts one legacy
function export, passes config-tuple options, and invokes
`experimental.chat.messages.transform` before provider message conversion.
Those source contracts do not prove that this particular daemon loaded the
updated module or invoked it.

Root can replace the owned fixture's Herder plugin entry with the versioned
`integrations/opencode/agent-herder-diagnostic.js` wrapper and tuple options
`{ "diagnostics": true, "diagnosticSessionId": "<exact owned native SID>" }`.
The wrapper delegates the implementation and writes a private, bounded
`.agent-herder-opencode-diagnostic.jsonl` in that directory. Factory/hook names,
exact root user/SID and text-change booleans separate failed loading from a
missing transform call. Opt-in critical context fetch observations add HTTP
status, elapsed milliseconds, allowlisted error types and boolean/count response
metadata. Generic event flooding is delegated without logging, preserving the
128-record budget for critical transforms. The native transport and 1200ms
deadline are unchanged; a timeout cannot be called a native no-admission proof. It records no prompt/context
text and is off unless explicitly enabled. Root alone refreshes that idle
instance and performs the one authorized native check; old accepted inputs and
effects are never replayed. A new physical entry file is preferable to relying
on an already loaded module path. The optional `implementationUrl` can point to
an exact hash-verified physical implementation copy in the original
`integrations/opencode` directory; this preserves its relative package root and
avoids assuming a query suffix refreshes dependencies. Stage both frozen files
and preserve the originals; the ordinary plugin does not use this option. The wrapper does not claim delivery itself.

There is no supported immediate global hook replacement proved safe for unknown
active instances. The tagged
[global config handler](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts)
starts `disposeAllInstancesAndEmitGlobalDisposed` whenever its global update
changes config. A direct file edit is also not proof of activation: global
config is cached with an infinite TTL, and plugin hooks are instance-local.
Use the existing scoped instance route for each independently idle instance;
leave active/unknown instances intact. Future-instance global discovery and
existing-instance activation must be reported separately.

A separate observed `/config`400 reports an incomplete model `limit.output`.
The native optional ConfigModel limit requires both finite context and output.
The canonical OmniRoute catalog can emit a partial limit for unknown output;
this source defect is being corrected without inventing token limits or changing
model identities/options. It is not yet evidence that this caused the missing
Herder hook invocation.
