# Task: review, commit, and publish remaining Agent Herder changes

## Original request

Review everything remaining in the worktree, commit the safe changes, and push
them to the canonical `main` branch.

## Objective

Publish the reviewed OpenCode model-selection and bounded native-message work
without including runtime state, worktrees, backups, or unrelated task files.

## Business canary

The OpenCode adapter selects `provider/model` before the first prompt, refuses
to send when selection fails, and exposes bounded native messages.

## Confirmed scope

- `src/adapters/opencode.ts`
- `src/mcp-tools/definitions.ts`
- `tests/opencode-recovery.test.ts`
- This task record

## Explicit exclusions

- Do not commit `.agent-herder/`, `.serena/`, `.tmpbin/`, `.worktrees/`,
  `dist.backup-*`, or unrelated historical task files.
- Do not stage unrelated changes outside the confirmed scope.

## Initial estimate

- Optimistic: 15 minutes.
- Likely: 25 minutes.
- Pessimistic: 45 minutes.
