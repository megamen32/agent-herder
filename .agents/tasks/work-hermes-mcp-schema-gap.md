# Hermes MCP schema gap

## Original request

Finish the remaining Agent Herder Hermes MCP schema gap without changing named-session conversion/resume behavior.

## Objective

Make Hermes appear in every canonical static MCP definition for an existing generic observation/control operation, while keeping `create_session` and `new_or_resume` restricted to OpenCode/Codex and preserving truthful unsupported Hermes controls.

## Business canary

Focused MCP-definition test proves Hermes is accepted/listed for generic observation/export/message schemas and absent from named-session creation/resume schemas; build and focused tests pass.

## Confirmed scope

- `/home/roomhacker/agents-projects/agent-herder/src/mcp-tools/definitions.ts`
- One new or updated MCP-definition-focused test under `/home/roomhacker/agents-projects/agent-herder/tests/`

## Explicit exclusions

- Do not alter `session-convert` or named-session implementation.
- Do not modify existing intentional dirty feature files.
- Do not commit or push.

## Stage and estimate

Selected stage: YAGNI.

Initial active-minute estimate: 15 minutes.

## Estimate revisions

| Revision | Trigger | Evidence | Estimate |
| --- | --- | --- | --- |
| 0 | Initial task intake | User acceptance and bounded file scope | 15 minutes |

## Verification

- `npm run build` passed.
- `npx vitest run tests/mcp-definitions.test.ts` passed: 1 file, 2 tests.
- `git diff --check` passed.
- Existing dirty feature files were preserved; no commit or push was performed.
