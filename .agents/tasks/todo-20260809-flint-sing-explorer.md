# Explorer package: Agent Herder current UI and capability seams

Role: Explorer
Status: todo
Owner: L
Allowed paths: `/home/roomhacker/agents-projects/agent-herder`
Excluded: edits, deployment, restart, secrets, security/ACL, database, observability.

Goal: map the existing web routes, tabs/views, APIs, adapter/capability/skill code, tests, and runnable business-path entry points. Identify concrete gaps with file/line evidence.
Acceptance check: concise evidence-backed map and a proposed independent baseline canary.
Model/budget: gpt-5.4-mini, low, 20/45/90 active minutes, relative cost low.
Stop: return NEEDS_REDECOMPOSITION if more than one product/repository is implicated.
Report contract: append detailed evidence here; return only a concise TL;DR to L.

## Explorer evidence (2026-08-09)

### Finding

The repository is self-contained (`agent-herder` only); no second product or repository was implicated. The current surface is a single responsive dashboard with tree/list and selected-session detail views, plus adapter-registry and named-session disclosure panels. Backend HTTP routing, MCP tools, adapter registry, and per-session capability metadata are already present. Unit/integration baseline is green: `npm test` completed build plus 24 test files / 94 tests passed (Vitest 4.1.10, duration 1.39s).

### UI/view map (source of truth: `src/web/index.html`)

- Shell and navigation: `src/web/index.html:609-702` (`body[data-view]`, topbar refresh/polling, filters, adapter registry, named-session form, sidebar session tree, detail pane).
- Filters/state: `src/web/index.html:705-752` and `856-870`; query-backed harness/CWD/status filters, sort/group controls, polling request sequencing, and hash-based provider/session selection (`802-826`, `1399-1417`).
- Adapter registry UI: `src/web/index.html:775-800`; GET `/api/adapters`, renders status/readiness/capabilities, POST toggles `/api/adapters/{id}`.
- Session tree: `src/web/index.html:1012-1057`, `1146-1190`; provider summary, lineage indentation, grouping by project/status/none, sorting, collapsed/expanded project persistence.
- Detail view: `src/web/index.html:1206-1341`; status/provider/model/CWD/native ID, actions, lineage parent/children, history source/completeness warning, last three logical messages, pending permission.
- Action controls/gating: `src/web/index.html:1069-1144`; send/resume/continue/pause/stop/recover/fork/model/permission/conversion. Stop/cancel/recover/fork use explicit session capability/status checks; resume is enabled for every non-running state (`1070-1079`).
- Message rendering: `src/web/index.html:1343-1391`; newest logical message first, expandable thinking/tool-call/tool-result parts.

### HTTP routes and dependencies (`src/web/server.ts`)

- Adapter registry: GET `/api/adapters` and POST `/api/adapters/{id}` (`48-63`).
- MCP Streamable HTTP: POST `/mcp`, session transport map and initialize handshake (`64-83`).
- Human-request completion callbacks: POST `/internal/human-requests/sss-completion` and `/ask-user-completion`, opaque UUID/event validation and bound resume (`85-115`).
- Dashboard/session routes: GET `/` (`116-120`), GET `/api/sessions` with harness/status/CWD filters (`122-129`), POST `/api/sessions` (`131-138`), POST `/api/sessions/new-or-resume` with queue/sync (`139-155`), GET session and `/details` with history selector/limit (`157-172`).
- Session actions: POST `/api/sessions/{harness}/{id}/{resume|message|stop|cancel|recover|fork|model|permissions/{permissionId}}` (`174-220`).
- Conversion: POST `/api/conversions` (`222-235`) and Hermes export conversion POST `/api/conversions/hermes-export` (`237-244`). Unknown routes return 404 (`246`).

### Adapter/capability map

- Harness union is OpenCode, Claude, Codex, Qoder, Hermes, ZCode (`src/types/common.ts:1-12`). Adapter interface owns list/get/send/stop/permission/transcript, optional create/lineage/cancel/detach/terminate/recover/fork/model/resume/history methods (`163-245`). Effective capability computation is centralized in `getHarnessCapabilities` (`247-272`), with explicit native `controlCapabilities` taking precedence.
- Registry status/readiness/error and persisted enablement are centralized in `src/adapter-registry.ts:30-130`; disabled adapters are disposed/deleted, enabling invokes factory + init before persistence (`89-120`). HTTP/UI consume this seam rather than adapter-specific UI logic.
- Startup factories and defaults are in `src/index.ts:60-90`: OpenCode, Claude, Codex, Qoder, Hermes, ZCode; Qoder default disabled, others default enabled according to env gates. Initialization/fallback behavior is in `98-255` (Claude SDK->CLI and Codex app-server->CLI fallback; lazy adapter handling).
- MCP capability surface is registered in `src/index.ts:275-518`: human request lifecycle, list/audit/info/lineage/export/send, named create/new-or-resume, stop/permission/resume/model/list-models. Named MCP creation is explicitly limited to OpenCode/Codex/ZCode (`405-433`), while generic observation/control enums include all six harnesses.

### Concrete gaps/risks

1. The web named-session selector exposes only OpenCode and Codex (`src/web/index.html:658-672`), although the MCP contract and server-side named-session path explicitly support ZCode (`src/index.ts:405-433`; `src/mcp-tools/definitions.ts:173-192`). This is a confirmed UI capability-discoverability gap; it is not an adapter implementation gap.
2. Web conversion target options are hard-coded to `claude`, `codex`, `opencode`, `qoder` and omit Hermes/ZCode (`src/web/index.html:1222-1225`), while the HTTP conversion endpoint accepts arbitrary `HarnessType` values at the type boundary (`src/web/server.ts:222-235`). Whether Hermes/ZCode conversion is semantically supported must be checked in `SessionSupervisor.convertSession`/converter implementation before calling this a functional defect; current evidence establishes at least a UI mismatch risk.
3. UI action gating derives `canResume` solely from status (`src/web/index.html:1072-1077`) rather than `session.meta.controlCapabilities.resume`; backend/adapters may reject unsupported resume. This is a UX optimism risk, not proof of a backend bug.
4. `src/web/server.ts:41` maps every non-`SessionNotFoundError` exception to HTTP 502, including malformed JSON/body-too-large errors thrown by `readJson` (`253-265`), so malformed requests may be classified as upstream failure rather than 400. Existing `tests/http-api.test.ts` covers happy routes and selected validation but does not visibly cover malformed JSON.

### What was checked/excluded

Checked route/UI source, adapter registry/types/startup, MCP registration/definitions, README run instructions, and all test names. Excluded source edits, deployment/restart, secrets/security/ACL, database, observability, and live external harness canaries per task scope. No live adapters were started; the baseline canary was the repository test suite only, so it does not prove live harness connectivity.

### Proposed independent baseline canary

Run `npm test` (already green above), then start a disposable built server with all external adapters disabled (`ENABLE_OPENCODE=false ENABLE_CLAUDE=false ENABLE_CODEX=false ENABLE_QODER=false ENABLE_HERMES=false ENABLE_ZCODE=false`) and verify via HTTP: GET `/` returns the dashboard shell; GET `/api/adapters` returns six registered definitions with inactive/disabled status; GET `/api/sessions` returns a valid empty/filtered payload; POST `/api/sessions/new-or-resume` with invalid body returns 400; unknown route returns 404. This proves the dashboard/router/registry seams without claiming a live agent business-path canary. A separate harness-specific canary is required for real message delivery.

## Explorer follow-up evidence (2026-08-09)

### Runnable entry points and shared topology

- `package.json:10-16` defines `npm test` (`build` then Vitest), `npm run build` (`tsc` plus web asset copy), `npm start` (`node dist/index.js`), `npm run dev`, and MCP Inspector via `npm run inspect`.
- `src/index.ts:520-551` is the production bootstrap: singleton, adapter registry load, adapter initialization, MCP server construction, shared dependency wiring, and web listen. `src/http-mcp-stdio.ts:1-38` is the stdio-to-HTTP MCP bridge using `AGENT_HERDER_HTTP_URL` and `mcp-session-id`.
- `README.md:128-150` is the operator-facing local runbook: install, test, build, start. No second product/repository is implicated.

### Routes, tabs/views, and API consumers

- `src/web/server.ts:48-63` serves adapter registry GET/POST; `:64-83` serves Streamable HTTP MCP POST; `:85-115` handles opaque human-request completion callbacks; `:116-172` serves dashboard, filtered session list, named creation/new-or-resume, session lookup, and details/history; `:174-220` serves resume/message/stop/cancel/recover/fork/model/permission actions; `:222-244` serves generic and Hermes-export conversion; `:246` is 404.
- `src/web/index.html:609-702` defines the responsive shell with tree/detail views, refresh/poll controls, filters, adapter registry, and named-session controls. Filter/query/poll state is at `:705-870`; tree grouping/sorting/expansion is `:1012-1195`; selected detail, lineage, history, messages, permission, and action views are `:1197-1341`; detail/action fetches are `:1420-1605`.
- The named-session web selector is OpenCode/Codex-only (`src/web/index.html:658-672`), while MCP `create_session` and `new_or_resume` explicitly allow OpenCode/Codex/ZCode (`src/index.ts:405-433`). This is a confirmed UI discoverability mismatch, not proof of backend inability.

### Adapter, capability, and skill seams

- `src/types/common.ts:1-12` defines six harnesses; adapter methods and optional control operations are `:163-245`; effective capabilities are centralized at `:247-272`, with native `controlCapabilities` precedence.
- `src/adapter-registry.ts:30-130` owns registration, persisted enablement, active lifecycle, readiness, and errors. `src/index.ts:60-90` supplies six factories and environment gates; `:98-255` performs startup/fallback/lazy initialization. The UI and HTTP layer consume this registry seam.
- Implementations are under `src/adapters/`: OpenCode, Claude/SDK, Codex/app-server, ACP/Qoder, Hermes, and ZCode/protocol. Hermes is explicitly backed by `hermes mcp serve` (`src/adapters/hermes/adapter.ts:72-105`).
- MCP tools are registered in `src/index.ts:275-518`, with definitions in `src/mcp-tools/definitions.ts` and handlers in `src/mcp-tools/handlers.ts`. Observation/control tools enumerate all six harnesses; named creation is deliberately limited to OpenCode/Codex/ZCode (`src/index.ts:405-433`).

### Tests and boundaries

- Route/UI contracts are in `tests/http-api.test.ts:1-165` and `tests/web-ui.test.ts:1-85`; named/MCP contracts in `tests/named-session.test.ts` and `tests/mcp-definitions.test.ts`; adapter/capability seams in `tests/control-capabilities.test.ts`, `adapter-registry.test.ts`, `adapter-gates.test.ts`, `zcode-adapter.test.ts`, `qoder-adapter.test.ts`, and `hermes-conversion.test.ts`. Fixtures cover ACP, Codex app-server, ZCode app-server, Qoder CLI, and named sessions.
- `tests/http-api.test.ts:78-164` uses loopback `createWebServer` with fake dependencies and verifies adapter APIs, sessions/new-or-resume, details, actions, conversion, and dashboard HTML. It does not prove real bootstrap, external harness connectivity, MCP HTTP initialize/continuation, or malformed JSON behavior.
- Existing evidence records `npm test` green: build plus 24 Vitest files / 94 tests. This remains contract evidence, not live message-delivery proof.

### Confirmed risks and next probes

1. Conversion targets are hard-coded to Claude/Codex/OpenCode/Qoder (`src/web/index.html:1224`), while `/api/conversions` accepts typed harness values (`src/web/server.ts:222-235`); inspect `SessionSupervisor.convertSession` before classifying Hermes/ZCode omission as functional.
2. Resume UI gating is status-based (`src/web/index.html:1070-1079`) rather than visibly consulting `session.meta.controlCapabilities.resume`; a fixture lacking native resume is the highest-value UX probe.
3. `readJson` errors (`src/web/server.ts:253-265`) fall into the top-level 502 handler (`:33-42`), so malformed JSON/oversized bodies may have incorrect status classification.

### Independent baseline canary

In an isolated disposable build/runtime with all six external adapters disabled and no credentials, start `dist/index.js` on loopback and assert: `GET /` is 200 and contains `Agent Herder`; `GET /api/adapters` returns six definitions with no active external session; `GET /api/sessions` returns a JSON `sessions` array; `POST /api/sessions/new-or-resume` with `{}` is 400; `POST /mcp` without an initialize session is the documented JSON-RPC 400; and an unknown path is 404. Separately, injected fake adapters may cover one details fetch plus one message action. This is an independent router/registry baseline only; real delivery still needs an authorized harness-specific canary.

### Scope confirmation

Only Agent Herder source, tests, README, package metadata, and this task file were checked. No source edits, deployment, restart, secrets, security/ACL, database, or observability access occurred.
