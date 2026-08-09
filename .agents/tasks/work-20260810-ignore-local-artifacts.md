# Task: ignore local Agent Herder artifacts

## Original request

Put the local runtime and generated artifacts in gitignore.

## Objective

Keep runtime state, IDE metadata, temporary binaries, linked worktrees, local
retrospective state, and backup distributions out of future git status output.

## Scope

- `.agent-herder/`
- `.serena/`
- `.tmpbin/`
- `.worktrees/`
- `.agents/last-human-commit/`
- `dist.backup-*/`

Historical `.agents/tasks/` records remain visible and are not ignored.

## Initial estimate

- Optimistic: 5 minutes.
- Likely: 10 minutes.
- Pessimistic: 15 minutes.
