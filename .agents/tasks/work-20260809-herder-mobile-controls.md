# Task: mobile chat controls and visual palette

## Original request

On iPhone, Chat menu does not open, chat does not auto-scroll to the bottom,
there is no jump-to-latest button, and session search is missing. Then align
the colors more closely with the supplied iPhone reference: black, graphite,
white, and purple.

## Objective

Make the mobile chat controls functional and make the Herder palette match the
reference visual language without changing backend transport.

## Business canary

At 390x844 the user can search sessions, open Chat menu, scroll away from a
long transcript and see a Latest button, then return to the bottom with it.

## Confirmed scope

- `src/web-ui/main.tsx` and `src/web-ui/styles.css`.
- Focused UI regression and live browser canary.

## Explicit exclusions

- No backend, adapter, transport, or session-data changes.

## Initial estimate

- Optimistic: 25 minutes.
- Likely: 45 minutes.
- Pessimistic: 90 minutes.

## Implementation and verification evidence — 2026-08-09

- Chat menu now has a working toggle and exposes reasoning/tools/session-info
  actions on mobile.
- Added session search button and query input; search covers title, id,
  harness, CWD, and last-message preview.
- Added layout-safe iOS scrolling, follow-bottom behavior after transcript
  updates, and a `Scroll to latest` button when the user scrolls away.
- Replaced the brown palette with black/graphite surfaces, white text, and
  purple accent matching the supplied reference.
- Full suite: 26 files, 92 tests passed.
- Live service: `agent-herder.service` active after restart.
- Browser canary at 390x844: search and Chat menu controls present, no page
  overflow; menu opened successfully, Latest appeared after scroll-up and
  returned the transcript to `atBottom: 0`.
