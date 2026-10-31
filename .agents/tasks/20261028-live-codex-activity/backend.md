# L01 — Codex native history activity

## Before / after

Before: CodexAppServerAdapter.getSessionMessages delegates to rawTranscriptAdapter; CodexAdapter.mapCodexMessage accepted only response_item/message with user/assistant text. Native tool/reasoning/subagent records were dropped before SessionSupervisor.readHistory and the details API, including quick reads before a final answer.

After: existing bounded rollout reader normalizes public persisted activity into existing SessionMessageView.parts. Native call_id/id and turn_id remain stable; call/output records merge into one activity entry. No native thread mutation, new index/store, RPC subscription, global scan, or expanded read limits. Existing tail starts at 256KiB and retains its previous 4MiB maximum; indexing settings are untouched.

## Actual read-only evidence

Exact user thread: 01a182fe-39b5-7730-a84b-7c484e8fc412, title AutoGramXAirlock, cwd /home/roomhacker/airlock-internal, host100. Native rollout path was looked up through exact read-only SQLite threads.id; only the last256KiB was inspected for event shapes/counts. At the first observation, persisted file size8,868,415 bytes, tail had item_completed Reasoning18, McpToolCall4, CommandExecution4, SubAgentActivity6, plus response_item function_call6/custom_tool_call7 and corresponding outputs. These are a moving live tail, not a complete-history inventory.

Every sampled native Reasoning had summary_text=[] and raw_content=[]; response_item reasoning had encrypted_content and empty summary. Thus the public thinking EVENT is available, but its text is not. We emit a thinking part without text for the public event, use actual public summary_text/summary if nonempty, and NEVER read/decrypt/expose raw_content or encrypted_content. Do not describe the fix as recovering hidden chain-of-thought.

A source-adapter readonly probe of the same exact user thread, limit12, observed12 normalized entries with thinking10, tool_call2, tool_result2; public-summary text count0, subagent tool names present. The later bounded correction omits empty native function outputs so empty communication acknowledgements cannot appear as child-task completion. No user prompt/session execution was sent. This source probe is NOT installed browser acceptance.

## Normalized contract

- reasoning/Reasoning: thinking{text?}, only public response.summary or event.item.summary_text. Empty public Reasoning event => thinking without text.
- response function/custom tool call: tool_call{name,input}, keyed by native call_id; output appends tool_result{name,output}. Empty native outputs omitted.
- CommandExecution: tool_call name=command input={command,cwd}; actual item_completed adds aggregated_output and error from failed status/nonzero exit. Started items never synthesize a result.
- McpToolCall/DynamicToolCall: actual server/tool name and arguments; completed native result/error only.
- SubAgentActivity: tool_call name=subagent input={kind,agentThreadId,agentPath,model?,reasoningEffort?}. This records native communication/lifecycle activity; interacted does not mean child work completed. No fabricated tool_result/task summary.
- Existing text/image message behavior, UTF8 byte-offset IDs, native turn grouping, and archive path handling retained.

## Fast RED → GREEN

Focused regression added BEFORE production edit: `npx vitest run tests/codex-message-turns.test.ts -t 'persisted public activity' --reporter=dot` failed, expected thinking part but got[].

After fix: `npx vitest run tests/codex-message-turns.test.ts tests/codex-archive-path.test.ts --reporter=dot` →7 passed,2 files,1.32s. Includes public summary, empty public Reasoning event, raw/encrypted exclusion, calls/results, SubAgentActivity, quick-tail2, native turn IDs, UTF8 stable IDs and archive behavior. `npx tsc --noEmit` PASS; scoped git diff --check clean. No full test suite/build/deploy/commit performed by worker.

## Installation / acceptance handoff

Owned paths: src/adapters/codex.ts; tests/codex-message-turns.test.ts; this report. UI owned by codex_self_identity; it must treat empty thinking parts as visible native events and leave details collapsed by default. Command native input.command may be array, not only string. No new native canary is needed to establish persisted activity: after Root's single release, GET exact session details with quick/limit12 then ordinary browser open should reveal actual tools/subagents/thinking events without touching the user's session. A separate new provider turn is unnecessary. Root owns installed/browser acceptance.

## Failure shield

Consumer path: src/web/server.ts details → src/session-supervisor.ts readHistory → src/adapters/codex-app-server.ts getSessionMessages → src/adapters/codex.ts bounded rollout/mapCodexActivity. A healthy native activity catalog or UI disclosure change alone cannot repair dropped records. Discriminating fast probe is persisted-public-activity regression above; inspect public event fields, never hidden reasoning payload.

### Bounded integration review followup

Added scalar public summary regression for both legacy.summary and native.summary_text (strings); RED lost both texts, then one-line public extractor change made it GREEN. Same fixture also verifies legacy function_call.call_id matches native CommandExecution.id and later output: exactly one normalized call entry, one tool_call+tool_result pair, no duplicate output. No additional stable-ID fix needed. Re-ran focused message-turns+archive tests:8 passed. Raw/encrypted negative assertions retained. Source frozen again.

## Reopened: commentary displaced by saturated activity tail

Owner's real root session `01a1754f-0228-7553-bea6-cc89e40b5187` exposed a second concrete boundary defect after activity normalization. The bounded window contained commentary, but `slice(-limit)` counted tools/thinking as dialogue and displaced it. Native source was checked read-only through exact SQLite rollout_path;132.9MiB file was NOT read whole. Latest256KiB contained actual response_item/message assistant.phase=commentary and its native AgentMessage duplicate. We intentionally do not add duplicate AgentMessage projection.

Focused RED fixture interleaves commentary with more activity than limit2: expected two commentary+two activity, received tools-only. Minimal fix `tailCodexMessages` uses separate dialogue and activity budgets, each <=limit, selects IDs then filters original chronology. At most2*limit output entries. Read window/expansion/stop conditions are UNCHANGED: no extra IO to fill dialogue slots and no new periodic native reads/index writes. `SessionSupervisor.tailLogicalTurns` groups by human turns and does not retrim individual assistant records, so it preserves this selection.

GREEN: message-turns+archive9/9,2 files,1.38s. Real source-adapter readonly probe of the exact root, limit12:13entries=1commentary+12activity. Preserved native commentary ID `msg_07d379cd22275ad4016ae242495c0c8191807e689f1a8ffd10`, phase commentary, beginning «Да, разница большая. Я ошибочно принял появление событий…». No input/native mutation. Temporary readonly probe test removed. Installed/UI acceptance remains Root-owned.

Additional bounded4MiB schema read (once, not a new poll) found actual SubAgentActivity interacted6/completed2. Both kinds have only type/model/reasoning_effort/id/kind/agent_thread_id/agent_path; no native display name, task summary or status field. Existing normalized input already exposes kind/agentThreadId/agentPath. UI can label basename(agentPath) and translate completed to «Завершён»; interacted is communication activity, not child completion. Exact schema delivered to UI owner.
