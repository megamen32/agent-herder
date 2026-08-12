# Codex harness filter has no effect in Agent Herder UI

Role: Worker

## Symptom

Selecting the Codex harness filter on the Agent Herder website does not change
the displayed session list.

## Smallest evidence

Direct user observation on the current site: filtering by Codex performs no
visible filtering.

## Blocker

Need to trace the filter value from UI state to the sessions API/query and
verify the stored harness discriminator before choosing the smallest fix.

## Assignment

Read only the bounded Agent Herder paths needed to trace the Codex filter from
UI state through the sessions API/query to stored harness values. Do not edit,
test, restart, deploy, or inspect unrelated systems. Append exact evidence,
the broken link, and the smallest owned fix scope to this file; return only
TL;DR to L.

Allowed path: `/home/roomhacker/agents-projects/agent-herder`.

## Continuation assignment

Perform the smallest live read-only consumer-path probe: compare the running
service's unfiltered `/api/sessions` response with `?harness=codex`, and trace
the active UI request/bundle only as needed. If source/runtime evidence exposes
a bounded local fix, write a focused failing regression, implement it, and
prove Green. Otherwise append the exact live evidence and blocker. Do not
restart, deploy, change config, or touch the Hermes task. Return only TL;DR.

## Status

Active.

## Worker evidence

- UI source path: `src/web/index.html` wires the harness select into `state.filters.harness` and calls `refreshAll()`, which serializes `harness` into `/api/sessions?${params.toString()}`.
- Server path: `src/web/server.ts` forwards `url.searchParams.get("harness")` into `supervisor.listSessions({ harness, status, cwd })`.
- Supervisor path: `src/session-supervisor.ts` filters adapters with `!filters.harness || key === filters.harness || adapter.type === filters.harness`, then returns only sessions whose `harness` and `meta.provider` are both set from the adapter/provider.
- Live probe on `http://127.0.0.1:18787`:
  - `/api/sessions` returned 132 sessions with harnesses/providers `{codex, opencode}`.
  - `/api/sessions?harness=codex` returned 100 sessions with harnesses/providers `{codex}`.
  - The first codex row had `harness: "codex"` and `meta.provider: "codex"`.

## Broken link

No broken link was found in the bounded source/runtime path. The Codex harness filter is functioning in the API layer and the stored harness discriminator is consistent; the user-visible failure is therefore likely outside this repo slice (for example, stale deployment, browser cache, or a different site bundle than the one traced here).

## Smallest owned fix scope

None identified from the required read-only trace. The smallest safe next step is a live browser/network capture of the currently observed website to confirm whether it is hitting the same `/api/sessions?harness=codex` endpoint and bundle as this local service.
