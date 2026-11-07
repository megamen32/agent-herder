# Experimental native HTTP transport

This independent crate composes RMCP's 2026-07-28 sessionless streamable HTTP
transport with a per-request OAuthAuthority and an ApplicationPort. It has no
production launcher, no built-in authority process, and no token store. The
embedder must establish that its authority is the live canonical owner through
an authenticated channel; never deserialize client-provided identity or trust a
forwarded header as a verified principal. Every HTTP method is authenticated
before RMCP dispatch, verified principal is placed in a private in-process
request extension, and self remains unbound. Authority failure or three-second
timeout denies the request. The application still checks its own exact grants.

Run the isolated integration test with explicit paths:

```
HERDER_OAUTH_STORE_MODULE=/absolute/path/to/dist/mcp/oauth-token-store.js \
HERDER_TEST_OPENCODE_BIN=/absolute/path/to/opencode \
cargo test --manifest-path crates/herder-http/Cargo.toml --test live_oauth_http -- --ignored --nocapture
```

The test starts one isolated real McpOAuthTokenStore process and communicates
through private inherited pipes; it is a fixture, not a production IPC adapter.
It starts an isolated real OpenCode and tests an ordinary HTTP client against the
native `session/recent` application. It checks the exact target grant, rejects a
different target, then revokes with the same live store object. Repeating on the
same observed HTTP/1.1 TCP connection is denied before the now-stopped native
reader. A stalled authority and a killed authority also fail closed. The 2026
native lifecycle intentionally has no MCP session ID; no legacy session is
created or claimed. Output is an empty test conversation, not a message canary.

Production remains unconnected: CI owner must change `src/web/server.ts` at the
verified OAuth branch to expose each request's result through an authenticated,
process-owned and bounded channel from the *same* in-memory store owner, or
transfer the canonical OAuth authority to a new owner at cutover. The test pipe
is created by the test parent and does not establish how the real daemon will
securely originate the production channel. A per-request recheck, issuer,
audience, scope, expiry and revocation must be preserved on that channel. No
second file reader or cached token copy is acceptable. The response timeout does
not by itself cancel an arbitrary blocking verifier implementation; production
IPC must bound, cancel and quarantine failed exchanges. Integration of this
crate with the shared Cargo/library configuration, native launcher, authoritative
session-ref resolution and production routing remains subject to coordination.
