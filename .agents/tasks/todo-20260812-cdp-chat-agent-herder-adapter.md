# Task: integrate CDP website chat MCP into Agent Herder

Started at: 2026-08-12 05:28 MSK
Lifecycle provenance: new follow-up created from the completed standalone CDP website chat MCP request after the user said `да доделай` and selected adding it to Agent Herder as an adapter.
Last task-file mtime observed: 2026-08-12 05:28 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: active Lead task
Last PID signal: none
Last task-file transition: follow-up opened; no source mutation for this task yet.

## Original request

> да доделай

Context: standalone CDP website chat MCP is complete; now add it to Agent Herder as an adapter and finish the concrete BrowserClaw/CDP path where safe.

## Objective

Integrate the reviewed standalone CDP website chat MCP into Agent Herder's MCP registry as a provider adapter, while preserving the existing `browser_wake` changes and single-page/fixture safety. Provide a supported concrete BrowserClaw/CDP driver seam, but do not send any real production ChatGPT prompt during implementation.

## Business canary

With explicit authorization for the consequential live step: use the existing authenticated ChatGPT/E-Frontier BrowserClaw page, create exactly one new disposable chat in the same page, prove `list_chats`, `search_chat`, bounded `export_chat`, and media behavior on that new fixture, then use guarded write operations only if separately approved. Existing E-Frontier conversation must never be targeted.

## Confirmed scope

- Agent Herder registry adapter integration for the seven standalone tools.
- Reuse the existing BrowserClaw/single-page worker seam where possible.
- Configuration/entrypoint documentation and focused integration tests.
- Preserve task-owned standalone contract and all foreign dirty changes.

## Explicit exclusions

- Telegram MCP, Overpod, Telegram polling, or Telegram code changes.
- Existing production E-Frontier conversation.
- BrowserClaw restart, deployment, or registry rollout without a separate explicit approval.
- Custom GPT/plugin configuration, credentials, MFA, or secret handling.

## Initial estimate (UTC+3, immutable)

- Started: 2026-08-12 05:28 MSK
- Minimum / maximum active time: 30 / 90 minutes for research, adapter integration, and local verification; live BrowserClaw canary/restart/deployment remain separately gated.

## Plan / execution

- Pending bounded Worker research of the existing Agent Herder MCP registration and BrowserClaw worker HTTP/page seam.

## Append-only estimate revisions

None.

## Evidence / result

Pending.
