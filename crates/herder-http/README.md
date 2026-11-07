# Experimental native HTTP transport

This independent crate composes RMCP's 2026-07-28 sessionless streamable HTTP
transport with a per-request OAuthAuthority and an ApplicationPort. It has no
production authority integration or token store. The
embedder must establish that its authority is the live canonical owner through
an authenticated channel; never deserialize client-provided identity or trust a
forwarded header as a verified principal. Every HTTP method is authenticated
before RMCP dispatch, verified principal is placed in a private in-process
request extension, and self remains unbound. Authority failure or three-second
timeout denies the request. The application still checks its own exact grants.

The executable `herder-http --listen 127.0.0.1:PORT` is a fail-closed launcher:
it binds loopback only, uses an unavailable authority and an unconnected
application, and returns 401. It is not the production composition. It accepts
no environment, HTTP header, fd number or path as proof of an issuer.

`authority_channel::AuthorityChannel` is an adapter for an already-connected
UnixStream that the embedding owner has authenticated and exclusively owns.
The constructor does not establish peer identity; using an arbitrary connected
socket, a same-UID peer, client-provided fd or a path alone would be unsafe.
The unconfigured launcher intentionally does not instantiate this adapter.
Each call sends a big-endian 32-bit length and UTF-8 JSON with `version:1`,
`bearer`, `issuer`, `audience`, and `required_scope`. The issuer replies with
the same framing and either `version:1,status:denied`, or `version:1`,
`status:verified`, `subject`, `issuer`, `audience`, `scopes`, `expires_at_ms`.
Frames are capped at 16 KiB and bearer values at 4096 bytes. Requests serialize;
timeout, cancellation, malformed frames and disconnect close/quarantine the
channel. A trusted owner must authenticate and install a new connection to
recover. There is no automatic reconnect, token cache, retry or token store.
This is a proposed protocol, not an agreed issuer seam.

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
IPC must bound, cancel and quarantine failed exchanges. The optional channel
adapter above implements these local properties but cannot establish issuer
identity by itself. Integration of this
crate with the shared Cargo/library configuration, native launcher, authoritative
session-ref resolution and production routing remains subject to coordination.
