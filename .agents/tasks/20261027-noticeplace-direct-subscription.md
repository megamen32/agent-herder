# Notice Place incident route: owner-selected GLM + MiniMax combo

## 29 October 2026 subscription readback

At 2026-10-29 20:28:53 UTC one read-only GET used the single effective native OpenCode `minimax-coding-plan` SQLite credential without printing it. HTTP 200, provider status code 0; the returned `general` entry reported total count 0 and usage count 0. This does not establish remaining quota greater than zero; active-and-positive gate remains unconfirmed. Do not repeat this request within an hour or replay earlier accepted operations. Owner-selected combo remains independent of this gate.

The next wake was not registered: this session has no Agent Herder MCP tools, and the live local `/mcp` initialization returned HTTP 401 even when using the running service's HTTP token, without exposing the token. Existing initial wait `wait_896ac6f6a785452b9bbda5ba9122dd84` is already `resumed`; it is not a future schedule. No automatic hourly continuation is claimed. The earliest next permitted status read is 2026-10-29 21:28:53 UTC; intended stable request ID is `notice-token-plan-hourly-20261029T21Z`.

## Owner correction and scheduled subscription check

Owner confirms the combo installation is correct; the previous instruction
to stop it was an error. Do not roll back the installed combo or change its
legs. An active Token Plan gates only the direct native subscription canary,
not the combo itself or independent integration work.

On 27 October the owner requested one read-only plan status per hour starting
tomorrow at noon Moscow: **28 October 2026, 12:00 Europe/Moscow**. Existing
Herder resume_after accepted the initial exact-session wake:
`wait_896ac6f6a785452b9bbda5ba9122dd84`, scheduled
`2026-10-28T09:00:00.000Z`, request
`notice-token-plan-hourly-start-20261028T1200MSK`, state waiting. No new session
or separate watchdog was created and no plan status was queried now.

The wake carries these continuation instructions: exactly one read-only
token_plan/remains request using the effective native integration credential;
never expose the credential. On inactive/unknown status schedule the next
hourly wake of this same session using a stable per-hour request ID. Do not
retry within the hour or invoke generation, login, purchase or fallback for
the check. On independently confirmed active plan with remaining quota,
stop rescheduling and record the gate for one isolated native acceptance
scenario; never replay accepted/UNKNOWN input. Existing combo operation and
independent tasks remain permitted. The first wake is durably scheduled;
later wakes are created by this bounded continuation, not claimed in advance.

Independent read-only source check still finds NoticePlace direct-only pin at
96b5fe1, with foreign WIP in its tests/bin. Leave those files to its already
assigned owner. No cross-session freeze or acknowledgement is required.

## Latest owner decision and installed receipt

Owner explicitly removed the paid-fallback prohibition on 27 October. Keep
the existing shared combo and its legs unchanged; the MiniMax API leg is
intentional. This supersedes the pending choice and earlier direct-only
instructions recorded below. Do not repeat subscription probes for activity.

Installed Herder source `46885ff4a5422da6bdafaeb4b2f441439eb02bb8` from canonical
main; no new checkout/worktree. 49 focused tests, canonical backend/frontend
build and all 14 release package checks passed. Bundle fingerprint
`1eed28dc5d733b068b4cd029d74458bb97d11e131d06b61756e8a4c813d36092`.
User unit PID `1383333`, start `2026-10-27 03:33:11 MSK`, entrypoint under
`.notice-herder-release-20261027/releases/46885ff4a5422da6bdafaeb4b2f441439eb02bb8/dist/index.js`.

Independent API readback ETag `c4d46cbefd965e8eb4e21d1426355edd` confirms
incidentExecution `{runtime:opencode, provider:omniroute,
model:omniroute/glm-5.3-flash-minimax-m3.1, reasoning:default, topic:health}`.
Only incidentExecution and the two existing NoticePlace/isolated-fixture
project routes changed. General routes and fallback configuration preserved;
incident dispatch still does not add an extra harness fallback around the
owner-selected combo. No shared router changes, generation or 2062 probe.

Activation restarted Herder once. The new validator initially returned 503
for the old direct-only policy, so readiness required correction: a valid
ETag on that response is sufficient to apply the compatible policy. The
existing documented If-Match PUT updated it without another restart; independent
GET and `/proc` entrypoint checks passed. Activation receipt is private at
`.tmp/notice-direct-20261027/combo-activation.json`.

Remaining integration boundary: NoticePlace-owned incident_model_policy.py
still pins direct MiniMax. Assigned its existing owner session
`01a174ce-7e3c-7a00-8b4d-174cf7ba10ad` the exact compatible combo contract,
with separate source/runtime ownership. Delivery
`owner-combo-allowed-fallback-20261027` was accepted, turn
`01a17ac5-7ef4-7d90-b227-780a8c3b49eb`. Do not overwrite that owner's source,
env or runtime. Full NP→Herder repair acceptance remains unproven until its
contract is installed; preserve previous accepted QA/session receipts. Then
run only one isolated source/service/verifier canary, not a production event
and not a replay of the previously accepted native operation.

## Latest owner direction: GLM + MiniMax combo (27 October)

This section supersedes the earlier direct-only target below. Owner states
that MiniMax Token Plan has been bought but remains inactive; do not repeat
2062 probes or use a paid fallback. Owner now selects the existing combo
`omniroute/glm-5.3-flash-minimax-m3.1` for incident execution.

The combo is present in the live OpenCode catalog. Read-only shared router
configuration shows four enabled legs: zcode/zc/glm-5.3-flash,
glm/glm/glm-5.3-flash, minimax-code/mmcode/MiniMax-M3.1-Flash and
minimax/minimax/MiniMax-M3.1-Flash. The final API leg must not silently
override the owner's paid-fallback prohibition. A concrete owner choice is
pending: remove it from the shared combo or constrain NoticePlace only.
Shared router settings have not been changed; no generation was attempted.

Owned Herder source now pins only the exact selected combo for incident
analysis/repair, including bare-model qualification; 49 focused checks passed.
Live runtime/policy still use installed aab06c81 and the previous direct route.
Do not claim the combo is installed. Source/release preparation can proceed;
activation and the one isolated canary require resolving the shared-route
constraint and aligning the NoticePlace-owned incident_model_policy contract.
NoticePlace's designated owner was sent one if_running handoff, which returned
skipped_inactive; no new session or wake was created.

## Historical direct-subscription delivery

Owner: Codex session `01a1754f-0228-7553-bea6-cc89e40b5187`.

## User result

Notice Place incident analysis and repair use only OpenCode provider
`minimax-coding-plan`, model `MiniMax-M3.1-Flash`. No OmniRoute or automatic
provider/model fallback. Ordinary nonincident routes are outside this change.

## Confirmed state

- Source commit `e74c6e6` is on `origin/main`. The incident policy validator,
  analysis admission, repair allowlist and both native-delivery boundaries
  reject alternative routes or pass an empty fallback list.
- Five focused test files: 53/53 passed; `npx tsc --noEmit` passed; scoped
  diff check passed. No incident producer event or native session was launched.
- Follow-up `aab06c81f763ef056d240f0ac0641ea6fbe6f5c7` fixes the repair
  normalizer boundary too. Focused regression tests: 34 passed.
- Canonical main build used the existing pinned-canonical-checkout manifest
  contract and release assembly/check helpers, without creating a Git worktree
  or another source checkout. All 14 package checks passed. Immutable release:
  `/home/roomhacker/agents-projects/.notice-herder-release-20261027/releases/aab06c81f763ef056d240f0ac0641ea6fbe6f5c7`.
  Bundle fingerprint: `870b84f628422a785d9ec90fdc56db4c3332b0426fcfdfe378ee90f935ffccb5`.
- User `agent-herder.service` runs that release. Independent `/proc` readback
  confirms its entrypoint; initial activation was 03:00:58 MSK on 27 October.
- GET/If-Match PUT changed incidentExecution and the NoticePlace/isolated QA
  project routes only. ETag `bb1b2b19bb53132eb348fbb988d03680` independently
  reads back OpenCode, minimax-coding-plan, MiniMax-M3.1-Flash, no incident
  fallback. Four existing project routes and general fallback policy preserved.
- The first isolated native admission exposed stale Herder auth: old protected
  credential returned 401, effective native credential returned JSON 200.
  Copied only OPENCODE_SERVER_PASSWORD into Herder's own protected env and
  restarted only Herder: PID 1001543, 03:15:10 MSK. Native OpenCode was not
  restarted. Independent authenticated API check now returns JSON 200;
  incident policy ETag stayed unchanged. Protected backup retained privately.

## Next owned action

Complete the existing isolated incident `inc_076f5b7158de468bb5c2422b1a469c62`.
Its SQLite, credentials, callback, Herder state, loopback service and verifier
are isolated under `.tmp/notice-direct-20261027/isolated-control`. No production
producer event was sent; no communication adapter is constructed. Scripts in
the sibling task directory reproduce this bounded deployment. Preserve all
admission receipts. The initial request was durably pre-admission rejected,
created=false, delivery=not_attempted; its attempt log remains intact. The
single post-auth correction admission has a separate QA attempt journal, and
its existence blocks another retry. Accepted/UNKNOWN operations never replay.

This canary exercises the real NoticePlace worker/helper and installed Herder
artifact/native adapter. Its isolated helper runs locally, so it does not
prove the separate production GPTAdmin webhook transport. Existing accepted
desktop/mobile QA toggles and their receipts remain unchanged.

## Installed result and exact external blocker

The existing isolated incident admitted exactly one native executor:
`ses_e85485447ffe94LLLhs1MabFaC`, operation
`f05cfddfb825e9ebcb6e0b384bec6c37`, accepted at
`2026-10-27T00:17:01.861Z`. Native receipt confirms provider
`minimax-coding-plan`, model `MiniMax-M3.1-Flash`; autopilot arming succeeded.
Generation then failed with provider HTTP 402, `insufficient balance (1008)`,
request ID `072f207eb2a6dd0a767a47d0c8e3beb8`. No tools or source repair ran;
the independent source verifier did not report healthy and did not resolve
the incident. This is NOT successful repair acceptance.

Read-only route investigation after that failure:

- Live native `/api/provider` and `/api/model` report the canonical provider,
  package `@opencode/ai/providers/minimax/messages`, Base URL
  `https://api.minimax.io/anthropic/v1`. This matches the official MiniMax
  OpenCode instructions: https://platform.minimax.io/docs/m-plan/opencode .
- Read-only native SQLite `credential` lookup finds exactly one credential
  for that integration, type `key`, subscription-key class. It matches the
  legacy native auth store. No value or digest was printed or copied.
- Read-only GET `https://www.minimax.io/v1/token_plan/remains` authenticated
  with that exact native credential returns HTTP 200 with MiniMax code 2062,
  `no active token plan subscription`, `model_remains:null`.
- Therefore the external blocker is absence of an active plan for the
  selected subscription credential, not proven quota exhaustion or a paid
  API route substitution. No balance top-up, route change, fallback or further
  generation attempt was made. Root does not manage the provider account.

Private evidence: `.tmp/notice-direct-20261027/isolated-control/` contains
`native-admission.json`, `native-messages.json`, both admission journals and
the isolated Notice SQLite. The original rejection journal is preserved.
The QA Herder/API/source processes exited; only the exact QA autopilot binding
was disabled using the installed store API. The failed native session and
receipts remain available for inspection; no live Stop was called. Communication
adapters constructed: zero; production producer events: zero.

Smallest next action: provider-account owner restores the active subscription
for the existing key. Verify the exact native credential's plan read-only
first. Only after a successful independent route/plan readback and confirmed
isolated contacts may one explicitly bounded canary continuation be considered;
never replay the previously accepted operation. Until then the installed
runtime/policy result is complete, repair business acceptance remains blocked.
