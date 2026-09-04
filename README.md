# Agent Herder

**MCP control center for coding agents.**

Monitor, inspect, and coordinate AI coding sessions from one MCP server:
OpenCode, Claude Code, Codex CLI, Qoder, and ZCode.

[Русский](README.ru.md) · [简体中文](README.zh.md)

![Animated Agent Herder session lineage](docs/assets/agent-herder-animated.svg)

## Start in 30 seconds

Run it without cloning a repository:

```bash
npx -y agent-herder
```

Add the same command to any MCP client:

```json
{
  "mcpServers": {
    "agent-herder": {
      "command": "npx",
      "args": ["-y", "agent-herder"]
    }
  }
}
```

Start the harness you want to observe first. For OpenCode, that means:

```bash
opencode serve
```

## What it does

**Monitor, inspect, and coordinate.** Agent Herder gives your MCP client one
control plane for coding-agent sessions that normally live in separate tools.

- See running, idle, stopped, and waiting sessions in one list.
- Find a session's parent and children without guessing IDs.
- Send, resume, stop, steer, or recover sessions where the harness supports it.
- Review permissions, switch models, and inspect worktrees.

Typical request:

> Find the parent of this session, list its children, then export the raw
> transcript of the child that is currently working on the bug.

## Why people use it

Use Agent Herder when you need an **MCP server for OpenCode**, a **Claude Code
session manager**, **Codex CLI transcript search**, **ZCode app-server control**, or one dashboard for several
AI coding agents. It is especially useful for parent/child agent workflows,
parallel coding tasks and session recovery.

## Supported harnesses

| Harness | Connection | Enablement |
|---|---|---|
| OpenCode | HTTP API | Enabled by default; run `opencode serve` |
| Claude Code | SDK/CLI, current and legacy session files, native `/autopilot` + `Stop` plugin | Enabled by default |
| Codex CLI | Native app-server with CLI fallback | Enabled by default |
| Qoder CLI | Native ACP | Set `ENABLE_QODER=true` |
| ZCode | Local stdio ZCode Protocol app-server | Enabled by default; set `ZCODE_CWD` for the workspace |
| Fast Agent | Read-only persisted session home | Set `ENABLE_FAST_AGENT=true` and `FAST_AGENT_HOME` |

## Core MCP tools

| Group | Tools |
|---|---|
| Discover | `list_agents`, `agent_info`, `audit_worktrees` |
| Lineage and transcript | `find_parent`, `list_children`, `export_transcript` |
| Named sessions | `create_session`, `new_or_resume` (OpenCode, Codex, and ZCode) |
| Control | `send_message`, `resume_agent`, `stop_agent` |
| Coordination | `coordination_note_create`, `coordination_note_list`, `coordination_note_get`, `coordination_note_update`, `coordination_note_delete` |
| Permissions and models | `respond_permission`, `set_permissions`, `list_models`, `change_model` |

### Multi-agent coordination notes

When multiple agents share a workspace, publish a short TTL note before touching
files another agent may also edit. For example: "working on `src/parser.ts`; do
not touch for 30 minutes" with `paths=["src/parser.ts"]` and `ttlSeconds=1800`.
Notes are durable, expire automatically, and the creator can update or delete
them early. Active notes from *other* sessions are injected automatically by
Agent Herder's pre-send hook into new `send_message`, resume, and named-session
turns for the same workspace, so agents do not need to poll on every turn. Use
`coordination_note_list/get` only when explicit inspection is useful. If a note
conflicts with your task, use `send_message` to contact its author before
editing the noted paths. Native integrations can consume the same context from
`GET /api/coordination/context?harness=...&sessionId=...&cwd=...`.

`export_transcript` copies the adapter-owned raw transcript for one session and
its in-workspace parent/child lineage, then always returns a short navigation
card. It deliberately does not rank or compress the conversation: use the
normal filesystem tools available to the agent to inspect exactly the slice it
needs.

Claude Code autopilot is packaged under `.claude-plugin/`: `/autopilot` toggles
the exact current session, the native `Stop` hook asks the shared AI judge to
continue or finish, and ambiguous decisions appear as NoticePlace/web buttons.
See [the autopilot guide](docs/autopilot.md).

`new_or_resume` identifies a session by the exact tuple `(harness, canonical
CWD, name)`. It reuses one matching native session or creates it, then delivers
one message. Multiple exact matches fail closed before delivery. `queue` reports
native acceptance; `sync` waits for the adapter response. Event idempotency
belongs to the webhook/control plane that calls Agent Herder.

## Requirements

- Node.js 22+ and npm.
- At least one supported harness installed and available in `PATH`.
- `OPENAI_API_KEY` for Codex when the Codex app-server requires it.

## Configuration

The common switches are:

| Variable | Default | Purpose |
|---|---:|---|
| `ENABLE_OPENCODE` | `true` | Enable the OpenCode adapter |
| `ENABLE_CLAUDE` | `true` | Enable the Claude Code adapter |
| `ENABLE_CODEX` | `true` | Enable the Codex adapter |
| `ENABLE_QODER` | `false` | Enable the Qoder ACP adapter |
| `ENABLE_ZCODE` | `true` | Enable the local ZCode app-server adapter |
| `ENABLE_FAST_AGENT` | `false` | Enable the read-only persisted fast-agent observer |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_PASSWORD` | — | OpenCode server password, if configured |
| `CODEX_TRANSPORT` | `app-server` | Codex native transport or `cli` fallback |
| `QODER_CWD` | current directory | Workspace used by Qoder |
| `ZCODE_CWD` | current directory | Workspace used by ZCode |
| `FAST_AGENT_HOME` | `~/.fast-agent` | Existing fast-agent home to observe; no process is started |
| `FAST_AGENT_CWD` | current directory | Workspace shown for persisted fast-agent sessions |
| `ZCODE_SERVER_NODE` | `~/.zcode/server/node` when present | ZCode server runtime executable |
| `ZCODE_SERVER_ENTRY` | `~/.zcode/server/zcode-server.cjs` when present | ZCode stdio app-server entrypoint |
| `ZCODE_BIN` / `ZCODE_ARGS` | `zcode` / `["app-server"]` | Fallback command when the bundled server entrypoint is unavailable |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_DIR` | `.agent-herder/transcripts` | Relative archive path inside the MCP process CWD |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_MAX_BYTES` | `104857600` | Archive retention size budget (100 MiB) |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_RETENTION_DAYS` | `3` | Remove unmodified archive bundles by modification time |

Example for Qoder:

```bash
export ENABLE_QODER=true
export QODER_CWD=/path/to/project
npx -y agent-herder
```

## Develop locally

```bash
npm ci
npm test
npm run build
npm run inspect
```

The local stdio entrypoint is `dist/index.js`.

<details>
<summary>Advanced: web UI and persistent ACP</summary>

The optional web UI runs on loopback:

```bash
export AGENT_HERDER_WEB_PORT=8787
npm start
```

Open `http://127.0.0.1:8787/`. For a persistent ACP profile, set
`ACP_AGENT_COMMAND`, `ACP_AGENT_ARGS` as a JSON array, and
`ACP_AGENT_PROFILE` before starting the server.
Set `AGENT_HERDER_WEB_PORT` to the loopback upstream expected by your reverse
proxy (the managed `agent.bezrabotnyi.com` deployment uses `18787`).
The matching user-service template is
[`deploy/systemd/agent-herder.service`](deploy/systemd/agent-herder.service).

</details>

## FAQ

**Does Agent Herder replace my coding agent?** No. It connects your MCP client
to the sessions owned by OpenCode, Claude Code, Codex, Qoder, or ZCode.

**Does `export_transcript` load everything into the model?** No. It writes the
raw source to a CWD-scoped archive and returns only the permanent navigation
card. The card shows `sed` for the first lines, `tail` for the last lines, and
`rg` examples for literal text, regex, or a timestamp.

**Can I use only one harness?** Yes. Disable adapters you do not run with the
`ENABLE_*` variables.

## Transcript archive

`export_transcript` atomically copies the adapter-owned raw source under the MCP
process CWD and writes a lineage manifest beside it. The archive never falls
back to display-only text. Its manifest names the source, format, timestamp
coverage, and whether the adapter can prove completeness. Parent or child
sessions outside the MCP CWD are recorded as excluded, not copied.

The navigation card is returned for every export, regardless of transcript
size. It shows how to view the first or last lines and how to use literal,
regular-expression, or timestamp searches. OpenCode and ACP archives are
explicitly partial until their upstream APIs offer a verified complete-history
source.

## License

MIT
