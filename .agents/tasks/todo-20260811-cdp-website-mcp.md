# Task: CDP website chat MCP

Started at: 2026-08-11 07:27 MSK
Lifecycle provenance: created by Lead from the user's CDP website chat MCP request; copied to work-20260811-cdp-website-mcp.md before implementation.
Last task-file mtime observed: 2026-08-11 07:56:09 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: unknown (desktop harness)
Last PID signal: none observed
Last task-file transition: user selected YAGNI 80/20 and requested new_chat; implementation route pending.

## Original request

> create mcp for cdp website to fast list_chats( unread,working,recent) , search(chat), export_chat, send_message, edit_message , download media,

## Objective

Create a provider-neutral MCP surface for a browser/CDP-backed chat website with fast read tools and explicitly gated write/media operations:

- `list_chats` with `unread`, `working`, and `recent` views;
- `search_chat`;
- `export_chat`;
- `send_message`;
- `edit_message`;
- `download_media`.

## Business canary

Against a disposable/local CDP fixture (and only after explicit user authorization for any real target): list the three chat views, find a known chat/message, export a bounded transcript, download a fixture attachment, and prove that send/edit are rejected without the write gate and accepted only with an explicit confirmation token. No real production chat may receive a canary message.

## Confirmed scope

- Agent Herder MCP integration seam and CDP website adapter contract.
- Fast read path, pagination/limits, stable opaque chat/message IDs, bounded export/media output.
- Explicit authorization/idempotency behavior for send/edit.
- Focused tests and documentation.

## Explicit exclusions

- Telegram MCP, Overpod, Telegram sessions, or Telegram polling.
- Reusing the real `E-Frontier` ChatGPT session for testing.
- BrowserClaw/BrowserOS restart or deployment without a separate explicit authorization.
- Site-specific selectors or production credentials until the target website and adapter seam are confirmed.

## Initial estimate (UTC+3, immutable)

- Started: 2026-08-11 07:27 MSK
- Minimum / maximum active time: 60 / 120 minutes for research, three plans, selected implementation preview, and first implementation slice; deployment and live-target adapter remain gated by target-site confirmation.

## Plan / execution

- First research worker entered an unbounded scan and was stopped before any source mutation or target-browser interaction; no evidence was returned.
- Re-route: repeat research with an explicit file allowlist and no graph-wide traversal.
- User decision received: use the same authenticated ChatGPT/E-Frontier site, but create a separate new chat as the disposable fixture. The existing production E-Frontier conversation remains excluded.
- The previously missing target decision is resolved; implementation still requires the existing BrowserClaw/CDP adapter seam and a one-chat ownership proof.

## Append-only estimate revisions

- 2026-08-11 07:39 MSK — initial 10-20 minute research slice did not produce evidence because the worker remained in a broad scan; new route remains within the immutable 60/120 minute envelope, with the next slice capped at 10 minutes and restricted to known MCP/browser files.

## Evidence / result

## Overseer audit receipt — 2026-08-11

- VERDICT: ASK_USER
- BUSINESS_DELTA: same — two research workers returned no evidence; no target website, DOM/API seam, or named disposable CDP fixture is identified.
- ESTIMATE: within — the recorded 60/120-minute envelope is not shown exceeded, but another broad research slice has no canary evidence.
- WASTE: repeating unbounded research would be avoidable; a provider-neutral MCP contract is implementable without site knowledge, but a site adapter and business canary are not.
- NEXT: choose the smallest path: authorize contract-only work against a named disposable/local CDP fixture, or provide the target website and its supported CDP/DOM/API seam.
- QUESTION: Which path is authorized: named-fixture contract-only, or target-site/seam confirmation?

- Resolved by user: target-site/seam confirmation for ChatGPT/E-Frontier, with a newly created chat as the disposable fixture.
