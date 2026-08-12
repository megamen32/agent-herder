# Search journal: CDP chat Agent Herder adapter seam

Date: 2026-08-12 (MSK)

## Scope

Read-only seam research for the task card `work-20260812-cdp-chat-agent-herder-adapter.md`.
No source, browser/CDP, Telegram, deployment, restart, or production E-Frontier action.

## Evidence collected

- `src/types/common.ts:3-4` defines `HarnessType` as only `opencode`, `claude`,
  `codex`, `qoder`, `hermes`, and `zcode`; `src/types/common.ts:163-258`
  defines `HarnessAdapter` as a coding-agent session lifecycle contract
  (`init`, `listSessions`, `getSession`, `sendMessage`, stop/permission/model
  operations), not a generic provider capability.
- `src/adapter-registry.ts:6-14,30-120` accepts only `AdapterFactory` values
  returning `HarnessAdapter`; registry activation calls `adapter.init()` and
  stores the adapter in the coding-session map. A `CdpChatClient` cannot be
  registered without inventing fake coding-session methods or broadening the
  registry type.
- `src/index.ts:70-107,114-274` wires the registry to concrete coding adapters,
  while `src/index.ts:575-583` creates a fresh MCP server per transport. The
  standalone route's `createCdpChatServer` (`src/cdp-chat-mcp.ts:104-112`)
  constructs one `CdpChatClient` per server; this client owns fixture/ref/gate
  state (`src/cdp-chat.ts:425-435`). Therefore Agent Herder integration must
  create one client per MCP transport/session, not one global mutable client,
  unless the product explicitly wants shared fixture ownership across clients.
- `src/web/server.ts:366-388` maps each MCP HTTP initialize to a fresh server
  transport and keeps it by MCP session id. This is the safe lifetime seam for
  per-session CDP client state. stdio has one server/client lifetime.
- `src/browserclaw-worker.ts:281-494` exposes a different seam:
  `BrowserClawBrowserDriver.execute(BrowserWorkerRequest, deadlineAt)` sends a
  fixed prompt to the allowlisted E-Frontier page; it does not expose chat
  snapshot/create/send/edit/media primitives. `src/browser-worker.ts:25-75`
  intentionally keeps the request opaque and fixed-template. Reusing it for
  CDP chat operations would violate the existing worker contract.
- `src/cdp-chat.ts:43-68` already defines the correct narrow page seam:
  `CdpChatPage` plus `CdpChatDriver.acquirePage()`. `src/cdp-chat.ts:594-603`
  reacquires and verifies page identity around every operation; fixture-only
  write/media checks are in `src/cdp-chat.ts:681-700`.
- `docs/cdp-chat-mcp.md:43-59` confirms the concrete BrowserClaw/CDP driver is
  intentionally injected through `CDP_CHAT_DRIVER_MODULE`; no concrete module
  exists in this checkout.

## Decision

`CdpChatClient` must not be modeled as a `HarnessAdapter` and must not be added
to the coding adapter registry. The smallest safe integration is an independent
MCP capability registration path that reuses the existing `CdpChatDriver`
interface and creates a per-MCP-server `CdpChatClient`. The concrete driver
factory should be configured explicitly and remain absent/disabled when
`CDP_CHAT_DRIVER_MODULE` is unset. The existing `browser_wake`/worker path stays
unchanged.

## Unresolved dependency

The repository has no implementation of `CdpChatDriver` backed by the existing
BrowserClaw MCP. A separate implementation slice must adapt the current
`BrowserClawToolClient`/page handling to `CdpChatPage`, with the same-page and
opaque identity contract. It must not call `BrowserClawBrowserDriver.execute`
or the fixed `browser_wake` prompt route.

## Proposed bounded implementation slices

1. **Capability wiring (<=20 min):** add a reusable registration helper for the
   seven standalone chat tools, add optional per-server driver/client creation
   to `src/index.ts` and the web MCP factory, and add focused schema/registration
   tests. Acceptance: no-driver default remains the existing tool set; injected
   fake driver exposes the seven tools and retains fixture state across calls.
2. **Concrete BrowserClaw page driver (<=20 min):** implement only the
   `CdpChatPage`/`CdpChatDriver` seam against the current BrowserClaw MCP session,
   with explicit page identity and safe semantic operations. Acceptance: fake
   BrowserClaw tool client proves snapshot/new-chat/read/export/send/edit/media
   mapping without existing-chat mutation.
3. **Review/live gate (separate):** fresh source review and real-user new-chat
   read-only canary; any browser failure requires same-session secret-safe
   screenshot before retry. Guarded writes remain separately approved.

## Live boundary

No live BrowserClaw/CDP page was opened, no existing E-Frontier prompt was sent,
and no credentials, restart, deployment, Telegram, or production action was
touched.

## A11y seam follow-up — 2026-08-12 07:56 MSK

- The requested structured seam is not present in Agent Herder. `src/browserclaw-worker.ts:77-80` returns only text from `callTool()` and optional screenshot bytes; `:144-228` owns the MCP JSON/SSE handshake but drops structured tool content. `BrowserClawBrowserDriver:281-494` is intentionally fixed-template E-Frontier `browser_wake` and is excluded from CDP chat.
- Local Chrome DevTools MCP confirms the intended primitive: `TextSnapshotNode` has semantic `role`, `name`, snapshot uid/id, and children (`/home/roomhacker/.local/share/chrome-devtools-mcp/src/types.ts:15-20`, `TextSnapshot.ts:54-109`); `take_snapshot`, `click`, and `fill` consume current snapshot uids (`tools/snapshot.ts:12-43`, `tools/input.ts:89-140,301-337`).
- Hermes BrowserOS confirms safe normalization: only fixed `tabs`/`snapshot` reads (`hermes-unified-inbox/src/unified_inbox/browseros.py:668-683`), exact page/origin revalidation (`:997-1036`), bounded JSON/SSE and structured/text extraction (`:1126-1273`), and fail-closed accessibility parsing (`:1632-1671`).
- Proposal: add `BrowserClawA11yNode`, `BrowserClawA11ySnapshot`, semantic `click`/`fill`/`type`/`press`, `BrowserClawA11yPage.snapshot/act`, and `BrowserClawA11yDriver.acquirePage` as a provider-neutral capability. Normalize only attested structured tree or bounded role/name/ref text; reject malformed, ambiguous, oversized, duplicate-ref, mixed-page, and stale snapshot/ref inputs.
- Ownership: one BrowserClaw MCP session -> one A11y page id; each operation re-lists tabs and proves one exact configured HTTPS origin/route. Never fall back to another tab or call `tabs new` twice. Reconnect invalidates lease. Stable provider chat/message/media ids are required before export/write/edit; transient A11y refs cannot become fingerprints.
- Media: A11y metadata is not bytes. Download requires a separately attested bounded attachment primitive; otherwise return `media_unavailable`. Do not fetch URLs or treat screenshots as media. Existing `CdpChatClient` keeps MIME/size/path and `0600` output enforcement.
- Proposed implementation graph: (1) <=20m typed structured transport/parser plus fake malformed-payload tests; (2) <=20m owned A11y page with exact lease/ref/no-second-tab tests; (3) <=20m read-only CdpChat mapper; (4) <=20m guarded writes/media only after stable refs/download schema; (5) separate review/live gate.
- No source, browser, `browser_wake`, Telegram, deployment, restart, credential, or production action was performed. Current result and task-card receipts record the full interface proposal and blockers.
