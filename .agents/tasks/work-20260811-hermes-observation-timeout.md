# Hermes observation timeout after process restart

Original request: continue the health-incident business outcome and repair the
Agent-Herder/Hermes observation boundary that caused the selected remediation
attempt to fail without a terminal receipt.

Objective: an unknown or no-longer-memory-resident Hermes CLI session must not
block the Agent-Herder HTTP control plane. It must fail closed within a bounded
deadline, preserving the distinction between unavailable observation and a
successful remediation.

Business canary: querying the historical Hermes session IDs from the failed
Health remediation returns a bounded explicit outcome, never an indefinitely
pending HTTP request. It must not emit `health.resolved` or produce a Telegram
message.

Confirmed scope: `src/adapters/hermes/adapter.ts` and focused tests. The
existing selected real remediation delivery is evidence only and must not be
requeued, resent, or restarted by this task.

Explicit exclusions: no Telegram send, Hermes remediation execution, service
restart/deploy, secret read/change, queue mutation, or destructive operation.

Initial active estimate: 20 minutes.

## План (Russian)

1. Воспроизвести зависание observation-MCP в focused test.
2. Ввести ограничение ожидания и fail-closed поведение для lookup/history.
3. Запустить focused tests, затем независимый review; deploy только после
   отдельной границы запуска.

## Execution log (English)

- 2026-08-11: Read-only production observation confirmed both historical
  `ses_011e13f35ffey3VJicdwJ1DHfK` and
  `ses_011e11bcfffekCRbt0raVIdl0x` progress routes produced no HTTP response
  within four seconds. Agent-Herder is currently active after a restart;
  in-memory Hermes CLI job state from the remediation attempt is unavailable.
- 2026-08-11: Root-cause candidate confirmed in source: unknown Hermes session
  lookup calls `init()` and `client.callTool()` without `withTimeout`, unlike
  `listSessions()`. The HTTP progress route awaits this chain.
- 2026-08-11: Red first: `tests/hermes-adapter.test.ts` added a never-resolving
  observation bridge. Before the fix, it failed with `test-timeout` after
  118 ms instead of returning `null`.
- 2026-08-11: Implemented a bounded observation helper covering MCP init plus
  session lookup/history. Timeout now disposes the owned observation client and
  returns `null`; it cannot be interpreted as remediation success.
- 2026-08-11: Green evidence: `npx vitest run --root . --config
  vitest.config.ts tests/hermes-adapter.test.ts tests/http-api.test.ts
  tests/session-details.test.ts` -> 3 files, 17 tests passed; `npx tsc
  --noEmit` -> exit 0.
- 2026-08-11: Fresh independent Reviewer `019feee9-f0fc-7ec0-b672-64c17938d53c`
  returned `APPROVE`. Its separate focused run of Hermes adapter plus HTTP API
  tests passed (11 tests). Review conclusion: the change bounds only the
  observation bridge, preserves local CLI jobs, and cannot trigger Telegram or
  remediation execution.
- 2026-08-11: Live no-send verification on server-100: both historical failed
  remediation sessions returned HTTP 404 with curl exit 0 within the four
  second ceiling. Before the repair, each produced no HTTP response within the
  same bound. Fleet preview confirmed the deployed Agent-Herder `dist` already
  had the exact SHA-256 of the reviewed build and its user service had started
  after that build, so no needless apply/restart was performed. No Telegram,
  Hermes egress, remediation run, queue mutation, or NoticePlace change was
  made by this verification.

## Reviewer evidence (English)

- 2026-08-11: Reviewed scoped changes in `src/adapters/hermes/adapter.ts`,
  `tests/hermes-adapter.test.ts`, and `tests/http-api.test.ts`.
- 2026-08-11: Re-ran focused verification:
  `npx vitest run --root . --config vitest.config.ts tests/hermes-adapter.test.ts tests/http-api.test.ts`
  -> 2 files, 11 tests passed.
- 2026-08-11: No scoped regressions found. The new observation timeout fails
  closed for unknown sessions, preserves local job sessions, and keeps the
  business canary bounded without re-emitting `health.resolved` or sending
  Telegram.

APPROVE
