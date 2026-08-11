# Hermes semantic-progress watchdog — P0 repair

## P0 and live evidence

The authorized `plan-003` attempt 5 on existing NoticePlace delivery
`dlv_2c7160a0bc604e19b2ff86e7ad4ac918` became terminal `failed` at 2026-08-11
14:34Z, but its Hermes child remained running. Agent-Herder job
`hermes-job-b0d1f569-a65c-476f-8880-7c2a31052135` produced only one useful
action (`pwd + 4 commands`) and no final receipt/verification; it was stopped
by the supervisor. This is not a resolved incident and no new remediation is
authorized by this task.

## Contract

- mode: implement
- procedure: bugfix/TDD
- Owner: `src/adapters/hermes/adapter.ts` and
  `tests/hermes-adapter.test.ts`; preserve unrelated dirty work.
- Goal: non-semantic CLI decoration, prompt echo, and tracebacks must not reset
  useful-progress; genuine command/evidence/result output must reset it.
- Acceptance: a red-first focused regression demonstrates that after one
  genuine command, subsequent decorative lines still cause SIGTERM at the
  configured useful-progress deadline; another genuine command postpones it.
- Exclusions: no deploy, restart, secrets, external Telegram send, or new
  Hermes remediation.

## Runtime identity

- Harness: Codex Worker
- PID: pending Worker launch
- Agent session: pending Worker launch
- PID status: not started
- Last PID signal: none
- Started at: 2026-08-11T14:44:00Z
- Lifecycle provenance: copied from todo by Lead before implementation
- Last task-file mtime observed: 2026-08-11T14:44:00Z
- Initial estimate: 10 / 20 active minutes
