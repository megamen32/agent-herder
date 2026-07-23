# Native Transport Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Agent Herder reliable pause/cancel, resume, subagent lineage, and post-error recovery across Qoder ACP, Codex app-server, and OpenCode server APIs.

**Architecture:** Keep one adapter per native transport and expose explicit capabilities instead of pretending every backend has the same pause operation. Qoder uses its persistent ACP connection, Codex gains an app-server adapter over stdio, and OpenCode keeps its server API while adding children/fork/event-aware operations. Recovery records native session and turn identity, reconnects or loads the same session, and forks only when native resume is impossible.

**Tech Stack:** TypeScript, Vitest, Codex app-server JSON-RPC, OpenCode HTTP/OpenAPI server, existing Agent Herder adapter and MCP layers, JSONL lineage store until a later SQLite migration is justified.

## Global Constraints

- Preserve all existing dirty worktree changes; do not reset or discard unrelated files.
- Do not stop or attach to the user's active Qoder worker while testing native transports.
- Keep Qoder ACP as the preferred Qoder transport; its CLI adapter remains fallback-only.
- Every behavior change starts with a focused failing test and ends with focused plus full verification.
- Do not claim universal pause: report cancel-current-turn versus resume-session semantics explicitly.

---

### Task 1: Define transport capabilities and explicit control semantics

**Files:**
- Modify: `src/types/common.ts`
- Modify: `src/mcp-tools/handlers.ts`
- Modify: `src/index.ts`
- Test: `tests/transport-capabilities.test.ts`

**Interfaces:**
- Add `HarnessCapabilities` with `cancelTurn`, `resume`, `recover`, `fork`, `subagents`, and `modelSwitch` booleans.
- Add optional adapter methods `cancelTurn`, `recoverSession`, and `forkSession` without removing existing methods.
- Preserve `stopSession` as hard process termination and route new MCP tools to the explicit methods.

- [ ] **Step 1: Write the failing capability test**

  Assert that Qoder advertises `cancelTurn`, `resume`, and `modelSwitch`; OpenCode advertises `cancelTurn`, `resume`, `fork`, and `subagents`; Codex's current CLI adapter advertises only `resume` until the app-server adapter is enabled.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npx vitest run tests/transport-capabilities.test.ts`
  Expected: FAIL because adapters do not expose a capability description.

- [ ] **Step 3: Implement the minimal capability interface and handlers**

  Add the typed capability result to `HarnessAdapter`, return it from each adapter, and make `agent_info` include the capability names. Add `cancel_turn` and `recover_session` schemas with the existing harness enum.

- [ ] **Step 4: Run focused tests**

  Run: `npx vitest run tests/transport-capabilities.test.ts`
  Expected: PASS.

- [ ] **Step 5: Run the existing MCP handler tests**

  Run: `npm test -- tests/handlers.test.ts tests/http-api.test.ts`
  Expected: PASS with no change to legacy `stop_agent` behavior.

### Task 2: Add Codex app-server adapter over stdio

**Files:**
- Create: `src/adapters/codex-app-server.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/index.ts`
- Test: `tests/codex-app-server.test.ts`
- Test fixture: `tests/fixtures/fake-codex-app-server.mjs`

**Interfaces:**
- `CodexAppServerAdapter implements HarnessAdapter` and owns one `codex app-server --stdio` child.
- Translate `thread/list`, `thread/resume`, `turn/start`, `turn/interrupt`, and `thread/fork` into Agent Herder methods.
- Keep `CodexAdapter` available as a disabled fallback behind `CODEX_TRANSPORT=cli`.

- [ ] **Step 1: Write the failing fake-server contract test**

  The fake server must record one initialize, return a thread, accept `turn/start`, answer `turn/interrupt`, and return a forked thread. Assert that the adapter reuses one child process and maps the returned native IDs.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npx vitest run tests/codex-app-server.test.ts`
  Expected: FAIL because the adapter and fixture do not exist.

- [ ] **Step 3: Implement JSON-RPC request correlation and lifecycle**

  Spawn the configured binary with `app-server --stdio`, maintain a request ID map, parse newline-delimited JSON, cache thread metadata, and map a failed turn to `status: "error"` without losing the thread ID.

- [ ] **Step 4: Implement cancel/resume/fork**

  `cancelTurn` sends `turn/interrupt`; `resumeSession` sends `thread/resume`; `forkSession` sends `thread/fork`; `recoverSession` resumes the same thread and returns a failed result if the server reports an active turn.

- [ ] **Step 5: Run focused tests**

  Run: `npx vitest run tests/codex-app-server.test.ts`
  Expected: PASS.

- [ ] **Step 6: Add runtime selection and verify legacy Codex behavior**

  Select app-server by default when `CODEX_TRANSPORT` is unset, retain CLI when it is `cli`, and run `npx vitest run tests/codex-adapter.test.ts tests/codex-app-server.test.ts`.

### Task 3: Extend OpenCode server adapter for children, fork, and recovery

**Files:**
- Modify: `src/adapters/opencode.ts`
- Modify: `src/types/common.ts`
- Test: `tests/opencode-adapter.test.ts`

**Interfaces:**
- Add `getChildren(sessionId)`, `forkSession(sessionId, messageId?)`, and `recoverSession(sessionId)` to the OpenCode adapter.
- Use `/session/:id/children`, `/session/:id/fork`, `/session/:id/abort`, and `/session/:id/message` from the server API.

- [ ] **Step 1: Write failing HTTP contract tests**

  Fake the existing fetch boundary and assert that children and fork map to `AgentSession` records, abort is distinct from hard stop, and recovery lists status before sending a new prompt.

- [ ] **Step 2: Run focused tests and verify failure**

  Run: `npx vitest run tests/opencode-adapter.test.ts`
  Expected: FAIL because children/fork/recovery methods are absent.

- [ ] **Step 3: Implement the server calls**

  Add typed responses, preserve provider/session IDs in metadata, and return the server's HTTP error body in failed control results.

- [ ] **Step 4: Run focused and full tests**

  Run: `npx vitest run tests/opencode-adapter.test.ts && npm test`
  Expected: PASS.

### Task 4: Add lineage-aware recovery records

**Files:**
- Modify: `src/lineage-store.ts`
- Modify: `src/session-supervisor.ts`
- Modify: `src/web/server.ts`
- Test: `tests/session-recovery.test.ts`

**Interfaces:**
- Extend lineage records with `nativeSessionId`, `nativeTurnId`, `transportGeneration`, `lastEvent`, `failure`, and `recoveryAttempt`.
- Add `SessionSupervisor.recoverSession(provider, id)` that delegates to the owning adapter and records the outcome.

- [ ] **Step 1: Write failing recovery tests**

  Assert that a failed turn records the native turn ID, a successful reconnect/load records one recovery attempt, and a fork records `recovered_from` instead of replacing the old session key.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npx vitest run tests/session-recovery.test.ts`
  Expected: FAIL because the lineage fields and recovery method do not exist.

- [ ] **Step 3: Implement append-only recovery metadata**

  Preserve old records when fields are absent, append recovery transitions, and use a per-session in-process lease to prevent simultaneous prompts through two transports.

- [ ] **Step 4: Expose recovery in MCP/web control surfaces**

  Add `recover_session` to the MCP registration and a web action that displays the native transport result and recovery attempt number.

- [ ] **Step 5: Run all verification**

  Run: `npm run build && npm test && git diff --check`
  Expected: successful build, all tests passing, no whitespace errors.

### Task 5: Document operational semantics and rollout

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Create: `docs/native-transports.md`

- [ ] **Step 1: Document the capability matrix**

  State which operations are native for Qoder ACP, Codex app-server, OpenCode server, and CLI fallbacks; explicitly distinguish cancel, resume, fork, and terminate.

- [ ] **Step 2: Document safe rollout variables**

  Document `CODEX_TRANSPORT=app-server|cli`, `CODEX_BIN`, `OPENCODE_URL`, Qoder ACP settings, and the single-owner rule.

- [ ] **Step 3: Re-run final verification**

  Run: `npm run build && npm test && git diff --check`
  Expected: PASS and no changes to the active Qoder worker.
