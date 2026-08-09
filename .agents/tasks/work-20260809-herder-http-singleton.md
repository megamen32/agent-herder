# Agent Herder HTTP singleton with per-harness stdio bridges

## Original request

Herder must remain present in every harness, but it should host its site over
HTTP and all harness stdio integrations should be shims to that HTTP service.

## Objective

Keep the `agent-herder` MCP capability in OpenCode, Codex, and Hermes while
ensuring only one full Agent Herder process owns the HTTP site and adapters.

## Business canary

The live HTTP endpoint accepts MCP initialize and tools/list; each configured
harness points to `http-mcp-stdio.js`; starting a second full Herder is rejected
by the singleton lock; the service restart leaves one full Herder process.

## Confirmed scope

- Add singleton guard to the full Herder process.
- Add Streamable HTTP MCP endpoint and stdio-to-HTTP bridge.
- Switch the three local harness configurations to the bridge.
- Keep credentials out of versioned files.

## Explicit exclusions

- Do not disable or remove the Herder capability from any harness.
- Do not change adapter behavior or unrelated dirty work.

## Estimate

- Initial estimate: optimistic 25 min, likely 45 min, pessimistic 75 min.
- Revision: 2026-08-09, +20 min after discovering each harness had a different
  stale/full-process path and the HTTP MCP factory had to be wired into the
  existing web server.

## Status

Status: complete.

## Evidence

- `npm run build` passed.
- `npx vitest run src/singleton.test.ts` passed.
- Live HTTP MCP initialize and `tools/list` returned 200.
- Live stdio bridge initialize returned the Herder MCP response.
- A second full process was rejected by the singleton lock.
- Exactly one full `dist/index.js` process remains after restart.
