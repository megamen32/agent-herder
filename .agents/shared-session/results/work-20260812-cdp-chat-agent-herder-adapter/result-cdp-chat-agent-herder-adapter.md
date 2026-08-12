# Result: CDP chat Agent Herder adapter seam

Status: READY_TO_IMPLEMENT

## Decisive finding

The standalone CDP chat route cannot safely be registered as a normal
`HarnessAdapter`: `src/adapter-registry.ts:6-14,30-120` requires coding-agent
session methods and `src/types/common.ts:163-258` has no generic capability
variant. `CdpChatDriver` (`src/cdp-chat.ts:66-68`) is the right independent
provider seam.

The correct integration lifetime is per MCP server/session. `src/index.ts:575-583`
creates one MCP server per transport; `src/web/server.ts:374-384` creates one
HTTP transport/server per MCP session. A `CdpChatClient` must be constructed in
that server factory so its fixture, opaque refs, page lease, and write gates
remain scoped to one MCP client session.

## Existing mechanism and blocker

The current BrowserClaw code is prompt-oriented: `src/browserclaw-worker.ts:281-494`
implements `BrowserClawBrowserDriver.execute(BrowserWorkerRequest, deadlineAt)`
for the fixed `browser_wake` templates. It does not implement
`CdpChatPage.snapshot/createChat/sendMessage/editMessage/downloadMedia`, and the
opaque worker schema intentionally excludes arbitrary chat payloads.

The standalone docs (`docs/cdp-chat-mcp.md:43-59`) therefore correctly defer a
concrete `CDP_CHAT_DRIVER_MODULE`. No such module was found in the repository.
The concrete driver is a separate implementation slice, not a reason to fake a
`HarnessAdapter`.

## Checked hypotheses

- Rejected: add `cdp-chat` to `HarnessType` and fake coding session methods.
  This would pollute session discovery/control and make registry status lie.
- Rejected: reuse `BrowserClawBrowserDriver.execute`/`browser_wake`.
  That path sends a fixed prompt and cannot support chat list/search/export or
  fixture-bound media/edit operations.
- Supported: add an independent MCP capability registration helper, optionally
  enabled by an explicit driver factory, while preserving the existing coding
  adapter registry and `browser_wake` path.

## Bounded next slices

1. Capability wiring, max 20 active minutes: register the seven standalone chat
   tools through a reusable helper and create one `CdpChatClient` per MCP
   server/session. Acceptance: existing no-driver behavior is unchanged; an
   injected fake driver exposes all seven tools and preserves fixture state.
2. Concrete BrowserClaw adapter, max 20 active minutes: implement the
   `CdpChatPage`/`CdpChatDriver` seam over the existing BrowserClaw MCP page
   primitives. Acceptance: fake BrowserClaw tool calls prove same-page
   snapshot/new-chat/read/export/send/edit/media behavior and no production chat
   mutation.
3. Separate review/live gate: fresh reviewer plus explicit live-step approval
   for one disposable new chat and read-only proof; guarded writes separately.

## Evidence checks

- `graphify query "How should the standalone CdpChatDriver and CDP chat MCP integrate with Agent Herder's HarnessAdapter and adapter registry? Trace concrete interfaces, initialization, disposal, and safety boundaries." --budget 1800`
  confirmed the registry/adapter cluster but was too broad; direct line-level
  probes above are authoritative.
- `git show --stat 030a12d` confirms standalone implementation commit `030a12d`
  contains only standalone chat source/tests/docs and task snapshots.
- Worktree status was read-only; existing foreign dirty paths were preserved.
- No live/browser/CDP action was performed.
