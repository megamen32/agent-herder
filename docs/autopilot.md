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
