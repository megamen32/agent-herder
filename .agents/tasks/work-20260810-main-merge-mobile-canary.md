# Task: merge Herder UI fix into main and provide mobile evidence

## Original request

Push the current work to `main`, merge the other relevant branches, run the
browser tester, and provide a real screenshot of the mobile chat behavior.

## Objective

Make the bottom-anchored chat, compact jump-to-latest control, and stopped-
session Resume control available from the canonical `main` branch, with a
fresh browser canary and screenshot.

## Business canary

At 390x844, a long session opens at the latest message; scrolling upward shows
the down-arrow and clicking it returns to the latest message; a stopped session
shows the `▶` Resume control.

## Confirmed scope

- Merge the completed UI commit into `main`.
- Run fresh browser verification and save a screenshot.
- Push the resulting `main` and remove only obsolete merged local branches.

## Explicit exclusions

- Do not stage or alter unrelated dirty adapter, MCP, or generated files.
- Do not merge unrelated branches without reviewing their commit scope.

## Initial estimate

- Optimistic: 15 minutes.
- Likely: 25 minutes.
- Pessimistic: 45 minutes.
