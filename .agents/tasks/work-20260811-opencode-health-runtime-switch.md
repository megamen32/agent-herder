# Health remediation: switch execution runtime to OpenCode

Status: in progress
Lifecycle snapshot: work
Supersedes: todo-20260811-opencode-health-runtime-switch.md
Original user request: "Ладно не надо гермеса брать, пусть опенкод это делает"
Objective: selected health remediation uses existing OpenCode harness, not Hermes.
Business canary: selected `plan-003` reaches one bounded OpenCode remediation
job after a future approved retry, yielding a strict receipt and independent
verification; no Hermes process is launched.
Confirmed scope: map the existing NoticePlace -> Agent-Herder OpenCode seam.
Explicit exclusions: no deployment, restart, retry, Telegram send, secrets, or
production mutation in research.
Cycle: short
Harness: Codex Worker
PID: pending Worker launch
Agent session: pending Worker launch
PID status: unknown
Last PID signal (UTC+3): none
Last task-file transition (UTC+3): work
Current stage: research
Current owner: Worker
Started at (UTC+3): 2026-08-11 17:55
Lifecycle provenance: copied from todo by Lead before implementation
Last task-file mtime observed (UTC+3): 2026-08-11 17:55
Workspace: primary checkout
Worktree path: /home/roomhacker/agents-projects/agent-herder
Branch: agent/session-lineage-tools
Initial estimate (minimum / maximum active minutes): 5 / 15
Stop when: one minimal implementation slice and acceptance test are identified.
Forbidden without explicit user authorization: deploy, restart, retry, external
Telegram delivery, Hermes execution, destructive action.

## Research

Mode: research
Worker reads only the task-relevant source in Agent-Herder and NoticePlace,
without editing. Return the exact call chain, current fixed Hermes point, least
cost OpenCode switch, tests to change, and any compatibility blocker.

## Research findings

- Exact call chain: `POST /api/health/remediation` in `src/web/server.ts:355-403`
  validates the request, normalizes the execution profile, and forwards the
  job to `supervisor.newOrResumeNamedSession(...)`.
- Current fixed Hermes point: `src/health-remediation.ts:1-48` hard-codes the
  canonical profile to `runtime: "hermes"` even though the selected harness path
  already uses OpenCode semantics via `healthModelForHarness()`.
- Least-cost OpenCode switch: change the canonical health execution runtime to
  OpenCode in `src/health-remediation.ts`, then update the health-route tests to
  expect the new runtime while keeping the provider/model mapping.
- Tests to change: `tests/health-remediation.test.ts` and
  `tests/http-api.test.ts`.
- Compatibility blocker: any OpenCode-flavored profile is currently rejected by
  `normalizeHealthExecution()` because it only accepts the Hermes runtime.
