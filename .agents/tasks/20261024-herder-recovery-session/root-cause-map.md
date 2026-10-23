# Mavis exact routing failure shield

- Symptom: global active inventory sees a V2 native session while `agent_info` times out or quick details prefer a legacy idle row.
- Source boundary: `src/adapters/minimax-code.ts::{getSession,getSessionMessages}` and `src/adapters/minimax-code-native-session.ts::readMinimaxNativeSession`. When the supported live manifest exists, read the exact ID and current continuation controller; reject a different ID. Preserve explicit offline disk history.
- Release dependency: `SessionSupervisor.getSessionDetails(quick)` must skip MiniMax list hydration and cached legacy rows. A host baseline predating the canonical exemption needs that existing source hunk as part of the surgical packet.
- Admission boundary: `src/mesh/local.ts::{observeNative,deliverMinimaxCode}` independently reads the current controller. Running selects supported queue-item steer; idle keeps queue. Durable ledger, HumanStop and model policy still surround the writer.
- Exact remote bootstrap: `src/mesh/gptadmin.ts::resolveExactRoute` uses existing registered peer, tool schema, owner identity and exact native session read. Whole-history `mesh_snapshot` is unnecessary for one known address.
- Tests: `tests/minimax-native-exact-read.test.ts`, `tests/harness-mesh-minimax-delivery.test.ts`, `tests/harness-mesh-exact-route.test.ts`. A NOT_ATTEMPTED preflight may be retried after repair; admitted or UNKNOWN content is never replayed.
- Tool scope: `fleet_session_view` is local to its HTTP MCP owner; invoke the M1 owner for an M1 native ID. The connected server100 tool has no hostId field.
