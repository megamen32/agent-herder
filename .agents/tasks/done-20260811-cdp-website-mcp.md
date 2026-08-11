# Done: standalone CDP website chat MCP

Started at: 2026-08-11 07:27 MSK
Lifecycle provenance: completed snapshot of work-20260811-cdp-website-mcp.md after user-authorized standalone implementation, P1/P2 fixes, review gates, and final tester boundary evidence.
Last task-file mtime observed: 2026-08-11 19:25 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: completed local slice; live surface unavailable
Last PID signal: completed child receipts and closed completed agents only
Last task-file transition: final handoff recorded; live ChatGPT/CDP explicitly deferred.

## Request

Create a CDP website MCP with `new_chat`, `list_chats` (`unread`, `working`,
`recent`), `search_chat`, `export_chat`, `send_message`, `edit_message`, and
`download_media`; use the same ChatGPT/E-Frontier site later, but start with a
new disposable chat and add the Agent Herder adapter afterward.

## Delivered

Standalone task-owned implementation:

- `src/cdp-chat.ts`
- `src/cdp-chat-mcp.ts`
- `tests/cdp-chat.test.ts`
- `docs/cdp-chat-mcp.md`

The implementation provides fixture/origin/account/page/lease-bound opaque
references, a single disposable fixture with in-flight `new_chat` protection,
explicit list semantics, bounded export, confined media writes, one-shot TTL
write gates, expected-version/text edit guards, and public opaque write
projections.

## Evidence

- Focused fake-CDP suite: `8/8` after the final concurrency fix.
- `npx tsc --noEmit`: pass.
- `npm run build`: pass.
- Whitespace checks: pass.
- In-memory MCP handshake: exactly 7 documented tools.
- Independent Reviewer: `APPROVE`.
- Independent Overseer: `CONTINUE`.
- Two fresh real-use Testers: `STOP_MISSING_REAL_SURFACE`; no concrete
  `CDP_CHAT_DRIVER_MODULE`, BrowserClaw page, or authenticated ChatGPT surface
  was available, so no real chat was opened or mutated.

## Deferred follow-up

Add the concrete BrowserClaw/CDP driver as an adapter in the Agent Herder
registry, then rerun both fresh real-use Tester passes. Do not deploy, restart,
or target the existing production E-Frontier conversation before that gate.

Detailed append-only evidence remains in
`work-20260811-cdp-website-mcp.md`.
