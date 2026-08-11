# Research journal: Agent Herder runtime settings UI

Started from the assigned Worker research contract for selected Plan 2.

## Orientation

- Repository: `/home/roomhacker/agents-projects/agent-herder`
- Checkout: primary path, branch `agent/session-lineage-tools`, not `origin/main`
- State: dirty; source and tests contain pre-existing edits, so no source mutation is allowed.
- Existing graphify graph was queried first; the current graph reports `src/autopilot-hook.ts`, `src/autopilot/index.ts`, `src/autopilot/choice-registry.ts`, `src/web/server.ts`, `src/web-ui/main.tsx`, and `tests/http-api.test.ts` as relevant seams.

## Initial decisive findings

- Autopilot is currently Codex Stop-hook ingress only; selection is armed-session or explicit all-session env opt-in.
- Choice persistence already exists but has no expiry/deadline state machine or long-lived sweep in the inspected surface.
- The real React surface is `src/web-ui/main.tsx`; the legacy static shell is separate.
- Existing worktree changes are foreign to this research lane and will not be staged, reverted, or included.
