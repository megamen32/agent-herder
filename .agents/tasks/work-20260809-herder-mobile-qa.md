# Agent Herder mobile QA

## Original request

Independently test the Agent Herder site on a mobile-sized viewport and report
what is unusable. Verify session selection and Codex/OpenCode/CWD filtering.

## Objective

Produce a read-only mobile UX report for the current live Agent Herder site.

## Business canary

At 390x844, a tester can identify a harness, filter sessions by harness and
CWD, open a session, read the latest conversation, and reach the composer and
compact actions without layout breakage.

## Scope

- Live site `http://127.0.0.1:18787`.
- Mobile viewport and touch-sized interaction.
- No source edits, service changes, or commits.

## Status

Tester assigned; report appended.

## Tester report — 2026-08-09

Verdict: `STOP_MISSING_REAL_SURFACE`

### Surface and method

- Intended real surface: live website `http://127.0.0.1:18787` through BrowserOS/Touchpoint computer use.
- Intended viewport: approximately 390x844.
- Scope: read-only mobile UX journey covering harness/session selection, Codex/OpenCode/CWD filters, session opening, conversation reading, reasoning, composer, compact actions, and scrolling.
- No source, service, configuration, browser state, or task-product changes were made.

### Blocking evidence

1. Called Touchpoint `windows` to enumerate the available real browser surface: failed with `Transport closed`.
2. Called Touchpoint `diagnostics` to verify browser/web-content availability: failed with `Transport closed`.
3. Because the required real-user surface could not be reached, no viewport resize or UI interaction was attempted. Per Tester boundary, shell/HTTP probes, source inspection, or synthetic checks would not constitute the required real-use test.

### Findings

- P0/P1/P2 UX findings: not assessed; no defensible severity can be assigned without the live UI.
- Acceptance canary: unverified — harness identification, Codex/OpenCode/CWD filtering, session opening, conversation/reasoning visibility, composer/actions, and scrolling were not exercised.
- Smallest repair: restore/reconnect the BrowserOS/Touchpoint real browser surface, then rerun this task as an independent mobile UX gate at 390x844.

## Tester follow-up — 2026-08-09

Verdict: `STOP_MISSING_REAL_SURFACE`

### Requested fallback

- Parent reported that BrowserOS CDP should answer on `http://127.0.0.1:9223` and requested a new CDP tab for the same read-only journey.
- In this Tester context, no BrowserOS CDP or Playwright tool is exposed. The only available website computer-use surface is Touchpoint, already evidenced above as unavailable with `Transport closed`.
- Tester hard boundary prohibits substituting shell commands or a hand-written CDP/test script for the real user-facing surface. Therefore no CDP navigation, viewport change, click, or DOM assertion was performed.

### Evidence and result

- The requested journey remains unverified: `?harness=opencode`, first session card, fixed composer, horizontal overflow, reasoning collapsed state, mobile back, Codex/OpenCode options, and CWD filter.
- No P0/P1/P2 UX finding is asserted because the live UI was not exercised.
- No source, service, configuration, browser state, or task-product changes were made.

### Smallest next step

Expose a supported BrowserOS CDP/Playwright computer-use surface to the Tester (or restore Touchpoint), then rerun the exact 390x844 smoke.
