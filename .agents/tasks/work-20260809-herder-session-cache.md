# Agent Herder session cache

## Original request

«а herder может кешериовать и выдвать все моментально и в фоне оновлять ? чтобы был быстрым»

## Objective

Make the session dashboard return the last known session snapshot immediately
after the first load, while refreshing that snapshot in the background without
overlapping adapter discovery calls.

## Business canary

After one cold discovery, repeated `GET /api/sessions` calls return the
cached snapshot without waiting for a slow adapter; one background refresh
eventually replaces it with newer session data.

## Confirmed scope

- `src/session-supervisor.ts` session discovery cache and refresh coordination.
- Focused regression coverage for warm cache and background replacement.
- No adapter protocol changes, credentials, or public ingress changes.

## Explicit exclusions

- No cache persistence to disk or database.
- No changes to session transcript/detail caching.
- No deployment or commit implied by this task until verification is green.

## Estimate

- Initial optimistic: 20 minutes.
- Initial likely: 35 minutes.
- Initial pessimistic: 60 minutes.

## Implementation evidence — 2026-08-09

Implemented an in-memory stale-while-revalidate snapshot in
`SessionSupervisor.listSessions`:

- the first request performs the cold adapter discovery;
- warm requests apply harness/status/CWD filters to the last snapshot and
  return immediately;
- an expired snapshot starts one deduplicated background refresh;
- a failed background refresh preserves the last good snapshot;
- no adapter protocol or persistent state was changed.

Focused red-first canary timed out before the cache implementation because a
blocked second adapter read was awaited. It is now green, proving that the
warm call returns the old snapshot while a single refresh is pending and then
serves the refreshed snapshot. Full verification: `npm test`, 47 files and
179 tests passed.

The built artifact is ready, but the currently running service PID predates
this implementation. Runtime activation requires an explicit user-approved
restart of `agent-herder.service`.

## Runtime canary — 2026-08-09

User approved the restart. `agent-herder.service` is active with PID 2617808
and reports `opencode, codex, hermes, zcode` on `127.0.0.1:18787`.

- Cold `GET /api/sessions`: 1.02 seconds, 2108 sessions.
- Immediate warm `GET /api/sessions`: 0.04 seconds, 2108 sessions.

The cache-first behavior is active in the configured runtime. The new cache
implementation is not committed yet.
