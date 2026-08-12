# Done: Agent Herder BrowserClaw CDP chat adapter

Started at: 2026-08-12 05:28 MSK
Lifecycle provenance: completed snapshot of `work-20260812-cdp-chat-agent-herder-adapter.md` after the user selected the shortest business route and the final BrowserClaw live canary passed.
Last task-file mtime observed: 2026-08-12 11:26 MSK
Last task-file transition: delivery confirmed locally and through one real BrowserClaw/ChatGPT disposable fixture; runtime activation in the already-running Agent Herder remains separately gated because it requires configuration and restart.

## Delivered result

- Persistent BrowserClaw MCP session owns exactly one ChatGPT page for the
  life of the CDP MCP process; it does not reopen a page for each operation.
- A new empty disposable fixture chat can be created, listed, searched, and
  exported through `new_chat`, `list_chats`, `search_chat`, and `export_chat`.
- Agent Herder has namespaced `cdp_*` registration when a
  `CDP_CHAT_DRIVER_MODULE` is configured; existing `send_message` remains
  untouched.
- Tester/debug procedure requires a same-session screenshot before any browser
  retry, reload, navigation, or new-tab action after an error or ambiguity.

## Evidence

- Final live BrowserClaw canary: tool list contained `new_chat`, `list_chats`,
  `search_chat`, `export_chat`; creation returned a fixture ref; list/search
  returned that fixture; export returned JSON bound to that same ref.
- Focused tests passed `25/25` and TypeScript compilation passed.
- No E-Frontier prompt, chat message, Telegram operation, deployment, restart,
  credential, or MFA action occurred.

## Explicit exclusions

- Real existing-chat inbox/unread/working parsing, transcript extraction,
  `edit_message`, and media download are not represented as delivered. They
  need a separately verified DOM/attachment contract.
- The currently running Agent Herder process was not restarted or reconfigured.
