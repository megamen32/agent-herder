# Health remediation OpenCode harness guard

Status: in progress
Lifecycle snapshot: work
Supersedes: todo-20260811-opencode-health-harness-guard.md
Original user request: do not use Hermes; use OpenCode for health remediation.
Objective: health API cannot create a Hermes session when canonical execution is
OpenCode.
Business canary: future selected health retry routes only to OpenCode; a
Hermes/OpenCode mismatch is rejected before session creation.
Confirmed scope: reject mismatched harness/runtime in health route; add isolated
HTTP regression in a new task-owned test file.
Explicit exclusions: edits to existing foreign MCP-auth hunk in
`tests/http-api.test.ts`, deploy, restart, retry, Telegram, secrets, production.
Cycle: short
Harness: Codex Worker
PID: pending Worker launch
Agent session: pending Worker launch
PID status: unknown
Last PID signal (UTC+3): reviewer CHANGES_REQUIRED
Last task-file transition (UTC+3): work
Current stage: implementation
Current owner: Worker
Started at (UTC+3): 2026-08-11 18:10
Lifecycle provenance: copied from todo by Lead before implementation
Last task-file mtime observed (UTC+3): 2026-08-11 18:10
Workspace: primary checkout
Worktree path: /home/roomhacker/agents-projects/agent-herder
Branch: agent/session-lineage-tools
Initial estimate (minimum / maximum active minutes): 6 / 18
Stop when: mismatch rejected with focused HTTP test, or route contract requires
larger compatibility decision.
Forbidden without explicit user authorization: deploy, restart, retry, external
Telegram delivery, Hermes execution, destructive action.

## Execution

- Mode: implement: bugfix/TDD
- Owner paths: `src/web/server.ts` and a new narrowly named test file only.
- Primary acceptance: `harness: hermes` combined with canonical
  `execution.runtime: opencode` returns 400/409 and does not reach session
  creation; valid OpenCode request remains accepted.
- Do not modify `tests/http-api.test.ts`; preserve all unrelated work.

## Recovery revision

- 2026-08-11 18:22 UTC+3: first Worker was stopped without a terminal receipt.
  It may have left a partial change only in the task-owned server path. A fresh
  Worker owns inspection of that partial diff plus the same bounded TDD
  acceptance; do not revert or touch unrelated changes.
- Estimate revision: 6/18 -> 5/15 active minutes. Trigger: recovery of one
  interrupted local slice, no scope expansion.

## Worker verification

- 2026-08-11 22:59 UTC+3: inspected the current task-owned diff in
  `src/web/server.ts` and the new route test file
  `tests/health-remediation-route.test.ts`.
- Focused red/green checks were already green:
  - `npx vitest run tests/health-remediation-route.test.ts` → 1 file, 2 tests
    passed.
  - `npx vitest run tests/http-api.test.ts -t 'health remediation'` → 1 file,
    2 tests passed, 5 skipped.
- Acceptance observed: a Hermes harness with canonical OpenCode execution is
  rejected with 409 before session creation, while canonical OpenCode health
  remediation remains accepted.

## Reviewer evidence

- Reviewed only the task-owned route guard at `src/web/server.ts:383-385` and
  new isolated regression `tests/health-remediation-route.test.ts`; the other
  concurrent changes in `src/web/server.ts`, `tests/http-api.test.ts`, and the
  dirty checkout were excluded.
- `normalizeHealthExecution` already enforces the canonical runtime
  `opencode`; the new guard compares that normalized runtime with the requested
  harness before `supervisor.newOrResumeNamedSession` at `src/web/server.ts:398`.
  Therefore a `harness: "hermes"` request cannot reach session creation.
- Independent safe HTTP canary passed:
  `npx vitest run tests/health-remediation-route.test.ts` -> 1 file, 2 tests
  passed. It exercises both the 409 mismatch/no-create path and the accepted
  OpenCode/create-once path through a bound local server.
- Focused existing route coverage also passed:
  `npx vitest run tests/http-api.test.ts -t 'health remediation'` -> 1 file,
  2 passed, 5 skipped.
- No task-scope defects found. The test error contract accepts an error payload
  rather than freezing message text, while status `409` and the absence of both
  adapter create calls are asserted.

## Reviewer verdict

APPROVE

Unverified assumptions: no deployment, restart, retry, Telegram action, or
production health consumer was run (all are explicit exclusions). The evidence
proves the local HTTP route contract, not a future live health retry.
