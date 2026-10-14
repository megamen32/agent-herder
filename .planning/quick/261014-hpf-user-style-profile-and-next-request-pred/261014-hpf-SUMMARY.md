---
status: incomplete
---

# User style and next-request prediction

Implemented and published in main:83b8465. Shared account-local `user-style.json`
under the existing autopilot state directory. Stop and both batch-planner protocol
factories request a prediction and consolidate style in the existing LLM call.
Native user messages supply learning observations; bounded profile/digests,
existing redaction, generated-input exclusion, atomic lock and revision fencing.
Corrupt/unwritable cache is preserved and does not invalidate a usable decision.
Per-request packing includes actual style data; shared batch accounting reserves
its bounded envelope. No daemon, scheduler, cross-host profile transport or UI added.

## Verification

- Fast unit + focused integration:97 tests passed (4 files),7.16s test time,
  8.40s whole scope. New coverage:8 profile/prompt/protocol cases.
- TypeScript compilation of the exact source to `.tmp/style-candidate`:49.32s,
  success. First earlier noEmit43.16s success.
- Real configured LLM Stop judge created revision1 from explicit fixture user
  preferences; then real configured OpenAI-compatible batch planner consumed
  that profile in project B, returned unfinished, predicted
  «Проверь, сохраняется ли порядок после обновления страницы» and included
  the real reload acceptance step in its handoff. Batch scope7.71s.
- Evidence: `.tmp/style-live-canary/first-proof.json`,
  `.tmp/style-live-canary/batch-response.json`,
  `.tmp/style-live-canary/batch-result.json`. All isolated fixture state; no native
  task continuation or notification was dispatched, no real user profile seeded.
- Original GSD detector complete, native recognized=true. SDK dependencies were
  installed via its own manifest after missing ws prevented the first SDK query.

## Retained failures and remaining delivery

The initial test scopes could not initialize Rolldown under Tasks64 because its
Tokio pool tried to create57 workers. Stopped only these owned idle scopes;
ROLLDOWN_WORKER_THREADS=2 + ROLLDOWN_MAX_BLOCKING_THREADS=2 corrected the runner
without raising its finite limits. Final scope succeeded.

Two project-B Stop-judge requests hit the existing35s provider timeout. The
initial project-A Stop response did persist a profile; the batch consumer passed
with its already-configured low reasoning effort and existing batch deadline.
This does not prove reliable Stop-hook latency. No repeated native action occurred.
A follow-up must isolate provider reasoning/latency before changing live settings.

BLOCKED_REAL_SURFACE for full activation: existing Herder daemon PID1072026,
started2026-10-13, retains the old imported code; installed Codex plugin0.2.3
also holds older compiled artifacts. Neither was overwritten/restarted. Current
`src/adapters/zcode-runtime-observation.ts` explicitly reports loaded-session
coverage unknown, queued/admitted counts null, idleProof=false; existing rollout
contract at docs/autopilot.md requires complete native coverage before owner
restart. Smallest next step: use the supported release/activation path once the
owner has a safe stopped/idle boundary, then run actual hooked/native acceptance.
No full installed/runtime completion claimed.

Foreign WIP preserved: two untracked OpenCode release JS files. No branches,
worktrees, foreign sessions or native queues changed.
