# Delivery and lifecycle follow-up — 2026-10-26

## Current source boundary

- Root reviewed and accepted the observer/fleet source delta. `npm run build:core` and `npx tsc --noEmit` now pass. Root is running the joined targeted suite and preparing the source commit/release; installed proof is pending the exact installed SHA.
- No native messages, queue actions, approvals, or accepted inputs were replayed in this follow-up.
- Observer recovery binds to the exact admitted OpenCode native user message ID and requires the latest page to contain that unique input, an immediately paired terminal assistant result, and stable idle reads. Whole-history completeness is not inferred from visible message count.

## L18 — exact native search and host routing

- The user's native Codex thread `01a134e4-c26e-7ae0-900c-f9be106dbc98` was found on `MacBook-Pro-User.local`, title «Собрать отток подписчиков каналов». Its native final answer contains the requested five-channel / 149–158-view / quiet-hours material. This is a positive historical hit, not a claim that the current monitoring is operating.
- Exact local native search on that host returned the matching message `msg_081a6d7a9254645f016adeaa6783f087d2886ff60e1c52d801` in 1.30s and 1.17s. Mac Codex index coverage was partial, so a negative result would not prove absence.
- A server-100 lookup had previously collapsed a missing local session into `fleet_session_identity_mismatch`. The source fix distinguishes `native_session_not_found` from identity mismatch and an unavailable/unconfigured host. Explicit host routing is read-only; mutation peer filtering is retained. Focused fleet tests passed as part of the 88-test run.
- The live MCP semantic leg was measured at 12.816s (exact 351ms; end-to-end MCP 18.017s); exact returned zero and semantic results were irrelevant. Root owns the RAG mode/coverage work. Installed search acceptance for the source changes is pending root's release SHA and read-only consumer rerun.

## L25 — delivery

- One isolated agent-originated input was accepted through OpenCode using provider/model `minimax-coding-plan/MiniMax-M3.1-Flash`: input `hf26-mm-opencode-02`, native user message `msg_175d4bc260014nhhj9oID7Z2T9`, job `job_f6e6788b9341c528d23040ff099cb6ae52f2edda66a15602b8721272d1529cbb`, session `ses_e8a2b8cb8ffeqr55gdaMUqw5Zk`.
- Independent OpenCode native history showed assistant `msg_175d4bc8e001c5J6z5F4b4L16w`, `finish=stop`, visible output `HF26_MINIMAX_OK` (15 characters), no tools, then terminal `outcome=succeeded` and session `idle`. The input was durably admitted once. The first steer attempt explicitly returned `not_attempted`; it admitted no native input.
- This proves an OpenCode-hosted MiniMax-provider response. It does **not** prove the separate native `minimax-code` harness. Do not count this as native MiniMax Code acceptance.
- Initial Herder observation was `unknown/baseline_unavailable`. After release, read the existing response resource only (no resend):

```js
const uri = "herder://delivery-responses/roomhacker-server-100/opencode/ses_e8a2b8cb8ffeqr55gdaMUqw5Zk/job_f6e6788b9341c528d23040ff099cb6ae52f2edda66a15602b8721272d1529cbb/hf26-mm-opencode-02";
const reads = [];
for (let attempt = 0; attempt < 2; attempt++) {
  const response = await client.readResource({ uri }); // already-connected MCP SDK Client
  const entry = response.contents?.find((item) => item.uri === uri && typeof item.text === "string");
  if (!entry) throw new Error("exact response resource missing");
  const value = JSON.parse(entry.text);
  reads.push({
    jobId: value.jobId,
    inputId: value.inputId,
    target: value.target,
    status: value.status,
    reason: value.reason,
    correlation: value.correlation,
    text: value.text,
    totalTextLength: value.totalTextLength,
    responseSha256: value.responseSha256,
    baselineCoverage: value.baselineCoverage,
  });
}
if (JSON.stringify(reads[0]) !== JSON.stringify(reads[1])) throw new Error("response changed between read-only reads");
console.log(JSON.stringify(reads[0]));
```

Expected consumer binding is the exact job/input/host/harness/session above, with visible text `HF26_MINIMAX_OK` and a completed response. Record the actual returned status/hash; do not treat this expectation as an installed result until the read succeeds.

## L26 — ZCode queue lifecycle

- No completed native ZCode recovery result is claimed. The separately authorized isolated fixture could not be created because ZCode requires an exact registered project mapping for the requested CWD; the attempted fixture was not registered or retried. This is the concrete current blocker for a fresh, isolated queue-to-final-answer canary.
- Existing historical queue evidence ends at admission/native turn start followed by provider/network failure and a native retry. It does not prove final assistant output or task completion. Do not replay the old queue head.

## L28 — historical empty OpenCode result

- The exact historical session was read without sending or resuming: `ses_e8ab75780ffeqDhM84IXxDabXN`. The available native history currently contains eight assistant `finish=stop` records and all have non-empty visible text; the alleged original empty terminal cannot be located in the available history snapshot. Treat the exact historical empty proof as unobservable/unavailable, not confirmed or refuted, and do not replay the already-accepted Notice Place action or session input.
- The source observer now has an exact native-input fallback and explicit empty-terminal status handling, but that does not substitute for the unavailable historical consumer receipt. Installed proof remains pending release/readback.

## Current leaf state

- L18: exact historical hit and source diagnostics are established; installed search consumer rerun remains pending.
- L25: one OpenCode/MiniMax-provider canary is accepted and its read-only response-resource consumer read remains pending; native `minimax-code` acceptance is not established.
- L26: final ZCode queue completion remains unproven; isolated fixture blocked by missing exact project mapping.
- L28: exact old empty terminal remains unavailable in the current native history; no replay.

## Delivery follow-up checkpoint — 2026-10-26 03:03 UTC

### Installed OpenCode response resource

- Read the already accepted resource for `hf26-mm-opencode-02` twice via the local Herder MCP SDK after the `16f73e161ddfaa1ef50b0b5bfaa5f1c4536ebc9e` install; the two returned objects were identical. Binding: job `job_f6e6788b9341c528d23040ff099cb6ae52f2edda66a15602b8721272d1529cbb`, host `roomhacker-server-100`, harness `opencode`, session `ses_e8a2b8cb8ffeqr55gdaMUqw5Zk`, status `completed`, text `HF26_MINIMAX_OK` (15 characters). No send or replay occurred. The earlier native OpenCode history read independently confirms its terminal assistant result.

### ZCode native project root and empty-history defect

- Official ZCode `project.readTree` returned TelegramAuto's existing root with a trailing slash. Herder had compared that raw string to `resolve(cwd)` and reported zero matches. The adapter now strips only trailing separators for this comparison; `/` remains `/`, and symlink resolution is unchanged. The new focused regression failed before the fix and passes afterwards.
- For a truly empty native history, a successful exact-session SQLite read used to return `null` because zero message rows were conflated with an unavailable DB/query. A new ZCode-only optional history-page method now returns `{sessionId,source:"native-db",messages:[],complete:true}` only after confirming the exact session row and successful bounded query; it uses `limit+1` to mark truncated pages incomplete and returns `null` for missing/unavailable reads. The delivery baseline and observer consume this explicit page coverage; other adapters retain their incomplete-history behavior.
- Focused RED was `npx vitest run tests/zcode-adapter.test.ts -t 'distinguishes a complete empty native history from an unavailable read'` (failed before the implementation). Focused GREEN suite: `npx vitest run tests/zcode-adapter.test.ts tests/user-message-delivery.test.ts tests/session-tools-delivery-response.test.ts` — 135/135 passed. `npx tsc --noEmit` exited 0.
- Earlier ZCode input `hf26-zc-delivery-01` was admitted once into `session_6da91078-f379-462f-971d-57a3f9337873`; native SQLite joined user message `msg_mvonl7yd_f4c2c1f6-fdd4-49d3-a0ac-fed3255186ca` to completed turn `turn_0c65133e-f532-4a59-9f05-58fef8848956`, then assistant message `msg_mvonlao8_e64c0f56-5c32-4e26-8114-17a098d1d71e` with `finish=stop`, exact `HF26_ZCODE_DELIVERY_OK`, zero tools, and session outcome `completed`. Its existing Herder response resource remains `unknown/baseline_unavailable`; it was read-only and never retried. Root requested a separate cold-start input after this source fix, so this historical input is not used as that acceptance.
- Native ZCode project root `herder` is `/home/roomhacker/agents-projects/agent-herder` (native project id `5745bfc9-27df-48f4-b220-770dcc09065b`). The TelegramAuto registered root `/home/roomhacker/PycharmProjects/TelegramAuto/` can now match a cwd without the final slash. No native project catalog row was changed.

### Native MiniMax Code delivery

- A bounded native `mcode exec` seed created session `mvs_5c7c9dfefeef4080a988c9dc9cc9f434` in `/home/roomhacker/agents-projects/agent-herder`. The CLI receipt reported provider `minimax`, model `MiniMax-M3.1-Flash`, exact `HF26_MCODE_NATIVE_OK`, one model request, and zero tool calls. Read-only runtime DB confirmed the session's exact workspace, `runtime=pi-agent`, `status=idle`, `archived=0`, with no active turn lease.
- One separate authenticated agent-originated delivery used input `hf26-mcode-agent-delivery-01` from Codex session `01a17599-2b1b-78d1-b33a-b31f8e08dc2d`. Herder job `job_a7f4220bea05d94847c3ba34e9388136b04cc9f5165ba3ab6b1492f9ce4a24e0` is durably completed/admitted with turn `turn_mvonxe4e_27y3pb`. Independent native runtime DB evidence: ingress status completed; user message `msg-user-v1-yl2QN7W_3QTb4krEfBw9v8Kju-oaZjhZuOYBNoWYDj0` for this exact turn contains the unique input ID; assistant message `eb36b2c6-0731-4fa0-8753-b0a71d03f95a` on the same turn finished with `stop`, exact `HF26_MCODE_AGENT_OK` (19 characters), zero tools. Session returned idle.
- The response resource was read twice without resend and remained stable with `correlation=reply_to`, exact text and turn ID. It reports `status=partial` and `baselineCoverage=partial`; native terminal evidence above proves the answer completed, while this response-resource status remains partial.

### Remaining integration work

- Root must review and include the eight owned source/test paths in the new joined release, then verify the installed source/runtime SHA.
- After that install, run the separately authorized new cold-start ZCode fixture/input with a fresh stable ID and record the new consumer receipt; do not reuse `hf26-zc-delivery-01`.
- Keep the OpenCode MiniMax-provider result separate from the native MiniMax Code route. Do not replay any of the accepted inputs in this file.

### Native completion observer follow-up — 2026-10-26 06:15 UTC

- Added a fail-closed native MiniMax Code terminal proof to the read-only adapter projection. It requires the exact latest session ingress and agent-state rows to agree on one completed turn, the latest user row and final assistant row to carry that same turn, assistant `finish_reason=stop`, an idle unarchived `pi-agent` session, and no active turn lease. Newer ingress, interrupted/nonterminal state, missing rows/schema, parse failure, or non-stop assistant finish omits `nativeLastTurn`.
- Focused tests cover the positive proof, cache invalidation after a newer ingress, interrupted ingress, nonterminal agent state, and `finish_reason=length`. `npx vitest run tests/minimax-code-adapter.test.ts` passed 31/31; `npx tsc --noEmit` passed.
- Source readback of the already accepted native MCode job (no send/replay) now returns idle plus `nativeLastTurn={turnId:"turn_mvonxe4e_27y3pb",status:"completed",completedAt:"2026-10-26T02:54:30.803Z",source:"native_runtime_terminal_turn"}` for exact session `mvs_5c7c9dfefeef4080a988c9dc9cc9f434`. This confirms the local adapter's proof against current native SQLite, not an installed consumer result. Root must join/release/install these additional source paths before the existing response resource can be read again for acceptance.
- ZCode native history page now holds one SQLite read transaction across exact session lookup, limit+1 message coverage and selected message parts. It commits both the true-empty and nonempty page paths and rolls back on missing session/schema/query failures; the focused empty-history case, including invalid schema, passed.

### Installed completion response and new ZCode queue capability check — 2026-10-26 07:20 UTC

- After canonical installer success for `683456df67b67c939b37ff9fab4fdf76c3f430df`, read the exact existing native MiniMax Code response URI twice with the local read-only MCP SDK. Both reads are identical and `completed`: job `job_a7f4220bea05d94847c3ba34e9388136b04cc9f5165ba3ab6b1492f9ce4a24e0`, input `hf26-mcode-agent-delivery-01`, target `roomhacker-server-100/minimax-code/mvs_5c7c9dfefeef4080a988c9dc9cc9f434`, turn `turn_mvonxe4e_27y3pb`, correlation `reply_to`, exact text `HF26_MCODE_AGENT_OK` (19 characters), SHA-256 `6fbd547ec372fe5f5416faac6e307fbeb8974d031d979647a690e720dce1d96c`. `baselineCoverage=partial` remains visible. No send/replay occurred. Receipt: `.tmp/hf-delivery26/installed-readback/mcode-response-receipt.json`.
- Installed `agent_info` readback of the same native MCode session independently exposes `nativeLastTurn={turnId:"turn_mvonxe4e_27y3pb",status:"completed",completedAt:"2026-10-26T02:54:30.803Z",source:"native_runtime_terminal_turn"}`, with session idle, exact provider/model `minimax/MiniMax-M3.1-Flash`, and last message `HF26_MCODE_AGENT_OK`.
- Created one distinct empty ZCode fixture via the registered `herder` project: native session `session_529567ea-c12d-457c-97df-846229bf96e4`, host `roomhacker-server-100`, exact cwd `/home/roomhacker/agents-projects/agent-herder`, catalog default `account:zai-individual-coding-plan/GLM-5.3-Flash$high`. Exact agent readback: idle, nativeLoaded, zero human messages, no pending request or tool. This is only a fixture setup receipt, not a delivered canary.
- The fresh fixture received one short seed through ordinary Herder using stable input `hf26-zc-queue-seed-20261026-01`; the accepted job's exact response URI was read twice, but stayed `unknown/baseline_unavailable` with no response text. Native events link the exact input to a completed turn, `turn_334e5c7e-95a4-44dc-8321-16bf48b23b51`; sanitized event projection reports success but not the expected token. The native DB has one `input_history` prompt, a completed turn with `model_request_count=0`, and no native user/assistant message or model usage. No retry was made. Receipt: `.tmp/hf-delivery26/installed-readback/zcode-seed-response-receipt.json`; sanitized events: `.tmp/hf-delivery26/installed-readback/zcode-seed-events.json`.
- On that owned fixture only, official existing-native V4 `setAutoDrain(false)` was query-first and acknowledged under stable command `hf26-zc-queue-pause-20261026-01`; exact readback showed `autoDrain=false`, revision 22, `pendingCount=0`, native phase `completedSuccess`, and unchanged owner process/generation. Receipt: `.tmp/hf-delivery26/installed-readback/zcode-pause-receipt.json`.
- Then one distinct queue canary (`hf26-zc-queue-input-20261026-01`) was submitted once via installed Herder. The installed adapter payload was `sendText` with `payload.requestedDelivery="queue"`; the pinned ZCode 3.16.3 V4 schema accepts this exact field and enum (`~/.zcode/server/zcode-server.cjs:204919–204925`; installed `@zcode/shared/src/zcode-protocol-v4/command.ts:92–102`). Gateway parsing preserves and forwards the sendText envelope (`~/.zcode/server/zcode-server.cjs:219206–219243`). Despite this, native ACK/persisted receipt admitted `delivery="startNow"`; Herder safely returned a terminal non-retryable mismatch and did not replay. Native DB records `session_input.delivery=startNow`; its turn `turn_2cf01363-a2d3-4705-9996-b6bdb57b656c` completed with `model_request_count=0`. Queue readback remains `autoDrain=false`, revision 42, pending 0, nativeState `completedSuccess`, `canResume=false`; no resume was issued because there is no queued item. Receipt: `.tmp/hf-delivery26/installed-readback/zcode-queue-response-receipt.json`.
- The Herder mapping matches the installed V4 schema; no adapter field-name/nesting defect was found. The installed contract comments say admission mode is adjudicated from native `inputRouting`; the observed downgrade happened after the correctly formed Herder envelope. L26 remains open because the supported native path did not preserve the requested queue mode and yielded no queued item or final model answer. Both exact inputs remain no-replay.
- Bounded native routing readback via the official existing ZCode WebSocket/V4 conversation snapshot, after the single admitted queue canary: `phase=completedSuccess`, `autoDrain=false`, `queue.items.length=0`, `inputRouting={mode:"startNow"}`, revision 42, seq 56. SQLite's exact persisted `session_input` intent shows `requestedDelivery=startNow`, `admittedDelivery=startNow`, and no `fallbackReasonCode`. This matches the installed V4 `command.ts` comment that inputRouting adjudicates startNow/enqueue/guide/choice. The pause receipt retained phase/autoDrain/queue/revision but not `inputRouting` from revision 22, so the exact pre-dispatch snapshot is unavailable; the installed JS gateway/schema contains no lower-level admission branch, which is not exposed in this runtime package. Claim is limited to the official post-admission route/state and native persisted rewrite; no Herder mapping defect is evidenced.
- Seed zero-model cause is visible in official native events, without exposing input text: seq 14 `SessionStart` and seq 34 `UserPromptSubmit` both have outcome `blocked`, source `plugin.last-human-commit...`, and exact error `python3: can't open file '/tools/lhc_time_guard.py': [Errno 2] No such file or directory`. The exact seed turn completed with `user_message_id=NULL`, `model_request_count=0`, no model usage or message rows. The effective native model ref is catalogued and persisted as `account:zai-individual-coding-plan/GLM-5.3-Flash` with reasoning `high`, so no request was rejected by provider/model validation; hooks blocked it before a model request. Read-only comparison fixture `session_6da91078-f379-462f-971d-57a3f9337873` has one completed `GLM-5.3` / `max` model request, so it proves a prior successful path but not the same effective model or hook state.
- Local history baseline diagnosis: live `agent-herder.service` has `HOME=/home/roomhacker`, no `ZCODE_DB_PATH`, and `ZCODE_TASKS_INDEX_DB` points only to the separate tasks index. `src/index.ts` constructs the ZCode adapter without an injected client/localDbPath; constructor therefore enables `allowLocalSessionHistory` and resolves `localDbPath` to `/home/roomhacker/.zcode/cli/db/db.sqlite`, the same SQLite file containing both fixture sessions. Seed baseline capture was `2026-10-26T07:23:25.407Z`; that exact session's native DB `session.time_created` was `1792999409033` ms (`07:23:29.033Z`), 3.626 seconds later. `readLocalSessionMessagePage` returns null when the session row is absent, which explains the first `baseline_unavailable`. The distinct queue canary baseline at `07:30:18.030Z` was `complete` with zero prior messages after the row existed. No DB-path override or disabled local-history flag caused the baseline gap.
