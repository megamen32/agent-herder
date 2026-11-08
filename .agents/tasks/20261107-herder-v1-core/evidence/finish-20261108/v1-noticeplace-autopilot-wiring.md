# Lorentz: concrete V1 autopilot constructor contract

Source: `src/automation/v1-noticeplace-autopilot.ts`; exported class `V1NoticePlaceAutopilot`, exported types `V1NoticePlaceAutopilotPorts`, `V1AutopilotRustPort`, `V1AutopilotSessionRow`, `V1AutopilotSnapshot`, `V1Completion`, `V1AutopilotArm`. Own runtime/facade is Lorentz; this module creates no HTTP server, adapter, discovery poller or native writer.

```ts
const autopilot = new V1NoticePlaceAutopilot({
  store, // existing AutopilotSessionStore(sharedStateDir + '/sessions.json')
  jobs,  // existing HerderJobRegistry WITH persistencePath; one runtime owner
  stateDir: sharedStateDir,
  rust: {
    listSessions, // existing shared Rust sessions(list): return result.sessions
    snapshot,     // fresh authoritative Rust read, schema below; unavailable -> throw
    deliver,      // existing shared Rust deliver only, deterministic requestKey
  },
  registerCompletion: async (sessionRef, callback) => ({ isActive, close }),
  createJudge: ({provider, model}) => existingConfiguredJudge,
  core: { notify, incidentUpdates, pendingQuestions, humanRequests,
          deliverHumanQuestion, choiceRegistry, notification, maxContinuationsPerSession },
});
await autopilot.restore(); // re-register existing enabled native store rows once after stream ready
// PUT /api/autopilot/sessions/opencode/:sessionRef
await autopilot.arm({sessionRef, enabled, noticeIncident, noticeAttempt});
// GET same path
await autopilot.get(sessionRef);
```

`listSessions()` output rows: `{session_ref, address:{native_session_id,...}, native:{harness:'opencode',cwd}}`. Do not synthesize native id from sessionRef; no guessed launch cwd. Missing/ambiguous native observation throws. Store keys use original exact native id (`harness:'opencode',sessionId:nativeId`), preserving existing NoticePlace/runner store consumers. HTTP result `sessionId` remains requested Rust sessionRef for NoticePlace verification; `nativeSessionId` is explicit separately.

`snapshot(sessionRef)` returns `{sessionRef,nativeSessionId,cwd,status,humanStopHeld,turnId,revision,model,messages:[{role,text?}]}`. Model must be `minimax-coding-plan/MiniMax-M3.1-Flash`. `revision` is stable content/turn fingerprint, not wall clock; reads before/after judge must compare equal when nothing changed. `turnId` is actual native completion event id. `humanStopHeld` must be authoritative; do not invent false on unavailable state. `status` must be fresh Rust/native read. All session/messages/status data comes through shared Rust, not adapter snapshots/stale cache. Rust callback replay can be dropped after durable job admission, not reissued after UNKNOWN.

`deliver({sessionRef,nativeSessionId,message,requestKey,model,expectedRevision,turnId})` maps to the existing Rust delivery operation. Revalidate expected native binding/turn/revision on the application boundary; Rust admission must preserve HumanStop independently. No fallback direct adapter send/resume or agent-resume. Module performs a fresh snapshot/binding/STOP check immediately before this call. Its job is durableOnce, so interrupted/UNKNOWN delivery is never rerun for the same native event.

`registerCompletion(ref, callback)` must **actually attach** an existing stream listener and return a live `isActive()`/`close()` registration; failure/inactive stream must not return true. Native stream: explicitly authorized `OpenCodeAdapter.subscribeEvents(onEvent)` READONLY source (`src/adapters/opencode.ts:844`, production OpenCode base4095 per owner). Filter only `turn.completed`, use exact `event.sessionId`, stable `event.data.nativeEventId`, and the authorized Rust list mapping to select ref; call `await callback({sessionRef,nativeSessionId,turnId})`. Never use `Date.now()` as completion identity; no eventsfalse AHAP polling workaround. `isActive` must reflect runtime shutdown/disconnection; close detaches this binding. Arm refuses to advertise armed without this registration. Registration emits no create/send.

Judge port reuses existing `createOpenAICompatibleJudge`/configured subscription route; receives `{provider:'minimax-coding-plan',model:'MiniMax-M3.1-Flash'}`. Supply the correct existing configured route, never OmniRoute/auto fallback or credentials in evidence. Module reuses `createAutopilotCore` for semantic decisions, original incident update outbox, pending question gate and continuation budget. Existing project-scoped incident sink and pending question/human request ports belong in core options; no generic notification fallback should substitute the original incident.

No live wiring/deploy claimed here. Offline acceptance in `tests/v1-noticeplace-autopilot.test.ts`: actual registered callback -> existing semantic core -> exactly one Rust deliver; durable store binding/attempt; duplicate/restart no resend; STOP/disable/history/native binding/new attempt fences; missing callback cannot arm; unknown delivery cannot replay. Integrator owns HTTP status/envelope/error translation and production callback lifecycle.

Verification 08.11, final slice: `./node_modules/.bin/vitest run --config vitest.config.ts tests/v1-noticeplace-autopilot.test.ts tests/autopilot-notice-incident.test.ts` -> **2 files, 24 tests PASS** (15 new, 9 existing). New suite initially RED because implementation module absent, then GREEN after implementation; no prior live regression is claimed. New negative cases also cover callback disconnect, a newly pending human question during judging, concurrent duplicate callbacks, nonpersistent job registry and original-incident terminal verdict. `./node_modules/.bin/tsc --noEmit --pretty false` -> exit0. Whitespace checks of new source/tests/this report -> PASS. No runtime/browser/model/network operations, token rotation, old daemon, commit/push. Changed source scope: only the two newly assigned source/test files; evidence is this explicit wiring handoff.

Review limits: this is a runnable application port, not a deployed restored NoticePlace service. Lorentz must supply real fresh Rust snapshot/STOP and event lifecycle ports and connect PUT/GET; neither store-only enable nor an inactive stream is reported as armed. The typed `core.incidentUpdates` and `core.pendingQuestions` ports are required (also checked at arm), so generic notifications or missing pending-question state cannot silently substitute the existing incident runtime. Event admission is durable before evaluation; failed/interrupted/UNKNOWN events remain pinned and are never automatically reissued. No inferred no-effect retry is introduced.
