# Health remediation OpenCode runtime implementation

Status: in progress
Lifecycle snapshot: work
Supersedes: todo-20260811-opencode-health-runtime-implementation.md
Original user request: "Ладно не надо гермеса брать, пусть опенкод это делает"
Objective: canonical health remediation profile is OpenCode, never Hermes.
Business canary: a future approved selected plan-003 retry reaches OpenCode and
does not create a Hermes process.
Confirmed scope: source-only OpenCode runtime switch and focused regressions.
Explicit exclusions: deploy, restart, retry, Telegram send, secrets, production
mutation, and unrelated backwards-compatibility redesign.
Cycle: short
Harness: Codex Worker
PID: pending Worker launch
Agent session: pending Worker launch
PID status: unknown
Last PID signal (UTC+3): none
Last task-file transition (UTC+3): work
Current stage: implementation
Current owner: Worker
Started at (UTC+3): 2026-08-11 18:00
Lifecycle provenance: copied from todo by Lead before implementation
Last task-file mtime observed (UTC+3): 2026-08-11 18:00
Workspace: primary checkout
Worktree path: /home/roomhacker/agents-projects/agent-herder
Branch: agent/session-lineage-tools
Initial estimate (minimum / maximum active minutes): 8 / 20
Stop when: focused test and TypeScript check pass, or the change requires a
broader compatibility decision.
Forbidden without explicit user authorization: deploy, restart, retry, external
Telegram delivery, Hermes execution, destructive action.

## Execution

- Mode: implement: bugfix/TDD
- Owner paths: `src/health-remediation.ts`, `tests/health-remediation.test.ts`,
  `tests/http-api.test.ts` only.
- Goal: change canonical health execution runtime from Hermes to OpenCode and
  make health-route validation accept that canonical profile.
- Primary acceptance: focused regressions prove OpenCode profile is normalized
  and returned by the health remediation route; Hermes is not selected as the
  canonical runtime.
- Preserve unrelated dirty work. Do not edit generated `dist` or service units.

## Worker result

- Outcome: the canonical health execution profile now normalizes to OpenCode
  runtime instead of Hermes, and the HTTP route tests assert the OpenCode
  profile end to end.
- Changed paths:
  - `src/health-remediation.ts`
  - `tests/health-remediation.test.ts`
  - `tests/http-api.test.ts`
- Evidence:
  - Focused red phase on `tests/health-remediation.test.ts` failed with
    `health execution runtime must be hermes` before the source change.
  - Final focused regression run:
    `npx vitest run tests/health-remediation.test.ts tests/http-api.test.ts --reporter=dot`
  - TypeScript check: `npx tsc --noEmit`
- Result:
  - `10` focused tests passed.
  - TypeScript check passed with exit code `0`.
  - OpenCode is now the canonical runtime asserted by the health remediation
    profile and the route validation tests.
- Remaining risk:
  - I kept the scope inside the assigned health-remediation slice, so unrelated
    Hermes surfaces and wider runtime wiring were not changed.

## Reviewer result

Verdict: CHANGES_REQUIRED

### Findings

- HIGH — `src/web/server.ts:368-402`: the health route still accepts
  `harness: "hermes"`.  After the changed normalizer returns the canonical
  `execution.runtime: "opencode"`, that branch still reaches
  `supervisor.newOrResumeNamedSession({ harness: "hermes", ... })` at lines
  395-402.  Thus a caller can submit the canonical OpenCode execution profile
  and create a Hermes remediation session, violating the objective and the
  business-canary condition that no Hermes process is created.  Small bounded
  fix: make this route require `harness === execution.runtime` (or directly
  `"opencode"`) before the Hermes configuration branch, and add a focused
  negative HTTP regression proving a canonical OpenCode profile with
  `harness: "hermes"` returns 400 and does not call a Hermes adapter.  This
  needs a coordinated owner-path extension for `src/web/server.ts`, which is
  currently modified by other work.

- SCOPE — `tests/http-api.test.ts:89-113`: the added MCP bearer-token test is
  unrelated to the declared source-only OpenCode runtime switch and has no
  matching source change in this task.  The file is concurrently dirty; do not
  stage this hunk as part of this task.  Keep the runtime-test hunks isolated
  or have their actual owner retain them.

### Evidence

- Reviewed the assigned objective, exclusions, Worker result, current owned
  diff, and the route implementation.  `normalizeHealthExecution()` now
  returns only `runtime: "opencode"` (`src/health-remediation.ts:1-42`), but
  the independent request `harness` remains selectable as Hermes in the route.
- `npx vitest run tests/health-remediation.test.ts tests/http-api.test.ts --reporter=dot`:
  2 files, 10 tests passed.
- `npx tsc --noEmit`: passed (exit code 0).
- `git diff --check -- src/health-remediation.ts tests/health-remediation.test.ts tests/http-api.test.ts`:
  passed.
- The live retry/deploy canary was correctly not run: it is explicitly outside
  scope and requires future approval.

### Unverified assumptions

- The later approved retry should use this HTTP route rather than a separate
  caller that bypasses it; the negative route contract is still required to
  keep the stated no-Hermes guarantee at this exposed entry point.
