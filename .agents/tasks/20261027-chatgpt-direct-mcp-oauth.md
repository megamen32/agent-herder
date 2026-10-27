# ChatGPT direct OAuth for Agent Herder MCP

## Accepted result

An owner can add `https://agent.bezrabotnyi.com/mcp` to ChatGPT as a custom MCP
connection, use the existing Agent Herder SSO account and explicit consent,
discover tools, and perform a harmless session read directly through Herder.
Existing static and Settings-issued Bearer clients and browser SSO remain valid.

## Scope and decisions

- Use the existing HTTP MCP resource and owner-cookie verifier; no GPTAdmin call
  is added to the runtime path.
- OAuth uses Authorization Code + PKCE S256, DCR with the exact ChatGPT stable
  callback `https://chatgpt.com/connector_platform_oauth_redirect`, resource
  binding to `/mcp`, owner scope plus `offline_access`, rotating refresh tokens,
  and RFC 7009 revocation.
- Access and refresh tokens, codes, and consent transaction handles are
  hash-only in the existing protected state directory. Authorization requires
  the current owner SSO check and same-origin consent POST.
- The OAuth grant carries the same current owner MCP permissions as an existing
  owner Bearer. The consent page says so; no permissions or MCP tools are added.
- Nginx exposes only the two public metadata endpoints and the three OAuth
  machine endpoints. `/oauth/authorize` and `/oauth/consent` keep ordinary SSO.

## Verification plan

1. Focused store and HTTP tests: discovery, DCR, exact redirect, state, PKCE,
   owner consent, audience/scope/issuer/expiry, MCP initialize/tools/list/read,
   refresh rotation, revocation, and legacy Bearer compatibility.
2. Run the required Agent Herder production build gates.
3. Publish owned source, install once through the existing release process, and
   apply the scoped vhost change. Verify public JSON/401, owner SSO, ChatGPT
   consent/refresh if the authorized browser session is available, plus a direct
   read-only MCP call. Do not repeat an operation with an unknown outcome.

## Current state

- Pre-change public reads: both well-known endpoints and `/oauth/token` returned
  `302` to `auth.bezrabotnyi.com`; unauthenticated `/mcp` returned `401` without
  `WWW-Authenticate`.
- Main was `71565da`, matching `origin/main`; OAuth source uses the isolated
  branch `feat/chatgpt-mcp-oauth-20261027`.
- OAuth source and focused tests are complete in the isolated worktree. The
  latest focused run passed: 3 test files, 7 tests. `npm run build` passed;
  Vite emitted its existing large-bundle advisory.
- `git diff --check` passed. The canonical site-vhost checkout contains
  unrelated dirty work; only the exact Agent Herder vhost file is owned for
  this task. Its scoped Nginx source change is committed as `923a1aaa` and
  pushed; installation is intentionally after the Herder app release.
- Installed/runtime, public discovery, and ChatGPT consent acceptance are
  still pending.
