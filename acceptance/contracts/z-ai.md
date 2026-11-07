# Z.ai native capability matrix

## Version and route

- Browser observed on 2026-11-07: Chrome `156.0.8078.80` on `mac-mini-2012.lan`.
- Provider client build/version: not captured; no version claim is made.
- Authenticated account: existing Z.ai browser session. Rust computes and checks a SHA-256 account scope inside the page; account identifiers and credentials are not exported.
- Transport: direct browser-level Chrome DevTools WebSocket through the task's SSH loopback tunnel, with Chrome's remote Origin port set to `9222`. Herder binds the selected node, Chrome instance, browser context, and target.
- Implementation: [Rust Z.ai adapter](../../crates/herder/src/adapters/zai/mod.rs) and [shared CDP transport](../../crates/herder/src/adapters/cdp.rs).
- Evidence inputs: [typed message fixture](../native/z-ai/messages-batch.json), the recorded V088B browser proof in the task tracker, and the [V088C Rust receipt](../native/z-ai/live-rust-cdp-20261107.md).

## Capabilities

| Capability | Observed route | Result and limit |
|---|---|---|
| Select authenticated account | In-page same-origin `GET /api/v1/chats/?page=1&type=all&channel=zai-web&project_id=`, then `GET /api/v1/chats/{id}` for the first listed chat | Rust hashes `user_id` and compares the expected account scope. This is an identity check; it is not a complete chat-list implementation and requires at least one existing chat. |
| Attach to exact browser target | Browser WebSocket `Target.getTargets`, `Target.attachToTarget`, `Target.getTargetInfo` | Target type, target ID, and browser context are checked before provider reads. No neighboring target is closed. |
| Create a new chat page | `Target.createTarget` at `https://chat.z.ai/` in the selected browser context; attach to that exact target and wait for its origin | Live Rust run succeeded. A bounded origin wait handles Chrome attaching before navigation completes. Cleanup closes only the target created by this connection. |
| Read one chat | Same-origin `GET /api/v1/chats/{chat_id}`; then `POST /api/v1/chats/{chat_id}/messages/batch` for requested message IDs, in batches of at most 60 | Rust verifies account scope, response chat ID, returned message IDs, ordering, roles, and text. The DTO fixture covers text/markdown blocks and filters internal roles. Live Rust readback returned the same chat's user and assistant messages. |
| Send the first message | On the new-chat page, Rust fills the visible composer with CDP input events, verifies the exact text and ready state, then clicks `#send-message-button` | One live marker was submitted once. Rust obtained the provider chat ID from the page route and used that exact ID for readback. There is no automatic resend after an uncertain outcome. |
| Per-message correlation | Provider message IDs are read from the messages batch response; the visible composer itself exposes no message ID | Live browser proof observed no message IDs in the DOM. A click alone is not treated as delivery; Rust checks the user message and expected assistant marker in the same chat. |
| List all chats as a Rust operation | No `ZaiReader::list_chats()` operation exists yet | **Not implemented in the current adapter.** The account-scope check reads only the first chat from the list response. V090A is the dependent implementation leaf; no full-list support is claimed here. |
| Interrupt/stop, context injection, permission reply, event replay | No corresponding Z.ai adapter methods or verified provider routes | **Not established.** These operations remain unsupported by the current Herder Z.ai adapter; provider-side support has not been tested. |

## Live Rust receipt

The exact observed result and its limits are preserved in [the live receipt](../native/z-ai/live-rust-cdp-20261107.md). The run used one task-owned target, submitted one benign marker, read back two messages from the returned chat ID, and closed the target. The captured summary omits the raw chat ID, so this is a redacted operation receipt rather than an ID-level provider receipt.

This matrix proves the Rust adapter's direct CDP create/send/read path for one authenticated browser profile. It does not establish the full chat list, interrupt, context injection, permission reply, event replay, a provider client build number, or public MCP acceptance.
