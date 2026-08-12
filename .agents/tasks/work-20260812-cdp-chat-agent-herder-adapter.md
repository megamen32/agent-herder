# Task: integrate CDP website chat MCP into Agent Herder

Started at: 2026-08-12 05:28 MSK
Lifecycle provenance: copied from todo-20260812-cdp-chat-agent-herder-adapter.md before bounded research; standalone implementation already exists in commit 030a12d and is treated as reviewed input, not reimplemented.
Last task-file mtime observed: 2026-08-12 05:28 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: active Lead task
Last PID signal: none
Last task-file transition: follow-up opened; research pending.

## Original request

> да доделай

## Objective

Add the reviewed standalone CDP chat MCP to Agent Herder as a provider adapter and establish the safe BrowserClaw/CDP driver seam without touching the existing production E-Frontier conversation.

## Business canary

Only after an explicit live-step approval: one same-page new disposable chat, read-only list/search/export/media proof, then separately approved guarded writes. No existing E-Frontier prompt.

## Confirmed scope

- Registry adapter integration, concrete driver seam, local tests/docs.
- Preserve standalone safety contract and foreign dirty changes.

## Explicit exclusions

- Telegram/Overpod, existing production E-Frontier, credentials/MFA, Custom GPT, restart/deployment without explicit approval.

## Initial estimate (UTC+3, immutable)

- Started: 2026-08-12 05:28 MSK
- Minimum / maximum active time: 30 / 90 active minutes; live canary/restart/deploy separately gated.

## Plan / execution

- Bounded research Worker pending.

## Worker research receipt — 2026-08-12 05:31 MSK

- Worker status: `NEEDS_REDECOMPOSITION`; session `019ff3cd-ad29-73e0-b9cd-6a3ef1b2d19a` completed and was closed only after terminal receipt.
- Business delta: `0`; no live BrowserClaw/CDP or E-Frontier interaction.
- Evidence: registry expects `HarnessAdapter`; standalone implementation exposes `CdpChatDriver`; direct integration is an unresolved architecture seam. Commit `030a12d` is already in HEAD.
- Route correction: split the follow-up into a <=15-minute seam-decision research slice, then a separate <=20-minute implementation slice. Live canary remains separately gated.

## Overseer receipt — 2026-08-12 05:34 MSK

- Verdict: `CONTINUE`.
- Next bounded action: one <=10-minute read-only research slice for the exact
  `HarnessAdapter` ↔ `CdpChatDriver` boundary; no source or live changes.

## Overseer assignment after NEEDS_REDECOMPOSITION

Audit the split and select the smallest safe seam decision. Read the task card
and current receipts only; no source edits, browser/CDP, Telegram, deployment,
or new implementation worker. Return CONTINUE, RETHINK, ASK_USER, or
STOP_SCOPE_DRIFT with one bounded next slice, maximum 10 active minutes.

## Append-only estimate revisions

None.

## Evidence / result

## Worker research receipt — 2026-08-12 05:43 MSK

- Worker status: `READY_TO_IMPLEMENT`; business-canary delta `0`. This was a
  read-only seam audit; no BrowserClaw/CDP page, existing E-Frontier prompt,
  Telegram/Overport path, credentials, restart, deployment, or production
  action was used.
- Decisive boundary: `src/types/common.ts:3-4,163-258` defines
  `HarnessType`/`HarnessAdapter` only for coding-agent session lifecycle.
  `src/adapter-registry.ts:6-14,30-120` accepts only factories returning that
  interface and invokes `init()`. The standalone `CdpChatDriver` at
  `src/cdp-chat.ts:66-68` is a page capability, not a coding harness; adding
  fake session methods or a fake harness type would make registry discovery and
  control semantics lie.
- Existing BrowserClaw seam is not reusable for this purpose:
  `src/browserclaw-worker.ts:281-494` implements
  `BrowserClawBrowserDriver.execute(BrowserWorkerRequest, deadlineAt)` for the
  fixed `browser_wake` prompt templates. It does not expose page snapshot,
  create-chat, message edit/send, or media primitives, and
  `src/browser-worker.ts:25-75` intentionally keeps that request opaque.
  `browser_wake` remains unchanged.
- Correct lifetime seam: `src/index.ts:575-583` creates one MCP server per
  transport; `src/web/server.ts:374-384` creates a fresh MCP server for each
  initialized HTTP session. Construct one `CdpChatClient` in that server
  factory so fixture binding, opaque references, page lease, and write gates
  remain scoped to one MCP session. Do not use one global mutable client unless
  shared fixture ownership is explicitly selected.
- Concrete driver remains unresolved: `docs/cdp-chat-mcp.md:43-59` and the
  repository search show only the injected `CDP_CHAT_DRIVER_MODULE` contract;
  no BrowserClaw-backed `CdpChatDriver` implementation exists in this checkout.
  This is a separate <=20-minute implementation slice, not grounds to fake a
  `HarnessAdapter`.
- Proposed next slices: (1) <=20 minutes, independent MCP capability wiring
  using `registerCdpChatTools` and per-server `CdpChatClient`, with a fake-driver
  registration/lifetime test; (2) <=20 minutes, concrete `CdpChatPage`/
  `CdpChatDriver` over BrowserClaw MCP page primitives with fake-client proof;
  (3) separate fresh review and explicitly approved same-page disposable-chat
  read-only canary. Guarded writes remain separately approved.
- Detailed receipts: `.agents/shared-session/search/work-20260812-cdp-chat-agent-herder-adapter/search-cdp-chat-agent-herder-adapter.md`
  and `.agents/shared-session/results/work-20260812-cdp-chat-agent-herder-adapter/result-cdp-chat-agent-herder-adapter.md`.
