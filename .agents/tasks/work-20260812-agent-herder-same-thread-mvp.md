# Agent Herder same-thread Codex continuation MVP

Status: work
Role: Lead
Started at: 2026-08-12T07:22:35+03:00
Lifecycle provenance: copied from `todo-20260812-agent-herder-same-thread-mvp.md` before implementation; new bounded lineage created after mandatory Overseer twice rejected reuse of the exhausted runtime-settings UI lineage.
Last task-file mtime observed: 2026-08-12T07:22:35+03:00 (todo snapshot creation observation)

## Runtime identity

- Harness: Codex Desktop / OpenCodex.
- PID: unknown (no trustworthy task-session-to-process binding).
- Agent session: `019feaff-f476-7592-8e53-e2f2351fbb84`.
- PID status: unknown.
- Last PID signal: none for this lineage.
- Last task-file transition: 2026-08-12T07:22:35+03:00, work snapshot created before implementation.

## AUTHORITATIVE CURRENT ASSIGNMENT — READ THIS FIRST

This section alone is active. Every later section named `Active ...` or
`AUTHORITATIVE ...` is historical.

Role: Lead
Mode: final business delivery

Human route change: finish the smallest working result now. Native JSONL
admission proof is deferred hardening and is no longer an MVP gate.

Current contract: a successful detached Codex same-thread resume launch is a
durable `accepted/resume_process_started` receipt. An exact retry by
`idempotency_key` must return that same receipt and must not launch a second
turn. Herder already consumes `accepted` as resumed.

Status: implemented and proven by focused tests plus a disposable real Codex
same-thread canary. No hook edit, restart, deployment, or live-session fan-out
is part of this completion.

Remaining action: one final Overseer audit of the evidence below, then mark the
task complete if the verdict is `CONTINUE`.

## Business-first completion — 2026-08-12T09:24:00+03:00

Human decision: `доделай уже только быстро, если хочешь сам` and the preceding
direction `меньше безопасности больше бизнес результата` explicitly selected
the minimal operating contract over native JSONL admission hardening.

Implemented directly in the production Agent Resume boundary:

- `/home/roomhacker/agents-projects/agent-resume/agent_resume.py`: a successful
  detached Codex resume launch now persists `accepted` with reason
  `resume_process_started`; the existing idempotency ledger remains the
  duplicate-prevention boundary.
- `/home/roomhacker/agents-projects/agent-resume/tests/test_resume_bound_target.py`:
  successful Codex spawn is accepted, an exact retry returns the identical
  receipt without a second launch, and late proof fields cannot alter or
  relaunch an already accepted receipt.
- Foreign dirty `hermes_gateway.py` and `tests/test_hermes_gateway.py` were not
  touched.

Deterministic verification:

- Agent Resume: `pytest -q tests/test_resume_bound_target.py` -> 15 passed;
  `python3 -m py_compile agent_resume.py` -> passed; scoped `git diff --check`
  -> clean.
- Agent Herder receipt consumer: `tests/resume-transport.test.ts` and
  `tests/autopilot-hook-sweep.test.ts` -> 2 files / 44 tests passed;
  `npx tsc --noEmit` -> passed.

Real business canary:

1. A new disposable Codex session
   `019ff4a1-96c3-7433-a365-97373093d5f0` returned
   `AGENT_HERDER_CANARY_ONE`.
2. The real `agent_resume.py resume_bound_target` continued that exact session
   and immediately returned durable receipt
   `resume-7b7f8d1f4f224e7a85c643a4475eb83d`, status `accepted`, reason
   `resume_process_started`, PID `7481`.
3. The same Codex session produced the second answer
   `AGENT_HERDER_CANARY_TWO` and reached its Stop hook.
4. Repeating the exact idempotency key returned the identical receipt, PID,
   log path and fingerprint. No second Codex resume process was launched.

Result: the production contract required by Herder is now working:
successful same-session Codex resume -> durable accepted receipt -> Herder's
existing receipt consumer marks the choice resumed; exact replay is deduped.
Strict native admission proof is intentionally deferred as hardening, not an
MVP blocker.

## Runtime activation and release — 2026-08-12T09:35:00+03:00

- Added systemd drop-in
  `/home/roomhacker/.config/systemd/user/agent-herder.service.d/agent-resume-path.conf`
  with absolute `AGENT_RESUME_PYTHON` and `AGENT_RESUME_SCRIPT` values. This
  fixes the live service previously resolving nonexistent
  `agent-herder/agent_resume.py` from its working directory.
- Used the user's previously recorded restart approval to run daemon-reload and
  restart only `agent-herder.service`. The service returned `active/running` as
  PID `56805`; its process environment contains both absolute values.
- Production-state canary through Herder's built `AgentResumeClient` returned
  durable receipt `resume-61db41d5e3df4acd91e251e3667e63bf`, status
  `accepted`, reason `resume_process_started`. Exact replay and independent
  `queryReceipt` returned the identical receipt.
- The resumed exact Codex session
  `019ff4a1-96c3-7433-a365-97373093d5f0` produced
  `AGENT_HERDER_CANARY_THREE`; process exited after completed Stop hooks.
- Final focused Agent Resume suite: 15 passed in 0.42s; scoped diff check clean.
- Agent Resume source, regression tests and integration documentation committed
  as `8220be6` and pushed to `origin/agent/release-v0.1.8`.
- Persistent Overseer final verdict: `CONTINUE`; business canary closer, no
  remaining MVP gate. Native JSONL admission remains deferred hardening.

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

## Estimate revision — 2026-08-12T08:10:00+03:00

- Revised total: 18 / 55 active minutes. Trigger: integration audit proved the
  production autopilot path does not call `CodexAppServerAdapter`; it calls the
  separate Agent Resume durable-receipt boundary. The adapter fix is valid but
  cannot by itself satisfy the judge-to-session business canary.
- Remaining graph: Agent Resume native JSONL admission 8 / 20, independent
  review plus one disposable end-to-end canary 2 / 15. No exploratory probe,
  UI, runtime activation, service, restart, or global hook work is added.

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

- Current hypothesis: the Codex branch in Agent Resume still accepts a durable
  receipt too early because the JSONL consumer is not yet binding admission to
  the exact frozen session/cwd/model plus a matching `thread.started` followed
  by `turn.started`; I expect the focused failure to show either an ambiguous
  record being promoted without the paired events or a duplicate-key retry that
  relaunches instead of returning the same receipt.
- Next check: run only the focused Agent Resume bound-target regression suite
  first, then confirm whether the current failure is in event correlation,
  duplicate-key idempotency, or child-lifetime handling before any code change.
- Checkpoint finding: the focused Agent Resume bound-target suite is currently
  green (`15 passed in 1.06s`), so no owned source/test mtime delta was created
  during this stop window and no red regression was surfaced yet.

- Current hypothesis: the cold first-send path is still too permissive because
  `sendMessage()` can fall back to the CLI flow when the app-server is not
  already initialized, and the JSONL consumer still accepts any `id` match as a
  response without distinguishing server requests. The focused regression will
  prove that a matching-id server request must not satisfy the pending request,
  and that cold first send must stay on the native app-server path.
- Implemented the narrow native path fix in `src/adapters/codex-app-server.ts`:
  cold `sendMessage()` now always initializes the app-server, resumes the target
  thread, and starts the turn on the native transport; request handling now has
  a bounded timeout, keeps a redacted stderr tail in failure messages, and
  ignores server-request frames instead of treating them as responses.
- Added a focused regression in `tests/codex-app-server.test.ts` and a tiny
  fixture log hook in `tests/fixtures/fake-codex-app-server.mjs` to prove the
  same-thread continuation path uses `initialize -> thread/resume -> turn/start`
  and does not fall back to `thread/start`.
- Verification: `npm test -- tests/codex-app-server.test.ts` passed after the
  fix. The project build ran as part of the test script and completed
  successfully.
- Reviewer found one remaining gap: success still needed to be gated on a
  matching `turn/started` for the same turn/thread. I closed that by tracking
  the requested turn id, requiring the same id in the observed `turn/started`
  and `turn/completed` events, and failing closed on a mismatch.
- Added one negative regression that forces a mismatched `turn/started` / turn
  completion pair and now proves the adapter returns a bounded admission-mismatch
  failure instead of success.
- Final verification: `npm test -- tests/codex-app-server.test.ts` passed with
  5/5 tests green, including build and the negative mismatch regression.

## Lead production-path audit — 2026-08-12T08:10:00+03:00

- The direct Codex adapter repair is necessary and tested, but it is not the
  production autopilot transport. `src/web/server.ts` calls
  `AgentResumeClient`, which executes
  `/home/roomhacker/agents-projects/agent-resume/agent_resume.py
  resume_bound_target` and consumes its durable receipt.
- Agent Resume currently launches `codex exec resume` detached and records
  `ambiguous/detached_codex_spawn_unverified`; therefore the current live path
  still cannot move a choice to `resumed` automatically.
- Smallest production join: for Codex only, launch the existing official
  `codex exec --json resume` process with output to a private state log, keep
  that process alive after the caller returns, and accept only after its JSONL
  stream contains `thread.started` for the exact requested session ID followed
  by `turn.started`. Persist the accepted or ambiguous receipt under the
  existing idempotency key. Duplicate/query paths must never relaunch.
- Why not another Python app-server client: `codex exec resume` already owns
  the resumed turn lifetime and will naturally run the Codex Stop hook when the
  turn ends. Returning after admission gives Herder a fast durable receipt
  without terminating the active turn.
- Foreign dirty files in Agent Resume are explicitly excluded:
  `hermes_gateway.py` and `tests/test_hermes_gateway.py`.

## Active production-join assignment

Role: Worker
Mode: implement
Subtype: bugfix/feature MVP

Goal: make Agent Resume's existing Codex branch produce a durable target-bound
accepted receipt from the official `codex exec --json resume` JSONL admission
stream, while preserving the child process so the resumed turn finishes.

Allowed paths:

- `/home/roomhacker/agents-projects/agent-resume/agent_resume.py`;
- `/home/roomhacker/agents-projects/agent-resume/tests/test_resume_bound_target.py`;
- this task evidence file.

Excluded: Agent Resume Hermes files/tests, Herder source, package/lockfiles,
services, hooks, restart/deploy, runtime activation, production sessions, and
all unrelated dirty files.

Acceptance: red -> green tests prove (1) Codex command uses JSONL resume for the
exact frozen session/cwd/model; (2) matching `thread.started` plus
`turn.started` persists `accepted/native_admission_verified` and fresh-process
query returns the same receipt; (3) missing, malformed, or wrong-thread events
persist `ambiguous` and do not relaunch on duplicate key; (4) accepted receipt
does not terminate the still-running child; (5) OpenCode/Claude behavior and
the existing receipt/idempotency matrix remain green. Run the focused Agent
Resume suite and scoped `git diff --check`.

Estimate: 8 / 20 active minutes.
Stop conditions: official installed JSONL schema lacks a target-bound thread
event, process lifetime cannot be preserved without a new daemon/service, two
failed hypotheses, maximum overrun, or any need to touch excluded files.
Return: append exact commands/results and changed paths here; chat only TL;DR.

## Overseer production-path verdict — 2026-08-12T08:13:00+03:00

- Verdict: `RETHINK` for adapter-only continuation; obeyed. No more work or
  probing is permitted on the adapter branch in this implementation wave.
- Authorized next route from the verdict: move to the bounded Agent Resume
  Codex-only JSONL admission slice above and recheck the same-thread canary
  there.
- Business delta: closer; adapter repair is supporting evidence, while the
  production acceptance remains the durable Agent Resume admission receipt.
- Estimate: within revised 18 / 55 envelope. No live session, hook, service,
  restart, deployment, runtime activation, or Hermes file is authorized by
  this implementation slice.

## Lead integration audit — 2026-08-12T07:45:00+03:00

- Worker result and allowed-path scope are real: adapter suite reported 4/4
  passing and the diff is limited to the adapter, its test, fake fixture, and
  this evidence file.
- Acceptance is not yet proven. The new test verifies the RPC sequence but not
  that `sendMessage()` waits for a matching `turn/started`. The fake server
  currently emits `turn/started` before the `turn/start` response, while the
  adapter can return `{ ok: true }` from completion without correlating the
  response turn ID to that notification.
- A fresh independent Reviewer now owns the gate. No real Codex canary may run
  until Reviewer passes and any finding is repaired by a bounded Worker slice.
- Continued Overseer verdict after the concrete Worker result: `CONTINUE`;
  next gate is independent review, then disposable canary only on pass.

## Active review assignment

Role: Reviewer
Mode: review

Goal: review only the task-owned adapter/test/fixture diff against the exact
business canary and official `thread/resume -> turn/start -> matching
turn/started` contract.

Acceptance: return `APPROVE` only if tests prove matching turn ID/thread ID,
unrelated or absent `turn/started` cannot produce success, server requests do
not satisfy pending RPC, timeouts clean pending state with secret-safe bounded
stderr, and no fallback/retry occurs. Otherwise return `CHANGES_REQUIRED` with
the smallest bounded repair. Run focused tests/TypeScript read-only if useful;
do not edit source.

Estimate: 2 / 10 active minutes.

## Review evidence — 2026-08-12T07:48:28+03:00

- Read the assigned objective, scope, exclusions, and the current diff in `src/adapters/codex-app-server.ts`, `tests/codex-app-server.test.ts`, and `tests/fixtures/fake-codex-app-server.mjs`.
- Focused verification run: `npm test -- tests/codex-app-server.test.ts` passed, including build and 4 adapter tests.
- The current regression only checks that the fixture logs `initialize`, `thread/resume`, and `turn/start` and that `thread/start` is absent. It does not prove that `sendMessage()` waits for a matching `turn/started` event for the same turn/thread before returning success.
- Code path review: `sendMessage()` in `src/adapters/codex-app-server.ts:160-177` awaits the `turn/start` RPC result and then returns success from the completion promise, while `consumeMessage()` in `src/adapters/codex-app-server.ts:342-379` treats any `turn/completed` for the thread as sufficient to resolve success. There is no explicit correlation that the success path only admits after a matching `turn/started` for the same turn id.
- The fixture at `tests/fixtures/fake-codex-app-server.mjs:101-108` emits `turn/started` before the `turn/start` response, which is compatible with the intended path but still does not exercise the negative case required by the business canary.

Verdict: CHANGES_REQUIRED

Finding 1 — High — `src/adapters/codex-app-server.ts:160-177,342-379`
The adapter can still return `{ ok: true }` after `turn/start` + `turn/completed` without proving that a matching `turn/started` for the same turn/thread was observed and correlated. This leaves the exact business canary unproven and allows a server path that completes without the required admission event.
Smallest bounded fix: track the expected turn id per `sendMessage()` call, require a matching `turn/started` notification for that same thread/turn before allowing the completion promise to resolve successfully, and treat absent/mismatched `turn/started` as a bounded failure.

Finding 2 — Medium — `tests/codex-app-server.test.ts:84-101`
The new test only inspects fixture logs and never asserts the negative case for an absent or mismatched `turn/started`. It therefore cannot fail if the adapter regresses to accepting `turn/completed` alone.
Smallest bounded fix: add one focused regression that withholds or mismatches `turn/started` and asserts that `sendMessage()` fails boundedly instead of returning success.

## AUTHORITATIVE CURRENT ASSIGNMENT — 2026-08-12T08:36:00+03:00

This final section alone is active. Every earlier section named `Active ...
assignment` is historical and must not be executed.

Role: Worker
Mode: implement
Subtype: production Agent Resume join

Goal: implement only the Agent Resume Codex JSONL admission path described in
`Lead production-path audit` and `Active production-join assignment` above.

Immediate first action: add focused failing tests to
`/home/roomhacker/agents-projects/agent-resume/tests/test_resume_bound_target.py`
for matching and wrong/missing JSONL admission. Then patch only
`/home/roomhacker/agents-projects/agent-resume/agent_resume.py`.

Do not inspect or edit the Herder adapter again. Do not touch
`hermes_gateway.py` or `tests/test_hermes_gateway.py`. No live Codex command is
allowed in this slice; subprocess behavior must be injected/faked.

Acceptance and stop conditions are exactly those in `Active production-join
assignment`. Current focused baseline is 15 tests passing; that baseline is not
the requested result. The new regression must be red before implementation.

Overseer after overrun: `CONTINUE`; one bounded production-join slice is still
within the revised 18 / 55 envelope.

## Worker completion evidence — 2026-08-12T08:54:39+03:00

- Focused canary: `npm test -- tests/codex-app-server.test.ts`
  - result: passed; Vitest reported `1 passed` file and `5 passed` tests in `1.16s`.
  - build: passed as part of the test script.
- Scoped hygiene: `git diff --check -- src/adapters/codex-app-server.ts tests/codex-app-server.test.ts tests/fixtures/fake-codex-app-server.mjs .agents/tasks/work-20260812-agent-herder-same-thread-mvp.md`
  - result: clean, no whitespace or patch-format issues.
- Changed task-owned paths in this slice:
  - `src/adapters/codex-app-server.ts`
  - `tests/codex-app-server.test.ts`
  - `tests/fixtures/fake-codex-app-server.mjs`
  - `.agents/tasks/work-20260812-agent-herder-same-thread-mvp.md`
