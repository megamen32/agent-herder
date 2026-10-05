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
  Original enabled=true values were restored through the live API at 10:10:57 UTC;
  no session was stopped.
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
- `/root/zcode_fix`: ZCode adapter/protocol and focused adapter tests.
- `/root/integration_review`: independent read-only safety review.
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

## Deployment and real consumer evidence

- Herder-only deployment at 09:55 UTC attached the managed Codex daemon via its
  Unix WebSocket. The daemon stayed PID 4019392/version 0.160.0; native Mac
  ChatGPT/Codex stayed PID 1100. No native runtime sources were patched.
- Existing ZCode canary `sess_9b3946bd-35f7-4fa9-a3d3-292d929ee454`, model
  GLM 5.3, was sent one exact echo through the actual Herder message API. Native
  details returned the exact assistant response `ZCODE_SAME_ID_OK_20261005` in
  that original session. A stopped state after a completed one-reply turn is
  normal. Business-chat permission gates are preserved; no approval was issued.
- Existing Codex canary `01a10946-be4a-7052-9604-025f46a19b2c` returned
  `CANARY_OK`; a second connection hydrated and interrupted its sleep turn.
  The Mac-connected native read-thread tool independently confirmed interrupted
  for turn `01a10b62-a5dd-7793-8f5f-4f66d8a94d46`. Fresh adapter status is idle.
  This proves shared native backend control; refreshing every stale desktop
  window after an earlier model-capacity failure is not proven.
- `63a65fd` wires severity through the notifier, documents same-ID behavior,
  and tracks the optional shared socket drop-in. `3586bcc` sets the live output
  reservation to 4096 (eight-session chunks), concurrency one. This matches
  the live drop-in; the configured judge and business models remain unchanged.
- Five affected suites passed 224/224 after `da15efe`; bounded production build
  passed. `3ddaa96` adds a focused 3/3 regression pass and TypeScript check for
  in-flight events. Final whole launcher suite passed 154/154 and the production
  build passed; independent delta review cleared the in-flight race fix.

## Watchdog duplicate urgency

Restoring the two original overrides exposed repeated urgency every ten seconds
for unchanged stopped sessions, bypassing assessment backoff and repeatedly
requesting MiniMax. `da15efe` remembers the urgent progress fingerprint and
consumes a failed assessment's urgency. New native events and changed progress
must reset that marker. Independent review caught a race where a native event
arriving during a failed planner call could be consumed by that old call; the
`3ddaa96` fixes this race with monotonic signal generations: a failed pass
consumes only the signal it assessed, preserving newer native events. The
assistant-proof signal updates its own captured generation only if no newer
event arrived during the asynchronous history read.

## Remaining external dependencies and completion boundary

MiniMax remains intermittently unavailable: at 10:25 UTC the latest live failure
was HTTP 529/overloaded_error even with a 4096 reservation. Earlier live passes
also received HTTP 504. The official read-only token-plan quota endpoint returned
status 0 with 97% interval and 92% weekly allowance remaining, so this is not
exhausted quota. One small plan parsed successfully after the confidence contract
fix, but a later three-candidate plan/reconcile attempt still failed HTTP 529.
Do not claim reliable bulk continuation or completed task totals from failed
assessments. Do not switch user-selected models or loosen validators to guess.

Owner remains Agent Herder; next action is one scheduled bounded plan/reconcile
retry after backoff, with a successful native same-ID continuation receipt. The
watchdog fix must prevent unchanged sessions from bypassing that timer. Keep this
tracker WIP until that real path succeeds or the user explicitly defers it.
The optional ChatGPT/CDP dependency and old desktop-window rehydration boundary
remain separately recorded above.

## Final deployed local fix — 10:33:38 UTC

Remote main `722fd7c` (code through `3ddaa96`) was clean and synchronized at
Herder-only restart. New Herder PID 454232, active, NRestarts=0. Managed Codex
PID 4019392 and Mac native app PID 1100 were preserved. The live process uses
the shared socket, output budget 4096, concurrency one, and the tracked drop-in
matches byte-for-byte. Compiled launcher SHA256:
`7620d710a81e8b723613d3dde5ca94fc6910fa84a4b68b3d81b4abc584c480ea`.

Over the first 86 seconds after restart, each of the two original stopped ZCode
sessions emitted exactly one urgent watchdog signal; no ten-second urgency storm
recurred. Existing ZCode same-ID echo remains visible through live Herder details;
existing Codex canary is idle on the same ID/model. Original two ZCode overrides
remain enabled=true; global enable and rollover/pin transfer remain false. No
new business sessions were created by this task.

This local fix is deployed and independently reviewed. The latest known provider
failure still is HTTP 529; a complete live bulk plan/reconcile success remains
unproven and the external MiniMax dependency keeps this task WIP. A docs-only
commit may follow this deployed identity; its code/build bytes must remain equal.
