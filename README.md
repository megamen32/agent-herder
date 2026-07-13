# Agent Herder

**MCP server for monitoring and controlling coding agents.**

One unified MCP interface to monitor and manage sessions across three coding agent harnesses:

- [OpenCode](https://opencode.ai) — via HTTP server API (`opencode serve`)
- [Claude Code](https://code.claude.com) — via CLI and session files
- [Codex CLI](https://github.com/openai/codex) — via CLI

## What it does

### Monitoring
- **List all agents** — which are running, idle, stopped, or need input
- **Inspect agent details** — model, cost, duration, message count, working directory
- **See pending permissions** — agents waiting for tool approval

### Management
- **Send a message** — sync (wait for response), queue (fire-and-forget), or steer (redirect)
- **Resume a stopped agent** — with an optional new message
- **Stop an agent** — abort a running session
- **Respond to permission requests** — allow or deny tool calls (OpenCode)
- **Set permissions** — configure allowed tools and permission modes

## Prerequisites

At least one of:
- `opencode` installed and `opencode serve` running
- `claude` (Claude Code CLI) installed
- `codex` (OpenAI Codex CLI) installed and `OPENAI_API_KEY` set

## Install

```bash
npm install
npm run build
```

## Configure

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENABLE_OPENCODE` | `true` | Enable OpenCode adapter |
| `ENABLE_CLAUDE` | `true` | Enable Claude Code adapter |
| `ENABLE_CODEX` | `true` | Enable Codex adapter |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_PASSWORD` | | Password for OpenCode server auth |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Username for OpenCode server auth |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_DATA_DIR` | `~/.codex` | Codex data directory |

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
        "ENABLE_CODEX": "false"
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
- Sending messages uses `claude -p --resume <id>`
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

## License

MIT