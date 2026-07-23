# Agent Herder

**MCP server for monitoring and controlling coding agents.**

[Русский](README.ru.md) · [简体中文](README.zh.md)

![Agent Herder developer workspace](docs/assets/readme-hero.png)

> Checked in this workspace with Node.js 22.22.3, npm 10.9.8, and the TypeScript build.

One unified MCP interface to monitor and manage sessions across four coding agent harnesses:

- [OpenCode](https://opencode.ai) — via HTTP server API (`opencode serve`)
- [Claude Code](https://code.claude.com) — via CLI and session files
- [Codex CLI](https://github.com/openai/codex) — via the native persistent `codex app-server` transport, with CLI fallback
- Qoder CLI — via its native ACP transport (`qodercli --acp`)

## Quick start

From a local checkout, install the Node dependencies and build the MCP server with one command:

```bash
npm ci && npm run build
```

The built stdio entrypoint is `dist/index.js`. For Claude Code, register this checkout with:

```bash
claude mcp add agent-herder -- node "$PWD/dist/index.js"
```

For Cursor, OpenCode, or another MCP client, use the same absolute `dist/index.js` path in the client configuration shown below. Start `opencode serve` first if the OpenCode adapter is enabled.

## What it does

### Monitoring
- **List all agents** — which are running, idle, stopped, or need input
- **Inspect agent details** — model, cost, duration, message count, working directory
- **See pending permissions** — agents waiting for tool approval

### Management
- **Send a message** — sync (wait for response), queue (fire-and-forget), or steer (redirect)
- **Resume a stopped agent** — with an optional new message
- **Pause a turn** — interrupt the active turn while keeping the native session resumable
- **Recover or fork** — reconnect after an error, or create a child session with preserved lineage
- **Stop an agent** — legacy terminate/abort action where the harness supports it
- **Respond to permission requests** — allow or deny tool calls (OpenCode)
- **Set permissions** — configure allowed tools and permission modes

## Prerequisites

At least one of:
- `opencode` installed and `opencode serve` running
- `claude` (Claude Code CLI) installed
- `codex` (OpenAI Codex CLI) installed and `OPENAI_API_KEY` set

## Install

```bash
npm ci
npm run build
```

## Configure

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENABLE_OPENCODE` | `true` | Enable OpenCode adapter |
| `ENABLE_CLAUDE` | `true` | Enable Claude Code adapter |
| `ENABLE_CODEX` | `true` | Enable Codex adapter |
| `ENABLE_QODER` | `false` | Enable Qoder's native ACP adapter |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_PASSWORD` | | Password for OpenCode server auth |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Username for OpenCode server auth |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_TRANSPORT` | `app-server` | `app-server` for native controls, or `cli` for the legacy filesystem/CLI adapter |
| `CODEX_CWD` | current directory | Working directory for the Codex app-server |
| `CODEX_DATA_DIR` | `~/.codex` | Codex data directory |
| `CODEX_MODELS` | `o4-mini,o3,gpt-4.1,gpt-4o` | Models shown by `list_models` |
| `QODER_BIN` | `qodercli` | Path to Qoder CLI |
| `QODER_ARGS` | `[]` | Extra Qoder CLI arguments as a JSON string array |
| `QODER_CWD` | current directory | Workspace passed to Qoder ACP |
| `QODER_MODEL` | | Initial Qoder model |
| `QODER_MODELS` | `Ultimate,Lite` | Models shown by `list_models` |

### Add to your MCP client

**Claude Code:**
```bash
claude mcp add agent-herder -- node /path/to/agent-herder/dist/index.js
```

**Cursor / other MCP clients** — add to your MCP config:

```json
{
  "mcpServers": {
    "agent-herder": {
      "command": "node",
      "args": ["/path/to/agent-herder/dist/index.js"],
      "env": {
        "ENABLE_OPENCODE": "true",
        "ENABLE_CLAUDE": "true",
        "ENABLE_CODEX": "false",
        "ENABLE_QODER": "true",
        "QODER_CWD": "/home/roomhacker/PycharmProjects/video_watching"
      }
    }
  }
}
```

**OpenCode** — add to `opencode.json`:
```json
{
  "mcp": {
    "agent-herder": {
      "command": "node",
      "args": ["/path/to/agent-herder/dist/index.js"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|---|---|
| `list_agents` | List all sessions, filter by harness or status |
| `agent_info` | Get detailed info about a specific session |
| `find_parent` | Find a session's native parent |
| `list_children` | List a session's native children |
| `get_transcript` | Read newest messages or search transcript messages by session ID |
| `send_message` | Send a message (sync/queue/steer) |
| `resume_agent` | Resume a stopped session |
| `stop_agent` | Abort a running session |
| `respond_permission` | Allow/deny a pending permission request |
| `set_permissions` | Set allowed tools and permission mode |

## Architecture

```
┌─────────────────┐
│   MCP Client    │  (Claude Code, Cursor, OpenCode, etc.)
└────────┬────────┘
         │ stdio (MCP protocol)
┌────────▼────────┐
│  Agent Herder   │  (this server)
│  ┌───────────┐  │
│  │ MCP Tools │  │  7 unified tools
│  └─────┬─────┘  │
│        │        │
│  ┌─────▼──────┐ │
│  │  Adapters  │ │
│  ├────────────┤ │
│  │ OpenCode   │──┼── HTTP → localhost:4096
│  │ Claude     │──┼── CLI + ~/.claude/sessions
│  │ Codex      │──┼── CLI + ~/.codex/sessions
│  └────────────┘ │
└─────────────────┘
```

## Harness-specific notes

### OpenCode
- Best supported — full HTTP API with session management, permissions, SSE events
- Requires `opencode serve` running (auto-starts with TUI on port 4096)
- Supports remote permission response and real-time status

### Claude Code
- Sessions read from `~/.claude/projects/*/sessions/*.jsonl`
- The official Claude Agent SDK is used first; CLI `claude -p --resume <id>` is the fallback
- For ACP-owned sessions, prompts stay on the persistent ACP connection instead of spawning another resume process
- Permissions must be set at launch via `--allowedTools` flag
- Running process detection via `pgrep`

### Codex CLI
- Sessions read from `~/.codex/sessions/`
- Sending messages spawns new `codex` invocations
- Uses `--full-auto` mode for unattended operation
- Permissions set at launch via `--full-auto`, `--approve-tools` flags

## Development

```bash
npm run dev        # TypeScript watch mode
npm run build      # Compile
npm run inspect    # Open MCP Inspector for interactive testing
```

## Persistent ACP and Web UI

`agent-herder` can own an ACP-compatible Claude process instead of starting a
new `claude --resume` process for every message. Configure the launcher as a
JSON argument array:

```bash
export ACP_AGENT_COMMAND=claude-agent-acp
export ACP_AGENT_ARGS='["--stdio"]'
export ACP_AGENT_PROFILE=claude-acp
export AGENT_HERDER_WEB_PORT=8787
npm start
```

Qoder has a native ACP mode. Enable it alongside the other adapters:

```bash
export ENABLE_QODER=true
export QODER_BIN=/home/roomhacker/.npm-global/bin/qodercli
export QODER_CWD=/home/roomhacker/PycharmProjects/video_watching
npm start
```

This exposes existing Qoder sessions through `list_agents`, `send_message`,
`resume_agent`, `stop_agent`, `list_models`, and `change_model`. Qoder model
changes use ACP `session/set_config_option` when available.

Open `http://127.0.0.1:8787/` to list sessions, pause/resume or recover them
through their owning adapter, fork child sessions, send a message, or convert
a Claude/Codex/OpenCode transcript. The UI shows only controls advertised by
the native transport.
Set `AGENT_HERDER_WEB_HOST` explicitly if the UI must bind beyond loopback.

The ACP adapter keeps one child process and one connection per profile. It can
list and load any sessions advertised by that ACP agent, but it cannot attach to
an unrelated stdio process already owned by Aion or another ACP client. Such a
session can still be continued by converting its native transcript into the
target harness with the built-in session-convert library; conversion creates a
new native transcript and does not transfer an in-flight turn.

## License

MIT
