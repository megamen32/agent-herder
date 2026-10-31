# Native questions → Notice Place: coherent WIP handoff

Owner moved this scope into a new native Codex session. Reboot recovery Root must not deploy this question WIP accidentally. No live question delivery, native answer, configuration edit or runtime restart was performed by this worker.

## Root runtime ownership and immediate build boundary

Native successor: `01a18444-4ce2-70d2-a7f0-65e9fe1cbbef`. Root `01a1754f-0228-7553-bea6-cc89e40b5187` remains the sole next restart100 executor. Its cold recovery adapter/launcher/tests are ready and actual native proof identifies five eligible interrupted sessions, one pending question, two already running. Root manually resumed zero sessions.

The two tracked question-WIP files below are compiler inputs and currently prevent an exact clean-source canonical release for recovery. Successor should first settle its own coherent preparatory slice through scoped commit/main if reviewed and compatible, preserving all root edits. An inert helper may travel in the shared release without claiming that Telegram question forwarding is installed or accepted. Do not wait for unrelated whole question feature completion to publish compatible preparation. Keep further edits outside the shared compiler inputs during the short announced recovery build. Root must not stage/revert question paths or copy their WIP into its release silently.

## Owned paths preserved in the shared canonical main checkout

- `src/human-request/native-user-input-notice.ts` (new, not wired): observer + typed context + canonical sibling answer collector.
- `tests/native-user-input-notice.test.ts` (new): four focused fixture tests; all four passed.
- `src/human-request/notice-question.ts`: exact Telegram receipt checks now compare the binding's own mode/choices instead of hard-coded permission allow/deny. Existing permission shape still checks exactly.
- `src/permission-control/notice-bridge.ts`: export existing safeVisibleText redactor; initial permission reconciliation includes needs_input sessions whose needsPermission flag was missing.

No commit/push/install was made. Do not overwrite unrelated adapter/supervisor/index/web-server WIP.

## Proven cause and live context

Existing observer accepts permission.requested only and enumerates getPermissionState. Native Codex item/tool/requestUserInput was not retained in a dedicated pending map or forwarded as a typed Notice question. AgentMessage.questions or a question mark in text does not prove a live actionable RPC.

Root identified Airlock `01a182ff-be14-7171-9b7d-a4965f7363cd` as a real waiting native question. Re-read exact current native state before acting: no historical prompt replay. The adapter worker has NOT implemented pending-map/read/respond yet; see its separate adapter-question-handoff.md. Do not wire calls assuming those methods already exist.

Notice Place existing producer is configured at `http://127.0.0.1:8091/v1/human-requests`, project `agent-herder`, recipient `me` (Root readback; no credential in this document). Local GET `/v1/instructions` succeeded and returned noticeplace.instructions.v1. Public HTTPS instructions failed in context-mode with connection refused; that did not prove the local Notice API was unavailable. Communications architecture and Notice Place skill were read. Use Herder → Notice Place → UserIO only, no direct Telegram API/new bot, no test calls to humans.

## Agreed adapter contract (not implemented yet)

`readNativeUserInputState(sessionId)` returns target `{hostId,harness:'codex',sessionId}`, pendingRequests `[{id,requestId,threadId,turnId,itemId,canRespond,questions:[{id,header,question,options:null|[{label,description}],isSecret,isOther}],isBlocking}]`, observedAt, coldRestoreSupported:false.

`respondNativeUserInput(sessionId, requestId, answers:Record<questionId,{answers:string[]}>)` returns ControlResult and writes exact native server RPC response. Never permission accept or turn/resume. Bind to RPC connection generation; after an ambiguous write, UNKNOWN/no replay. Event: message.updated + nativeType item/tool/requestUserInput; data contains requestId/turnId/itemId/questions/isBlocking. Resolution event nativeType serverRequest/resolved, data userInput:true.

## Helper exports implemented

- `createNativeUserInputNoticeObserver(registry, dependencies)` returns onEvent(adapter,event), reconcileInitialSnapshot(adapter,sessions). Uses exact adapter state/fresh session, one card per nativeRequestId + questionId. Registry write-ahead Notice claim persists accepted/UNKNOWN and prevents duplicate posts across observer restarts. Secret questions are skipped, never copied to Telegram.
- `hasNativeUserInputContextRef`, `parseNativeUserInputContextRef`, `nativeUserInputContextRef` encode only exact native routing identity.
- `collectCanonicalNativeUserInputAnswers(registry, pendingRecord, adapter, dependencies)` returns null while a sibling canonical answer is unavailable; otherwise `{target, answers, siblings:[{record,resultRef}], carrier}`. Carrier is deterministic first sorted questionId. Choice IDs option_N map to original native option labels. No native method is invoked by the helper; callback text is not treated as the answer.

## Remaining integration and acceptance

1. Implement adapter pending-map/read/respond with generation fences, strict exact IDs and no fake cold acceptance. Fresh source/transport evidence is required after reboot; old RPC may not exist.
2. Wire a composite observer (permission + native input) into existing supervisor poll/events. No second scheduler. Root had agreed ownership of index.ts/session-supervisor.ts/web/server.ts, but the new session must now coordinate that ownership explicitly.
3. Extend existing completion callback before generic human resume: collect all canonical sibling answers, admit only deterministic carrier once, respond exact native RPC, then close sibling registry fences with receipts. Never auto-select, auto-approve or use a synthetic ordinary prompt for a live native RPC. Add stale/duplicate callback and UNKNOWN failure checks.
4. Guard manual MCP resolution from bypassing typed canonical native-answer routing (same principle as permissions).
5. For secrets reuse the protected SSS channel; this WIP intentionally does not deliver secret content or implement a new secret route. No secrets observed in the actual cohort.
6. Publish/install through the single approved installer and prove one actual owner-authorized question card and answer in the same native session. Live configured owner Telegram is allowed for real questions; synthetic tests use canonical isolated QA only. Do not repeat accepted/UNKNOWN cards.

## Checks at handoff

- `npx tsc --noEmit --pretty false`: PASS.
- `git diff --check` for the four owned paths: PASS.
- `npx vitest run tests/native-user-input-notice.test.ts tests/permission-control-notice.test.ts --reporter=dot`: 15 passed / 1 failed. All four new native-user-input fixture tests passed. Existing permission test `fails closed on an ID-less permission event and freezes an ambiguous Notice POST as unknown` failed in afterEach cleanup with ENOTEMPTY on its own `/tmp/agent-herder-permission-auto-unknown-*` directory; assertions were not the reported failure. Do not describe the combined run as green. No rerun after owner moved scope.
- Tests exercised fixture Notice delivery only. No live card/answer/native response acceptance is claimed.
