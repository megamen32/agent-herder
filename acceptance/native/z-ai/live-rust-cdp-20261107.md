# Z.ai live Rust direct-CDP receipt

- Date: 2026-11-07.
- Browser: Chrome `156.0.8078.80` on `mac-mini-2012.lan`; selected instance `google-chrome-default-profile`.
- Route: Rust browser-level CDP WebSocket over the SSH loopback tunnel; Origin port `9222`.
- Scope: authenticated Z.ai page selected by explicit browser context; Rust checked the account-scope hash before creating a target. The target was new and task-owned.
- Operation: submit marker `HERDER_ZAI_DIRECT_RUST_CDP_20261107_OK` once; use the returned provider `chat_id` for immediate same-chat readback; close only the created target. No retry occurred.
- Observed Rust output: `ZAI rust_create=ok rust_input_event=ok rust_send=clicked rust_reply=matched rust_readback=true messages=2`.
- Outcome: the user message and assistant marker were both present in the two-message readback. The raw provider chat ID and account identifier were not retained in the captured summary.
- HumanStop boundary: no ChatGPT page or request was used.

This summary records the previously completed V088C operation. It is not a new provider request. Related test evidence: task plan `20261107-herder-native-mcp-breaking`, leaf V088C, and its linked V088C result.
