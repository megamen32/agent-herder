# Notice Place incident route: direct MiniMax subscription

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
