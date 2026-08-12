# Real UI test of Agent Herder Codex harness filter

Role: Tester

## Goal

Use `http://127.0.0.1:18787` as a real user and verify that selecting Codex
changes the rendered session list.

## Known evidence

The live API returns 132 mixed sessions and 100 Codex sessions for
`?harness=codex`, so the test must distinguish UI/cache failure from API.

## Allowed actions

BrowserOS only: open the exact URL, select Codex filter, inspect visible session
list and browser request state, reload the page if needed. No source edit,
service change, config/cache clearing outside this browser page, login/secret
access, or unrelated browse.

## Acceptance

Append before/after visible evidence, actual request if observable, and one of
`PASS`, `CHANGES_REQUIRED`, or `STOP_MISSING_REAL_SURFACE`; return only TL;DR.

## Status

Active.

## Tester evidence

- Surface: BrowserOS page at `http://127.0.0.1:18787/` in page 6.
- Initial visible state before interaction: Harness filter showed `All harnesses`; the rendered session tree contained mixed providers/harnesses, including `opencode` rows in the `/home/roomhacker` group.
- Interaction performed: opened the live page, set the Harness filter select to `codex`, and clicked `Apply filters` from the page context.
- Observed after interaction:
  - The Harness filter select value reverted to `All harnesses` when re-read from the DOM.
  - The visible session tree still showed the mixed `/home/roomhacker` group with `16 sessions · 1 providers · opencode` and opencode rows.
  - The browser URL remained `http://127.0.0.1:18787/?harness=codex`.
  - Browser resource history showed repeated requests only to `http://127.0.0.1:18787/api/sessions?` with no preserved `harness=codex` query in the observed request URLs.
- Result: `CHANGES_REQUIRED`
- Smallest in-scope repair suggestion: make the harness select persist into the page state that drives `/api/sessions` so the visible tree re-renders from the codex-filtered response instead of snapping back to `All harnesses`.

## Follow-up tester run

- Surface: BrowserOS page 6 at `http://127.0.0.1:18787/?harness=codex`.
- Before interaction: the Harness filter combobox still read `All harnesses`, while the visible list under `Projects / sessions` showed mixed harness content including `opencode` rows in `/home/roomhacker`.
- Interaction performed: selected `codex` in the Harness filter and clicked `Apply filters`.
- After interaction:
  - The Harness filter combobox displayed `codex`.
  - The visible session list still showed the same mixed `/home/roomhacker` group with `opencode` rows rather than a codex-only render.
  - The page URL stayed `http://127.0.0.1:18787/?harness=codex`.
  - Page resource history included both `http://127.0.0.1:18787/api/sessions?` and `http://127.0.0.1:18787/api/sessions?harness=codex`; the UI did not reflect the codex-filtered response in the visible tree.
- Result: `CHANGES_REQUIRED`
- Smallest in-scope repair suggestion: keep the applied harness value synchronized with the render state that populates `Projects / sessions`, and ensure the visible tree rerenders from the codex-filtered session payload after Apply.

## Final tester run

- Surface: BrowserOS page 6 at `http://127.0.0.1:18787/?harness=codex`.
- Before interaction: the Harness filter combobox showed `codex`. The `Projects / sessions` list was already rendered as codex-only groups, with counts like `35 sessions · 1 providers · codex`, `6 sessions · 1 providers · codex`, `10 sessions · 1 providers · codex`, `1 sessions · 1 providers · codex`, and `34 sessions · 1 providers · codex`.
- Interaction performed: expanded the `/home/roomhacker/agents-projects` group and inspected the visible rows under it.
- After interaction:
  - The expanded group stayed in codex form, with rows labeled `idle`, `codex`, `external`, and `model unknown`.
  - The page URL remained `http://127.0.0.1:18787/?harness=codex`.
  - Browser resource history showed repeated fetches to `http://127.0.0.1:18787/api/sessions?harness=codex`.
  - The visible render no longer showed mixed-harness `opencode` rows.
- Result: `PASS`
- Note: this live browser session confirms the Codex filter now drives the rendered session list and the request URL.
