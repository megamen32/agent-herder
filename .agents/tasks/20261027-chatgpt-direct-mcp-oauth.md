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
  latest focused run passed: 3 test files, 7 tests. `npm run build` and the
  Codex plugin payload build passed; Vite emitted its large-bundle advisory.
- `git diff --check` passed. The canonical site-vhost checkout contains
  unrelated dirty work; only the exact Agent Herder vhost file is owned for
  this task. Its scoped Nginx source change is committed as `923a1aaa` and
  pushed; installation is intentionally after the Herder app release.
- Source commit `f35713f249bddbfceee4ad1ea30604e47586de08` is on `origin/main`.
  The clean artifact is installed from
  `/home/roomhacker/agents-projects/.notice-herder-release-20261027/releases/f35713f249bddbfceee4ad1ea30604e47586de08`;
  `dist/index.js` SHA256 is `2250c2b7a808fedf709d6d8b31c5d9023158ce7bc99912bef15e9491c9767561`,
  bundle fingerprint `82b08b7a791a714b1e7bf8974f58418eb2cbd92807fa35a1865bd53979783eba`.
  Candidate checks passed for source identity/cleanliness, complete payload,
  package layout, bundle fingerprint, config preservation and size.
- One activation completed at 2026-10-27 23:13 MSK: PID `60063` runs the exact
  immutable entrypoint. Launch policy and session-autostart hashes/ETag matched
  across activation and the event sequence did not regress; see
  `activation.json`.
- The published nginx site config reached deployed whole-tree SHA
  `923a1aaa881fd7c920645fd80e3482a6d20212a1`; `nginxctl check` and managed
  diff both pass. Public protected-resource and authorization-server metadata
  return JSON 200 with the exact `/mcp` resource and issuer. Public `/mcp`
  without credentials remains 401 with an absolute RFC 9728 challenge. The
  ordinary `/oauth/authorize` path remains on its HTML SSO flow.
- ChatGPT owner consent and the owner-authorized code exchange/refresh plus
  native session read are not claimed: no owner-authorized ChatGPT browser or
  session is available here. Remaining owner action: in ChatGPT, add
  `https://agent.bezrabotnyi.com/mcp` as a custom MCP connection, select the
  discovered OAuth sign-in, sign in through the existing owner SSO and approve
  Herder's consent page. Then perform one read-only session call. OAuth
  registration, code, and refresh lifecycle are covered by focused provider
  tests; no live owner token was created.
