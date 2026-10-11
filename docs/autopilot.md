# Agent Herder autopilot

## `/autopilot`

The plugin exposes the same user command in Codex, Claude Code, OpenCode, and Hermes:

```text
/autopilot          # enable for the current session
/autopilot status   # show the current-session switch
/autopilot off      # disable for the current session
```

Codex loads the bundled `autopilot` skill and keeps using its native `Stop`
hook. Claude Code loads the native `.claude-plugin` package, captures the exact
`CLAUDE_CODE_SESSION_ID`, and invokes the shared judge from its `Stop` hook.
OpenCode loads `integrations/opencode/agent-herder-autopilot.js`, which
captures the exact `sessionID` in `command.execute.before` and invokes the
judge on `session.idle` (the slash-control turn itself is skipped). Hermes loads the extension under
`integrations/hermes/agent-herder-autopilot/`, registers the real slash command
with `register_command`, and invokes the same judge at `on_session_end`.

All four write one durable current-session switch to
`$AGENT_HERDER_AUTOPILOT_STATE_DIR/sessions.json`. OpenCode resumes through the
existing durable `agent-resume` client. Hermes injects an automatic next goal
or a selected NoticePlace choice into its bound session. Codex and Claude Code
return the next goal through native Stop-hook continuation. A selected Claude
Code choice resumes the exact session through Agent Resume.

The web session inspector exposes the same durable switch as an **Autopilot**
toggle. It does not create a second policy: changes made on the website are
immediately visible to `/autopilot status` and to the next Codex Stop hook,
Claude Code Stop hook, OpenCode idle event, or Hermes completion hook for that
exact session.

## Explicit stops in Codex and ZCode

A stop through Herder persists a fence for that native session before the
transport is interrupted. Native Codex interrupted turns and ZCode cancelled
turns also pause automation; a plain completed/stopped status is not sufficient
evidence. Codex does not identify the interrupting actor, so an external native
interruption is treated conservatively. Herder's own transport interruptions
are recorded separately and cannot erase an existing human stop.

The fence survives restarts and blocks automatic delivery, retries, watchdogs,
handoffs and replacement sessions. Creating a related session accepts
`sourceSessions` (at most 32 verified native receipts); all supplied ancestors
are checked. Unknown sources fail closed. There is no automatic ancestry
inference for a new request that supplies no source receipts.

Only an explicit human resume/new request can clear the fence. API and MCP
message/resume requests default to automation and must set `humanRequested`
only for an actual human instruction. Native UserPromptSubmit callbacks include
prompt evidence; generated prompts are registered before native admission and
cannot clear a stop. Native callback release requires the supported hook to be
installed and loaded in that session; editing hook configuration alone does not
prove that an existing process reloaded it.

`GET /api/coordination/context?consume=0` exposes the boolean `humanStopHeld`
without draining the inbox. Stop-hook callers suppress continuation if this
field is missing, invalid or unavailable.

Codex supports `POST /api/sessions/codex/:id/archive` through the native
`thread/archive` operation. Active sessions and pending approvals/input are
rejected. Archiving preserves exact-ID history and the human-stop fence; it
does not resume, delete, or migrate the session. Other adapters return an
explicit unsupported error until they implement this optional operation.
An automatic cleanup caller must independently verify the completed readonly
controller receipt, resolved incident and absence of active jobs before using
this endpoint; the endpoint does not infer those facts from a session title.

Install the Claude Code surface through its supported plugin control plane:

```bash
claude plugin marketplace add /path/to/agent-herder --scope user
claude plugin install agent-herder@agent-herder-local --scope user
```

ZCode uses the native plugin under
`integrations/zcode/agent-herder-autopilot/`. Its `Stop` hook returns ZCode's
native continuation output for automatic next goals; it never starts an
app-server or connects to the Z.AI web relay. For a Telegram/NoticePlace
choice, the Stop hook exits immediately after persisting the question. An
explicit selection resumes the same native session through the existing
choice consumer; the hook does not hold the native turn open.

## Crash recovery (Autocontinue)

Autocontinue restores an interrupted native turn in the same session. It does
not judge whether a normally completed answer has finished the user's task;
that decision belongs to Autopilot. Semantic inventory does not authorize a
recovery, and recovery never rolls over to a replacement session.

The web settings expose `recoverOnFailure` and `recoverOnDisconnect` (both
enabled by default), plus a separate `watchdogEnabled` timeout option (off by
default). A timeout is an explicit heuristic for a turn with no observed
progress, not proof that every long model call has failed. Existing explicit
watchdog settings are preserved.

Recovery requires observed native turn identity and durable failure evidence.
Normal completion supersedes that evidence. Running sessions, pending human
input or approvals, human-stop holds, non-retryable admissions, and native
Codex subagent threads are excluded. The supervisor delegates recovery to this
single owner, so a second retry loop cannot bypass these settings.

After a restart, ZCode recovery also reads the newest durable native error
receipt without starting its transport. It must belong to a root session and
the exact latest user message, with no newer progress, successful answer,
pending input, or user cancellation. A flattened task-index `completed` label
does not override this evidence; a confirmed current error is shown as an error.
Missing schema or ambiguous evidence never authorizes a retry. Native
`retryable=false`, unknown retryability, and human-verification failures remain
blocked with a durable reason and no native send. A client SSH disconnect alone
is not evidence that a server-side turn crashed.

Remote ZCode has one narrower cold-recovery exception: if a
`remote:ssh:` task index still says the root task is running while its newest
durable turn was cancelled, the transport has gone away without a normal
terminal event. ZCode labels that abort `cancelled_by_user` even when the SSH
client died, so the native bit is not treated as a human-stop receipt. In this
tuple Autocontinue resumes the same session once; a durable HumanStopStore
receipt, pending input, or a human-verification gate still blocks it.

When the durable Autopilot policy enables `zcode` or `codex`, the background
48-hour semantic inventory becomes an active Autopilot backlog sweep for only
those enabled harnesses. The LLM classifies each chat, then resumes every
unfinished native session under its original session ID. Planner clusters are
split before dispatch so one chat cannot absorb or disable another. Session
overrides, explicit human-stop fences, cancellations, pending input/permission,
and human-verification gates still block delivery. With Autopilot disabled the
same inventory remains a read-only explicit audit.

## Agent Plugin package

Agent Herder ships an [Agent Plugins 1.0](https://agent-plugins.org/) package.
The portable root is `plugin.json`; the existing Agent Herder MCP server is
declared in `mcp.json` and uses the same built `dist/` runtime.

Agent Plugins 1.0 does not standardize lifecycle hooks. Codex loads the thin
adapter declared under `extensions.com.openai` from
`com.openai/hooks/hooks.json`; the judge, receipts, NoticePlace choices, and
continuation logic stay in the shared Agent Herder runtime. The
`.codex-plugin/plugin.json` file is a thin compatibility manifest for Codex
marketplaces that still discover that location directly.

The launcher contains no credentials. It reuses the existing local OmniRoute
and NoticePlace environment files when present, defaults to the
`autopilot-live` state directory shared with the callback service, and enables
all-session supervision for the installed plugin. Set
`AGENT_HERDER_AUTOPILOT_ALL_SESSIONS=0` in the hook environment to roll back to
the armed-session allowlist.

This is an additive Codex `Stop` hook. Codex still owns the session and its
native continuation mechanism; Agent Herder only judges the stop event and
returns a continuation reason when the judge says `continue`.

The standalone hook command remains opt-in per session unless its environment
sets `AGENT_HERDER_AUTOPILOT_ALL_SESSIONS=1`. The installed Agent Plugin launcher
sets that value by default because its intended mode is zero-click supervision
of every Codex session.

After the hook command is available, arm exactly one session with the explicit
local command:

```bash
agent-herder-autopilot-hook --arm-session <codex-session-id>
```

`--help` prints the same arm/configuration surface. The arm record is written
to `armed-sessions.json` beside the receipts and is additive; attempting to
arm a different second session fails closed.

## Install the package command

Build and make the package command available to the Codex process:

```bash
npm run build
npm link
```

Merge [`codex-hooks.json`](./codex-hooks.json) into the existing Codex hook
configuration. This is a merge, not a replacement: retain all existing hooks.

If `hooks/list` or `/hooks` does not list the enabled plugin's Codex
`UserPromptSubmit` callback, install that callback through the supported user
hook configuration:

```bash
node scripts/install-codex-coordination-hook.mjs
```

This preserves existing handlers, hook trust and Stop settings. Review and
trust only the added callback in Codex `/hooks`; the installer never grants
trust automatically. The callback runs in a bounded user systemd scope on
Linux (128/256 MiB memory, no swap, one CPU, 32 tasks, five seconds). It handles
new native prompts so an explicit human continuation can release a previous
manual-stop hold. A plugin-cache refresh alone does not prove that this native
callback runs. Check the real original chat after installation.

The command is:

```text
agent-herder-autopilot-hook
```

Do not install or trust the hook in a live Codex profile until the runtime
operator has explicitly confirmed the judge endpoint/model, Notify producer
token, and Matrix consumer/room policy.

## Runtime configuration

The hook reads one session arm from either:

```text
AGENT_HERDER_AUTOPILOT_SESSION_ID=session-id
```

or a newline-separated / JSON-array file named by
`AGENT_HERDER_AUTOPILOT_ARM_FILE`.

When neither form is supplied, the hook reads
`armed-sessions.json` from the state directory. This is the file written by
`--arm-session`.

It requires these judge settings:

```text
AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL=https://judge.example/v1
AGENT_HERDER_AUTOPILOT_JUDGE_MODEL=model-name
AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN=...
```

For a direct provider credential already stored on disk, set
`AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE` instead of copying the secret into
the environment file. Both launchers load public endpoint/model settings from
`~/.config/agent-herder/autopilot.env` and read only the first line of that
credential file inside the hook process.

## All-session mode

The installed Agent Plugin launcher evaluates every Codex session without an
`armed-sessions.json` entry. For a standalone or legacy global Stop hook, enable
the same behavior explicitly in the environment inherited by the hook process:

```text
AGENT_HERDER_AUTOPILOT_ALL_SESSIONS=1
```

Only the exact value `1` enables this mode in the hook runtime. The packaged
launcher supplies `1` when the variable is unset; an explicit value such as `0`
keeps the armed-session allowlist behavior.

The all-session mode keeps the existing safety limits: the per-session
continuation budget (three by default), filesystem locking, and
`session_id`/`turn_id` receipt deduplication remain active; transcript and
choice context stay bounded and secret-redacted; and outbound notifications
still require the explicit Notify recipient and producer credentials. Because
every Codex stop can reach the judge, enable it only in a controlled
environment and unset the variable to return to allowlist-only operation.

The judge receives the official Codex `Stop` payload plus a bounded tail of the
transcript and the last assistant message. It must return one of the strict
JSON decisions described in the prompt:

- `continue` with `nextGoal`: returned as Codex `{decision:"block",reason}`;
- `done` with `summary`: terminal and always emits a completion notice through
  Notice Place (including its configured Telegram fan-out);
- `human` with `title`, `body`, and `severity`: terminal, emits a notice.
- `choice` with 2–4 `{choiceId,label,nextGoal}` options when several safe next
  steps are possible. `nextGoal` stays in the durable registry; only the
  opaque choice identity and user-facing label cross the Notify boundary.

For a `choice` notification, the Telegram body is a bounded Russian context
card. It includes the project, the short session ID, the latest real Codex
`event_msg.user_message`, the latest assistant message, the reason a choice is
needed, and the numbered options. Secret-like values are redacted. The
callback resumes the exact Codex session and then removes the inline keyboard,
leaving a `✓ Выбрано: ...` marker. If the user taps an already-resolved card,
the callback is idempotent and does not send a second turn.

The web dashboard uses the same durable choice registry. Its default inbox
shows only running sessions, sessions waiting for input, and sessions with a
pending autopilot decision; enable **Show completed sessions** in settings to
restore the full list. Pending decisions render as buttons on the bound session
card. Selecting one resumes that exact Codex/Claude Code/OpenCode session through Agent
Resume (or hands it to the Hermes polling plugin), then removes the buttons.
The browser receives only `choiceId` and the user-facing label; `nextGoal`
remains server-side. Clicking the session row opens its available conversation
history in the main panel.

Human and completion notices use the existing `notify.event.v1` producer seam:

```text
NOTIFY_CENTER_EVENT_URL=http://.../v1/events
NOTIFY_CENTER_TOKEN=project-scoped-token
AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT=me
AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT=agent-herder
AGENT_HERDER_AUTOPILOT_NOTIFY_KIND=notification
```

If the autopilot-specific recipient is omitted, Agent Herder uses the shared
`NOTIFY_CENTER_RECIPIENT` from the Notice Place environment.

Agent Herder does not call Matrix or Telegram directly. NoticePlace keeps its
configured fan-out, so adding Matrix does not remove existing notification
channels. `202 Accepted` means the event was durably accepted; it is not proof
that a person has seen it.

Receipts and per-session continuation state are stored under
`~/.local/state/agent-herder/autopilot` by default. Override with
`AGENT_HERDER_AUTOPILOT_STATE_DIR`. The Stop-hook process and the HTTP callback
service must use the same explicit directory; the production user unit uses:

```ini
Environment=AGENT_HERDER_AUTOPILOT_STATE_DIR=%h/.local/state/agent-herder/autopilot-live
```

The default continuation budget is three; override with
`AGENT_HERDER_AUTOPILOT_MAX_CONTINUATIONS`.

The hook uses a short-lived filesystem lock and a stable fingerprint for each
Stop iteration. An exact replay does not cause a second judge call or
notification, while a later Stop after a native Codex continuation is judged
again even though Codex intentionally retains the same `turn_id`. The
continuation budget applies to that user turn; after the budget is exhausted,
the judge may still declare `done` or ask the user, but another silent
continuation is not admitted.


## Fleet recovery admission

The production launcher and the supervisor's independent failed-turn retry use
one admission reader for the existing canonical fleet monitor registry. Override
its location with `AGENT_HERDER_FLEET_MONITOR_STATE`. A registered task must be
`active`; paused tasks, completed components awaiting integration, retained
blockers, unknown sessions and unverifiable or older-than-30-minute snapshots
hold automatic work. The existing shared `heavy.admission=DENIED` authority
also holds fresh active tasks without interrupting their active turns. This
reader never clears or copies the owning blocker. Automatic create and rollover
hold because this registry authorizes recovery of existing identities only.
Explicit human-requested controls and active no-message adoption retain their
existing semantics. Holds consume no recovery retry and do not manufacture a
native failure. Every combined planner source must pass the same gate. Nonhuman HTTP resume,
send, recover and fork controls use this gate before native initialization and
immediately before delivery, replacement creation or deferred inbox insertion.

`GET /api/sessions?harness=zcode&quick=1&inventory=1` projects all matching
identities, cwd, activity state/timestamps and available native blocker flags.
It omits titles, messages, raw metadata and blocker prose. Missing native flags
stay unknown; a completed native turn or idle directory entry is not task
completion. The default API response remains unchanged.

Focused admission/inventory verification uses the existing UID safety boundary
with a stricter job scope: RAM192/256MiB soft/hard, swap0, CPU1, Tasks128,
IOWeight10, runtime60s, one Vitest worker, Node heap128MiB, no build or dependency
install. Cache/temp stays under ignored project `.tmp/`, capped16MiB. Measured
focused checks including supervisor bypass coverage used up to243MiB RSS with zero swaps. These test-job limits do
not change service or host ceilings and do not authorize a heavy build.

## Existing ZCode runtime observation

The adapter's observeExistingRuntime(sessionId, cwd) source seam reads a known
session through callIfReady and SDK runtimePolicy=existing-only; it never calls
transport start or initialization. Cold, disconnected, unsupported or malformed
responses remain unavailable. The projection excludes dialogues.

The installed SDK snapshot has activeTurnId, pendingRequestIds, eventSeq and
stateRevision, but does not enumerate all loaded identities or queued/admitted
not-started input. Those counts remain unknown and idleProof is always false.
Permission request counts are not input queue counts. No HTTP endpoint or live
rollout is implied. Safe owner restart requires a reviewed native/SDK contract
for complete loaded-session/generation/queue coverage at a current revision and
an existing supported live controller channel. Directory entries, cached status
and admission receipts cannot prove runtime idle.

The missing SDK/native diagnostic contract must enumerate only already-owned
workspace clients and their actual loaded session IDs; read each live native
controller's current active generation IDs, queued input count, admitted inputs
awaiting generation, pending runtime commands and background work. Include the
SDK process/runtime identity and monotonic revision before and after collection.
If any owned runtime is unavailable, changes during collection, or cannot report
one of those counts, coverage is incomplete and restart admission stays held.
Implement enumeration in the SDK process manager's ownedProcesses/existing
client maps, never its getClient/start path; native loaded state must come from
the native controller rather than session/list storage. The current installed
SDK does not offer this contract, and its stdio-only live controller lacks an
independent supported diagnostic route. Replacing it requires owner review and
a safe handoff/idle window; this source seam does not remove that dependency.

## Shared ZCode native resource budget

The Linux ZCode app-server launch uses the existing transient scope naming and
lifecycle with a mandatory shared SDK/native/MCP descendant budget:
memory high 30 GiB, hard maximum 34 GiB, CPU quota 16 cores, and 4096 tasks.
Swap maximum is temporarily 2 GiB pending the separate reviewed host swapoff
rollout. This supersedes the initial 18/20 GiB candidate.

The 2026-10-08 same-generation measurement recorded 23.87 GiB resident memory,
28.04 GiB lifetime resident peak, 1.047 GiB swap and 2121 tasks. These
measurements describe the whole shared native tree, which is excluded from
the smaller Herder supervisor budget.

Before executing the SDK payload, the scope-local guard reads actual
memory.high, memory.max, memory.swap.max, pids.max and cpu.max. Missing or
mismatched memory/task caps, unlimited or excessive CPU quota, and disabled
Linux isolation refuse launch. The guarded profile rejects caller overrides;
unsupported systemd resource properties cannot fall back to an unbounded
native process. Other adapters retain their existing launch behavior.

Finite scope caps and source validation do not grant workload admission or
prove host reserves. Current-generation live limits are managed separately;
publishing this source does not restart, replace, or resize an existing scope.
A future SDK launch still needs native consumer acceptance of this guard.

## Original task completion after migration

A newer session with the same harness, cwd and title does not complete an
original task. Each original and replacement keeps its own semantic evidence;
the owning task contract must include the requested consumer result and any
remaining checkpoint or blocker. Native turn completion, idle status, queued
or ADMITTED receipts, deletion and explicit forgetting are lifecycle signals,
not evidence of task completion. Paused or forgotten sessions remain
unverified and receive no automatic native action from inventory assessment.

Evidence version 3 refreshes persisted verdicts that could have been derived
from title matching or lifecycle exclusion. This source change does not
activate or widen recovery authority.

The verified 2026-10-08 installed stop-hook and unfinished-session judges both
use `glm-5.3-flash`, OpenAI-compatible protocol, through
`https://api.z.ai/api/coding/paas/v4`. Persisted settings are in the configured
`autopilot-live/session-autostart.json`. A future MiniMax route is a separate
planned configuration change; this repair does not select it.

## Resume API admission receipts

A resume request with a message returns after native admission rather than
waiting for the generation to finish. Codex receipts include the exact native
`turnId`, `admitted: true`, and the caller's `inputId` when supplied; these
fields do not indicate task completion.

Actors may supply a stable `inputId` to `POST /api/sessions/codex/{id}/resume`.
Retrying that same operation uses the existing durable delivery receipt and
does not repeat native admission. A distinct continuation after a new failure
uses a distinct operation ID, even when its message text is identical.
No implicit 24-hour message-hash dedupe is introduced for legacy requests.
A timeout, disconnect, or unverifiable turn ID returns
`admissionUnknown/nonRetryable`: reconcile native state and hold rather than
blindly submitting the message again.

## Human questions, answers and one resume per answer

A `human` judge decision and a `choice` decision are both real questions, not
dead ends. The judge binds one durable Human Request to the exact native
session and puts its `human_request_id` on the NoticePlace card, so the
existing answer path resumes that one session.

```text
POST /api/autopilot/sessions/{harness}/{sessionId}   {"enabled":true,"cwd":"/abs/cwd"}
```

The per-session switch above is enough to activate one exact session while the
global policy still selects other harnesses. It is written into the shared
state directory, so the daemon, the Stop hook and the runner all read it.

An answer is admitted exactly once:

- `HumanRequestRegistry.admitResume` returns the admission receipt. Only
  `admitted: true` may invoke the resume transport, and it must use the
  returned `idempotencyKey`. Every replay returns the same attempt, key and
  canonical admitted answer.
- A bounded persisted lease makes a crash recoverable: after it expires a
  later answer takes the same attempt and key over, and the durable provider
  receipt is read before anything is launched again.
- The stable key travels to the deduplicating native ingress as `inputId`, so
  a takeover cannot deliver the answer to the session twice.
- The answer carries `human_requested_at`, the instant it was admitted. An
  explicit human stop newer than that instant keeps the session held; the
  answer is never replaced by a bare "human requested" flag.

A pending Human Request or a pending choice is a durable fence. The launcher,
the Stop hook and the runner all defer that exact session until the answer is
applied. A deferral never deletes accepted or recovery state and never pauses
another session.

## One Autopilot state directory

The daemon, the Stop hook and the runner resolve one directory:

```text
AGENT_HERDER_AUTOPILOT_STATE_DIR=/home/user/.local/state/agent-herder/autopilot-live
AGENT_HERDER_HUMAN_REQUEST_STORE=/home/user/.local/state/agent-herder/autopilot-live/human-requests.json
AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR=/home/user/.local/state/agent-herder/autopilot
```

Without an explicit pin, the default is `~/.local/state/agent-herder/autopilot-live`,
and pre-seam state is adopted once, exclusively and atomically. The receipt store
and the armed-session set are adopted as well: they hold the terminal decision
deduplication, the pending notice outbox and the hook admission list. When both
directories are populated, only `choices.json` and `human-requests.json` are
merged, by verified `requestId`: the canonical record wins and a legacy-only
record is appended, with the previous canonical file kept as
`<file>.pre-merge`. An unrecognized shape is never rewritten. Set
`AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR` to merge two populated directories
explicitly; with only the canonical directory pinned, nothing is adopted.

## One question path: Herder binds, Notice shows, Herder resumes

There is exactly one card per question, and it always lives in the dedicated
Notice human-request intake. Agent Herder sends **no** generic `/v1/events`
question card. Two callers may create the binding:

- a plugin or agent through `human_request_create`;
- Herder itself, when the judge decides a human decision is required. It builds
  the same binding and posts exactly one envelope to
  `NOTIFY_CENTER_HUMAN_REQUEST_URL` (default: `NOTIFY_CENTER_EVENT_URL` with
  `/v1/events` replaced by `/v1/human-requests`), using the configured producer
  token, `NOTIFY_CENTER_PROJECT` and `NOTIFY_CENTER_ALLOWED_ACTORS`:

```json
{
  "schema": "ask_human.request.v1",
  "request_id": "…",
  "project": "…",
  "recipient": "…",
  "mode": "question",
  "message": "…",
  "kind": "user",
  "native_target": { "harness": "opencode", "session_id": "ses_…", "cwd": "/workspace/incident" },
  "allowed_actors": ["…"]
}
```

The request id is Herder's canonical key and is sent as the `Idempotency-Key`
header, so a retry updates the same question instead of creating a second card.
If the intake is not configured, no request is created at all: a notification
alone must never leave a request pending behind a question nobody can answer.


There is exactly one question card. Agent Herder never sends a generic event
card for a human question: it creates the durable request and returns the
binding that Notice needs for its own Ask card.

```text
1. MCP human_request_create {kind, harness, sessionId, cwd?, message, choices?}
   or POST /internal/human-requests {kind, harness, session_id, cwd, message, choices?}
2. Notice: POST /v1/human-requests   (once, with the binding below)
3. Answer -> Herder human_request_resolve, or
            POST /internal/human-requests/ask-user-completion
```

The binding returned by step 1:

```json
{
  "request_id": "…",
  "native_target": { "harness": "opencode", "session_id": "ses_…", "cwd": "/workspace/incident" },
  "dedup_key": "human-request:…",
  "kind": "user",
  "question": { "message": "…", "choices": [{ "choice_id": "continue", "label": "…" }] },
  "answer": { "mcp_tool": "human_request_resolve", "completion_path": "/internal/human-requests/ask-user-completion" }
}
```

The internal endpoint verifies the exact native session (id plus canonical
workspace) before binding and answers `404` for a missing or foreign session.
The source session, the message and the choices therefore land in the same
Notice question row, and the answer of that row resumes the exact bound session
once. Calling both create paths for one question is the only way to get two
cards.

`message` is optional. Without it the request is metadata-only and creates no
Notice question, so existing metadata-only and `secret` callers keep working.

What the resumed turn receives is derived from the durable record, never from
the caller, so a conflicting repeat cannot substitute its own instruction:

```text
Human Request <request_id> is answered; continue the same task on this exact session.
Read the canonical answer with noticeplace_question_result(request_id="<request_id>") and apply it.
Answer reference: <canonical result_ref>. Do not invent an answer and do not start a different task.
```

A `secret` request stays opaque: its continuation names only the secret
reference and never the answer itself. The answer source is a durable
discriminator, not a guess: only a request created through the question-binding
seam has a Notice question row. A metadata-only request (the generic judge
decision, a legacy caller) resumes with an instruction to use the human message
in the session and never points at `noticeplace_question_result`.

An expired or withdrawn question is cancelled through the supported path:

```text
POST /internal/human-requests/cancel {request_id, reason?}
```

Cancellation is terminal, resumes nothing and lifts the pending-question gate,
so an ordinary bound question can never hold its session forever.

A NoticePlace consumer that launches work for a project reads
`GET /api/automation/launch-policy` and uses `projectRoutes[project]` when the
project is configured there:

```json
{ "kind": "launch", "harness": "opencode", "model": "minimax-coding-plan/MiniMax-M3.1-Flash-Preview", "mode": "create" }
```

Documented presets (`PROJECT_ROUTE_PRESETS`, applied only when an operator saves
them) use the verified real roots and the identifiers real cards carry:

```json
"/home/roomhacker/PycharmProjects/TelegramAuto": {
  "harnesses": ["opencode", "zcode"],
  "aliases": ["tg-commentator", "autotelegramviews", "canonicalTelegramAuto"]
},
"/home/roomhacker/PycharmProjects/AutoFindClient": { "harnesses": ["codex", "zcode", "opencode"] }
```

Aliases and canonical paths match case-insensitively. A project without a
declared alias is never bound to a route, and no other service is mapped without
a confirmed match.

`kind: "unconfigured"` means the project keeps the default incident runtime
(OpenCode with `minimax-coding-plan/MiniMax-M3.1-Flash-Preview`); `kind:
"exhausted"` with reason `accepted` or `admission_unknown` means an executor
already exists or may exist and no fallback is allowed.

## One project launch consumer

`POST /api/automation/project-launch` is the only place a project launch runs.
A Notice consumer must call it instead of choosing a harness on its own.

```json
POST /api/automation/project-launch
{ "project": "tg-commentator", "cwd": "/abs/workspace", "message": "…", "operation_id": "…" }
```

```json
200 {
  "operation_id": "…",
  "project": "/home/roomhacker/PycharmProjects/TelegramAuto",
  "outcome": "accepted",
  "selected_harness": "zcode",
  "model": "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
  "mode": "create",
  "session_id": "zcode-1",
  "routing_reason": "OpenCode не запустилась до подтверждения приёма: quota exhausted. Выбираем следующую среду маршрута. Среда ZCode приняла запуск.",
  "attempts": [{ "harness": "opencode", "outcome": "pre_admission_rejected", "input_id": "herder-launch:opencode:…" }]
}
```

- `attempts` is the durable ordered log at
  `project-launch-attempts.json` in the Autopilot state directory. It is the
  authority: a repeated `operation_id` is answered from that log and touches no
  harness again. It is keyed by the configured route key, so an alias, a path
  spelling or a case variant of the same project share one authority.
- Each attempt is **reserved durably before the native call** and completed
  after it, keeping its model, mode, `created` (new session or resumed) and
  delivery. The reservation is exclusive under one lock and returns
  `{claimed, record}`: only the claiming caller may call the native writer.
  OpenCode has no native input-id deduplication, so this durable claim is the
  only thing preventing a second POST; Codex and ZCode additionally deduplicate
  natively. A concurrent or restarted caller gets `outcome: "in_flight"` with a
  visible reason and no native call.
- A configured project is authoritative: its route decides the harness, the
  model and the workspace. `harness` and `model` from a caller profile are
  ignored for that project and reported as overridden in `routing_reason`; the
  profile applies only to a project without a route.
- Only `pre_admission_rejected` (a definite pre-admission failure such as a
  quota or an unavailable runtime) advances to the next harness of the route.
- `accepted`, `admission_unknown` and `human_hold` stop the chain. A pending
  human answer or a semantic repair failure is never a launch outcome, so no
  second executor can appear.
- `mode: "handoff_required"` means the project already has a live session on
  another harness. The caller must use the existing context-preserving handoff;
  Herder does not clone a running session.
- `409` with `outcome: "no_harness"` means the route cannot launch: no allowed
  runtime, no route entry left, or an explicit harness outside the route.
