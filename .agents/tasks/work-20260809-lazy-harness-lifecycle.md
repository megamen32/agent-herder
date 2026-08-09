# Lazy harness lifecycle and current-session reuse

## Original request

Adapters must prefer an already running harness/session and must start their
own process lazily only when a new session is explicitly requested or no
attachable current session exists for an operation that requires creation.

## Objective

Stop Agent Herder startup from eagerly spawning Codex, Hermes, and ZCode child
processes. Preserve current-session discovery and make explicit create/new
operations the only normal spawn paths.

## Business canary

Starting Agent Herder creates no new harness child processes; listing or
continuing existing sessions uses an existing transport; explicit creation
starts exactly one lazy child when needed.

## Confirmed scope

- Codex app-server adapter lifecycle.
- Hermes adapter lifecycle.
- ZCode adapter lifecycle.
- Named-session reuse/create boundary and focused tests.

## Explicit exclusions

- Do not change adapter protocol semantics or add Gemini.
- Do not kill or restart unrelated existing harness processes.

## Estimate

- Initial estimate: optimistic 35 min, likely 75 min, pessimistic 140 min.

## Status

Complete for the lazy lifecycle scope.

## Evidence

- `npm run build` passed.
- 14 focused tests passed, including `lazy-polling` and existing
  `named-session` reuse/create coverage.
- After a real systemd restart, the Herder cgroup contained only the Herder
  process; Codex, Hermes, and ZCode were registered but not spawned.
- Existing OpenCode HTTP attach remained active.
