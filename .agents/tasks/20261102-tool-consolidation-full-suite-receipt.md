# Agent Herder PR25 tool consolidation acceptance receipt, 2026-11-02

- Worktree: /home/roomhacker/agents-projects/.worktrees/herder-catalog-40-20261102
- Base: origin/main 4a97225 (PR24 guarded realpath/Git-owner fix retained), worktree initial commit c6f7ba9.
- PR25: https://github.com/megamen32/agent-herder/pull/25
- AgentHerder registered tools: 99; discoverable tools: 40; original tool names registered and directly callable.
- TypeScript, npm run build, npm run test:core passed at relevant source states. Dedicated 107-file MCP/session regression: 842/842 passed.
- Independent review found hidden remote mesh discovery; fixed in source by reusing original authenticated mesh_route/mesh_deliver handlers with no local fallback; exact native tests passed.
- Full project Vitest command: 503 test files, 4328 total tests, 4211 passed, 103 failed, 14 skipped; 1 unhandled rejection (captured .catalog-alltests.log).
- Every full-suite failure logged at .agents/bugs/alltests-*.md; 37 issue files including unhandled rejection, immutable history maintained.
- Follow-up independent isolated checks after repairs:
  * 107 MCP/session files: 842/842 passed.
  * CDP and scope: 18/18 passed.
  * Codex app-server: 74/74 passed without Codex CLI launch or native live sends.
  * ZCode workspace lifecycle: 33/33 passed; V4 fixture now proves queue receipt matching requested delivery.
  * Codex policy unit: 15/15 passed without Codex CLI launch.
  * 31 remaining failure file group isolated: 59 failed tests / 362 passed; exact per-test signatures in bug records.
- RELEASE GATE RED: full project tests are RED. Do not classify cycle done, merge PR25, or install candidate until every remaining issue is fixed or clearly resolved as a duplicate/false-positive with evidence. No tests disabled/removed, no safeguards lowered, no production changed.
- Do not modify the main owner checkout or unrelated polling/429, broker, consumer scopes. Native guarded installer enforces canonical release proof, lease project binding, entrypoint snapshot CAS, Git owner, and service identity; no bypass.

## Follow-up full project acceptance

- First final full-suite run on c2dd294: 503 files, 4314 passed, 2 failed, 14 skipped, no unhandled errors. Exact log: .catalog-final-all.log. Registered two new bugs before repair: alltests-final-noticeplace-allowlist and alltests-final-permission-poll.
- Focused RED-to-GREEN of these two: 27/27 passed. Code fixes are test-contract-only: one exact two-route allowlist, and bounded polling plus single accepted Notice external action. No owner gate changes.
- Status at this record: pending the next single full-suite run after the two fixes; do not claim production/merge readiness until proven green.
