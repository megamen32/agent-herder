# Result: CDP chat Agent Herder structured A11y seam

Status: READY_TO_IMPLEMENT

## Decisive findings

The standalone CDP chat route remains an independent MCP capability, not a
`HarnessAdapter`: `src/adapter-registry.ts:6-14,30-120` only accepts coding-agent
session lifecycle adapters, while `CdpChatDriver` at `src/cdp-chat.ts:66-68`
is the correct provider seam. The reviewed namespaced wiring already creates a
fresh `CdpChatClient` per MCP server/session; the existing `browser_wake` path
must remain unchanged.

The current BrowserClaw seam is insufficient for a concrete driver:
`src/browserclaw-worker.ts:77-80` exposes only text `callTool()` plus optional
screenshot bytes, and `:144-228` currently projects MCP results to text. The
prompt-oriented `BrowserClawBrowserDriver` at `:281-494` owns the fixed
E-Frontier `browser_wake` lifecycle and cannot be reused for list/search/export,
fixture binding, message identity, or media operations.

## Supported capability proposal

Add a provider-neutral structured A11y capability beside the prompt worker. Its
minimal public model is:

```ts
interface BrowserClawA11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  children: readonly BrowserClawA11yNode[];
}

interface BrowserClawA11ySnapshot {
  schema: "agent-herder.browserclaw-a11y.v1";
  page: number;
  url: string;
  snapshotRef: string;
  root: BrowserClawA11yNode;
}

type BrowserClawSemanticAction =
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "press"; key: string };

interface BrowserClawA11yPage {
  snapshot(deadlineAt: number): Promise<BrowserClawA11ySnapshot>;
  act(input: {
    snapshotRef: string;
    action: BrowserClawSemanticAction;
  }, deadlineAt: number): Promise<BrowserClawA11ySnapshot>;
}

interface BrowserClawA11yDriver {
  acquirePage(): Promise<BrowserClawA11yPage>;
}
```

`BrowserClawMcpClient` should expose one typed structured-result method while
preserving string `callTool()` for `browser_wake`. Normalize only an attested
`structuredContent` tree or the existing bounded role/name/ref text form;
ambiguous, malformed, oversized, duplicate-ref, or mixed-page payloads fail
closed. `act` accepts only semantic role/name/ref actions, requires the latest
`snapshotRef` and node ref, and returns a fresh post-action snapshot.

## Evidence and safety boundaries

- A11y precedent is local and concrete: Chrome DevTools MCP's
  `TextSnapshotNode` contains a tree, `role`, `name`, snapshot id, and children
  (`/home/roomhacker/.local/share/chrome-devtools-mcp/src/types.ts:15-20`,
  `TextSnapshot.ts:54-109`); `take_snapshot`, `click`, and `fill` consume the
  latest semantic uid (`tools/snapshot.ts:12-43`, `tools/input.ts:89-140,301-337`).
- Hermes BrowserOS provides the validation pattern: fixed allowlisted calls
  (`hermes-unified-inbox/src/unified_inbox/browseros.py:668-683`), exact page
  origin revalidation (`:997-1036`), bounded JSON/SSE and structured/text
  extraction (`:1126-1273`), and fail-closed snapshot parsing (`:1632-1671`).
- One BrowserClaw MCP client owns one session id; one A11y driver owns one page
  id. Every operation re-lists tabs and requires exactly one matching page and
  exact configured HTTPS origin/route. Missing, reused, duplicate, or changed
  identity invalidates the lease; it must not fall back to another tab.
- Acquisition may establish one explicitly configured page, but must never call
  `tabs new` a second time. A reconnect invalidates ownership instead of
  silently reacquiring a replacement. The adapter never calls
  `BrowserClawBrowserDriver.execute()` and never targets existing E-Frontier.
- `CdpChatClient` already rechecks page identity at `src/cdp-chat.ts:594-603`
  and binds opaque refs at `:622-700`. The concrete mapper must provide stable
  provider chat/message/media ids; transient A11y refs cannot be silently
  converted into fingerprints. Without stable ids, read-only snapshot/search
  may remain available but export/write/edit must fail closed as stale-ref.
- A11y exposes attachment metadata only. Raw bytes require a separately
  attested BrowserClaw attachment primitive; no URL fetch, page script, or
  screenshot-as-media fallback is allowed. If absent, return `media_unavailable`.
  Existing `CdpChatClient` retains MIME/size/path bounds and confined `0600`
  file creation at `src/cdp-chat.ts:570-591`.

## Checked and rejected hypotheses

- Do not add CDP chat to `HarnessType` or fake coding-session methods: this
  would pollute discovery/control semantics.
- Do not reuse `browser_wake`, arbitrary `evaluate`, CSS/XPath selectors,
  DOMSnapshot scripts, raw URL navigation, or generic tool calls.
- Do not claim a live BrowserClaw/CDP canary: no concrete driver, attested
  structured upstream schema, or attachment-download tool exists in this
  checkout, and no browser action was performed.

## Bounded implementation graph

1. **Structured transport/parser, <=20 min:** modify
   `src/browserclaw-worker.ts` only to add a typed response method that leaves
   `callTool()`/`browser_wake` intact; add `src/browserclaw-a11y.ts` and
   `tests/browserclaw-a11y.test.ts`. Acceptance: fake MCP structured/text and
   JSON/SSE responses normalize to one bounded tree; malformed cases reject.
2. **Owned A11y page, <=20 min:** add
   `src/browserclaw-a11y-page.ts` and fake tests. Acceptance: one session/page,
   exact tab/origin checks, no second `tabs new`, stale refs rejected, and every
   action returns a fresh snapshot.
3. **Read-only CdpChat mapper, <=20 min:** add
   `src/browserclaw-cdp-chat.ts` for `CdpChatDriver`/`CdpChatPage` snapshot,
   list/search/export and no-prompt fixture creation. Acceptance: opaque
   identity, production rows never bind as fixture, lease/ref changes fail
   closed.
4. **Guarded writes/media, <=20 min:** only after stable refs and an attested
   download schema; preserve existing confirmation/version/idempotency gates and
   prove MIME/byte/path bounds. If missing, stop with `NEEDS_REDECOMPOSITION`.
5. **Separate review/live gate:** fresh review then explicit approval for one
   same-page disposable-chat read-only canary. Browser failure/timeout/ambiguous
   state requires a same-session secret-safe screenshot before retry; no live
   E-Frontier prompt or guarded write is authorized here.

## Evidence

- `graphify query` used the existing persistent graph for initial repository
  orientation; direct `nl`/`rg` probes above are authoritative for this seam.
- `git status --short` showed no task-owned source edits. No browser, CDP page,
  `browser_wake`, Telegram, deployment, restart, or credential action occurred.
- Detailed append-only receipt is in
  `.agents/tasks/work-20260812-cdp-chat-agent-herder-adapter.md`; search journal
  is in `.agents/shared-session/search/work-20260812-cdp-chat-agent-herder-adapter/search-cdp-chat-agent-herder-adapter.md`.

Smallest next slice: implement items 1 and 2 as separate fake-contract workers;
stop before item 3 if the structured upstream payload or stable ref contract is
not attested.
