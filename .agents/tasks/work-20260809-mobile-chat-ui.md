# Mobile-first unified chat UI

## Original request

Make Agent Herder look like a standard minimal chat on mobile for all
harnesses: compact composer at the bottom, hidden reasoning by default,
expandable secondary actions, and unified session selection/filtering.

## Objective

Ship the first mobile-first UI slice without changing session APIs or adapter
behavior.

## Implemented

- Harness filter options now include registry adapters even when sleeping or
  without sessions.
- Mobile detail view uses chat bubbles, a bottom composer, compact Resume/Send
  controls, and a collapsed More actions section.
- Lineage/history/metadata are secondary on mobile and hidden by default.
- Thinking/tool parts remain collapsed by default.

## Verification

- `npm run build` passed.
- UI, HTTP API, and lazy polling focused tests passed.
- Live OpenCode+CWD filter returned 23 matching sessions.
- Live Codex filter returned 200 with zero sessions without waking Codex.
- Live UI contains the composer and registry-backed filter logic.

## Remaining gate

Independent 390x844 BrowserOS/Touchpoint QA is still pending; the first run
was blocked by `Transport closed`.

## Status

Implementation slice complete; goal remains active pending real mobile QA and
any fixes it reports.
