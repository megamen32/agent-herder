# Real UI test of Agent Herder Codex harness filter

Role: Tester

## Goal

Use the actual Agent Herder website as a user would and determine whether
selecting Codex changes visible sessions.

## Known evidence

Live API currently returns 132 mixed sessions unfiltered and 100 Codex sessions
for `?harness=codex`; source query path is coherent. The reported defect may be
browser cache/stale bundle rather than API filtering.

Known test URL: `http://127.0.0.1:18787`.

## Allowed actions

Read-only BrowserOS computer-use/browser inspection of the Agent Herder site:
load page, select Codex filter, observe rendered list/network-visible result,
reload if needed. No source edit, service restart, cache clearing beyond the
test page, login/secret access, deployment, or unrelated browsing.

## Acceptance

Append exact user journey, visible before/after evidence, actual request if
observable, and verdict: `PASS`, `CHANGES_REQUIRED`, or
`STOP_MISSING_REAL_SURFACE`. Return only TL;DR.

## Status

Stopped — initial Tester had no URL/tab; a fresh Tester receives the known URL.

## Tester evidence (2026-08-04)

- Surface/tool: BrowserOS managed tabs (`mcp__browseros__tabs`, `action=list`).
- Exact journey attempted: inspected the available user-owned browser tabs to locate the Agent Herder website before interacting. Available tabs were the ANO IRI applications site (pages 1 and 3), Telegram Web (page 2), GPTAdmin Login (page 4), and ChatGPT (page 5). No Agent Herder tab or identifiable Agent Herder URL was available.
- Before/after UI evidence: unavailable; the required real surface could not be located, so Codex filter selection was not attempted and no visible session list/request can be verified.
- Stop condition: required real surface missing. No source, API, logs, configuration, cache, or unrelated pages were inspected.
- Verdict: `STOP_MISSING_REAL_SURFACE`.
