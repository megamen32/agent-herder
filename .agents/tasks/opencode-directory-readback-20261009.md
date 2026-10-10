# OpenCode directory-aware readback — 2026-10-09

Owner: Codex 01a11747-c694-7340-be48-f973e3c4e568. Root assignment: 01a11b43-e667-7c61-aaf5-4a26e12623a1.

Status: source repair and 21 focused tests PASS; priority pause before typecheck/build/publication/deployment/native acceptance. Task remains open.

## Confirmed native RED

Existing `ses_edfb30318ffeZR52kIkd5wbCiK` in `/home/roomhacker/gptadmin`, explicit `minimax-coding-plan/MiniMax-M3`, was busy in directory-scoped native `/session/status`, while the bare endpoint returned `{}`. Herder exact lookup reported idle with empty lastMessage. Folder discovery discarded the project before post-filtering. Native session and current tool/edit receipts were read only; no session recreation or provider prompt.

Evidence: ignored `.tmp/opencode-directory-20261009/native-red-observation.json` and native OpenAPI snapshot. Native timestamps are milliseconds.

## Owned repair

`src/adapters/opencode.ts`: retain session directories, resolve cold native metadata, scope status/messages/transcript/control requests, hydrate exact lookup with current status/latest receipt, preserve native millisecond timestamps and explicit model/provider. Retry means running; non-404 status failure propagates rather than claiming idle.

`src/mcp-tools/handlers.ts`: only listAgentsResult folder forwarding for OpenCode (`adapter.listSessions({cwd:expandPath(parsed.folder)})`). Other adapters/folderless calls and accepted-receipt formatter/delivery/queue/replay functions remain unchanged. This hunk was explicitly transferred by publisher54.

`tests/opencode-directory.test.ts`: seven directory/readback/discovery cases. `tests/opencode-recovery.test.ts`: fourteen existing regression cases, scoped query fixtures and unique model-failure name to avoid cross-test recentNamedSessions reuse. No production named-cache change.

## Actual focused result

Canonical existing `herder-delivery-focused100` authorized-case, 512 MiB high / 1 GiB max / swap0 / CPU1 / tasks128 / wall120 / temp64 MiB / files4096. One worker, two files: **21 ordinary PASS**, 2.61s; peak151195648 bytes, swap0, OOM0. Unit run-u16377.scope / invocation4fb6c3aeb22f4605b5ee905fc4e6e725; same-generation cleanup confirmed.

Exact inputs/case: `.tmp/opencode-directory-20261009/focused-case-isolated.json`. Receipt `attempt-61128c54586f3d3f1e715ea87c5896ee.json`; log `bounded-a69xp6ui/payload.log`; compact SHA proof `focused-green-handoff.json`. Earlier two 20PASS/1FAIL fixture attempts retained, not substituted for final result. Final failure cause was reused `(harness,cwd,name)` cache across independent mock servers; isolated fixture name fixed it.

## Priority pause and next executable step

Root reported explicit GPTAdmin/human pause until actual AutoFind acceptance. Current bounded command finished and evidence preserved. No new tests/build/restart/consumer canary started after that message. Neither clock expiry nor old resource reports release the pause.

After verified release, reuse this 21PASS while pins match; run scoped semantic typecheck/transpile of only the two changed production modules through existing canonical authorized-case. Publish only owned paths on main; assess actual inflight and deploy exact two-module slice through supported safe reload, preserving native sessions/turns. Read back SAME native session through Herder agent_info and list_agents(opencode,folder=gptadmin), comparing current native status/receipts/model without prompts or recreation. Record actual runtime/consumer proof and scoped post-canary publication.

Foreign WIP preserved/excluded: three other owner task trackers and src/web-ui/main.tsx. FastAgent canary is already accepted; do not replay it. No QA/browser lease used. No runtime or daemon changes in this repair cycle yet.

## 2026-10-10 integration ownership handoff

Root assigned sole fleet integration/deploy to owner55 `01a11755-69a6-7c33-8475-349da94d0f77`; previous priority pause is not renewed. Adapter and both test files remain exactly byte-identical to accepted21PASS. Current tracked handlers and named-session source have since changed; retain their published behavior. Historical21PASS is not a full current-dependency acceptance. Current source delta manifest and transferred pins: `.tmp/opencode-directory-20261009/owner55-integration-handoff-20261010.json`. All three source/test paths plus this tracker transferred for integration/publication. No competing check/build/reload from original owner; no native input recreation/replay.

## Текущая интеграция 10.10

Currentdependency regression выявил старое fixture expectation: published discovery передаёт limit20. Исправлен только owned assertion, сохранены cwd-only OpenCode и bounded других adapters. 21/21 fast units PASS2.87s/peak157409280 bytes/swap0/OOM0/cleanup; source published e9f9a5e. В integrated fleet candidate77 relevant units и TypeScript/frontend build также PASS. Historicalpause не действует для нового explicitfleet scope. Native readback без recreate/prompt остаётся следующим runtime acceptance после согласованного Herder reload; старые accepted/unknown inputs не повторять.
