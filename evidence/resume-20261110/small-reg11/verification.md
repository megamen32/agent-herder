# SMALLREG11 verification

Base: detached worktree at `1838175e81b8e8644efccd64ddaf71bd9486b5d3` (`main`).

## Reproduction

Focused baseline run reproduced failures across all six assigned test files: duplicate `node:vm` imports, stale UI string expectations, async Codex event assertion timing, empty `.mcp.json` payload fixture rejected by the native projection, and an AHAP result assertion expecting an `inputId` the returned admission receipt does not expose.

## Changes

- Removed duplicate `createContext` / `runInContext` import declarations.
- Asserted web UI calls `detailQuery` with the expected latest/full-history arguments.
- Matched the current Fleet loading label.
- Waited for Codex's deferred terminal event and stubbed its independent quota-evidence lookup.
- Supplied the native HTTP MCP route required by the projection fixture.
- Asserted the native OpenCode receipt fields actually returned by AHAP.

No production source changed. No provider, browser, message, or external service was used.

## Verification

- `npx vitest run --root . --config vitest.config.ts tests/vibe-async-evaluation.test.ts tests/web-ui.test.ts tests/fleet-cabinet-navigation.test.ts tests/codex-capacity-evidence.test.ts tests/codex-plugin-release-payload.test.ts tests/opencode-v22-protocol.test.ts --reporter=dot` — PASS, 6 files / 65 tests.
- `npx tsc --noEmit` — PASS.
- `git diff --check` — PASS.
