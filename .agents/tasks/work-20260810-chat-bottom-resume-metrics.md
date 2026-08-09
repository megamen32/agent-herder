# Task: bottom chat navigation and Resume composer control

## Original request

The chat should open at the latest message, use a familiar down-arrow jump
button, turn the send control into a play-shaped Resume control for stopped
sessions, and show useful session metrics when available.

## Objective

Match the expected bottom-anchored chat behavior and reduce duplicate Resume
controls without changing session transport semantics.

## Business canary

Opening a long session lands at the bottom; scrolling upward reveals a compact
down-arrow button that returns to latest. A stopped session shows `▶` in the
composer and resumes from that control. Session Info shows available duration,
message, token, and cost data without inventing missing values.

## Confirmed scope

- `src/web-ui/main.tsx`, `src/web-ui/styles.css`, focused UI tests.
- Reuse existing resume endpoint and AgentSession metadata.

## Explicit exclusions

- No transport or persistence changes.
- Do not fabricate metrics that the adapter does not provide.

## Initial estimate

- Optimistic: 25 minutes.
- Likely: 45 minutes.
- Pessimistic: 90 minutes.

## Verification

- `npm test`: build passed; 27 test files and 105 tests passed.
- Live local canary at `http://127.0.0.1:18787/`, viewport 390x844, long Codex session `019fc677-cea3-7502-a247-443eb18e0654`: initial chat distance from bottom was `0`.
- After setting the chat scroll position to the top, the `Scroll to latest` circular down-arrow appeared; clicking it returned distance from bottom to `0` and hid the button.
- The stopped-session composer exposed `Resume session` with `▶`; inspector exposed Messages, Duration, Cost, Tokens and Subagents, using `—` for unavailable adapter metadata.
