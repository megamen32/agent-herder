# Health remediation OpenCode harness guard

Status: in progress
Lifecycle snapshot: todo
Supersedes: reviewer finding on OpenCode runtime implementation
Original user request: do not use Hermes; use OpenCode for health remediation.
Objective: health API cannot create a Hermes session when canonical execution is
OpenCode.
Business canary: future selected health retry routes only to OpenCode; a
Hermes/OpenCode mismatch is rejected before session creation.
Confirmed scope: reject mismatched harness/runtime in health route; add isolated
HTTP regression in a new task-owned test file.
Explicit exclusions: edits to existing foreign MCP-auth hunk in
`tests/http-api.test.ts`, deploy, restart, retry, Telegram, secrets, production.
Cycle: short
Harness: Codex Worker
PID: pending Worker launch
Agent session: pending Worker launch
PID status: unknown
Last PID signal (UTC+3): reviewer CHANGES_REQUIRED
Last task-file transition (UTC+3): todo
Current stage: implementation
Current owner: Worker
Started at (UTC+3): 2026-08-11 18:10
Lifecycle provenance: recorded after independent reviewer finding
Last task-file mtime observed (UTC+3): 2026-08-11 18:10
Workspace: primary checkout
Worktree path: /home/roomhacker/agents-projects/agent-herder
Branch: agent/session-lineage-tools
Initial estimate (minimum / maximum active minutes): 6 / 18
Stop when: mismatch rejected with focused HTTP test, or route contract requires
larger compatibility decision.
Forbidden without explicit user authorization: deploy, restart, retry, external
Telegram delivery, Hermes execution, destructive action.

## Execution

- Mode: implement: bugfix/TDD
- Owner paths: `src/web/server.ts` and a new narrowly named test file only.
- Primary acceptance: `harness: hermes` combined with canonical
  `execution.runtime: opencode` returns 400/409 and does not reach session
  creation; valid OpenCode request remains accepted.
- Do not modify `tests/http-api.test.ts`; preserve all unrelated work.
