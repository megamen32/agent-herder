# Agent Herder Codex autopilot MVP

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
- `done` with `summary`: terminal, optionally emits a completion notice;
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

Human and completion notices use the existing `notify.event.v1` producer seam:

```text
NOTIFY_CENTER_EVENT_URL=http://.../v1/events
NOTIFY_CENTER_TOKEN=project-scoped-token
AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT=me
AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT=agent-herder
AGENT_HERDER_AUTOPILOT_NOTIFY_KIND=notification
```

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
