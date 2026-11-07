# Codex native app-server capability gate

Checked 2026-11-07 against Codex CLI 0.167.0. This document describes the official Codex app-server used as Herder's native Codex adapter transport. It is distinct from the public Herder MCP endpoint and its 2026-07-28 wire contract. Codex was not patched or forked.

## Observed live

| Operation | Evidence | Result |
|---|---|---|
| `initialize` / `initialized` | Isolated app-server JSON-RPC trace in `.tmp/v052b-codex-profile-20261107/native-transcript.jsonl` | `initialize` returned `userAgent`, protocol host and the explicit temporary `CODEX_HOME`. |
| `thread/start` | Same trace | Created one thread in the temporary project/profile. |
| `turn/start` | Same trace | Accepted one unique text input; response and `turn/started` carried the same native turn ref. |
| `turn/completed` notification | Same trace | Completed that turn and included an `agentMessage` item with the fixture marker. |
| `thread/read` with `includeTurns: true` | Same trace and `result.json` | Readback contained the exact unique user input and fixture assistant item under the same completed turn ref. |

The native probe used the existing `scripts/test-model-server.py` fixture over loopback inside a user/network namespace whose only interface was `lo`. A temporary `CODEX_HOME` had only a `fixture` provider pointed at that loopback endpoint; the process environment did not inherit the operator profile or credentials. The fixture received one request. Exact thread/input/message/turn refs and fixture source hash are in `.tmp/v052b-codex-profile-20261107/proof.json`.

This is direct app-server evidence. It does not prove the Herder adapter, Herder MCP routing, installed artifact, or independent consumer path.

## Declared by the versioned app-server protocol; not live-tested here

`thread/list`, `turn/steer`, and `turn/interrupt` are present in the protocol source for the version captured by V052A. V052B exercised only create, one new turn, completion, and history readback. These other methods remain unverified here; dependent acceptance must test each exact operation before relying on it.

Protocol/version references: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Codex CLI 0.167.0 release](https://github.com/openai/codex/releases/tag/rust-v0.167.0). The V052A canonical plan leaf records the pinned version and declared methods.

## Exact unsupported call and design boundary

A read-only JSON-RPC request `tasks/list` to the same Codex app-server 0.167.0 returned error code `-32600` with `Invalid request: unknown variant `tasks/list``. Raw request/response: `.tmp/v052b-codex-profile-20261107/unsupported-transcript.jsonl` and `.tmp/v052b-codex-profile-20261107/unsupported-result.json`.

This rejection is specific to Codex's app-server method enum; it is not an MCP request and does not establish anything about methods on Herder's public MCP endpoint. The app-server route has no `tasks/list` operation, so task listing must remain a Herder responsibility. Do not infer a task store, durable task lifecycle, MCP Tasks support, or public compatibility from this native RPC probe.

## Compatibility boundary

Keep Codex's official app-server as the native adapter route. Do not patch Codex or treat its app-server JSON-RPC as the Herder MCP wire protocol. Unchanged legacy MCP clients use the separate removable translator described by the canonical `COMPATIBILITY.md`; the native Herder endpoint remains on MCP 2026-07-28. The translator does not add task-list behavior to the Codex app-server and does not create a second durable task store.
