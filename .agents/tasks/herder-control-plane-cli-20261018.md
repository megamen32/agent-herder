# Agent Herder control-plane repair — 2026-10-18

## Request and acceptance

The server-100 user must be able to list native sessions, open the selected
session history, and deliver one message or create a test session with a
confirmed response. A temporary transport failure must remain visibly
unavailable/unknown and must not look like an empty inventory or a successful
delivery. Work is limited to this task worktree; do not message or stop other
sessions. Any live canary must be harmless and exact-ID-addressed.

## Starting state and evidence

- Worktree: `/home/roomhacker/agents-projects/.worktrees/agent-herder-control-plane-cli-20261018`.
- Branch at start: `fix/herder-control-plane-cli-20261018`, clean and at
  `c4bbe31` (`origin/main`). The canonical checkout and sibling worktrees were
  not modified.
- Current LHC router and `REVIEW_TO_DELIVERY.md`, parent runtime/branch rules,
  README, `package.json`, `.planning/{PROJECT,REQUIREMENTS,ROADMAP,STATE}.md`,
  and existing Herder session/list task records were read. The planning files
  track a separate Mac-public-connection milestone; this task is not recorded
  as completing that roadmap.
- AgentMemory recall and GrepMesh search were attempted for this project;
  both MCP calls returned `MCP tool call requires approval, but approval
  policy is never`. No memory result was inferred; bounded local reads were
  used instead.
- The saved native transcript was inspected for ordinary user/assistant text
  only. The supplied earlier `fleet_session_view` connection reset remains
  unverified from this execution and is not attributed to a Herder restart.
- The work shell reports hostname `roomhacker-server-100`, but it is isolated
  from the host service/runtime: PID 798884 is not visible, the user systemd
  bus is unset, `ss` cannot inspect netlink, and `curl` to
  `127.0.0.1:18787/health` gets connection refused. GPTAdmin schema lookup for
  the documented AgentBrowser target succeeded, but its read-only execution
  was also refused by the same approval gate. The direct Agent Herder
  `list_agents` MCP call was refused too. Thus no current host service state,
  service journal, list/history route, or native delivery receipt was
  obtained here.

## Diagnosis

The source already treats incomplete inventory separately from a complete
empty list: fleet snapshots propagate `complete`/`limited`, owner inventory
pages propagate `partial`/`reason`, and session history reports
`historyUnavailable`. The owner HTTP message path performs one POST and turns
an unconfirmed result into `admissionUnknown`/`nonRetryable`; it does not
retry. Existing tests cover these contracts, but were not executable in this
environment.

A reproducible UI defect was found in `FleetCabinet`: each sessions effect
called `setSessions([])` before the request. A manual refresh that then failed
discarded the last successful list and left a blank session list beside a
generic error. This did not prove the reported connection reset and does not
explain a false successful delivery; it did make the list look like sessions
had disappeared during a temporary refresh failure.

## Change

- Preserve the last successful session snapshot when refreshing the same
  selected machine fails, and visibly mark that snapshot stale.
- Do not display a cached session list belonging to another selected machine.
- Added focused regression cases for same-machine retention and
  cross-machine isolation in `tests/fleet-session-snapshot.test.ts`.
- No native session, service, configuration, credential, approval, or external
  message was mutated.

## Verification and remaining gates

- `git diff --check`: passed.
- Node 22 `--experimental-strip-types` ran three assertions against the new
  snapshot function: same-host failure preserves rows and marks stale;
  another-host failure returns no rows from the previous host; a cold-start
  failure does not claim a prior successful list. All three passed.
- Full Vitest RED/GREEN and build were not run. `node_modules` was absent;
  `npm ci --offline` failed because `vite@8.2.1` is not cached
  (`ENOTCACHED`). Online dependency installation was not attempted under the
  network-restricted sandbox. The regression test therefore remains
  unexecuted by Vitest.
- Independent Codex review was attempted through both `codex review` and
  `codex exec review`; both failed before review with
  `failed to initialize in-process app-server client: Read-only file system`.
  No independent review result is claimed.
- No real list/history/delivery or test-session canary could run because MCP
  execution is approval-blocked and this shell cannot reach the service.
- No service restart, installation, commit, push, PR, or deployment was done.
  Source-only UI acceptance is not claimed. Install/review/live acceptance
  remain open until an authorized host runtime and test toolchain are
  available; avoid restarting the service if another task is active.
- Final manual source review caught and fixed the cold-start wording case: the
  stale-list status now requires `hasPrevious`, so it only appears when an
  earlier successful snapshot is retained. The three Node assertions above
  were run after that correction.

## Artifact path limitation

The requested `.agents/tasks/herder-control-plane-cli-20261018.md` could not
be written: the active filesystem permission profile explicitly grants read
access to this worktree's `.agents/` and denies writes there. This report is
in the writable worktree root instead.

## Перенос в main и проверка — 2026-10-22

The change described above was carried from the author worktree
`.worktrees/agent-herder-control-plane-cli-20261018` into the branch
`feat/fleet-session-snapshot-20261022` (base `ead1ad5` = `origin/main`),
worktree `.worktrees/herder-fleet-snapshot-20261022`.

- `src/web-ui/fleet/FleetCabinet.tsx`, `src/web-ui/fleet/session-snapshot.ts`
  and `tests/fleet-session-snapshot.test.ts` were copied byte-identically
  (matching git blob hashes). The `FleetCabinet.tsx` blob is the same in
  `c4bbe31` and in `origin/main` (`dd6028d`), so the carried diff is exactly
  the author's diff and nothing else.
- This note moved from the author worktree root to `.agents/tasks/`, the path
  the original report asked for; the root placement was only a fallback for
  that worktree's read-only profile. The limitation recorded above is
  therefore resolved for the committed copy.
- `npx tsc --noEmit`: clean, no diagnostics.
- Focused tests: `tests/fleet-session-snapshot.test.ts` (3) and
  `tests/fleet-cabinet-navigation.test.ts` (4) — 7 passed.
- Full `npx vitest run --root . --config vitest.config.ts`: 267 test files
  passed, 2288 tests passed, 2 files and 6 tests skipped, 0 failed. The base
  `ead1ad5` measures 266 files and 2285 tests, so the delta is exactly this
  feature's new file and its three cases.
- One earlier full-suite run failed `tests/choice-stop-origin.test.ts`
  (`expected 'dispatching' to be 'failed'`) — a timing-sensitive dispatch
  race with no import path to the fleet UI. It passes 3/3 in isolation, 2/2
  on the base and 3/3 in the full suite with the change applied, so it is
  recorded as a pre-existing flake, not a regression of this feature.
