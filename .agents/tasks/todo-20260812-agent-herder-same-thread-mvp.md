# Agent Herder same-thread Codex continuation MVP

Status: todo
Role: Lead
Started at: 2026-08-12T07:22:35+03:00
Lifecycle provenance: new bounded lineage created after mandatory Overseer twice rejected reuse of the exhausted runtime-settings UI lineage; this card preserves that history and implements the user's newer narrowed request.
Last task-file mtime observed: not yet observed (new snapshot)

## Runtime identity

- Harness: Codex Desktop / OpenCodex.
- PID: unknown (no trustworthy task-session-to-process binding).
- Agent session: `019feaff-f476-7592-8e53-e2f2351fbb84`.
- PID status: unknown.
- Last PID signal: none for this lineage.
- Last task-file transition: 2026-08-12T07:22:35+03:00, todo snapshot created.

## Original request

`сделай быстрый минимально рабочий результат. исходники кодекса если надо скачай в ~/source_codes если он тут не скачен и не разобран`

## Objective

Make the smallest local Agent Herder path that can append one judge-generated
`continue` goal to the same existing Codex thread and return success only when
Codex confirms admission of that exact new turn.

## Business canary

Given an existing disposable Codex thread ID, a cold Agent Herder continuation
performs exactly one native handshake, `thread/resume(existing ID)`, and
`turn/start` for that same ID. It reports success only after a matching
`turn/started`. A server request, unrelated turn event, timeout, or process
failure is not treated as admission and does not trigger fallback or retry.

## Decisive evidence

- Current official Codex manual says `thread/resume` reopens an existing thread
  so later `turn/start` appends to it, and `turn/started` signals execution.
- Official Codex source is already locally available at
  `/home/roomhacker/agents-projects/.agents/vendor/openai-codex-20260811`; no
  download is needed.
- Existing adapter can bypass native startup on cold first send, discards
  stderr, has no bounded per-method timeout/stage, and can confuse server
  requests (`id + method`) with responses.
- Prior fresh-thread probe was inconclusive and must not be repeated as proof of
  same-thread continuation.

## Confirmed scope

- `src/adapters/codex-app-server.ts`;
- `tests/codex-app-server.test.ts`;
- that test's existing fake app-server fixture only if required;
- this task file and persistent shared-session evidence.

## Explicit exclusions

- no settings UI/policy work;
- no Agent Resume changes;
- no global hook edit, restart, service/deploy, all-session activation or live
  timeout;
- no production Codex session, health remediation, NoticePlace/Telegram change,
  credentials, package/lockfile change, branch/worktree operation, or unrelated
  dirty file;
- no retry of the failed exploratory `thread/start` probe.

## Initial active-minute estimate

10 / 35 active minutes: one 8 / 20 Worker implementation slice, followed by
one 2 / 15 independent review and disposable same-thread canary gate.

## Plan

1. Add a failing focused regression for cold first-send same-thread admission.
2. Implement bounded native initialization/resume/turn-start/event matching in
   the adapter only.
3. Run focused adapter tests and TypeScript build; independently review scoped
   diff.
4. Run one disposable real same-thread canary only after deterministic proof;
   keep runtime default-off.

## Active child assignment

Role: Worker
Mode: implement
Subtype: bugfix/feature MVP

Goal: implement steps 1-2 above without broadening scope.

Allowed paths: `src/adapters/codex-app-server.ts`,
`tests/codex-app-server.test.ts`, its existing fake fixture if required, and
this task file.

Acceptance: red -> green focused tests prove cold first send initializes native
app-server, resumes the requested existing thread, starts exactly one turn,
accepts only a matching `turn/started`, and fails boundedly with redacted
stage diagnostics without raw fallback, hang, or retry. Existing adapter tests,
TypeScript build and scoped `git diff --check` pass.

Stop conditions: public adapter contract requires another production module;
official protocol contradicts the contract; two failed hypotheses; 20 active
minutes; or any need to touch runtime/global state.

Return: append exact commands, results and changed paths here; chat returns only
TL;DR.

## Execution

<!-- Append-only; implementation updates in English. -->
