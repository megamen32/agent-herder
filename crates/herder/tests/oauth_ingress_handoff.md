# OAuth ingress handoff (prepared seam, not a deployed HTTP bridge)

Baseline `9788a174`. The existing HTTP ingress at `src/web/server.ts` lines
2958-2997 verifies a request bearer with the live `McpOAuthTokenStore` and then
maps its returned OAuth principal to a generic mesh principal, losing `subject`.
`src/mcp/oauth-token-store.ts` lines 206-220 rejects expired/revoked access and
grant records and checks issuer/audience/scope, returning the subject. The store
caches state in the owning process; starting a second store reader is not an
acceptable revocation bridge. Consent is owner-checked by
`src/web/mcp-oauth-api.ts` lines 111-125.

## Concrete ownership seam

The owner of `src/web/server.ts` must retain the verified OAuth subject for the
current HTTP request and pass it through a server-owned authenticated boundary to
Rust, with issuer, audience, scopes and expiry. One possible change at the
`oauthPrincipal` branch is to pass the verifier result as typed request context
rather than replace it with `TRUSTED_MESH_MCP_CLIENT_ID`; the native HTTP adapter
must consume this context per request, without trusting JSON-RPC metadata or
headers supplied as identity. Alternatively, a same-process authority adapter may
call the exact existing store instance's `verifyAccessToken(bearer, expected)`
for every HTTP request and securely return that result to `OAuthRequestGate`.
A separate process requires an authenticated, integrity-protected channel with
peer ownership and lifetime defined; a plain localhost HTTP endpoint, same-UID
socket alone, client-controlled environment, or forwarded JSON assertion is not
the boundary. Do not allow MCP session IDs to cache or select an identity.

On every GET/POST/DELETE, including an existing streamable HTTP session, repeat
the authority check before touching native state. Fail closed on missing,
expired, revoked, invalid or unavailable authority, bind subsequent response to
that request, and make no self assertion. Server-side exact grants still apply.
The code here offers `OAuthRequestGate::call` for tool requests, but it is not a
HTTP transport and does not cover GET/DELETE/session lifecycle. A real ingress
must enforce the check outside and before *all* MCP handling, including discovery
and resume of an old session; using a fixed `NativeServer` connection identity
for HTTP would permit stale authority and is forbidden. Preserve the existing
single native Task store and prevent access while authority is unknown.

The checked-in test fixture exercises an isolated `McpOAuthTokenStore` object
and private subprocess pipes; those pipes are test wiring, not an authentication
protocol or proposed production bridge. The gate test uses an application spy;
the OpenCode recent handler was separately tested with injected principal.
Neither test establishes an HTTP consumer through the native reader, production
bridge security, or revocation on a real HTTP connection.

Next integration is a jointly owned change at the OAuth branch above plus a
native Rust streamable-HTTP transport using an approved SDK feature/dependency
change; common `Cargo.toml`/`lib.rs` and `src/web/server.ts` require owner
coordination. Acceptance: real HTTP client, isolated existing authority and
OpenCode instance; authorised read with subject-specific ACL; revoke using the
same store object; same MCP session and TCP connection retries and is denied
before native I/O; repeat for unavailable authority and different subject.
