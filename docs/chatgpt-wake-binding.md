# ChatGPT wake and callback from an MCP chat

This document states exactly what is and is not possible when the caller is a
ChatGPT chat that reaches Agent Herder through MCP (ChatGPT -> GPTAdmin Hub ->
Herder).

## Verified transport facts (2026-10-31)

1. **ChatGPT hosts supply no routable conversation identity in MCP request
   metadata.** The documented `_meta["openai/session"]` is an anonymous
   per-conversation correlation id, and `_meta["openai/subject"]` is an
   anonymous user id. Neither is a native chat route.
2. **The Hub drops `params._meta` on the nested relay.** The nested call is
   enqueued as `tools/call` with only `name` and `arguments`
   (`go-hub/internal/hub/server.go`, `enqueueRelayWithTraceParentForRequest`),
   and the shell MCP server reads `tools/call` params without a `_meta` field
   (`go-shellmcp/internal/server/mcp.go`). Even a host that sent `openai/session`
   therefore cannot reach Herder through the Hub as it stands.
3. **Herder's native caller metadata is per-harness.** `caller-session.ts`
   accepts `ai.opencode/sessionID`, `com.zcode/request-context` and `threadId`
   (Codex) as sole-provider request metadata. Any missing, malformed, or
   conflicting metadata yields no caller, and the tools fail closed with
   `caller_session_unavailable`.
4. **A ChatGPT session in Herder is an opaque `chatRef`**
   (`cdpchat:v1:chat:<uuid>`) produced by the CDP driver, not a native
   `/c/{id}`. Only the owned browser page can resolve it back to the real chat.

## What this means

- Automatic self-attribution (`session_identity()` without `sessionId`) and
  automatic self-resume (`resume_after` without `owner`) are **not available
  for ChatGPT callers**. They fail closed; they never guess a chat.
- ChatGPT chats still receive Herder results over the channels that already
  work: the GPTAdmin Hub session (this conversation) and the Herder
  coordination board. A background result is delivered as a message, not as an
  automatic wake of the originating chat.

## The supported path: explicit wake binding

Because the host offers no attributable identity, the only honest mechanism is
an explicit, opt-in, validated binding.

| Tool | Purpose |
| --- | --- |
| `chatgpt_wake_binding_register` | Bind `bindingId` + secret to a **validated** owner session. The owner must exist in the live adapter registry; a guessed or foreign session is refused. Only a salted SHA-256 digest of the secret is stored. |
| `chatgpt_wake_binding_verify` | Return the validated bound owner once, against a bounded use budget. Any mismatch fails closed with `chatgpt_wake_binding_unverified`. |
| `chatgpt_wake_await` | Wait for one job to reach a terminal state and deliver the result **exactly once** to that binding. A second delivery of the same job is refused with `chatgpt_wake_delivery_already_done`. |

The returned owner is passed **explicitly** to `session_identity` and
`resume_after`:

```jsonc
// 1. register once (from a session that can prove the owner exists)
chatgpt_wake_binding_register({
  "bindingId": "release-1031",
  "secret": "<kept in a protected store, never in chat text>",
  "owner": { "harness": "opencode", "sessionId": "ses_..." }
})

// 2. from the ChatGPT chat: verify, then use the owner explicitly
chatgpt_wake_binding_verify({ "bindingId": "release-1031", "secret": "..." })
// -> { "owner": { "harness": "opencode", "sessionId": "ses_..." } }
session_identity({ "sessionId": "ses_...", "harness": "opencode" })
resume_after({ "owner": { "harness": "opencode", "sessionId": "ses_..." }, ... })
```

Cross-chat substitution is refused: a binding id resolves only to the owner
that was validated at registration time.

## Storage

The registry lives at
`$AGENT_HERDER_CHATGPT_WAKE_BINDINGS` (default: the Autopilot state
directory, `chatgpt-wake-bindings.json`), mode `0600`, containing digests only.

## Not implemented on purpose

- Writing into an ordinary ChatGPT chat through CDP is not a wake mechanism;
  the page-driven send path already exists as `send_message` for the owned
  page, and it needs no binding.
- OpenAI MCP Events (`events/subscribe` with a verified callback URL) is the
  documented push mechanism for Work/Cloud chats. The GPTAdmin Hub does not
  expose `events/list`, `events/subscribe` and `events/unsubscribe` today, so
  this path is not available without extending that hub.
