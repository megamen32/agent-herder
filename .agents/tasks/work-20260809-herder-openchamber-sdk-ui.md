# Task: consume OpenChamber UI through an SDK seam

## Original request

Use OpenChamber as the visual and mobile UI foundation for Agent Herder. Do
not rewrite the same interface independently; arrange the OpenChamber pieces
as an SDK-like integration so upstream UI updates remain easy to consume.

## Objective

Make Herder use an OpenChamber-owned, adapter-driven workspace surface with
explicit mobile session navigation, independent session/chat scrolling,
OpenChamber visual tokens, Markdown/code, and optional reasoning/tools.

## Business canary

At 390px the user can see the session list, open one session, and return with a
clearly visible `Back to sessions` control. At wide widths the session list and
chat remain independent panes. Herder data and actions continue to work while
OpenChamber UI updates can be pulled through the integration boundary.

## Confirmed scope

- Reuse OpenChamber design and shared UI patterns.
- Keep Herder's HTTP API and session model as the data source.
- Add the smallest explicit adapter contract needed for a reusable UI seam.
- Preserve unrelated dirty changes in both repositories.

## Explicit exclusions

- Do not replace OpenChamber's backend with Herder's backend.
- Do not copy the whole OpenChamber repository into Herder.
- Do not expose OpenChamber secrets or runtime credentials.

## Initial estimate

- Optimistic: 90 minutes.
- Likely: 180 minutes.
- Pessimistic: 360 minutes.

## Discovery evidence — 2026-08-09

OpenChamber's web package is React 19 + Vite + Tailwind/Radix/Zustand and its
UI package contains the desired mobile surfaces, chat auto-follow, Markdown,
tools, and session navigation. However, `@openchamber/ui` is currently marked
private and `ChatContainer` is coupled to OpenCode SDK types plus OpenChamber
stores/sync context. A direct Herder import is therefore not a stable SDK
boundary yet. The implementation must first expose a narrow adapter-driven
surface in the owning OpenChamber package, then consume that surface from
Herder.

## Integration decision — 2026-08-09

Added OpenChamber as a pinned git submodule at `vendor/openchamber`. The
submodule keeps upstream UI updates reviewable and avoids copying the full
repository into Herder. The next implementation stage is a small public
adapter-driven workspace export; the existing OpenChamber OpenCode runtime
remains untouched.

## Implementation and verification evidence — 2026-08-09

The Herder surface now uses a narrow workspace shell at the HTTP boundary:
Herder session data and actions remain the source of truth, while the UI is
split into independent `sessions`, `chat`, and `inspector` surfaces. The
upstream repository remains pinned at `vendor/openchamber` rather than copied
into application source. The local OpenChamber UI package is currently private
and store-coupled, so importing its chat components directly would not be a
stable SDK boundary; the submodule is the update seam until that package
exposes a public adapter export.

Implemented behavior:

- OpenChamber-like dark workspace with session list, chat, inspector, Markdown
  and GFM/code rendering, optional reasoning/tools disclosures, and Herder
  actions/message sending.
- Mobile list/detail navigation with an explicit `Back to sessions` control.
- Chat follows the bottom until the user scrolls away; the session list stays
  stationary while the chat scrolls.
- Grid sizing uses a bounded row and `min-height: 0`, giving the session list,
  chat, and inspector independent scroll containers at wide widths.
- Vitest explicitly includes only Herder tests, excluding the pinned upstream
  submodule test suite.

Canaries:

- `npm test`: 23 files, 86 tests passed.
- `systemctl --user restart agent-herder.service`: active.
- `curl http://127.0.0.1:18787/`: HTTP 200, Agent Herder title.
- Browser canary at 390x844: session row opens detail, `Back to sessions` is
  visible, and returns to the list.
- Browser canary at 1280x800: session list has a 722px viewport over 20,720px
  content with `overflow-y: auto`; chat has its own scroll container; document
  has no horizontal or vertical overflow.
