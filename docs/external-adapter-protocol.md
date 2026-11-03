# External Adapter Protocol (AHAP) — v0.1

**Status:** draft
**Goal:** let any harness adapter of agent-herder be implemented in any
language that can speak JSON-RPC 2.0 over stdio (Go, Rust, Python, C, …).

The TS process (the agent-herder supervisor) stays lightweight: it owns
the registry, the event bus, the MCP/HTTP control plane, the autopilot
loop and the human-request notice bridge. Heavy per-harness bridge code
(talks to a native binary, parses 200 KB of native protocol state, etc.)
moves into a separate subprocess.

This is the same shape as the existing `AcpAdapter` and `CodexAppServerAdapter`,
but the protocol is general: any language can implement it.

## Transport

- One subprocess per adapter instance, spawned by the supervisor via
  `spawnIsolatedWorkload` (existing helper) with `stdio: ["pipe", "pipe", "pipe"]`.
- Newline-delimited JSON (ndjson), one JSON-RPC 2.0 message per line.
- Bidirectional: requests flow in both directions. The supervisor calls
  the adapter; the adapter emits notifications.

## Message envelope

```jsonc
// Request (supervisor -> adapter)
{"jsonrpc":"2.0","id":"req_1","method":"listSessions","params":{"options":{}}}

// Response (adapter -> supervisor)
{"jsonrpc":"2.0","id":"req_1","result":{"sessions":[...]}}

// Error response
{"jsonrpc":"2.0","id":"req_1","error":{"code":-32603,"message":"not implemented"}}

// Notification (adapter -> supervisor, no id)
{"jsonrpc":"2.0","method":"event","params":{"kind":"permission.requested","harness":"echo","data":{...}}}
```

## Lifecycle

1. Supervisor spawns the adapter subprocess with env:
   - `AHAP_VERSION=0.1`
   - `AHAP_HARNESS=<harness-id>` (e.g. `chatgpt`, `zai`, `codex`, …)
   - `AHAP_ROLE=adapter`
   - `AGENT_HERDER_AUTOPILOT_STATE_DIR=<dir>` (for any durable state the
     adapter wants to read/write next to the supervisor's state).
2. Adapter reads `initialize` request first and replies with its
   capabilities (which HarnessAdapter methods it actually implements).
3. Supervisor caches the capability set and only calls methods the adapter
   declared. Unsupported methods return error code `-32601` and the
   supervisor falls back to the same path as when an in-process adapter
   leaves a method `undefined`.
4. Adapter may emit `event` notifications at any time; the supervisor
   forwards them as `HarnessEvent` into its bus.
5. On supervisor shutdown, it sends `shutdown` and waits up to 5 s before
   SIGTERM.

## Methods (subset of HarnessAdapter)

The full method list mirrors `HarnessAdapter` in `src/types/common.ts`.
Each method that the adapter implements takes the same JSON shape as the
TS interface. Methods the adapter does NOT implement simply never appear
in `initialize.result.capabilities`, and the supervisor returns the same
"not supported" error as for any in-process adapter that lacks them.

| Method | Direction | Notes |
|---|---|---|
| `initialize` | req | First call. Returns capabilities + harness + name. |
| `init` | req | Optional. Called once after `initialize`. |
| `listSessions` | req | Returns `AgentSession[]`. |
| `listActiveSessions` | req | Optional. |
| `getSession` | req | `(id) => AgentSession \| null`. |
| `findNamedSessions` | req | Optional. |
| `getSessionMessages` | req | `(id, limit?) => SessionMessageView[] \| null`. |
| `sendMessage` | req | `(id, options) => SendMessageResult`. |
| `sendActiveMessage` | req | Optional. |
| `stopTurn` | req | Optional. `(id) => ControlResult`. |
| `createSession` | req | Optional. |
| `renameSession` | req | Optional. |
| `setPermissions` | req | Optional. |
| `respondPermission` | req | Optional. |
| `getPermissionState` | req | Optional. |
| `listModels` | req | Optional. |
| `changeModel` | req | Optional. |
| `subscribeEvents` | req | Bidirectional: the call itself is a notification
   registration. Adapter starts emitting `event` notifications afterwards.
   Unsubscribe happens on `shutdown`. |
| `shutdown` | req | Clean exit. Adapter should `process.exit(0)`. |

## Events (notifications)

The adapter emits these as JSON-RPC notifications with `method:"event"`.
The supervisor wraps each into a `HarnessEvent` and fans out to every
listener (supervisor, permission-control notice-bridge, UI event bus).

| `params.kind` | Meaning |
|---|---|
| `session.created` | A new native session appeared. |
| `session.updated` | A session's metadata changed. |
| `session.deleted` | A session is gone. |
| `turn.started` | A model turn started. |
| `turn.completed` | A model turn finished. |
| `turn.failed` | A model turn failed. |
| `message.updated` | A message was appended or edited. |
| `permission.requested` | The harness is asking the user to allow an
   action. |
| `permission.resolved` | A permission request was answered. |
| `model.changed` | The chat's model was changed. |
| `process.connected` | Adapter successfully connected to its backend. |
| `process.disconnected` | Adapter lost its backend. |

Every notification carries `params.harness`, `params.sessionId?`,
`params.at?`, and an optional `params.data` object.

## Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (bad JSON). |
| `-32600` | Invalid request. |
| `-32601` | Method not implemented (the adapter declared it unsupported). |
| `-32602` | Invalid params. |
| `-32603` | Internal adapter error. |
| `-32000` | Adapter-specific business error (see `error.data`). |

## What moves out of the TS heap

A 200 KB TS adapter source compiles to a few hundred MB of V8 JIT code,
plus its parsed AST and module graph, all in the supervisor heap. Moving
the bridge to a Go subprocess means:

- the supervisor imports only the **~300-line** `ExternalProcessAdapter`
  shim, not the 200 KB of harness-specific code;
- the Go subprocess has its own (much smaller, natively compiled) heap;
- the supervisor's V8 heap stays bounded by the control plane.

This is what makes `--max-old-space-size=512` realistic without giving
up the heavy harness bridges.
