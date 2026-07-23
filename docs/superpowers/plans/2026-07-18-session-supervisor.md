# Agent Herder Session Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-herder` a persistent session supervisor that can launch and control ACP agents, reuse Claude sessions through the official SDK or ACP, import/convert sessions between Claude, Codex, and OpenCode, and expose those operations through a mobile-friendly web UI.

**Architecture:** Keep the existing MCP tools and harness adapters as the domain layer. Add a persistent ACP client adapter that owns one child ACP process per configured agent command and keeps its `ClientSideConnection` alive for `list/load/resume/prompt`. Turn `session-convert` into a reusable library consumed by `agent-herder`; expose both through a small native Node HTTP server with a static PWA, enabled by `AGENT_HERDER_WEB_PORT` so stdio MCP remains compatible.

**Tech Stack:** TypeScript ESM, Node 20+ `node:http`/Web Streams, `@agentclientprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, Vitest, existing session-convert readers/writers.

## Global Constraints

- The existing stdio MCP entrypoint must continue working when no web port is configured.
- Never send `claude --resume` to a session already owned by a persistent ACP connection.
- ACP agents that do not advertise `listSessions`, `loadSession`, or `session.resume` must return an explicit capability error.
- Conversion must preserve the existing session-convert warning semantics and must never overwrite an existing target transcript without an explicit new target ID.
- Tests must use fake ACP JSON-RPC streams and temporary directories; no real provider credentials are required.
- Web bind defaults to loopback and must require an explicit environment setting to expose another host.

---

### Task 1: Define the session supervisor interfaces and failing tests

**Files:**
- Create: `mcp/agent-herder/tests/session-supervisor.test.ts`
- Create: `mcp/agent-herder/tests/http-api.test.ts`
- Modify: `mcp/agent-herder/package.json`
- Modify: `mcp/agent-herder/tsconfig.json`

**Interfaces:**
- `SessionSupervisor.listSessions(): Promise<AgentSession[]>`
- `SessionSupervisor.sendMessage(id: string, options: SendMessageOptions): Promise<Result>`
- `SessionSupervisor.resumeSession(id: string, message?: string): Promise<Result>`
- `SessionSupervisor.convertSession(input: ConvertSessionInput): Promise<ConversionResult>`
- `createWebServer(deps: WebDependencies): http.Server`

- [ ] **Step 1: Add Vitest and a test script**

Add `vitest` to dev dependencies and `"test": "vitest run"` to the scripts object. Keep `build` unchanged.

- [ ] **Step 2: Write the ACP lifecycle regression test**

Start a fake ACP child command that answers `initialize`, `session/list`, `session/load`, and `session/prompt`. Assert that two messages sent to the same session use one child process and that `resumeSession` calls ACP `session/load` or `session/resume`, never a second CLI `--resume` process.

- [ ] **Step 3: Write the conversion regression test**

Create a Claude JSONL fixture in a temporary directory, call the supervisor conversion API for `claude -> codex`, and assert the output session ID/path exists and the result includes the source/target harnesses and message count.

- [ ] **Step 4: Write the HTTP regression test**

Create an in-memory fake supervisor, start `createWebServer`, request `GET /api/sessions`, `POST /api/sessions/:harness/:id/resume`, and `POST /api/conversions`, and assert JSON status codes and payloads. Also assert `GET /` returns an HTML document containing the session list shell and action controls.

- [ ] **Step 5: Run the focused tests and verify they fail for missing behavior**

Run `npm test -- --run tests/session-supervisor.test.ts tests/http-api.test.ts` from `mcp/agent-herder`. Expected result: test collection or assertions fail because the new supervisor/API modules do not yet exist.

### Task 2: Implement a reusable session-convert library

**Files:**
- Create: `session-convert/src/library.ts`
- Modify: `session-convert/package.json`
- Modify: `session-convert/tsconfig.json`
- Create: `mcp/agent-herder/src/session-convert.ts`

**Interfaces:**
- `session-convert` package exports `SessionConverter`, `Conversation`, `ConversionResult`, `HarnessType`, and `SessionSummary` from `dist/library.js`.
- `AgentHerderSessionConverter.convert(input: ConvertSessionInput): Promise<ConversionResult>` delegates to the existing converter.

- [ ] **Step 1: Export the existing converter and types from `session-convert/src/library.ts`**

Export only the existing core converter and type contracts; do not make the MCP CLI entrypoint a library side effect.

- [ ] **Step 2: Add package exports and declaration metadata**

Set `types` and `exports` so TypeScript consumers resolve `.` to `dist/library.js` and retain the CLI under `./cli`. Ensure `tsc` emits both `dist/library.js` and declarations.

- [ ] **Step 3: Add the agent-herder wrapper**

Construct `SessionConverter` with environment-derived Claude/Codex/OpenCode roots when the existing core supports those constructors, and expose a typed conversion method that rejects same-harness conversions before writing.

- [ ] **Step 4: Run session-convert tests and build**

Run `npm run build && npm test` from `session-convert`; expected result is the existing conversion suite passing with the new library entrypoint emitted.

### Task 3: Implement persistent ACP supervision

**Files:**
- Create: `mcp/agent-herder/src/adapters/acp.ts`
- Create: `mcp/agent-herder/src/session-supervisor.ts`
- Modify: `mcp/agent-herder/src/types/common.ts`
- Modify: `mcp/agent-herder/src/adapters/index.ts`
- Modify: `mcp/agent-herder/src/index.ts`
- Modify: `mcp/agent-herder/package.json`

**Interfaces:**
- `AcpAgentConfig { name: string; command: string; args?: string[]; cwd?: string; env?: Record<string,string> }`
- `AcpAdapter implements HarnessAdapter` and owns a child process plus `ClientSideConnection`.
- `SessionSupervisor` combines the configured ACP adapter, existing SDK/CLI adapters, and converter without routing one live session through another adapter.

- [ ] **Step 1: Add `@agentclientprotocol/sdk` and local session-convert dependency**

Use a file dependency for the sibling package so builds consume the same converter implementation. Update the lockfile with npm, not by hand.

- [ ] **Step 2: Implement ACP process ownership**

Spawn the configured command with piped stdin/stdout, wrap them with `Readable.toWeb`/`Writable.toWeb`, create `ClientSideConnection`, and call `initialize` once. Keep the process and connection in a map keyed by ACP agent profile.

- [ ] **Step 3: Implement ACP session operations**

Map `listSessions`, `loadSession`, `resumeSession`, `prompt`, `cancel`, and `closeSession` to the existing `HarnessAdapter` contract. Capture `sessionUpdate` text/tool status into an in-memory session cache and return explicit errors when the advertised capability is absent.

- [ ] **Step 4: Implement ACP client callbacks**

Handle permission requests by recording `PermissionRequest` objects and defaulting to a safe deny until the web/MCP permission endpoint answers. Implement filesystem callbacks against the session CWD only when the agent requests them and enforce path containment.

- [ ] **Step 5: Make Claude selection explicit**

Keep the official Claude Agent SDK as the first Claude adapter when available. Add `ACP_AGENT_COMMAND`/`ACP_AGENT_ARGS` configuration for any ACP-compatible Claude launcher; do not claim that a stdio ACP process can attach to an unrelated Aion-owned process. The adapter must prefer a live ACP connection for its own sessions and only use SDK resume for sessions it owns through the SDK.

- [ ] **Step 6: Run the ACP focused tests and build**

Run the lifecycle test and `npm run build`; expected result is one child process per configured ACP agent and no `--resume` invocation for ACP-owned sessions.

### Task 4: Add the web API and mobile-friendly PWA

**Files:**
- Create: `mcp/agent-herder/src/web/server.ts`
- Create: `mcp/agent-herder/src/web/index.html`
- Modify: `mcp/agent-herder/src/index.ts`
- Create: `mcp/agent-herder/tests/http-api.test.ts`

**Interfaces:**
- `GET /api/sessions?harness=&status=&cwd=` returns `{ sessions: AgentSession[] }`.
- `GET /api/sessions/:harness/:id` returns one session plus transcript metadata.
- `POST /api/sessions/:harness/:id/resume` accepts `{ message?: string }`.
- `POST /api/sessions/:harness/:id/message` accepts `{ message: string, mode?: "sync"|"queue"|"steer" }`.
- `POST /api/conversions` accepts `{ sessionId, from, to, projectPath? }`.
- `GET /` serves the static PWA shell.

- [ ] **Step 1: Implement request parsing and JSON error responses**

Use only `node:http`; reject unknown routes with 404, malformed JSON with 400, and internal adapter failures with 502 plus a stable `{ error }` body.

- [ ] **Step 2: Implement session and conversion routes**

Resolve the harness from the route before calling an adapter, return the created target session/path for conversions, and never expose raw API keys or environment values.

- [ ] **Step 3: Build the touch-first UI**

Render filter controls, session cards grouped by status, CWD/model/last message, and buttons for Resume, Send, and Convert. Use `fetch` and small forms; keep the UI dependency-free and usable at iPhone width.

- [ ] **Step 4: Wire the optional web server into the existing MCP process**

When `AGENT_HERDER_WEB_PORT` is set, start the web server on `AGENT_HERDER_WEB_HOST` or `127.0.0.1`; otherwise preserve stdio-only behavior.

- [ ] **Step 5: Run HTTP tests and a local browserless smoke**

Run `npm test -- --run tests/http-api.test.ts` and `curl` the local server. Expected result: HTML loads, session list is JSON, resume/message/convert route calls reach the fake supervisor.

### Task 5: Document operation and verify release behavior

**Files:**
- Modify: `mcp/agent-herder/README.md`
- Modify: `mcp/agent-herder/README.ru.md`
- Modify: `mcp/agent-herder/package.json`

- [ ] **Step 1: Document ACP configuration and limitation**

Document `ACP_AGENT_COMMAND`, `ACP_AGENT_ARGS`, `AGENT_HERDER_WEB_PORT`, `AGENT_HERDER_WEB_HOST`, capability behavior, and the important distinction between sessions launched by agent-herder and sessions owned by another ACP client.

- [ ] **Step 2: Document conversion and resume flows**

Show the web/API examples for listing, continuing a session, and converting Claude/Codex/OpenCode sessions. State that conversion creates a new native target transcript and does not magically transfer a live in-flight turn.

- [ ] **Step 3: Run complete verification**

Run `npm run build && npm test` in `session-convert`, then `npm run build && npm test` in `mcp/agent-herder`, and inspect `git diff --check`. Do not claim live provider success without credentials; report the fake ACP proof separately from live Claude/ACP smoke status.
