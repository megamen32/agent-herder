# Independent active-session review

2026-10-23 18:26 UTC. Read-only source/test review; product/runtime unchanged.

## Current verdict
Consumer acceptance NOT RUN: new feature not installed. R1 updater and production reader wiring fixes reviewed; 6 tests passed. R2 plus attribution finding R3 and native GUI coverage R4 remain with owners.

## R1 — workspace ingestion disconnected / first location frozen
`src/active-session-inventory.ts:41` constructed updater with `readEvidence:async()=>[]`. `createSessionWorkspaceOwnerUpdater` skipped every nonempty record. Counterexample: declare A, execute in B, activity changes; updater never reads B. Required regression A→A+B with independent evidence. Core/workspace owners acknowledged and are fixing background ingestion separately from fast materialization.

## R2 — startup declaration instruction not connected beyond tool description
`src/index.ts:647` registers workspace tools, but task-start declaration instruction appears only in `session_workspaces_declare` description. No lifecycle/server instruction invoking that seam found in current source. Existing common MCP instruction seam should tell every new session to declare exact runtime identity and real work host/path; capability availability alone is not lifecycle activation.

## Verified source guards
- Physical owner from local hostname; primary hostId matches workspaces, runtimeHostId independent.
- Totals before pagination; unknown workspace makes filtered exact count null.
- Dedicated coverage receipts, ZCode known-candidate coverage non-exhaustive.
- Slow provider does not block fresh provider publication. Read does not renew TTL.
- proper-lockfile, reload-under-lock, expectedVersion CAS. Durable declarations have no activity TTL.
- Mavis status_type 1 active despite retained error; metadata cursor-cycle validation.
- Parent inheritance only explicit native parent identity, same runtime/harness.
- Legacy list_agents explicitly directs current inventory to list_active_sessions.
- Native evidence persistence contains absolute path plus message/tool references; raw full tool command is not persisted. User-supplied evidence remains freeform; callers must not supply secrets.

## Validation
First focused run: active-session-inventory, session-workspaces, session-workspaces-backfill, opencode-active-runtime: 4 files, 17 passed. Second: minimax-active-runtime, minimax-active-native-proof, zcode-active-runtime, session-workspaces-owner: 3 files passed, 1 skipped; 8 tests passed, 2 skipped. Skipped native proofs do not establish installed acceptance. Durations 2.77s and 3.35s.

## Acceptance still required
Current native IDs vs installed command IDs, same observedAt window; roots/children counts; 1..N actual paths/evidence; three sequential read-only timed fleet queries with no LLM gaps. Dynamic live count has no fixed historical expectation. Native metadata status proof does not yet independently prove in-memory GUI generating/compacting-only coverage. No deployment, restarts, activation, messaging, or AI launches by reviewer.

## Re-review 18:28 UTC
R1 updater corrected in 9707c7a: known records can ingest changed native activity; inherited-only child follows exact parent version while own declarations/explicit clear stay authoritative. Production native reader wired and background ingestion does not block materializer. Rerun owner/backfill: 2 files, 6 passed.

## R3 — declared host is not per-tool execution host proof
Production resolver picks the single known ledger host then labels every extracted native shell path as that host. Counterexample: declared server100; native local M1 bash cwd=/Users/user/project -> false server100 workspace. Or ssh server44 with cd /home/roomhacker/other -> false server100. Need explicit native execution host/verified transport per event; leave uncertain paths unknown. Sent core+Lead.

## R4 — metadata-exhaustive differs from GUI-busy-exhaustive
`src/adapters/minimax-code-active.ts:59` says exhaustive true, while :60 only matches status_type 1. Required native GUI OR includes isGenerating, generatingBySession and compacting. Need prove those flags always imply started from current native source/runtime, or use specific gui_activity_flags_unobserved coverage reason and partial. No observed live omission is claimed; this is a source-level completeness gap, not a fabricated consumer failure. Sent Lead.

## Final source delta review 18:39 UTC — SOURCE GREEN
- R2 closed c51f74c: declaration instruction now in MCP initialization instructions, not just tool description.
- R3 closed 9614acd: only native tool.executionHostId or explicit MCP shell target establishes execution host; declared workHostId does not. Ambiguous local/SSH paths remain unknown. Native persistence contains paths and event references, not raw tool commands.
- R4 closed 656827d for actual accepted native execution contract: union metadata-started + read-only accepted-ingress candidate IDs, validate every candidate through current turn-continuation Running=2. Stale metadata Started cannot override idle controller; metadata Idle can still be active. Failed seed/per-ID reads yield partial receipt, retaining independent positives. Read-only SQLite selects only distinct session_id; no prompt/message/tool body or credentials read/persisted by this index. Source proof reviewed at canonical minimax-native-active-turn-source-proof.md; direct installed source absolute root not yet independently reread. Optimistic pre-acceptance GUI spinner states intentionally outside actual execution contract.
- Concurrent recovery regression was observed RED (21 pass, 1 fail), then fixed 74436ba and independently rerun GREEN: 4 files / 22 tests, 0 fail, 649ms vitest duration. Failed workspace reader does not stop other identities and retries unchanged failed identity after cooldown.

No source blockers remain from this bounded review. This statement is SOURCE GREEN only; installed consumer/API/MCP, current native ID equality, actual workspace inventory, and three sequential timed queries remain pending deployment readiness.

## Independent installed native contract readback 18:42 UTC
SSH reverse route verified MacBook-Pro-User.local / arm64. Read installed /Applications/MiniMax Code.app/Contents/Resources/app.asar using existing read-only asar-slice/asar-grep helpers. Verified turn-continuation service activeTurnId check precedes history inspection; continuation-history fallback returns unavailable/available/waiting-for-user, never running. Generated enum Running=2. Regular turn repository.admit offset19708 precedes controller.register25462; manual compaction admit27681 precedes register28147. This independently confirms the source candidate/control contract. No runtime/GUI/session mutation. Readiness requested once from product; live installed Herder acceptance still pending deploy.

## Installed M1 consumer attempt 18:50:56 UTC — freshness FAILED
Fresh real HTTP MCP initialize/tools-list/tools-call and API successfully used installed feature. MCP schema exposes hostId/runtimeHostId/harness/limit/offset; initialize includes declaration instruction. API and MCP exact returned ID sets match. Workhost100 includes M1 runtime rows, runtime-only returns same20, primary workhostM1 returns0. Twenty rows have14 multiple-workspace records; all18 unique paths exist on actual server100. Every workspace has source/evidence/observedAt; only expected fields are serialized, no raw command/token fields.

Acceptance blocker: both API/MCP returned stale owner observedAt18:50:21.511Z with native_activity_unavailable; all20 activity rows became unknown, activeCount0 and exactnull (honest partial, not false idle). Independent read-only native accepted seed contained21 IDs; current controller GET returned Running2 for21, including new nativeOnly mvs_4f40fab5c86f4ad5bad2cd9b7b5507a2. No stale API-only ID. Earlier LHC idle-metadata example now controller0 (dynamic, correctly absent). Product+Lead notified. Full bounded secret-safe receipt reviewer-live-m1.json. No runtime mutation by reviewer.

## ZCode transport repair — user current-work correction, 19:19 UTC
The user's claim was correct. Herder's old stdio instance PID1274871 had no loaded target and historical native completed metadata; that was not the official server's current runtime. Official supported control.sock status/running-tasks/status verified ready3.16.3 corePID1199736 generation1, root session_b38b92e45be8939782ee5863251407b4 plus2 native children. Do not describe the user's observation as stale.

RED→fix→GREEN source commits:
- 8b4afb0: background supported official control observer, cached positives override historical completed for active/list/exact-ID readers. No query socket/history scan. Initial focusedRED returned[] for genuine current positive;15focusedGREEN.
- 13c9a7a: actual official RPC rejected messageLimit0 (-32602 expected>0); positive-limit regressionRED then14focusedGREEN. Limit1 dialogue is discarded, not persisted.
- c4c80f1: existing native codec/parser/event client reused over official authenticated /ws/host, single-use native capability; no new daemon/core patch. Official server is never a Herder-owned process and close disposes connection only. Lost-admission unit proves one request/one connection/no automatic replay. Exact-parent gapRED→GREEN: bounded native SQLite session.parent_id read for exact official running IDs with matching native directory; two children link to actual b38root.18focusedGREEN/2optinskipped, tscGREEN.

Native readonly WebSocket consumer19:07:54: exact userID Running, activeTurnId turn_10ba0b7e-8212-407a-8c50-236926fa3850, eventSeq17934/stateRevision7. SOURCE new reused WebSocket client read proof passed and closing its connection left target in official running-tasks. User-target sends/steers zero.

Own isolated canary receipts: reviewer-zcode-canary.json records initial BEFORE-ID native refusal project.remote-project-required; no prompt was sent. Corrected supported project.saveProject→prepareSession created own project a1e2fa34-9aba-4537-a34b-1e7fef72097d and session_95c794ef-153f-4a3b-a0c4-5d0031cecbb3 in /tmp/herder-zcode-ws-uKNbi0. One stable input herder-ws-e5712529-a80d-41b2-87bb-475c8a0bbbc0 received native accepted admission. It was never replayed. Native DB confirms queue promoted to exact user anchor and turn_28821070-89ff-4dac-9d17-8ceac5ed2c5b completed. Initial opt-in test60s timed out before roughly66s provider completion; this invocation is not labelled GREEN. Independent19:18:48 readonly WebSocket readback proved idle/noactiveTurn and assistant exact marker HERDER_ZCODE_WS_20261023_OK. Stable receipts reviewer-zcode-canary-v2.json and reviewer-zcode-canary-readback.json. Future nightly canary deadline adjusted120s from measured latency; existing accepted canary must never rerun.

Delivery contract: V4 requestedDelivery queue/guide is supported and receipt/admission/current input consumption proven on own session. Native guide does not expose expectedTurnId/turn CAS in request schema (targetTurnId is an event field); no claim of exact-turn CAS or working-user steer acceptance. Source createSession without an existing native project context remains refused by official remote-project policy; isolated fixture uses supported project preparation rather than weakening native policy.

Installed latest transport boundary awaits product readiness/readback; source send completion and installed identical-byte/preflight claims remain separate. No ZCode core/GUI restart, user message, socket rename or accepted-input replay. Existing user processes preserved.

## Installed ZCode boundary 19:24–19:25 UTC — verified separately
Installed Herder ExecStart bda5746d2d46b6f613b94f3d6f99239aa4cc8b0a, PID1940009. Four owned installed JS modules (adapter/protocol/server-control/runtime-observation) are byte-identical to independent current-source TypeScript ES2022 transpilation; full hashes reviewer-zcode-installed-hashes.json. Imported the INSTALLED protocol and official helper; same completed own canary readSession succeeded: idle, noactiveTurn, exact assistant marker true, ownedNativePid null. This was a read of the existing accepted canary, never a new send. Installed readback reviewer-zcode-installed-readback.json.

At19:23:35 API currentZCode2 active, roots0/children2, each exact parentb38; official running-tasks at19:24:31 likewise2children (root naturally no longer running). Fresh connected MCP list_agents at19:25:21 showed both current children running with official-server-ws route and parent linkage. Historical root currently error; its earlier19:07 running observation remains valid historical evidence and is not contradicted by later completion/error.

Remaining confirmed workspace integration gap: installed active rows both workspaces[] despite supported official current workspacePath TelegramAuto on physical100. Core product owner notified to ingest this explicit background native evidence; until then primary workhost100 filtering can omit these known-location sessions. No fabricated exact count.

Mesh capability boundary: LocalHarnessMesh intentionally reports noncodex/nonminimax delivery unsupported/native_admission_receipt_unverified. That is mesh admission policy, not a dead socket claim. Repaired/proven delivery consumer is existing send_message queue/guide→ZCodeAdapter→official authenticated WS V4. Mesh_route ZCode acceptance was not added or claimed.

## Final mesh contract and Mini readback, 19:36–19:38 UTC
Mesh bridge b1b6b63 RED2fail→GREEN;18focused combined/1optinskipped, finalmesh14/14 and tscGREEN. Only official-selected ZCode with fresh native control scope is enabled; V4 native input admission is mapped without fabricated turnId. Existing mesh ledger preserves accepted/UNKNOWN inputs and budgets; HumanStop, automation disarm, project model gate and coordination context remain. Other unsupported harnesses unchanged. This supersedes the earlier mesh-policy unsupported gap.

Installed f630075ef68a8bb0fe63faed95b6e3256f61cc81: five owned JS modules (adapter/protocol/control/runtime-observation/meshlocal) independently byte-match tested source transpilation. Real connected MCP mesh_snapshot advertises ZCode discovery available + delivery available and current root+2children. Own completed canary's idle executor has since unloaded: existing-only returns Session is not active; no load or resend was attempted. Its earlier completed marker/admission receipts remain preserved. Current installed native readonly preflight against user b38 (no input) succeeded19:37:07 Running, turn315dd97b-5915-44b7-8845-c8c99fd3584e, revision8/eventSeq18368; ownedPidnull. Proof reviewer-zcode-installed-mesh.json and reviewer-zcode-final-readback.json.

Mini independent readback19:38:09: hostname mac-mini-2012.lan, current/config f630, existing user501 watchdogPID38592 running, actual nodePID38634 LISTEN18789, API receipt ownerPID38634/fresh available/exhaustive codex zero. Historical last exit78 remains in launchctl output and does not invalidate present running/listener proof. Operator recovery retained inactive bytes outside active releases after actual guards (<=2 releases and512MiB artifact bytes), with no quota increase. Reviewer performed no restart/recovery action. Proof reviewer-mini-final.json.

NEW LIVE GAP: independent global API query19:38:11 took1.582s,4hosts available but M1 unavailable/direct_native_listener_unavailable and0M1 rows. Do not claim five-host acceptance from earlier readiness. Product/Lead/Tester2 notified with reviewer-all5-final.json. Safe independent result: ZCode3 current rows now1root+2children and all3 have actual100/TelegramAuto observed supervisor workspace evidence. The workspace integration gap is closed. Final five-host availability remains pending M1 owner repair/retest.

## M1 transient observer false-kill — source and helper delivery
Actual installed guard SHA fce53f441565b65af118cd08c57584d4c5e413ea7b20a7330aacbfe096ead7f9 matched tracked deploy/fleet/mac-node-watchdog.py. Last-run recorded state-census deadline3.529s attempt0 after182.75s, while independent fresh native state probes measured6–12ms/187136bytes/5entries. Darwin native mutable branch bypassed the existing deadline retry seam. Owned7714233 (published main0655bee) adds one deadline-only entirely fresh native census within the SAME original four-second window, pinned root, adaptive bounded cleanup reserve. Byte/file/root/cleanup failures remain fail closed; no quota change, stale-good cache, nativeGUI restart or input replay. Exact3.529s RED became5/5GREEN; existing80/80GREEN.
Supported helper/config CAS retained old files in M1 ~/.local/state/agent-herder/rollback/guard-7714233. Installed new helper SHA1dfa7c46a4c6f2d4991af9b3463e78e9ed2b6c964c22cf4c0504b148fb8a08fa and only its launcherHashes pin; config SHA2eb8d4b7faae8152bbedde583fdb0c666c26fedf276c4996a4e8acc9d4317250. Existing source/current f630 preserved. Reviewer did not restart manager. Product owns combined b17 activation/single restart; steady runtime acceptance is pending, not PASS.

Independent installed guard readback: product combined one activation/kickstart; source/current b17f6e48f8ebd66fb876fbc0e4c3f103f8decb7c, helper and launcher pin independently exact1dfa7c46...a08fa. Existing gui501 manager88455 running, Node88827 stable. Three owner observedAt generations19:49:24.975→19:49:35.202→19:49:40.219; native MiniMax evidence21.107→37.314 refreshed. Bounded guard deployment/owner-generation acceptance PASS; sustained long-run absence of future transient failure is not claimed. Receipt reviewer-m1-guard-readback.json contains host provenance only, no dialogs/tool commands/tokens.
New separate fleet transport observation: first two queries all5available, third query via M1 returned other4hosts activity_host_deadline while M1 remained available. Forwarded to product owner, so this evidence does NOT claim whole-fleet acceptance. No new send, GUI/native restart, notification, quota increase or accepted canary replay.

## Final independent installed materialized-index acceptance, 20:10–20:12 UTC
Actual M1 config source9cffc9efa0dfe05eed6eb67c2b9a21db877dba7e, manager19467 running, installed guard and launcherHashes both1dfa7c46a4c6f2d4991af9b3463e78e9ed2b6c964c22cf4c0504b148fb8a08fa. Three M1-origin global API reads20:10:08.019→17.801→26.961 each returned all5hosts available. Every owner's observedAt advanced; physical global index mtime changed1792786205115153755→1792786213493185700→1792786226839365402 (index schema version/owners/errors, no invented generation field). MiniMax M1 fresh native source observations included; counts38active18roots20children,0unknownActivity,5unknownWorkspace. partial=true/activeCountExact=null correctly retains unsupported coverage uncertainty.
Measured local urllib latencies2234.88/1775.51/1153.80ms. One bounded curl follow-up measured2918.425/532.205/24.226ms, TCP connects0.314/0.419/0.327ms. No sub100ms guarantee or whole-call benchmark substitution. Query uses the released materialized backend; no syscall-trace proof is claimed.
Independent actual primary-workhost100 + runtimeM1 filter returned17currently active rows (dynamic later count), all physical runtimeM1 and all containing actual workspaces on100; multiple paths retained with1/2/3locations. Earlier18M1rows comprised5single/7two/6three location rows. Provenance contains declared/inherited exact parent/native-event refs and original observedAt, no raw tool commands/dialogs/tokens. Runtime host is not replaced by workspace host. Receipt reviewer-final-materialized.json.
Final bounded acceptance PASS: five-host availability, fresh background observations/index updates, honest uncertainty, workhost/runtime separation, multi-location evidence and installed guard continuity. No new sends, canary replay, source edits, runtime changes, GUI actions or notifications in this final check.
