# L01 adapter startup — read-only finding

The initial report showed no Codex inventory after reboot, but live readback during this diagnosis independently returned Codex enabled=true, active=true, ready=true, event-source connected=true, and /api/sessions?limit10 contained Codex. No mutation, enable/disable, restart, socket unlink, resume or input was performed by this worker. The late native runtime discovery has recovered itself; a permanent startup retry defect is not proven.

Verified source path: CodexAppServerAdapter.lazyDiscovery=true; SessionSupervisor observation tick/readSessionSnapshot include not-ready lazyDiscovery adapters; refreshNativeProvider clears its in-flight promise in finally and does not permanently cache an enumeration failure. CodexAppServerAdapter.ensureReady clears initialization in finally, and later initialization reconnects a closed/absent socket. This explains how the later socket can be discovered by the existing mechanism without a new retry timer.

AdapterRegistry.setEnabled(true) separately persists enabled=false on failed init, but startup initAdapters does not invoke this path. It is not evidence for this reboot symptom and was not changed speculatively.

No production source changed, and no healthy-path test added. Remaining business investigation: native unfinished-turn persistence and recovery eligibility after boot, owned by Root and the assigned native-turn worker. Earlier UI/history source and evidence preserved. Shared AgentMemory MCP was absent from effective tools at this task start; no silent XERJ/local-memory substitution was made.

## Authorized bounded native latest-turn helper

Root subsequently assigned the missing cold-turn proof seam. Public method `CodexAppServerAdapter.readLatestTurnRecoveryEvidence(id)` now issues exactly one supported `thread/turns/list` request: limit1, sortDirection desc, itemsView summary. Generated pinned protocol at `.tmp/permission-control-codex-schema-20261025/v2/ThreadTurnsListParams.ts`, TurnItemsView.ts, Turn.ts and ThreadItem.ts confirms the contract; there is no turn/read in that schema. No thread/resume/start, rollout scan or native mutation is used.

Return distinguishes `{available:false,reason}` from authoritative `{available:true,latest:null}`. Latest summary projects native turnId/status, native startedAt/completedAt normalized to ISO or NULL (never invent terminal time), exact userMessageId/clientId and strict userMessageCount, assistantFinal and conservative pendingQuestion marker. Only declared summary arrays <=256 items are admitted. The consumer must require its own exact user count and fresh same-turn fence before dispatch; one latest summary is evidence, not permission to replay.

Real read-only native validation for Airlock01a182ff-be14-7171-9b7d-a4965f7363cd: latest01a183c3-e935-74e3-8a08-7aaac6367484 interrupted; startedAt1793212016; completedAtNULL; summary has userMessage01a183c3-f204-7700-a899-cce5241080b9/clientIdd87b3461-9060-4f38-95bc-376d2c35b5eb and agentMessage phasefinal_answer with nonempty questions. Thus it must not be treated as a plain abandoned turn with no pending question. No full132MiB history was loaded by Herder.

Fast regression RED: method absent. GREEN: `npx vitest run tests/codex-app-server.test.ts -t 'bounded latest-turn recovery evidence' --reporter=dot` →1 passed/70 skipped; verifies native nullable completion, exact user linkage, questions gate, unavailable versus empty, and only readonly native RPC. `npx tsc --noEmit` PASS; scoped diff-check clean. Source passed directly to launcher owner and Root for one integrated release.

Owned delta for this helper: src/adapters/codex-app-server.ts, tests/codex-app-server.test.ts, this report. Worker did not commit/build/deploy/restart/send.

Safety followup requested by launcher owner: any native agentMessage.phase=final_answer now conservatively sets assistantFinal=true even if text is empty/unavailable or questions also present; launcher interprets it only as an auto-resume exclusion, not completed business work. Added empty-final RED (false) → GREEN (true), with existing pendingQuestion preserved separately. NativeUserInput source work was reassigned before any map/method/test edit; adapter-question-handoff.md contains the proposed contract and verified native protocol limits only.
