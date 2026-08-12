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

## History archive: current direct route

When the native ChatGPT export control is unavailable, the minimal source route
is the same single owned page: list the visible sidebar, open one chat in that
same page, scroll upward, and save each raw accessibility snapshot locally.

- `list_chats({ view, limit? })` returns only visible sidebar metadata and
  opaque chat references.
- `export_chat({ chatRef, maxSegments? })` is read-only. It clicks one listed
  chat in the owned page, scrolls back in bounded steps, and writes raw JSON
  segments plus `manifest.json` under `CHATGPT_HISTORY_ARCHIVE_ROOT` (default:
  `~/archives/chatgpt-history`). The MCP result is a receipt/path/checkpoint,
  never the chat text itself.
- A click must settle on a same-page ChatGPT conversation route (`/c/...`). A
  sidebar shell, Library, project, or landing-page control fails with a local
  diagnostic instead of being mis-recorded as a chat archive.
- A `checkpoint` result means call the same tool again in the same running
  process. A restart reopens the selected chat and deduplicates already saved
  source views from the manifest.

The concrete BrowserClaw route exposes these two read-only operations only.
`E-Frontier` is visible but excluded as the archive canary; it is never sent,
edited, or used as a test target. Attachment byte downloads remain the next
vertical after the first real archive proves the actual accessible controls.

In Agent Herder these tools are `cdp_list_chats` and `cdp_export_chat`.
The standalone server uses their short names.

## Native account archive: fallback

Do not attempt to infer an HTML/Markdown format or scrape every historical chat
first. ChatGPT's native account export is the canonical first archive: it
returns a ZIP by email or SMS containing chat history and related account data.
Completed Deep Research reports are part of chat history and may also have
their own downloadable Markdown, Word, or PDF representation. ChatGPT Library
is the separate authoritative surface for saved uploaded/generated files.

The first 80/20 capability therefore uses the native ZIP as an immutable source
and records what it actually contains before any conversion or publishing:

- `request_account_export({ confirmation: "REQUEST_ACCOUNT_EXPORT" })` requests
  the official asynchronous export on the one owned ChatGPT page. It sends no
  chat message. The result says to download the ZIP from the account's email or
  SMS link.
- `import_account_export({ sourcePath })` copies that downloaded `.zip` into
  `CHATGPT_ACCOUNT_ARCHIVE_ROOT` (or `chatgpt-account-archive`), computes a
  SHA-256, and writes an immutable manifest that counts conversation sources,
  research candidates, and file candidates without exposing chat text.
- `list_account_exports({ limit? })` lists imported ZIP bundles and their
  aggregate manifest counts.

In Agent Herder these names are namespaced as:

- `cdp_request_account_export`, `cdp_import_account_export`,
  `cdp_list_account_exports`.

The manifest is the decision point for the next vertical slice. If the native
ZIP includes the files, preserve it as the complete raw source. If it does not,
add a focused `Library → select → download` batch runner using BrowserClaw's
fresh `download(page, ref)` primitive. That follow-up must retain the same
  long-lived BrowserClaw MCP process and single owned page; it must not open a
  tab per file.

The concrete BrowserClaw driver exposes the above read-only history archive and
the native account-export/archive fallback. It does not expose `new_chat`,
`search_chat`, `send_message`, `edit_message`, or `download_media`: those need
separate observable browser receipts before they can be advertised.

## Safety contract

1. The driver returns an opaque page identity: `origin`, `accountRef`,
   `pageRef`, and `leaseRef`. Every call reacquires and rechecks the same
   identity; a changed page, account, origin, or lease fails closed.
2. `new_chat` requires the literal `NEW_CHAT` and an idempotency key. It binds
   the first created chat as the single disposable fixture. It does not submit
   a prompt.
3. Fixture `export_chat`, `send_message`, `edit_message`, and `download_media`
   reject every chat reference that is not that fixture. The read-only history
   archive is a separate surface: it can only list and locally preserve raw
   snapshots; it cannot submit, edit, or download a chat attachment.
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

For the history-archive canary use `list_chats → export_chat` on one selected
non-`E-Frontier` chat and stop on the first failure. The operation is read-only
and returns only a local receipt. For the legacy fixture route, use
`new_chat → list_chats → search_chat → export_chat`; the fixture is the only
target that may be written. If a BrowserClaw action errors, times out, or leaves the page state
ambiguous, capture and inspect a secret-safe screenshot from that same MCP
session and page before retrying, reloading, navigating, or opening any new
tab. Record only the redacted timestamp, page URL without query data, operation
and error class — never a ChatGPT transcript, cookies, headers, or prompt body.

For the native account-export flow, the BrowserClaw driver additionally writes
a private `trash/logs/chatgpt-account-export-*.a11y.json` diagnostic on a
failure (and a same-page PNG when BrowserClaw returns one). It is a bounded,
redacted slice of BrowserClaw's `snapshot(mode: "full")` — the supported
equivalent of a CDP accessibility tree — containing only the relevant
name/role/disabled fields near Data Controls and Export. Use it to adjust a
matcher after a UI change; do not open a second inspection tab or record a
full chat transcript.

Every first successful `open_chat` and any failed history browser action also
writes a private `trash/logs/chatgpt-history-archive-*.json` receipt and, when
BrowserClaw returns it, a same-page PNG. The receipt intentionally contains no
chat text; it records only the outcome, stage, page, and URL without query data.
