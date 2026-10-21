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

## Updated delivery checkpoint (2026-10-21 02:07 UTC)

- Published reviewed source candidate is `410a591fbc1e516cb0a098fcc4a60ba0a5411d2d`;
  `origin/main` matches. Adapter source is published at `0d3bb234`, and UI
  source is included in the core commit after the safe join. This checkout still
  has unrelated dirty WIP; the source-pinned build receipt records its exact
  dirty-path list and no clean-tree claim is made.
- Built from the isolated tracked-source snapshot of that exact published
  commit, not the mixed checkout. Receipt:
  `.tmp/remote-workspaces/quota-recovery-410a591fbc1e/build-provenance.json`
  (SHA-256 `89b035c966cddeb4e892d347cb4326d22ddcb16d249a4d9fc3f437decd93b4de`).
  It records 238 source/config inputs, exact source hashes, output hashes, and
  the 34 unrelated dirty paths observed at snapshot time.
- Runtime overlay is source-pinned and active on server-100, PID 1517601. The
  first attempted start exposed a missing generated web runtime module after
  static-overlay; service was stopped, full published `dist/web` modules were
  restored before static assets, import was verified, and the service now
  serves schema-v8 settings. Runtime receipt and pre-overlay backups are under
  `/home/roomhacker/.local/state/agent-herder/release-backups/quota-recovery-410a591/`.
  Verified hashes include `dist/index.js` `3665b703…592154b`,
  `dist/web/server.js` `5c066357…afba00`,
  `dist/autopilot/unfinished-session-launcher.js` `3dba7d48…d5ca7`,
  `dist/adapters/opencode.js` `a10c4cf4…122498`, and
  `dist/adapters/zcode.js` `433cc9a7…d1fe7`.
- The published static UI is installed at
  `/var/www/agent-herder-ui/410a591fbc1e516cb0a098fcc4a60ba0a5411d2d`.
  Its Nginx source pin was committed to ServersAdministration as
  `48f2577321931a650f122690892260da1b9333f5` and applied via the documented
  site-scoped transaction. The repository's unrelated divergent checkout
  prevents its sync timer from fast-forwarding; do not reset/rebase that checkout.
  Public UI redirects to SSO; controls owns the local browser persistence/status
  check and this lead has stopped duplicate browser work.
- Current real consumer state is not yet a quota-recovery PASS. The earlier
  dedicated OpenCode `OK` reply proves ordinary native response only. Adapter
  peer has one precise bounded task for a new OpenCode canary: exact terminal
  quota proof, durable waiting across Herder restart, one fallback continuation,
  and live provider reply, without exhausting quota or touching old accepted
  sessions. No proof or trigger has yet been claimed for that new canary.
- ZCode remains pending user-requested manual cleanup or supported guard
  diagnosis: socket inode 385415 is not kernel-bound and DCG one-use remains
  unconsumed. No unlink, process kill, bypass, or ZCode prompt was sent here.
- Deployment scope verified so far: Agent Herder runtime on server-100 and its
  public static UI pin. No rollout to other fleet nodes is claimed; no separate
  Agent Herder runtime instance on another node has been established in this
  checkpoint. OpenCode's global plugin is absent from the running global plugin
  directory, and a global OpenCode restart is not safe while unrelated sessions
  are active.
- Elapsed since the 01:49 UTC checkpoint: 18 minutes wall time; active time
  inside that interval is unknown. Completed: source-pinned build/runtime
  identity, repaired scoped runtime overlay, Nginx site pin/apply, and exact
  OpenCode canary dispatch. Next 15-minute slice: receive the canary's durable
  queue/restart/native-reply evidence; record a concrete safe blocker if native
  terminal proof cannot be produced; then reconcile controls' browser result
  and ZCode's separately owned socket result without duplicating their work.

## Operator cohort enrollment checkpoint (2026-10-21 02:52 UTC)

- Direction now prioritizes OpenCode and the frozen 28-entry operator-approved
  failure cohort. Controls owns cohort inventory and its output canary; the
  engine, never a controller loop or agent, owns durable enrollment, fallback,
  native admission, and receipt reconciliation. No cohort entry has been
  staged or sent from this session.
- Added `POST /api/quota-recovery/operator-cohort/enroll` and
  `GET /api/human-stop/status`. Enrollment accepts a stable authorization ID
  and exact selected native terminal identity; it checks the fresh session,
  root OpenCode status, exact failed assistant/model/provider/completion,
  HumanStop, pending human input, existing launch-policy project route, and
  configured fallback. It sets only the selected session's independent
  `waitForQuota=true`; it does not change general Autocontinue `enabled`.
- Durable evidence is explicitly `operator_cohort`, never fabricated
  `quotaFailure`. The existing engine rechecks the exact native terminal
  snapshot, live project route/harness permission, configured ordered fallback,
  native catalog and HumanStop before claim, after model change, and immediately
  before send. Stable input IDs and accepted/UNKNOWN no-replay behavior remain
  the existing queue path. Retry after a definite pre-admission quota response
  advances only through still-configured candidates.
- Exact route evidence now identifies the supported OpenCode model ID as
  `omniroute/minimax-combo-m3.1`, mapped to OmniRoute wire model
  `minimax-combo-m3.1`. The launch-policy validator accepts this exact native
  model ID. This is independent of the aggregated MiniMax account quota; the
  Oct 25 plan-expiry claim remains operator-supplied and unverified. A prior
  successful `OK` response was an ordinary earlier prompt, not a quota recovery
  canary. The separate length-limited combo probe was not a successful reply.
- Focused verification: `npx vitest run tests/unfinished-session-launcher.test.ts
  tests/session-autostart-http.test.ts tests/automation-launch-policy.test.ts`
  passed (3 files, 58 tests); root TypeScript and `git diff --check` passed.
  Includes exact-identity enrollment, stale identity rejection, project policy
  gate, independent `enabled` setting, engine dispatch, and the product HTTP
  routes.
- Source remains uncommitted and undeployed. `src/web/server.ts` and several
  other paths still contain foreign WIP; no full-file commit/deploy is safe.
  Adapter's native snapshot/mapping source is also still local to its owner and
  not yet published. Existing deployed runtime is not claimed to contain this
  enrollment API. The historical accepted canary was not replayed; no new
  provider prompt was sent here.
- Progress since 02:07 UTC: about 45 minutes wall time; active time within that
  interval is not fully tracked. This implementation/test slice took about
  20 minutes. Next 15-minute slice: reconcile the adapter's published exact
  snapshot/mapping with this API, selectively publish only owned core hunks
  without absorbing dirty `src/web/server.ts` WIP, source-pin/build/deploy the
  combined candidate, then let Controls enroll its exact frozen ledger and
  verify the engine-owned reply/receipt. Do not stage a cohort before the
  published runtime contains the adapter contract and exact model mapping.
- 2026-10-21 03:02 UTC: Addressed Controls' restricted-project blocker in the
  existing project-launch policy seam. Operator cohort enrollment fails closed
  for TelegramAuto root/aliases, video_watching root, explicit route deny, or
  a route that excludes OpenCode. Controls reviewed this guard and passed. A
  later direct user clarification authorizes an exact per-session human cohort
  enrollment without a project route; the engine still requires the configured
  global ordered fallback, exact fresh terminal snapshot, HumanStop/admission
  checks, and the same durable receipt path. Ordinary launches and persistent
  project routes remain unchanged. Legacy full-document policy writes preserve
  explicit route deny. Focused backend run passed 3 files / 60 tests, and root
  TypeScript plus `git diff --check` passed. Restricted nine remain excluded;
  no resolved-leaf or child admission support is claimed for them.
- Sent Controls one scoped request to review only this guard and select one
  unrestricted entry from its existing frozen ledger; no rescan or enrollment
  was performed. Asked the adapter owner to publish its exact `nativeLastTurn`
  source delta before building the combined runtime. Both peer replies remain
  partial; work continues independently. Controls returned its first
  unrestricted ledger candidate. The live policy has no global OpenCode
  fallback; the user explicitly authorized a supported ETag-guarded policy
  PUT for the exact combo route, preserving all other settings. The candidate
  was not enrolled because it still requires a fresh `nativeLastTurn`
  projection and terminal identity recheck after deployment. The first ledger
  candidate remains the first exact-session trial. `src/web/server.ts` contains foreign
  WIP alongside the owned enrollment endpoint and must be published by
  path/hunk, never as a full-file change. The primary checkout has no
  `.agents/TEST_ACCESS.md`; no new test account or external credentials were
  used for the focused local checks.
- Progress since the 02:52 checkpoint: 14 minutes wall time tracked; active
  implementation/check time about 10 minutes. Next: finish the scoped review
  of no-route human-authorized enrollment, publish/build/deploy the combined
  source pin, configure only the exact OpenCode combo fallback through the
  ETag API, then read the first ledger session's current native projection and
  enroll only that session through Herder. Elapsed time before checkpoints
  remains unknown.
- 2026-10-21 03:17 UTC: Published source pin `cd0c3684d47983a4ec02abac3f18bae13d03271d`
  is on `origin/main`. A source-pinned core runtime overlay was built with
  provenance SHA256 `b524c2f28389b12fe9a186e98ef12d1c3f20bf2cb120598ee3c2061b51f82995`;
  six changed modules were overlaid while preserving `dist/index.js`, unrelated
  runtime modules, and the existing static UI release. The Herder user service
  restarted successfully (PID 2385028) and policy/session/HumanStop/wait APIs
  returned HTTP 200. Live `getSession` now exposes the exact candidate's
  `nativeLastTurn`, but exposed a status mapping mismatch: OpenCode's terminal
  native failure maps to `AgentSession.status="error"`, while enrollment had
  required `"idle"`. The owned admission check now permits that `"error"` only
  when the exact fresh native failed-turn evidence matches; the enrollment
  regression now uses the real status. Focused launcher tests pass 49/49 and
  root TypeScript passes. At this checkpoint the fix still needed publication
  and runtime overlay; no candidate had been enrolled and no new prompt sent.
- 2026-10-21 03:24 UTC: Published the terminal-status enrollment fix as
  `1153ba419f929b13d15947234c62532c760108ac`; `origin/main` matches. A
  source-pinned artifact with provenance SHA256
  `145a27301372676e4c7ec6fc97e39d0eac379f825266c2f048a3a52efbd4f0fb`
  deployed only `dist/autopilot/unfinished-session-launcher.js`; all other
  runtime modules and the previous static release were preserved. Service
  restart succeeded (PID 2426350). API reads for policy, exact session,
  HumanStop and wait returned HTTP 200. ETag PUT set only
  `fallbackModels.opencode=["omniroute/minimax-combo-m3.1"]`; readback showed
  all other policy fields unchanged.
- The first unrestricted entry was enrolled once through the product endpoint
  under `quota-cohort-20261021-opencode-01`; Herder persisted a waiting record
  with attempts=0 and changed the model to `omniroute/minimax-combo-m3.1`. No
  prompt was sent. After model change the exact session still reads status
  `error`, but `meta.nativeLastTurn` is absent, so the post-change exact fence
  correctly withheld dispatch. The latest safe Herder message projection still
  shows the exact user and failed assistant IDs; it omits native status frames,
  turnId, parentID and active-state details. Direct OpenCode GETs without auth
  return 401; no credential was inspected. The native transcript route returns
  422 for this adapter's JSON export format. Adapter worker received the exact
  mismatch and is inspecting its owned snapshot seam; this queue is not retried
  manually.
- OpenCode restricted descendant guard source was integrated and pushed as
  `e091499a6265679f4c34b64bbad4dd6e6816f4a4`, limited to three plugin/test
  paths. Focused guard/quota/protocol tests passed 36/36, plus root TypeScript
  and `node --check`. It has not been installed into or restarted in the global
  OpenCode runtime. Controls has been asked for an independent guard review and
  isolated V2 hook proof first.
- Progress since 03:17 UTC: about 7 minutes wall time, roughly 6 active. Next:
  receive and verify adapter's fresh native terminal readback after model
  change, reconcile the existing waiting claim without replay, observe one
  engine-owned successful response, then enroll the next unrestricted entry.
  Restricted nine remain excluded until Controls approves the guard. Do not
  restart global OpenCode or enroll another entry before these checks.
- 2026-10-21 03:27 UTC: Adapter accepted a bounded extension for
  `packages/agent-resume/src/harness/opencode/client.ts` and
  `tests/opencode-v2-protocol.test.ts`: retain the latest explicit failed
  terminal frame when a later status-only idle frame follows model selection,
  while rejecting later user/assistant records or conflicting terminal
  outcomes and keeping the original failed assistant/provider/model identity.
  No prompt or send is allowed in this fix. Controls reviewed guard commit
  `e091499` and returned REVISE: permission evaluate sees child Agent ID but
  may miss a parent-supplied model override; the mock only proves a thrown
  `session.model.request` callback, not zero provider HTTP. Controls is doing
  the already-authorized isolated OpenCode 2.0.31 local-stub proof with a safe
  ordinary-project control. Global plugin install/restart is held pending that
  proof. The first operator-cohort wait remains waiting/attempts=0; no response
  has been delivered and no further entries were enrolled.
- Authenticated native GET, using the service's existing protected OpenCode
  config inside a temporary read-only client process, resolved the adapter
  mystery. Session outcome remains `failed`; current native model is
  `omniroute/minimax-combo-m3.1`; `/session/active` has no entry. Descending
  messages are: status-only `model-switched` at 1792552783256; original
  `idle/outcome=failed` quota frame at 1792549118697; assistant
  `msg_15c40de46001ejIlGoK2JiYJ7c`, original model
  `minimax-coding-plan/MiniMax-M3.1-Flash`, completion 1792549118685; user
  `msg_15c40dcca001ueFTuK9EQED9NG`. There are no later user/assistant records
  and no native turnId/parentID fields. Adapter worker received these exact
  sanitized native fields; safe solution is to preserve the latest explicit
  failed terminal frame across a later nonterminal status-only frame while
  rejecting later conversation records or conflicting terminal outcomes.
- Credential handling correction: a bounded diagnostic accidentally rendered
  an unrelated environment property in its command output. Its value was not
  copied into source, task notes, or follow-up messages and was not used; treat
  it as exposed and replace it if active. No further `Environment` property
  dumps were run.
