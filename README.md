# Agent Herder

**MCP control center for coding agents.**

Monitor, inspect, search, and coordinate AI coding sessions from one MCP server:
OpenCode, Claude Code, Codex CLI, and Qoder.

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
- Read the latest messages or search one transcript with bounded context.
- Send, resume, stop, steer, or recover sessions where the harness supports it.
- Review permissions, switch models, inspect worktrees, and summarize sessions.

Typical request:

> Find the parent of this session, list its children, then show the last five
> messages from the child that is currently working on the bug.

## Why people use it

Use Agent Herder when you need an **MCP server for OpenCode**, a **Claude Code
session manager**, **Codex CLI transcript search**, or one dashboard for several
AI coding agents. It is especially useful for parent/child agent workflows,
parallel coding tasks, bounded context, and session recovery.

## Supported harnesses

| Harness | Connection | Enablement |
|---|---|---|
| OpenCode | HTTP API | Enabled by default; run `opencode serve` |
| Claude Code | SDK/CLI and session files | Enabled by default |
| Codex CLI | Native app-server with CLI fallback | Enabled by default |
| Qoder CLI | Native ACP | Set `ENABLE_QODER=true` |

## Core MCP tools

| Group | Tools |
|---|---|
| Discover | `list_agents`, `agent_info`, `audit_worktrees` |
| Lineage and context | `find_parent`, `list_children`, `get_transcript`, `search_transcripts` |
| Control | `send_message`, `resume_agent`, `stop_agent` |
| Permissions and models | `respond_permission`, `set_permissions`, `list_models`, `change_model` |
| Summaries | `summarize_session` |

`get_transcript` accepts a session ID, an optional number of latest messages,
and an optional `query` (or lead-oriented `need`). It ranks matching messages,
keeps nearby context, and returns only that bounded slice instead of loading an
entire conversation into context.

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
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_PASSWORD` | — | OpenCode server password, if configured |
| `CODEX_TRANSPORT` | `app-server` | Codex native transport or `cli` fallback |
| `QODER_CWD` | current directory | Workspace used by Qoder |
| `SUMMARIZER_API_KEY` | — | Enables `summarize_session` |

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

</details>

## FAQ

**Does Agent Herder replace my coding agent?** No. It connects your MCP client
to the sessions owned by OpenCode, Claude Code, Codex, or Qoder.

**Does `get_transcript` load everything?** No. Ask for the latest N messages or
search for a prompt; the result is bounded for practical agent context.

**Can I use only one harness?** Yes. Disable adapters you do not run with the
`ENABLE_*` variables.

## License

MIT
