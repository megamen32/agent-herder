# OpenCode native route evidence

## V061B — isolated profile and input correlation

- Runtime: official OpenCode CLI/server 2.2.4, isolated to the V061B HOME, XDG config, and XDG data directories.
- Native route: `POST /api/session` created `ses_e4c5afe46ffegA4WFmXjGvF9xS`; `GET /api/session/{id}/message` independently read it back.
- Input ref `v061b-input-20261107-5e7429b5` was read as native user message `msg_1b3a66ec3001qxRDmdN2DXIlDE` in that session. The corresponding assistant message `msg_1b3a670a9001Z40JO1l9YfPKHo` returned `HERDER_TEST_MODEL_OK`.
- The isolated deterministic model endpoint was the existing `scripts/test-model-server.py`, on a task-owned loopback port. No provider credentials or external inference were used.
- The fixture counted two completion requests during the single CLI input. The receipt proves the native session/input/result correlation; it does not assert a single model HTTP request.
- Evidence: `.tmp/v061b/evidence.json` and `.tmp/v061b/native-messages.json`.

This gate does not prove Herder adapter behavior, HumanStop/UNKNOWN preservation, MCP create/deliver/recent, or the final capability matrix. Those remain later acceptance steps.

## V061 — native capability matrix

The official OpenCode 2.2.4 server generated an authenticated OpenAPI 3.1.0 document from the task-owned empty profile. Exact live session/input/result proof is in V061B above.

| Capability | Native route | Evidence and limit |
|---|---|---|
| Create session | `POST /api/session` | Live 200 returned the exact new session ID. |
| Read session | `GET /api/session/{sessionID}` | Live 200 read back that same session. |
| Read history | `GET /api/session/{sessionID}/message` | Live readback contained distinct user and assistant message IDs, timestamped in the same session. Pagination uses the returned cursor. |
| Deliver input | `POST /api/session/{sessionID}/prompt` | OpenAPI says it durably admits one input and schedules the agent loop. `text` is required; `id` is optional. Herder must supply and preserve its unique input ref; the OpenCode schema alone does not promise deduplication on retry. |
| Subscribe to events | `GET /api/event` | SSE. The native contract marks the stream volatile: disconnection loses events and a slow consumer may overflow. Reconcile from history after reconnect. |
| Read active context | `GET /api/session/{sessionID}/context` | Returns messages since last compaction. This is readback; no context-injection hook is established by this route. |
| Interrupt | `POST /api/session/{sessionID}/interrupt` | Returns whether active execution was interrupted; idle may be a no-op. Do not interpret admission as proof of stopped work. |

**Exact unsupported call:** `POST /api/session/{sessionID}/prompt_async` is absent from the OpenAPI paths and returned HTTP 404 on the isolated server. Use the documented `POST .../prompt` route for admission. The event stream has no documented replay cursor; it cannot replace history reconciliation.

Generated OpenAPI, the exact 404 probe, and the compact receipt are preserved in `.tmp/v061b/openapi.json`, `.tmp/v061b/prompt-async-probe.txt`, and `.tmp/v061b/evidence.json`. The route matrix does not prove Herder adapter execution or installed public MCP behavior.
