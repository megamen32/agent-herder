# Standalone CDP website chat MCP

This route exposes bounded ChatGPT/E-Frontier chat operations over one injected
BrowserClaw/CDP page. It is intentionally standalone: the Agent Herder MCP
registry and browser runtime are not changed by this slice.

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

`unread` uses the page's unread marker. `working` uses the observable
generation/stop state on the row. `recent` uses UTC `updatedAt` within the
last seven days. All list results are sorted by `updatedAt` descending and are
bounded to 100 rows per call.

## Driver seam

The stdio entrypoint expects `CDP_CHAT_DRIVER_MODULE` to point to a local module
exporting `createCdpChatDriver()` (or a default factory). The factory must
return the small `CdpChatDriver` interface from `src/cdp-chat.ts`; the concrete
BrowserClaw/CDP adapter is deliberately injected later, after this standalone
contract is reviewed.

```sh
CDP_CHAT_DRIVER_MODULE=/absolute/path/browserclaw-cdp-driver.mjs \
CDP_CHAT_MEDIA_ROOT=/absolute/path/fixture-media \
node dist/cdp-chat-mcp.js
```

The real canary should call `new_chat` first, retain its returned fixture
receipt, and use only that `chatRef` for export/media or any explicitly
approved write. No existing E-Frontier conversation is a canary target.
