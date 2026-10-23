# Native MiniMax active-work contract (read-only proof, 2026-10-23)

The installed M1 runtime at PID5404 was inspected read-only. No messages, steer, cancellations, provider requests, GUI actions or runtime source edits were performed.

Authoritative GET `/minimax-desktop/api/v1/session/{id}/turn-continuation` returns enum Running=2 when `execution.activeTurnId(sessionId)` exists. Installed source: `@mavis/local-runtime-v2/dist/service/turn-system/execution/turn-continuation.service.js`; enum `@mavis/thrift-gen/dist/generated/desktop-service/types.js`.

Both regular turns and MANUAL COMPACTION enter the durable `local_runtime_turn_ingress` through `repository.admit` before `controller.register`. Source: `service/turn-system/execution/turn-execution.service.js` `beginCompaction`, `compactionAdmission` (`busyReason: 'compaction'`); `infra/db/schema/turn.js` stores busyReason as `source`, status `accepted` until settlement. This is a candidate index only; every ID must be independently validated by the current runtime API. Old accepted rows never prove activity.

Manual compaction is not guaranteed to set session metadata status Started: `execution.coordinator.js` `compact` calls `host.compact` directly, whereas ordinary `executeAgentTurn` explicitly projects started preparation. `local-agent-host.js` `compact` starts plugin session activity; `agent-projection.js` emits compaction lifecycle facts. Thus status_type1 alone can miss actual runtime work.

Concrete live counterexample at 18:32:13 UTC: LHC `mvs_92b7a29fcb6147ae848063c2e62bf864` returned runtime Running=2 while metadata status_type0=Idle. The full independent probe observed26 accepted candidate sessions, all runtime Running,25 metadata Started and1 Idle; no compaction active in that particular sample. Exact ID/state pairs are in `minimax-native-active-turn-proof-1832.json`.

GUI spinner has additional client-only states: renderer chunk85734 `busy = isGenerating/generatingBySession || statuses[id].type==='started' || compactingSessions[id]`. Chunk24568 setsGenerating(true) before opening resume transport. These optimistic frontend flags are not proof of accepted execution. The active-work API reports validated current native work, including compaction, rather than promising a pixel-identical optimistic spinner count.

Global GET `/minimax-desktop/api/v1/events` exposes session lifecycle/compaction events but its generated contract has no replay/bootstrap cursor. This change uses periodic native snapshots and does not claim a gap-free live event subscription or atomic fleet-wide count.
