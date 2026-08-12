# CDP website chat MCP

This capability exposes bounded ChatGPT/E-Frontier chat operations over one
injected BrowserClaw/CDP page. It has two MCP entrypoints:

- The standalone stdio server (`dist/cdp-chat-mcp.js`) keeps the short tool
  names documented below for compatibility.
- Agent Herder registers the same capability under the `cdp_*` namespaced tool
  names when `CDP_CHAT_DRIVER_MODULE` is configured. Its existing coding-agent
  tools, including `send_message`, remain unchanged.

Agent Herder creates one `CdpChatClient` for each MCP server/session. The
fixture binding, opaque references, page lease, and write gates therefore do
not cross between separate stdio or HTTP MCP sessions. The HTTP route creates
the server when a new MCP initialize request creates a session.

## Safety contract

1. The driver returns an opaque page identity: `origin`, `accountRef`,
   `pageRef`, and `leaseRef`. Every call reacquires and rechecks the same
   identity; a changed page, account, origin, or lease fails closed.
2. `new_chat` requires the literal `NEW_CHAT` and an idempotency key. It binds
   the first created chat as the single disposable fixture. It does not submit
   a prompt.
3. `export_chat`, `send_message`, `edit_message`, and `download_media` reject
   every chat reference that is not that fixture. Existing production chats can
   be listed or searched, but their references cannot be targeted.
4. `send_message` and `edit_message` require their exact confirmation literal.
   The idempotency key is bound to the operation, fixture reference, message
   reference where applicable, and exact payload. It is one-shot and expires
   after the configured TTL (`60s` by default). Editing also requires
   `expectedVersion` or `expectedText`.
5. Exports default to 50 messages and 64 KiB. Media is restricted to PNG,
   JPEG, WebP, PDF, or plain text, defaults to 5 MiB, and is written with mode
   `0600` under `CDP_CHAT_MEDIA_ROOT` (or the process-local
   `cdp-chat-media` directory). Traversal and symlink escapes are rejected.

## Tools

- `new_chat({ confirmation, idempotencyKey, title? })`
- `list_chats({ view: "unread" | "working" | "recent", limit?, cursor? })`
- `search_chat({ query, limit? })`
- `export_chat({ chatRef, format: "json" | "markdown", maxMessages? })`
- `send_message({ chatRef, text, confirmation: "SEND_MESSAGE", idempotencyKey })`
- `edit_message({ chatRef, messageRef, text, confirmation: "EDIT_MESSAGE", idempotencyKey, expectedVersion? | expectedText? })`
- `download_media({ chatRef, messageRef, mediaRef, outputDir? })`

The Agent Herder namespaced equivalents are:

- `cdp_new_chat`, `cdp_list_chats`, `cdp_search_chat`, `cdp_export_chat`
- `cdp_send_message`, `cdp_edit_message`, `cdp_download_media`

`unread` uses the page's unread marker. `working` uses the observable
generation/stop state on the row. `recent` uses UTC `updatedAt` within the
last seven days. All list results are sorted by `updatedAt` descending and are
bounded to 100 rows per call.

## Driver seam

Both entrypoints expect `CDP_CHAT_DRIVER_MODULE` to point to a local module
exporting `createCdpChatDriver()` (or a default factory). The factory must
return the small `CdpChatDriver` interface from `src/cdp-chat.ts`. The concrete
BrowserClaw/CDP adapter is still injected separately; this wiring does not by
itself prove a live BrowserClaw/CDP connection or a real ChatGPT canary.

```sh
CDP_CHAT_DRIVER_MODULE=/absolute/path/browserclaw-cdp-driver.mjs \
CDP_CHAT_MEDIA_ROOT=/absolute/path/fixture-media \
node dist/cdp-chat-mcp.js
```

The separately approved real canary should call `new_chat` (or
`cdp_new_chat` through Agent Herder) first, retain its returned fixture receipt,
and use only that `chatRef` for export/media or any explicitly approved write.
No existing E-Frontier conversation is a canary target.

## BrowserClaw tester and debug procedure

The BrowserClaw driver owns one MCP session and one ChatGPT page for the life
of the MCP process. Start `dist/cdp-chat-browserclaw-main.js` (or configure
the same factory through `CDP_CHAT_DRIVER_MODULE`) once; do not run a fresh
one-shot probe before each tool call, because BrowserClaw page ownership is
session-scoped.

For a real test use the sequence `new_chat → list_chats → search_chat →
export_chat`. The test fixture is the only target that may be exported or
written. If a BrowserClaw action errors, times out, or leaves the page state
ambiguous, capture and inspect a secret-safe screenshot from that same MCP
session and page before retrying, reloading, navigating, or opening any new
tab. Record only the redacted timestamp, page URL without query data, operation
and error class — never a ChatGPT transcript, cookies, headers, or prompt body.
