# Agent Herder

**MCP control center for coding agents — and the missing inter-agent messenger.**

Monitor, inspect, and coordinate AI sessions — and message them — from one **MCP server**: OpenCode, Claude Code, Codex CLI, Qoder, ZCode, Fast Agent, and existing ChatGPT conversations.
Sessions keep living in their own harnesses; Agent Herder gives them a shared
control plane, a shared presence ledger, and a shared inbox.

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

## What it actually does

**One control plane, three layers.**

### 1. Observe — every session, every harness, one list

- Running / idle / stopped / waiting sessions across OpenCode, Claude Code,
  Codex CLI, Qoder, ZCode, and Fast Agent.
- Liveness you can trust: a hook-fed lifecycle registry observes real session
  events (start, turn start, turn end, session end) and beats the stale
  status that task indexes keep for interactive sessions. Recency heuristics
  are the fallback, observed state is the truth.
- Parent/child lineage without guessing IDs, raw transcript export with a
  navigation card, worktree audits, model inventory.

### 2. Message — agents talk to agents (and to you)

- `send_message` delivers into a target session with `queue`, `steer`, or
  `sync` semantics — and **wakes it up**. A parked ZCode session would
  otherwise never execute a queued prompt; Agent Herder resumes the target so
  the message actually runs.
- `fromSessionId` / `fromHarness` wrap every delivery in a reply header:
  *who sent this* and *the exact call to answer*. No id hunting.
- Idle interactive sessions that reject direct prompts are auto-resumed on
  delivery.
- Unfinished turns survive an Agent Herder restart. This is a separate,
  opt-out feature from autopilot: it is enabled by default, records only a
  turn that actually started, and continues the same harness/session/model
  sequentially, including after the provider cache expires. Cache rollover and
  pin transfer default off; a new summarized session requires an explicit
  Autocontinue setting. Missing resume support never creates a replacement
  while rollover is disabled. Disable continuation globally
  with `AGENT_HERDER_UNFINISHED_AUTOSTART=false` or use the Web UI's separate
  Autocontinue master, harness, and per-session switches.
- `respond_permission` answers tool-permission requests remotely — this is
  how headless agents get unstuck while nobody is watching.

Verified live: two headless ZCode sessions created, tasked with a
conversation, exchanging multiple messages each through `send_message`, and
finishing with `CHAT-DONE` — zero human input after the initial kick.

## Screenshots

Live web UI against real workloads — several harnesses, dozens of parallel
sessions, one board.

![Session roster — every harness, one list](docs/assets/screenshots/01-sessions.png)
*Session roster: running agents across workspaces with autopilot toggles,
durations, and a message composer per session.*

![Session detail — chat, autopilot, controls](docs/assets/screenshots/02-session-chat.png)
*Session detail: conversation view, autopilot switch, stop/visualize
controls, and a message composer.*

![Statistics — real activity patterns](docs/assets/screenshots/03-statistics.png)
*Statistics: 805 sessions sampled, 11.1k write events, harness and model
mix, token coverage, and session-volume histograms measured from real
coding sessions.*

### 3. Coordinate — repo boards, only-new-information injections

Every workspace gets a coordination **board** keyed by the git repo that owns
the touched files. A session editing across three repos appears on three
boards.

- **Auto-reserve on file activity**: harness hooks report each edited file;
  the board records who touches what. Conflicts with another agent's paths
  come back as a soft-lock warning before the edit lands.
- **Peers roster**: on every file edit the hook may inject "other agents
  recently active in this repo, and how to contact them".
- **Task declaration**: a session that has not declared what it is working on
  receives a one-line directive to publish a `working` note — so a pair of
  agents never trip over each other silently.
- **Session-end purge**: when a session wraps up, its Stop hook drops its
  leases and presence from every board immediately. Dead agents disappear
  from rosters instead of haunting them until a TTL expires.
- **Injection dedup**: every injection channel (turn-start notes,
  file-activity rosters, delivered messages) shares one per-session,
  per-board signature slot. A session only ever receives a block when the
  roster materially changed — TTL refreshes and id churn are invisible — or
  after a staleness window (`AGENT_HERDER_INJECTION_RESHOW_MS`, default 45
  minutes) that covers context compaction.

Manual notes work too: `coordination_note_create` with a TTL, editable and
deletable by the author, auto-pruned on expiry.

## Supported harnesses

| Harness | Connection | Enablement |
|---|---|---|
| OpenCode | HTTP API | Enabled by default; run `opencode serve` |
| Claude Code | SDK/CLI, current and legacy session files, native `/autopilot` + `Stop` plugin | Enabled by default |
| Codex CLI | Native app-server with CLI fallback, plugin `Stop` judge | Enabled by default |
| Qoder CLI | Native ACP | Set `ENABLE_QODER=true` |
| ZCode | Local stdio ZCode Protocol app-server, native `Stop`/`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`SessionEnd` hooks | Enabled by default |
| ChatGPT | BrowserClaw-owned ChatGPT page | Existing conversations are resumable sessions; no automatic chat creation |
| Fast Agent | Persisted session home + CLI resume/send | Set `ENABLE_FAST_AGENT=true` and `FAST_AGENT_HOME` |

## Core MCP tools

| Group | Tools |
|---|---|
| Discover | `list_agents`, `agent_info`, `audit_worktrees` |
| Lineage and transcript | `find_parent`, `list_children`, `export_transcript` |
| Named sessions | `create_session`, `new_or_resume` (OpenCode, Codex, and ZCode); existing ChatGPT chats are addressed by `sessionId` or title + `/home/roomhacker/.chatgpt` with `create=never` |
| Control | `deliver` (activation policy + queue/sync), `send_message`, `resume_agent`, `stop_agent`; ChatGPT supports delivery/resume but not stop/create yet |
| Coordination | `coordination_note_create`, `coordination_note_list`, `coordination_note_get`, `coordination_note_update`, `coordination_note_delete` |
| Permissions and models | `respond_permission`, `set_permissions`, `list_models`, `change_model` |

### ChatGPT resume semantics

Agent Herder treats an existing ChatGPT `/c/...` conversation on its one owned BrowserClaw page as a resumable session. ChatGPT does not have a filesystem working directory, so Herder uses the stable local identity directory `/home/roomhacker/.chatgpt` for named-session matching. Prefer the stable Herder `sessionId` when titles are duplicated.

`resume_agent` with a message and `deliver(..., create=never)` reopen the existing conversation on the same owned page, write to its composer, and continue that conversation. The adapter does not create a new ChatGPT conversation when a named target is missing. `working=true` maps to Herder `running`; otherwise the conversation is `idle`.

For ChatGPT data access there are two complementary transports: the token driver in `chatgpt-cdp-mcp` is the fast backend/session-token read path, while BrowserClaw/CDP is the mutation/UI path used for resume and delivery. Both can read; the distinction is transport capability, not a global ChatGPT read-only limitation.

Operationally, the current Mac app is named **BrowserOS neo** (bundle id `com.browseros.BrowserClaw`), not the older `BrowserClaw` display name. Agent Herder reaches it through the localhost-only SSH tunnel `127.0.0.1:39479` → Mac `127.0.0.1:9010`; internal Mac BrowserClaw ports may change. If the Mac is sitting at `loginwindow`, macOS cannot start the GUI browser from SSH. Herder retries ChatGPT adapter activation periodically, so once the user GUI session is available and BrowserOS neo starts, ChatGPT sessions appear without restarting Herder.

## Architecture notes

- **Singleton daemon.** One Agent Herder process per host holds the state and
  serves the web UI plus MCP over HTTP (`AGENT_HERDER_WEB_PORT`, default
  loopback `18787`). Harness processes either run the stdio entrypoint or the
  bundled `http-mcp-stdio.js` shim / direct HTTP entry that forwards to the
  singleton.
- **ZCode adapter.** Talks the native ZCode Protocol app-server (length-
  framed channel protocol, `zcode-agent` / `zcode-task` namespaces), and
  attributes every protocol call to the right workspace (`workspaceKey`).
- **ZCode plugin** (`integrations/zcode/agent-herder-autopilot`): native hooks
  for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Stop`, and `SessionEnd` — feeding lifecycle and file-activity events —
  plus the autopilot `Stop` judge (continue the session, ask the human via a
  durable choice registry, or wrap up and purge).
- **Codex plugin** (`.codex-plugin`): native `Stop` judge with the same
  continue-or-notify contract.
- **Claude Code autopilot** is packaged under `.claude-plugin/`: `/autopilot`
  toggles the exact current session, the native `Stop` hook asks the shared
  AI judge to continue or finish, and ambiguous decisions appear as
  NoticePlace/web buttons. See [the autopilot guide](docs/autopilot.md).

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
| `CODEX_TRANSPORT` | `app-server` | Codex native transport or `cli` fallback |
| `ZCODE_SERVER_NODE` / `ZCODE_SERVER_ENTRY` | `~/.zcode/server/…` when present | ZCode stdio app-server runtime |
| `ZCODE_BIN` / `ZCODE_ARGS` | `zcode` / `["app-server"]` | Fallback command when the bundled server entrypoint is unavailable |
| `ZCODE_TASKS_INDEX_DB` | `~/.zcode/v2/tasks-index.sqlite` | Cross-workspace discovery source for ZCode sessions |
| `AGENT_HERDER_COORDINATION_NOTES` | `~/.local/state/agent-herder/coordination-notes.json` | Shared coordination board store |
| `AGENT_HERDER_INJECTION_RESHOW_MS` | `2700000` | Re-inject unchanged rosters after this staleness window |
| `AGENT_HERDER_AUTO_TTL_SECONDS` | `60` | Auto-reserved file-activity lease TTL |
| `AGENT_HERDER_UNFINISHED_RECONCILE_INTERVAL_MS` | `60000` | Cheap local observer cadence; MiniMax is called only when a session reaches its TTL-aware broken-session deadline |
| `AGENT_HERDER_UNFINISHED_UNKNOWN_TTL_CHECK_MS` | `240000` | Candidate delay when the provider/model cache TTL is unknown |
| `AGENT_HERDER_UNFINISHED_MAX_TTL_CHECK_MS` | `600000` | Maximum candidate delay for documented long-TTL models such as current Codex GPT-5.6+ |
| `AGENT_HERDER_UNFINISHED_CACHE_MARGIN_MS` | `60000` | Safety margin subtracted from short cache TTLs before classification |
| `AGENT_HERDER_UNFINISHED_RESUMES_PER_CYCLE` | `8` | Bounded parallel continuation admissions per cycle; all resumed workloads still share the server-100 user-slice budget |
| `AGENT_HERDER_UNFINISHED_INVENTORY_HOURS` | `48` | Default lookback; the Web UI persists a runtime override without a restart |
| `AGENT_HERDER_UNFINISHED_EVIDENCE_MESSAGES` | `200` | Maximum recent semantic messages read per session before fair shared-budget packing; the first user goal and latest user/model tail are always retained |
| `AGENT_HERDER_UNFINISHED_BATCH_MAX_TOKENS` | `16384` | Per-request output ceiling for planning and reconciliation; chunk size scales with this budget (32 sessions at the default, 16 at 8192) |
| `AGENT_HERDER_UNFINISHED_BATCH_CONCURRENCY` | `3` | Maximum simultaneous planner calls, capped at three; managed server-100 uses one to preserve shared provider capacity |
| `CODEX_APP_SERVER_SOCKET` | — | Join the existing managed Codex daemon through its Unix WebSocket endpoint so Desktop and Herder share native thread/turn control |
| `AGENT_HERDER_UNFINISHED_JUDGE_ANTHROPIC_BASE_URL` | `https://api.minimax.io/anthropic` | Direct MiniMax Anthropic-compatible classifier endpoint; avoids an extra gateway hop |
| `AGENT_HERDER_UNFINISHED_JUDGE_MODEL` | `MiniMax-M3.1-Flash-Preview` | Default classifier model; the Web UI runtime selection overrides it and reads `MINIMAX_API_KEY` from the protected service environment |
| `AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS` | `600000` | Maximum time for each MiniMax batch; a failed planning pass never falls back to ungrouped launches |
| `AGENT_HERDER_UNFINISHED_JUDGE_ENABLED` | `true` | Disable only the MiniMax unfinished-session classifier |
| `AGENT_HERDER_CODEX_STATE_CACHE_MS` | `60000` | Share one persisted Codex rollout scan across dashboard, observation, and recovery callers |
| `AGENT_HERDER_CACHE_HANDOFF_ENABLED` | `true` | Make cache handoff available; replacement also requires the persisted `rolloverExpiredCache` opt-in, which defaults off |
| `AGENT_HERDER_HANDOFF_MODEL` | `MiniMax-M3.1-Flash-Preview` | Direct MiniMax model used only to summarize stale sessions; Fast Agent is the fallback when `MINIMAX_API_KEY` is absent |
| `AGENT_HERDER_CACHE_TTL_MINUTES` | `{}` | JSON exact overrides such as `{"zcode:provider/model":30}`; unknown provider TTLs are never guessed |
| `AGENT_HERDER_UNFINISHED_DISCOVERY_IDLE_MS` | `60000` | Wait one quiet minute before classification, so a 10-minute sweep catches work interrupted just after the previous sweep |
| `AGENT_HERDER_WEB_PORT` | — | Serve the web UI + MCP over HTTP (singleton daemon mode) |
| `AGENT_HERDER_HTTP_TOKEN` | — | Required when the web host is non-loopback |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_DIR` | `.agent-herder/transcripts` | Relative archive path inside the MCP process CWD |

Every observer pass scans only local Codex and ZCode status metadata inside the configured window. A non-running session becomes actionable after a model-aware delay: 10 minutes for documented 30-minute Codex caches, 4 minutes for conservative 5-minute or unknown caches, with exact overrides available through `AGENT_HERDER_CACHE_TTL_MINUTES`. MiniMax receives one global request only when new, changed, unclassified, unfinished, or legacy-evidence candidates are due. The planner keeps the first user goal plus the freshest semantic tail from up to 200 messages per session, then fairly packs every candidate under the shared 480,000-token input ceiling. Completed unchanged sessions with current evidence stay out of the request; a session-level Autocontinue opt-out blocks launch but never blocks changed-session auditing.

Cache-aware restart uses 30 minutes for documented GPT-5.6+ cache retention,
and a conservative 5-minute boundary for GLM-5.3 and MiniMax M3/M3.1. Z.ai's
public docs do not promise a fixed TTL, while MiniMax explicitly describes its
passive expiry as load-adjusted; the source is retained in each policy result.

## Develop locally

```bash
npm ci
npm test
npm run build
npm run inspect
```

The local stdio entrypoint is `dist/index.js`; the HTTP-forwarding stdio shim
for harness processes is `dist/http-mcp-stdio.js`.

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

The managed server-100 service has a measured steady working set of roughly
170 MiB and a 1 GiB soft / 2 GiB hard RAM control-plane budget. Persistent
adapter app servers, interactive sessions, MCP descendants, and health jobs
run in independent transient systemd scopes, so their memory cannot throttle
the supervisor that observes and resumes them. Failed native turns are resumed
on the same session/model with bounded exponential backoff (three attempts by
default); Herder never forks or switches providers during automatic recovery.
The transient scopes still inherit server-100's outer per-workload and UID
guards. Run no more than one heavy suite per agent and raise budgets only from
fresh measurements while preserving the host reserve documented by
ServersAdministartion.

The server-100 continuity drop-in is
[`session-continuity.conf`](deploy/systemd/agent-herder.service.d/session-continuity.conf).
It joins the existing managed Codex daemon and limits MiniMax planning to one
request with an 8192-token output reservation. On 2026-10-05 the same tiny API
probe returned `overloaded_error` at 16384 and succeeded at 8192 and 4096; the
production planner also returned a validated small plan after the numeric
confidence contract was clarified. Global input packing and coverage validation
remain enforced.

Restart continuation settings are available at `GET/PUT
/api/session-autostart` and `GET/PUT/DELETE
/api/session-autostart/sessions/{harness}/{sessionId}`. `PUT
/api/session-autostart` persists `rolloverExpiredCache`: fresh sessions always
resume in place; expired sessions use a new summarized handoff only when that
switch is explicitly enabled (default off). Pending tool-permission requests
wait for the user's answer; neither the chat title nor a stopped snapshot
authorizes another prompt or permission approval. Autocontinue and Autopilot are separate top-level Web UI
settings and never toggle each other. The independent
durable state lives under `AGENT_HERDER_AUTOPILOT_STATE_DIR` by default.
Recovery is sequential, retries three times with persisted exponential
backoff, never forks or changes the model/provider, and emits a Russian
`health.degraded` Notice Place incident only after the retry budget is
exhausted.

</details>

## FAQ

**Does Agent Herder replace my coding agent?** No. It connects your MCP client
to the sessions owned by OpenCode, Claude Code, Codex, Qoder, ZCode, or Fast
Agent — and adds the messenger layer between them.

**Do agents need the herder MCP to receive messages?** No. Delivery goes
through the harness itself (native prompt injection). The herder MCP on the
agent side is only needed to *send* and to manage notes.

**Why do headless ZCode sessions stop to ask for permission?** Harness
policy, not the herder: each tool call can require an approval. Approve
remotely with `respond_permission` (`remember: true` scopes the grant); the
grant lives in the app-server process, so daemon restarts clear it.

**Does `export_transcript` load everything into the model?** No. It writes the
raw source to a CWD-scoped archive and returns only the permanent navigation
card.

**Can I use only one harness?** Yes. Disable adapters you do not run with the
`ENABLE_*` variables.

## License

MIT

BrowserOS neo 0.49.3.1 currently bundles BrowserClaw server 0.0.26 (migrations through `m0013`). On 2026-09-08 the local BrowserClaw DB had `m0014`–`m0016` applied by a newer server while those migration files were absent from 0.0.26, causing the embedded server to exit and proxy `9010` to return 503. After backing up the DB, the three empty/new schema changes were rolled back (`skills`, `skill_runs`, `skill_run_marks`, and empty `tasks.task_summary`), preserving historical sessions/dispatches; `PRAGMA integrity_check` returned `ok`. DB backup: `/Users/roomhacker/.gptadmin/file-backups/browserclaw-db-20260908-052917`.
