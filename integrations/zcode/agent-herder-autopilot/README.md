# Agent Herder autopilot for ZCode

This is a native ZCode plugin. Its `Stop` hook invokes the existing Agent
Herder judge and returns `{ "continue": true }` to ZCode when a next goal is
safe. ZCode therefore continues the same `session_id`; the plugin does not
start `zcode app-server` and does not connect to the Z.AI web relay.

For a human choice, the Stop hook saves the choice and releases the completed
native turn so queued user messages can start. A Telegram/NoticePlace selection
uses Herder's existing native writer to continue the exact same session, with
a durable receipt preventing duplicate delivery. No replacement session is
created. Stop evaluates the existing policy and respects a session switched off
by its user.

## Install

From the Agent Herder checkout run:

```bash
./scripts/install-zcode-autopilot.sh
```

The installer adds only two official ZCode configuration hooks under
`~/.zcode/cli/config.json` and symlinks `/autopilot` under `~/.zcode/commands`.
It uses the standard `~/.local/state/agent-herder/autopilot-live` state path,
the same one as the launcher. Open a new ZCode session afterwards because ZCode
snapshots hooks at session start.
