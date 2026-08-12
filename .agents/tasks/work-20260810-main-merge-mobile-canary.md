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

## Verification result

- `origin/main` was merged with the current UI history as `e88b91f`; the
  merged worktree passed `npm test` with 27 files and 101 tests.
- Fresh browser canary at 390x844 opened the long Codex session at the bottom
  (`atBottom: true`) and showed the stopped-session composer as `▶`.
- Scrolling to the top exposed the compact `Scroll to latest` down-arrow;
  screenshot: `/tmp/agent-herder-mobile-scroll-latest.png`.
- Bottom-anchored stopped-session screenshot: `/tmp/agent-herder-mobile-bottom-resume.png`.
- Remote `dev` and `agent/session-lineage-tools` branches were deleted after
  ancestry checks. The local Flint branch remains attached to a worktree with
  an untracked task file, so it was not destructively removed.
