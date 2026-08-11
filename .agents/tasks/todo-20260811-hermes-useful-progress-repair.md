# Hermes useful-progress watchdog repair

## Business request

The authorized `plan-003` health remediation retry ran Hermes job
`hermes-job-b0d1f569-a65c-476f-8880-7c2a31052135`. It reached a terminal
NoticePlace failure while its Hermes child remained alive. CLI decoration and
echoed prompt lines must never count as useful progress; only semantically
meaningful action/evidence/result must reset the watchdog.

## Worker contract

Owner: `src/adapters/hermes/adapter.ts` and
`tests/hermes-adapter.test.ts` only. You are not alone in the codebase; do not
revert unrelated dirty work. Work in a bounded <=20 active-minute slice.

Implement the smallest regression-tested repair that:

1. makes decorative/echoed input and cosmetic CLI output non-useful;
2. preserves real command/evidence/result output as useful;
3. proves with a red-first test that post-initialization decorative output does
   not postpone termination;
4. runs focused tests and TypeScript validation.

Do not deploy, restart services, mutate production, touch secrets, create
Telegram messages, or start Hermes remediation. Append evidence and a concise
result to this file.

## Runtime identity

- Harness: Codex multi-agent worker
- PID: unknown until Worker starts
- Agent session: unknown until Worker starts
- PID status: pending
- Last PID signal: none
- Started at: 2026-08-11T14:38:00Z
- Lifecycle provenance: created by Lead after failed authorized attempt 5
- Last task-file mtime observed: 2026-08-11T14:38:00Z
- Initial estimate: 10 / 20 active minutes
