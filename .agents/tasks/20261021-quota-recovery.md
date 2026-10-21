# Quota recovery and ordered OmniRoute fallback

## Accepted result

Implement an opt-in, persistent wait/recovery path for exact terminal provider
quota failures in OpenCode and ZCode, plus ordered per-harness OmniRoute
fallback models. The real user path must expose global/harness/session controls,
preserve independent inheritance, survive restart without duplicate native
admission, and be proven with a bounded live canary before scoped publication
and authorized runtime promotion.

## Scope and safety contract

- `waitForQuota` is independent from general Autocontinue `enabled`, defaults
  to false, and resolves session > harness > global/default.
- A delayed wait requires exact terminal `nativeTurnId` + `inputId`, provider,
  and model evidence. `resetAt` only schedules a read-only check/attempt.
- Missing/stale reset uses bounded backoff and the approved native next-model
  attempt; never infer quota availability from elapsed wall time.
- Recheck current setting, exact workspace/session/turn/input, pending
  permission, and HumanStop after each probe and immediately before claim/send.
- Persist dispatching before native admission; use a stable per-attempt input ID
  and reconcile exact native receipt. Accepted/UNKNOWN is never replayed.
- Immediate ordered fallback is separate and only follows definite
  pre-admission quota rejection. Authentication failures, generic 429,
  ambiguous admission, and incomplete terminal identity never enter quota wait.
- Preserve foreign WIP. UI integration is limited to the existing handed-off
  render seam plus owned isolated components; no other UI files without an
  explicit ownership change.

## Progress plan

| Work item | Owner | Status | Estimate / actual | Dependency or evidence |
| --- | --- | --- | --- | --- |
| Read project instructions, AgentMemory, current paths and challenge | Lead | Complete | Estimate 5m / actual duration unknown | Verified production consumer and exact queue seams; control challenge received |
| Add schema-v8 independent wait setting, exact wait state, and minimal API DTO/routes | Lead | Complete | 15m / actual ~16m shared implementation slice | Reuse SessionAutostartStore and UnfinishedSessionStore; `/api/quota-recovery/waits` is exact-session read-only |
| Consume exact adapter evidence; schedule/probe/reconcile and select native fallback | Lead + adapter peer | Complete | Implementation actual ~12m; total active elapsed untracked | Exact event and snapshot branches, startup scan, due attempt, claim/send/settle are wired; adapter/plugin proof uses exact assistant.parentID and native readback |
| Integrate isolated controls through the handed-off render seam | Lead; controls peer owns component files | Complete | 15m / actual ~2m integration slice | Global/session quota controls and ordered fallback editor are mounted; fallback client sends `{}` on explicit clear |
| Focused regression tests and peer source review | Lead + controls peer | Complete | Focused implementation actual ~8m; peer review actual unknown | Controls accepted backend/API safety review; its A→B request race and missing dispatch-state labels are fixed in owned UI files. Combined run passes 211 tests in 10 files; root TypeScript and diff checks pass |
| Real OpenCode and ZCode consumer canaries, scoped publish and runtime promotion | Lead + controls (ZCode bridge repair) | Active | Estimate 20m; actual remaining unknown | OpenCode dedicated prompt completed successfully with `OK`; ZCode exact-session creation remains blocked before prompt admission by stale socket lifecycle |

## Evidence log

- 2026-10-21: Research confirmed `UnfinishedSessionLauncher` is the real
  consumer; its durable queue already stores native recovery identity and
  `nextAttemptAt`. Generic `model-quota.ts` is insufficient for every OmniRoute
  provider; adapter-specific exact evidence is the selected boundary.
- 2026-10-21: Controls challenge required cross-process claim semantics,
  fresh terminal identity checks, and separation of delayed recovery from
  immediate pre-admission fallback.
- 2026-10-21: Source and tests are on shared `main`; pre-existing unrelated dirty
  paths remain untouched. `src/web-ui/main.tsx` has an existing render handoff.
- 2026-10-21: Exact quota terminal events now require both turn/input identity
  and matching `nativeLastTurn.quotaFailure`; startup scans only opted-in
  OpenCode/ZCode native sessions. Due recovery verifies current workspace,
  terminal IDs, model catalog/readback, settings, pending questions, HumanStop,
  and admission before cross-process CAS claim and durable send.
- 2026-10-21: Focused verification: `npx vitest run tests/session-autostart-http.test.ts tests/automation-launch-policy.test.ts tests/unfinished-session-launcher.test.ts tests/automation-project-routes.test.ts` passed (4 files, 64 tests); `npx tsc --noEmit --pretty false` exited 0.
- 2026-10-21: Additional focused verification passed: 9 UI/backend/dispatch test files (134 tests), 3 adapter classifier/protocol files (113 tests), and the full TypeScript check. A first competing-claim test failed because its synthetic claim timestamp preceded the due time; fixture was corrected and the 47-test launcher suite passed.
- 2026-10-21: Fixed review findings: dispatching claims now have a 30-second reconciliation lease; receipt absence leaves the original revision settleable, exact start with the claimed input ID records acceptance, and the scheduler reconciles dispatching at a bounded interval. Fallback candidate normalization now turns native `providerId=omniroute, modelId=provider/model` into the full `omniroute/provider/model` ID before skipping current model. Disabling quota/autocontinue clears a waiting queue in the settings request path.
- 2026-10-21: Adapter peer reports the real OpenCode v2 canary reply succeeded, but supported terminal transcript/status readback did not expose a parent/input/turn correlation for that already-completed prompt. Adapter remains fail-closed; peer is checking whether supported `/prompt` ID+metadata can provide a native exact receipt for future turns. This is the current critical-path question, not permission to use adjacency or a status-frame ID.
- 2026-10-21 01:27 UTC: A fresh supported OpenCode adapter send returned the exact
  native Inbox.User ID and persisted `metadata.agentHerderInputId`; the backend
  stores that ID in `dispatchNativeInputId`. Native inbox events expose that
  same message ID, while `session.execution.started` lacks turn/input identity.
  The dedicated canary remains accepted/running and has no terminal assistant
  receipt yet, so terminal parent/input correlation is still unproven and no
  retry was made. `/openapi.json` omits assistant `parentID`; user-only metadata
  is not enough to qualify a quota failure.

## Next 15-minute slice (updated 2026-10-21 01:49 UTC)

1. Obtain controls' final source challenge and safe ZCode bridge repair result;
   address any concrete owned backend issue.
2. Publish the reviewed core-owned source paths to `origin/main`, preserving
   shared WIP, then run the deploy build and documented server-100 runtime/UI
   promotion path.
3. Prove both native consumers with dedicated bounded sessions. OpenCode's
   successful response is already observed; quota recovery remains
   deterministic-test-only. Send no ZCode prompt until bridge creation works.
- 2026-10-21: UI owner reports component checks green (fallback editor explicitly
  writes `{ fallbackModels: {} }` to clear); owner integrated both controls in
  the existing global/session/launch-policy render seams. Final peer source
  review requested and pending.
- 2026-10-21 01:31 UTC: Adapter confirmed no ZCode canary has been sent. The
  OpenCode canary is still running; its accepted input remains untouched. The
  bearer route was dropped because the OpenCode process lacks the existing
  Herder HTTP token; use the supported native session metadata projection
  instead, without adding a new secret.
- 2026-10-21: Adapter now captures exact `session.inbox.delivered.data.inboxID`
  and maps it to the following `turn.started` input identity for that session.
  It emits no synthetic turn ID and suppresses ambiguous multiple deliveries;
  adapter reports 17/17 protocol tests, core build, root TypeScript and scoped
  diff check green.
- 2026-10-21: The plugin proof writer is now in the working diff. Review found
  three items sent to its owner: preserve HTTP status to reject auth 401/403/502,
  persist the exact verified parent-message ID, and unwrap SDK array response
  envelopes for native message lists. OpenCode terminal proof is not accepted
  until those details and a fresh native readback pass.
- 2026-10-21 01:35 UTC: Corrected fallback-policy bound handling so stable
  case-insensitive dedup runs before enforcing the maximum of 8 unique models
  (bounded raw input: 64). `tests/automation-launch-policy.test.ts` passed 6/6;
  root TypeScript and `git diff --check` both exited 0.
- 2026-10-21 01:39 UTC: RED/GREEN caught that configured OmniRoute fallback
  lists were passed to launches whose selected model used another provider.
  `namedSessionRunner` now supplies policy lists only when the selected model is
  fully qualified as OmniRoute, preserving existing explicitly known default
  routes. New focused dispatch test passes; root TypeScript and diff check pass.
- 2026-10-21 01:42 UTC: Final combined focused run passed 10 files / 209 tests,
  including plugin proof persistence, both native adapters, durable recovery,
  policy inheritance, UI controls, and launch dispatch. Root TypeScript and
  `git diff --check` exit 0 after the adapter's ascending SDK readback change.
- 2026-10-21: Dedicated ZCode session creation is blocked before prompt
  admission by `EADDRINUSE` on `/run/user/1000/agent-herder/zcode-herder.sock`.
  Exact canary session absence and no prompt send are confirmed. Controls owns
  the supported bridge lifecycle repair; this session will not unlink the
  socket, restart the native service, or stop another process. The ZCode
  consumer canary remains an acceptance dependency.
- 2026-10-21: Read-only follow-up confirms no Unix listener for that path and
  its filesystem entry predates the current Herder `MainPID` generation.
  Controls is checking the bridge owner's supported stale-endpoint reconcile
  seam; no socket or service mutation has been performed here.
- 2026-10-21 01:44 UTC: Adapter commit
  `0d3bb234cd44bb7ebfb3867cd97673323fdb7a69` is on `origin/main`. Final plugin
  proof explicitly requests ascending SDK messages, verifies exact assistant
  `parentID` against the selected user message, and carries sanitized statusCode
  to reject auth failures. Adapter reports 24/24 focused tests, `build:core`,
  root typecheck, and scoped diff check green.
- 2026-10-21 01:44 UTC: Controls UI commit `cf0ec97` contains exactly its four
  assigned component/test paths. It is local and not yet on `origin/main`; the
  remote currently ends at the adapter commit. Core source remains uncommitted.
  Shared working tree contains unrelated dirty WIP and is not clean.
- 2026-10-21 01:44 UTC: OpenCode's accepted dedicated prompt later completed
  with `OK`; no prompt was replayed. This proves the native consumer can answer,
  not quota exhaustion or automatic recovery. ZCode remains unproven because
  session creation failed before any prompt; controls owns the stale socket fix.
- Progress since previous recorded checkpoint (01:42 UTC): 2 minutes verified;
  earlier untracked elapsed time remains unknown.
- 2026-10-21 01:49 UTC: Controls source review accepts bounded backend/API
  behavior without further backend changes. Its UI correction aborts and ignores
  late status responses after session switches and labels `dispatching`,
  `accepted`, and `exhausted`; focused UI tests pass 15/15. The combined run now
  passes 10 files / 211 tests, root TypeScript, working diff check, and staged
  diff check.
- 2026-10-21 01:49 UTC: Rechecked `agent-herder.service` after a peer reported
  it inactive: it is active with MainPID 1073090, started 04:31 MSK, using
  1.4 GiB at inspection. No restart was needed; the earlier inactive report was
  stale. ZCode stale-socket cleanup is now authorized only through the
  documented exact-command single-use allow-once route; no deletion, core edit,
  or process kill has occurred.
- Progress since previous recorded checkpoint (01:44 UTC): 5 minutes verified;
  elapsed time before tracked checkpoints remains unknown.
