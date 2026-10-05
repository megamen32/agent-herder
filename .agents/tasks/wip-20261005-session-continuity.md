# Same-session continuation and native chat controls

Owner: Codex session `01a10b3f-b648-74d0-8265-023d1ae85312`.

User outcome: ZCode and Codex continue the original native sessions. Diagnose
ZCode turns stopping after a few seconds and native Mac Codex send/stop failures.

## Evidence before repair

- Canonical service: `agent-herder.service`, server-100, PID 2828546 at
  2026-10-05 08:53 UTC, running this checkout's `dist/index.js`.
- Live settings: `~/.local/state/agent-herder/autopilot-live/session-autostart.json`:
  rollover and pin transfer false, global enabled false, ZCode harness false,
  328 per-session overrides. Preserve this state; do not globally restart tasks.
- Source defaults and UI missing-field defaults enabled cache rollover. Planner
  could create a replacement when resume is absent even with rollover disabled.
- Preserved interrupted admission-state patch in launcher and its tests, 324
  changed lines. Initial bounded test: 139 passed, six failed. Do not deploy it
  before review, repair, and real consumer proof.
- Mac `~/Library/Logs/com.openai.codex/2026/10/05/` proves turn/interrupt at
  08:24/08:32 and turn/steer at 08:49 fail with `thread not found` for
  `01a1066d-63ad-7042-8542-e3732783f994`; source rollout remains on server-100.
- ZCode recent sessions `sess_5539f292-1ef6-4d48-bc83-7c98e363b93a` and
  `sess_92cc95b6-a821-44b1-ae13-f046bc85fe90` have native pending permissions.
  The service logs repeat same-ID admissions while persisted index stays stopped.
  Cancellation/provider failure must be distinguished from a human gate.
- At 09:00 UTC, temporarily paused only these two per-session autocontinue
  overrides through the live API to prevent repeated admission across the human
  gate. Original overrides saved mode 0600 in
  `~/.local/state/agent-herder/recovery/session-continuity-20261005-paused-overrides.json`.
  Restore their original values after gate verification; no session was stopped.
- Native Codex read-thread proves the last turn of `01a1066d...` is failed with
  model-at-capacity; current native state is notLoaded. Desktop stop/steer calls
  target this stale in-memory identity. Reopening/rehydration remains unverified.
- Optional ChatGPT adapter repeatedly reports `fetch failed`; separate dependency
  issue, no ChatGPT repair claimed. Smallest next action: verify configured CDP
  endpoint and its owner before any browser restart. Browser transport absence
  blocks that optional surface; keep native Codex/ZCode investigation independent.

## Shared verification budget

One heavy command at a time behind
`/run/user/1000/agent-herder/heavy-check.lock`, worker count one, RAM soft 1 GiB,
hard 2 GiB, swap zero, CPU two cores, tasks 128, IOWeight 10, timeout 120 seconds
and scope deadline 150 seconds. Existing service budget remains 1/2 GiB,
512 MiB swap, four cores, 512 tasks. Initial launcher suite ran in ten seconds.
Use existing node_modules; no downloads, containers, GPU, or new databases.
Temporary test fixtures limited to the focused suite and removed after checks.
Host measured 30 GiB available and UID 34.3 GiB against a 44 GiB outer cap.

## Ownership

- `/root/continuity_launcher`: launcher, launcher tests, rollover UI defaults.
- `/root/zcode_short_stops`: ZCode adapter/protocol and focused adapter tests.
- `/root/codex_mac_control`: Codex app-server adapter and focused tests.
- Root: integration, deployed identity, existing isolated canaries, this tracker.

Completion requires reviewed commits on remote main, clean authoritative checkout,
same-ID live proof, and supported native Mac control proof. No business chat is
interrupted, no permissions are auto-approved, and no new business chat is created.

## Reviewed source slices

- `7565b4d`: fresh ZCode pending-permission gate; adapter checks 37/37.
- `ce72575`: same-ID defaults, no title-based approval, accepted-turn state and
  progress deadlines; launcher checks 149/149 and TypeScript green.
- `5c8fb76`, `79f922d`, `74b0f65`: native ZCode history rejects
  `executionStartedAt`; use a cursor and exactly parent-correlated assistant
  response from snapshots. A changed turn ID is insufficient and remains pending.
  Adapter checks 40/40. Installed ZCode source remains untouched.
- `60779d2`: classify transient provider errors and deduplicate Notice Place
  notices, preserving validation and backoff. Affected checks 151/151.
- Shared Codex daemon version 0.160.0 exposes a Unix WebSocket endpoint. The
  CLI proxy relays raw bytes, so plain JSONL cannot initialize that endpoint.
  Direct supported Unix WebSocket initialize/list succeeded against the live
  daemon. `424c34b` and `ff58112` add the shared transport and fresh tagged native
  status. Same existing canary `01a10946...` returned an exact echo, was interrupted
  from a second connection, and the Mac app independently reported interrupted.
  Adapter checks 28/28; client disconnection does not declare native turn failure.

## MiniMax incident

User reported `inc_38204bd354d44f9b99b6e5a2a2fa0454` at 09:15 UTC.
Live registry had 257 assessment failures, all HTTP 529 from the MiniMax
Anthropic batch planner. The alert's 210 is an assessment batch, not terminated
sessions. Hardcoded critical severity and evidence-cohort deduplication generated
multiple alarms for one upstream failure. Source fix uses canonical Notice Place
`notice` and stable provider-level deduplication. Validation/backoff remain.
A bounded 11-input/2-output-token API probe returned 200/end_turn at 32 output
tokens. The same tiny request reserving 16384 returned 529/overloaded_error;
8192 and 4096 reservations returned 200. `469c6b2` shares the output budget across
planning/reconciliation and scales chunks to 16 sessions at 8192. It also gives
the strict numeric confidence contract explicitly; a small production-judge
probe changed from invalid confidence to a parsed plan with numeric confidence 1.
`d84f7f0` invalidates obsolete failure backoffs once (pipeline version 2).

## Integration checks before rollout

Five affected suites passed 222/222 under the shared resource guard. The last
Codex-only delta passed 28/28 and the production build. Independent review found
no remaining blocker after removal of the unsafe ZCode turn-ID inference.
Source is ready for scoped main publication and Herder-only deployment. The
managed Codex daemon and Mac application must stay running. Final deployed
identity, original ZCode echo, restored override values, and bulk planner
observation are still required; do not claim that these have already passed.
