# Agent Herder Codex autopilot MVP

This is an additive Codex `Stop` hook. Codex still owns the session and its
native continuation mechanism; Agent Herder only judges the stop event and
returns a continuation reason when the judge says `continue`.

The hook is intentionally opt-in per session. A global installation is safe:
without an armed session it returns `{}` and does not call a judge or Notify.

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

The hook uses a short-lived filesystem lock and stable receipt keys, so a
duplicate Codex stop event does not cause a second judge continuation or a
second notification.
