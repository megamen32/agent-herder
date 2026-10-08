# Registered native Codex communication delivery — 2026-10-08

Owner: native Codex session 01a11b43-e944-7663-9ce8-d75df67c1167. Secondary to AutoFind deadline15:00; no AutoFind files, root status/ACK messages, machine/device use or new harness daemons.

## Actual route and red proof

Existing singleton agent-herder.service -> HTTP /mcp -> createAgentHerderMcpServer -> registerSessionTools -> handleDeliver / handleSendMessage / deliverNamedSession -> CodexAppServerAdapter -> shared existing Unix WebSocket. Every native ID remains unchanged. Root direct RPC bypass is a separate route; no claim that root generated all queue entries.

Default registered deliver passes queue=true. Native adapter previously excluded queue requests from current-turn steer, attempted thread/resume + turn/start, and handlers stored active-writer collisions in the hook inbox. Registered MCP regression reproduced TWO turn/start attempts for two identical deliveries into an active thread, zero steer. Red artifact: .tmp/communication-fix/red.log.

## Repair and exact safety semantics

Queue controls waiting, not active native admission. Active automated input uses turn/steer with fresh expectedTurnId. Only explicit -32600 pre-admission turn mismatch/no-active rejection authorizes one refreshed attempt or one idle start. Lost/ambiguous replies are nonRetryable and never fall back into deferred debt. Per-thread admission serialization releases before sync completion, allowing further immediate steer. Idle duplicate requests start once; distinct concurrent messages steer that new current turn.

Registered send_message, deliver (ID/named), new_or_resume carry inputId; omitted automated identity hashes original pre-injection input. Explicit human repeated input is not content-deduplicated. Private disk receipts store hashed identity and bounded outcome without message body, survive service/adapter reconnect, reserve intent before mutation, keep unknown outcome nonRetryable. Retry window24h/max2048 entries. Caller must use a fresh inputId for intentional new deliveries. Deferred activation remains intentionally non-waking and identical deferred input is deduplicated.

Live existing native rejected probe on OWN current thread confirmed exact error -32600: expected active turn id `<invalid>` but found `<actual>`. This exact installed-runtime wording is covered by the refresh predicate and fixture, not assumed from a wrapper. Official API contract: https://learn.chatgpt.com/docs/app-server#steer-an-active-turn.

## Verification budget

Fresh host/UID memory and I/O PSI below1%, UID full avg60 below3%, >=2GiB below actual UID MemoryHigh before focused checks. BOTH existing global/project flock paths. Finite verification scope RAM512MiB/1GiB, swap0, CPU1, Tasks128, IOWeight10, runtime120s/payload100s; one Vitest worker and one RollDown worker, Node heap512MiB. No quotas raised, GPU/downloads/containers/provider suite. Build uses existing budget1/2GiB, swap0, CPU1, Tasks128, heap1GiB, wall120s and both locks. Outputs under project .tmp / ignored linked build worktree.

## Evidence and remaining delivery gates

111 final focused checks passed across registered-codex-delivery, codex-app-server, deferred-messages, named-session, mcp-definitions human-stop-integration and unfinished-session-launcher. Final artifact .tmp/communication-fix/green-final.log (7 files, 31.16s). Fixtures cover duplicate active admission, exact race refresh, missing receipt, persistence across adapter replacement, idle duplicate/distinct admission, registered named and send_message routes. Generated isolated fixture inbox rows from the original red reproduction were consumed through existing runtime context API; no foreign queued messages are removed or replayed.

Pending: exact committed revision build, push and singleton-only deployment; own same-native-thread/current-turn registered HTTP canary, published main reconciliation. Foreign WIP initially src/adapters/zcode-protocol.ts, src/workload-launcher.ts and tests/workload-launcher.test.ts, later docs/autopilot.md. Preserve all. Main clean invariant is blocked until their owner commits or explicitly defers them; do not reset/stash/copy/publish foreign edits. Existing12 historical inbox rows for two unrelated targets are preserved; do not inject old coordination into deadline root or silently discard it.


## Safe runtime deployment blocker (current evidence)

2026-10-08 live Herder PID763536 owns stdio ZCode SDK/native PID763762 in agent-herder-zcode-app-server-8740a059.scope. Parent death/stdio close is not a documented supported handoff. Current docs/autopilot.md explicitly records missing complete loaded-session/generation/queue diagnostic coverage and unavailable independent native controller. Restart admission stays held. A Herder restart can disconnect the shared ZCode owner; no group is restarted, killed, detached or migrated here. No supported hot-load registered-route API exists in the existing contour. Changing only dist files is not proof of replacing already-imported handlers or schema.

Smallest next action: owner provides a safe native handoff/idle window with complete generation/queue proof, or selects a reviewed supported in-process route reload. Then install the exact built published revision, transition only Herder, and run the registered HTTP current-turn canary without changing native thread ID. Direct Codex RPC alone cannot claim the old HTTP registered route is fixed.

The existing unrelated compiler defect from commit4dad57b passed optional record.title to required AgentSession.title during recovery admission. One-line fallback to native sessionId fixes the type without changing admission authority. NoEmit TypeScript passed after this repair.

Foreign owner published1873cd5 and cleaned its ZCode/workload/autopilot WIP during this cycle. No foreign edits were included in our commit. Own red fixture2 inbox rows were consumed via existing context API with harness=opencode (avoids initializing/scanning a nonexistent native Codex thread); historical12 entries remain unchanged.

Final reviewed source includes cleanup of unknown-admission deferred batches: timeout cannot replay the old batch in a different later input. Explicit native rejection retains undelivered context. Final TypeScript NoEmit passed. Publication/build/live candidate receipts follow.
