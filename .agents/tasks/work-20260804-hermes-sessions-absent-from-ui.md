# Hermes sessions absent from Agent Herder UI

Role: Worker

## Symptom

Agent Herder's web UI does not show Hermes sessions, although Hermes is active
on this host and the user expects them to be visible.

## Smallest evidence

User reports no Hermes sessions in the site. The repository contains
`src/session-convert.ts`; the missing UI rows may be an unsupported Hermes
conversion/ingest path, but that is not yet proven.

## Blocker

Need a bounded consumer-path trace from Hermes session export/ingest through
session conversion to the UI query before assigning a root cause or fix.

## Assignment

Read only the bounded Agent Herder paths needed to trace Hermes session export,
ingest, conversion, storage, and UI query. Do not edit, test, restart, deploy,
or inspect unrelated systems. Append an evidence-backed trace, exact missing
link (if any), and the smallest owned fix scope to this file; return only TL;DR
to L.

Allowed path: `/home/roomhacker/agents-projects/agent-herder`.

## Continuation assignment

User rule: every Agent Herder harness adapter is enabled by default; an explicit
setting may disable a named adapter. Implement the smallest owned change for
all `ENABLE_*` adapter gates, not Hermes alone. First add/run a focused failing
regression that proves default-on and explicit-false behavior, then make it
green. Allowed write paths: `src/index.ts` and the smallest directly relevant
test file(s). Do not restart, deploy, change service configuration, or alter
the Codex filter. Append detailed changed files, Red/Green evidence, and any
remaining runtime canary to this task file; return only TL;DR.

## Worker receipt

- Changed `src/index.ts`: `ENABLE_QODER` and `ENABLE_HERMES` now default to
  `true`; explicit `false` remains opt-out.
- Added `tests/adapter-gates.test.ts` after Red evidence for the previous
  default-false behavior; Green command passed.
- Worker evidence: `npx vitest run tests/adapter-gates.test.ts`, `npm run
  build`, and `git diff --check` passed.
- Runtime proof remains pending user-authorized Agent Herder restart followed
  by `GET /api/sessions?harness=hermes`.

## Next stage

Fresh Reviewer is checking only this bounded diff before L accepts or commits
it. No deploy/restart is authorized.

## Reviewer-required test repair

Reviewer found `CHANGES_REQUIRED`: `tests/adapter-gates.test.ts` must prove the
runtime behavior of explicit `false` for every gate and must use an exact
expected gate list rather than permissive `toMatchObject`. Repair only that
test, re-run its focused command and build, append Red/Green evidence, and do
not alter `src/index.ts`, runtime config, services, or deployment.

## Final review

Fresh Reviewer approved: all six `ENABLE_*` gates default to `true`, each
explicit `"false"` is covered, and the test asserts the exact gate set. Worker
reported focused Vitest, build, and diff checks passed. The remaining business
canary is runtime-only and requires a separately authorized service restart.

## Status

Active — runtime activation preparation.

## Runtime trace evidence (2026-08-05)

- Read-only service evidence: `systemctl --user status agent-herder.service` reports active PID 745574 since `Tue 2026-08-04 06:27:48 MSK`; its journal startup line at `06:27:50` is exactly `[agent-herder] Ready with harnesses: opencode, codex`. There is no Hermes init failure/listing error line and no Hermes process in the service cgroup. This identifies the observed runtime as Hermes adapter absent from the active adapter map, not a proven `conversations_list` zero result.
- Effective service environment from `/proc/745574/environ` and `systemctl --user show`: `ENABLE_OPENCODE=true`, `ENABLE_CODEX=true`, `ENABLE_CLAUDE=false`, `ENABLE_CLAUDE_SDK=false`, `ENABLE_QODER=false`; `ENABLE_HERMES` is unset, so current source would default it to true (`src/index.ts:32-44`, specifically line 38). The service unit has no Hermes disable setting (`~/.config/systemd/user/agent-herder.service:15-19`). `hermes` is installed at `/home/roomhacker/.local/bin/hermes` and `hermes --help` succeeds.
- Binary freshness mismatch: the active process started at 06:27, while `dist/index.js` was rebuilt/modified at `2026-08-04 22:30:18 MSK` (`src/index.ts` at 22:27). Therefore the prior restart/business canary predates the default-on build and cannot establish current source behavior. `dist/index.js` does contain `ENABLE_HERMES` and the Hermes init logging (`dist/index.js:17,124-128`), but the active PID has not loaded that post-rebuild binary.
- Source path if freshly loaded: `src/index.ts:151-157` creates/registers `HermesAdapter` and calls `adapter.init()`; `src/adapters/hermes/adapter.ts:100-110` spawns `${HERMES_BIN || hermes} mcp serve` and immediately calls `conversations_list(limit=1)`. `src/adapters/hermes/adapter.ts:118-124` lists with `conversations_list(limit=200)`, retains only rows with `session_key`, and maps them to UI sessions. No listing result was observed in this trace because the active process never initialized Hermes.
- Smallest next action: obtain explicit restart authorization, restart only the user `agent-herder.service` so it loads the rebuilt `dist/index.js`, then capture startup lines and run the business canary `GET http://127.0.0.1:18787/api/sessions?harness=hermes`. Do not claim Hermes visible until the response contains one or more session rows; if freshly loaded startup logs report `Hermes adapter failed to init`, continue with that exact MCP spawn/initialize error.

### Runtime trace status

Blocked on separately authorized service restart; no source/config mutation performed.

## Runtime continuation

Inspect the effective Agent Herder service environment/config and produce the
exact minimal restart plus `GET /api/sessions?harness=hermes` business canary
command. Read-only only: do not restart, deploy, modify config, or claim Hermes
visible. Append the actual effective gate value, any preflight blocker, and
the exact action awaiting L/user authorization; return only TL;DR.

## Runtime canary after authorized restart

- `agent-herder.service` restarted successfully and is active.
- `GET http://127.0.0.1:18787/api/sessions?harness=hermes` returned `200` with
  zero sessions.
- Default-on source is now active, but Hermes remains absent; next bounded work
  is read-only adapter-init/listing error trace. Do not change config or source
  until that exact failure is proven.

## Continuation assignment: runtime trace

Inspect only Agent Herder startup/service logs and Hermes adapter initialization
evidence after the restart. Identify whether the adapter is absent, init failed,
or listing returns zero; append exact evidence and smallest fix scope. No edit,
restart, deploy, configuration mutation, or unrelated log audit.
