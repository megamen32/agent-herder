---
status: complete
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

## Clarification14.10: provider failures and existing fallback

Live configuration confirmed both the daemon environment and hook env/persisted
judge settings choose direct `glm-5.3-flash` via Z.AI Coding Plan. No judge fallback
chain exists in these factories. The expected MiniMax→GLM chain does exist for
TelegramAuto execution: OpenCode/MiniMax then ZCode/GLM; its definite pre-admission
quota2056 gate does not govern judge requests. Models, deadlines and routes were
preserved; no accepted/unknown native task was retried.

Actual provider snapshot 14.10 ~13:08 MSK, isolated inference/no native dispatch:
- Existing MiniMax one-token quota probe: HTTP200, returned exact
  MiniMax-M3.1-Flash-Preview,698ms. This proves admission, not a full business turn.
- Actual configured GLM Stop judge: HTTP200, headers after33365ms, valid completed
  verdict after33418ms. The previous failures had a35s client deadline. The new
  sample supports slow-response latency near that deadline; it does not prove
  the historical server-side reason or any historical429/quota exhaustion.
- Evidence: `.tmp/judge-diagnostics/live-result.json` (mode0600).

Implemented `JudgeRequestError.diagnostic` for Stop and both judge protocols:
actual model/endpoint/operation, elapsed time, headers/body stage, known HTTP
status, native code/message, request id and Retry-After. Distinguish cancellation,
transport, timeout, quota, rate limiting, overload, auth and malformed JSON.
HTTP429 alone never becomes confirmed subscription exhaustion. Anthropic stream
errors keep their native detail even under HTTP200. Read at most8KiB of provider
error body under the existing deadline; redact existing patterns and exact auth
values, exclude request prompts/auth and URL query/userinfo. Preserve semantic
JSON repair and existing bounded HTTP429/5xx planner retry classification.

Focused diagnostic/style/core/audit checks:70 passed,6.30s tests/7.32s scope,
including12 new HTTP/native-code/timeout-phase/stream/repair cases. First compile
49.15s passed; final compile46.76s passed. Original activation boundary remains: no
restart or installed-plugin overwrite was performed, so future live daemon/hook
errors still require supported activation to gain these diagnostics.

## Async Stop and authorized activation —14.10

Replaced hook-side judging with a1200ms-deadline notification. The existing
Herder job registry owns a bounded serial queue of32 pending jobs and performs
the LLM call after acknowledgement. Native session snapshots, opt-in, Stop,
pending-question and cancellation checks fence continuation; batch admission
waits while that same session has a Stop job. Existing native transport and
stable input identities retain receipt/noReplay behavior. Hermes polls the
existing job API through its supported plugin. No detached judge is spawned.

Fast unit/focused integration:72 unique cases across6 files passed (71-case
scope15.71s; final background+runner13-case scope6.98s). Final candidate tsc48.85s
passed; Python plugin compiled. Actual installed-hook code against the real
configured GLM exited `{}` after936ms, while the isolated background judge
completed after22176ms. No native dispatch or notification was allowed by that
canary. Evidence: `.tmp/async-stop-plugin/result.json`.

Official GLM docs confirm5.3/5.3Flash force thinking; it cannot be disabled.
The user explicitly authorized updating the installed plugin and restarting
Herder now after the idle-coverage limitation was explained. Earlier activation
block is historical; deployment receipt follows below.

## Activated and verified —14.10 13:34MSK

Published implementation437d74e to origin/main before activation. Backed up
canonical and installed dist plus replaced plugin files under
`.tmp/async-stop-activation-20261014/`; overlaid350 compiled artifacts while
preserving static UI, installed0.2.3 manifests/config and dependencies. Updated
the installed Codex hook/skill. Hermes plugin is already a symlink to the
canonical integration; existing Hermes processes were not restarted.

With explicit human authorization, restarted only agent-herder.service once.
New daemonPID1536249 active/running, memory398MiB at first check. Exact installed
Codex hook against the live daemon exited `{}` in354ms, then274ms; repeated
POST returnedHTTP202 in17ms with the SAME completed job identity. The isolated
unknown session had no opt-in and was fenced before model/native dispatch,
as expected. Evidence: install-receipt.json and live-hook-result.json in the
activation directory. Combined with the real GLM async canary and guarded
same-session integration tests, this proves installed notification/background
activation. A real business continuation was not injected into a foreign chat.

Shared style/prediction and detailed judge error diagnostics are now loaded by
the running daemon and installed Codex package. Historical activation blockers
above are resolved for this instance; this is not a fleet-wide plugin rollout.
Foreign untracked OpenCode release files remain untouched.
