# Native Codex user-input seam — handoff only

Owner moved NativeUserInput→Notice/Telegram into a separate native session. NO pending-map/userInput method/test code was added by this worker. Root reboot release contains only the separate latest-turn read-only helper. New adapter writer must coordinate ownership after that helper is integrated; do not duplicate or overwrite it.

## Verified pinned native contract

Source `.tmp/permission-control-codex-schema-20261025/ServerRequest.ts` lists `item/tool/requestUserInput`; v2/ToolRequestUserInputParams.ts: `{threadId,turnId,itemId,questions,isBlocking,autoResolutionMs}`. RequestId is number|string. Question: `{id,header,question,isOther,isSecret,options:null|[{label,description}]}`. Response must be the response to the SAME native RPC request: `{id:rpcId,result:{answers:{[questionId]:{answers:string[]}}}}`, not turn/start, turn/resume, a new user message or permission allow/deny. Native completion notification `serverRequest/resolved` has `{threadId,requestId}`.

Current CodexAppServerAdapter.handleServerRequest only tracks approvalMethods. No existing userInput queue is available. It needs its own map tied to connection transportGeneration, exact session/turn/item and original native rpcId. Keep no-replay tombstone after a write with UNKNOWN confirmation. Disconnect/generation change must invalidate ownership and resolve outstanding confirmation waiters without replay. A request observed on a different client cannot be answered by treating historical transcript metadata as current RPC ownership.

## Proposed API agreed with bridge worker

`readNativeUserInputState(sessionId)` -> `{target:{hostId,harness:'codex',sessionId},pendingRequests:[{id,requestId,threadId,turnId,itemId,canRespond,questions,isBlocking}],observedAt,coldRestoreSupported:false}` (null/unavailable on connection failure). Exact questions remain native shaped. `respondNativeUserInput(sessionId,requestId,answers:Record<questionId,{answers:string[]}>)` -> ControlResult. Reject foreign session, foreign turn, stale transport generation, resolved/already-written requests, malformed/incomplete question sets and unavailable current-turn proof. Re-read latest turn via limit1 desc notLoaded before writing; after await recheck map identity/generation/writability. No reconnect during response to an old request.

Use existing HarnessEvent `kind:'message.updated'`, `nativeType:'item/tool/requestUserInput'`, `status:'needs_input'`, `data:{requestId,turnId,itemId,questions,isBlocking}`. Resolution: message.updated/nativeType serverRequest/resolved with data requestId/userInput. This separates question handling from permission.requested/allow-deny. Root owns supervisor/index wiring; bridge worker owns one Notice card per questionId and gathers all sibling answers before a single native response. Secret questions require the existing secure secret path, not plaintext Notice card answers.

## Cold restore limit — do not hide it

Pinned ClientRequest schema has NO pending-server-request list/replay API. A new connection can enumerate only requests it has actually received, not another client's blocked requests. Empty pendingRequests is NOT proof there are no cold native questions. Return coldRestoreSupported:false and preserve unknown status; do not attach/resume a user thread solely to capture question ownership. Any supported replay/attachment seam must be independently verified and explicitly integrated before claiming full cold question restoration.

`thread/turns/list itemsView:'summary'` can contain agentMessage.questions, but AsyncUserInputQuestion has only title/options (no questionId, requestId or pending status). That is conservative recovery exclusion evidence, not enough to send a native RPC answer. Actual Airlock summary shows this marker; never synthesize a pending request ID from it.

## Needed focused RED → GREEN cases

Exact multiquestion request received→snapshot and one typed event; duplicate inbound request does not duplicate Notice admission; collecting all canonical question answers→one exact native RPC response; foreign session/current-turn mismatch rejected; native resolved removes pending; native response timeout/disconnect becomes UNKNOWN and is not replayed; reconnect does not resurrect ownership; no native start/resume/permission reply used. No tests or implementation for this seam have run yet.
