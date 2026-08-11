# Health remediation OpenCode runtime implementation

Status: in progress
Lifecycle snapshot: todo
Supersedes: work-20260811-opencode-health-runtime-switch.md research result
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
Last task-file transition (UTC+3): todo
Current stage: implementation
Current owner: Worker
Started at (UTC+3): 2026-08-11 18:00
Lifecycle provenance: recorded at creation from completed seam mapping
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
