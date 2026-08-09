# Task: enable SessionSupervisor snapshot cache

## Original request

Enable SessionSupervisor caching so session lists return instantly while the
supervisor refreshes them in the background.

## Objective

Serve the last known session snapshot immediately, deduplicate concurrent
refreshes, and retain the last good snapshot when a refresh fails.

## Business canary

The live `/api/sessions` endpoint returns from a warm snapshot without waiting
for adapter discovery; after TTL expiry one background refresh runs and the
next snapshot becomes visible.

## Confirmed scope

- SessionSupervisor discovery cache and its focused tests.
- Preserve harness/status/CWD filtering.
- Restart the Agent Herder service after verification.

## Explicit exclusions

- No adapter protocol, database, or UI redesign.
- Do not stage unrelated dirty health/model/server changes.

## Initial estimate

- Optimistic: 15 minutes.
- Likely: 30 minutes.
- Pessimistic: 60 minutes.
