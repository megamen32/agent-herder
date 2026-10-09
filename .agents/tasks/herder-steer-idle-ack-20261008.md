# Herder idle-steer acknowledgement

Status: accepted-receipt source candidate prepared by existing publisher01a11b54; focused checks require fresh registered resource admission; publication, safe deployment and one-input native canary remain pending. The obsolete Telegram language53 test hold was explicitly removed by Root on 2026-10-09. GPTAdmin prerequisite is complete. No accepted message is replayed; source preparation is not delivered acceptance.

## Exact native evidence

One existing Herder MCP `send_message` addresses Codex session `01a11755-69a6-7c33-8475-349da94d0f77`, with `mode=steer` and stable inputId `gptadmin-relay-owner-routing-20261008-ai-secretary-handoff-v1`. Fresh native `agent_info` reports idle before dispatch. Native `task_started` at 2026-10-08T19:52:55.375Z has turn ID `01a11d13-6f37-7ff3-99bb-381f8c0d8fe8`; exactly one matching handoff user `response_item` appears at 19:52:59.009Z in that turn. Herder readback reports the same nativeLastTurn inProgress.

The same MCP call later returns HTTP200, JSON-RPC id3, with text `Failed to send message: Timed out waiting for Codex turn completion for 01a11755-69a6-7c33-8475-349da94d0f77`. The native turn remains running after that response. Accepted delivery is proved; GPTAdmin repair completion is not.

Private operational receipts are outside Git on server-100: `/home/roomhacker/gptadmin/.tmp/relay-owner-native-admission-20261008.json` and `/home/roomhacker/gptadmin/.tmp/relay-owner-handoff-20261008.json`. They contain no credentials. No second dispatch is performed.

## Source boundary and smallest repair

`src/adapters/codex-app-server.ts` creates `waitForCompletion` for every idle-started delivery where queue is false, including explicit steer. Its 300000 ms deadline returns ok:false without accepted receipt metadata. `src/mcp-tools/handlers.ts:handleSendMessage` then formats that result as failed delivery. The durable CodexDeliveryReceipts lifecycle also must preserve an accepted acknowledgement rather than treating task completion as delivery admission.

The smallest candidate separates explicit steer admission from optional sync completion: after a valid native turn/start receipt, steer returns ok/admitted plus matching turnId/inputId immediately and persists that receipt. Explicit sync retains completion waiting. Existing active-steer turn validation and idle one-turn start remain authoritative; no queue/backlog or repeated RPC is substituted. Verify with focused idle-steer acceptance without completion, active-steer matched turn, repeated same inputId returning the same receipt without another native start, and unchanged explicit sync completion. Native acceptance uses one authorized idle session and a harmless task, then verifies one matching user input and native turn; a second accepted handoff to the active GPTAdmin owner is prohibited.

## Current ownership and exact blocker

Canonical infrastructure card `ServersAdministartion/docs/inventory/sites/agent.md` delegates Agent Herder product/source to `megamen32/agent-herder`, primary `/home/roomhacker/agents-projects/agent-herder`, user service `agent-herder.service` on loopback18787. At this inspection main/origin main are93fbc0c. Existing foreign composer/outbox WIP occupies `.agents/tasks/wip-20261008-composer-delivery-queue.md`, `src/herder-jobs.ts`, `src/human-stop-store.ts`, `src/session-supervisor.ts`, `src/types/common.ts`, `src/web-ui/main.tsx`, `src/web-ui/styles.css`, `src/web/server.ts`, plus user-message-delivery/composer source and tests. Preserve that work. Its ledger identifies coordinator01a11b24-233f-76e0-b368-a6a8655bfad3, publisher01a11b54-d261-7bb3-ac0f-634926280766 and worker01a11b43-e944-7663-9ce8-d75df67c1167. Cached quick inventory reports worker idle but warming=true; this does not prove exclusive ownership is released.

The existing Herder build contract permits Node heap1024MiB and one Vitest worker in an existing guarded session, one project heavy workload. Live service memory current667570176B, high1073741824B, max2147483648B, swapmax536870912B, CPU4cores,11/512tasks are observed service metadata, not a test budget grant. Dynamic host/project admission and current source ownership must be refreshed before any tests/build/restart. No heavy job or service restart is performed for this ledger.

Smallest next action: after the GPTAdmin owner provides its meaningful repair outcome, refresh exact Herder owner status/turn, deliver this source boundary once through native steer, and have the existing publisher integrate the accepted-receipt fix with the preserved composer history under the documented measured budget. Capture focused checks, published same SHA, deployed artifact and the native idle-steer acknowledgement canary. Until then this defect remains open; no false failed response authorizes a repeat delivery.

## Post-routing owner checkpoint — 2026-10-09

GPTAdmin source 1a4eec89, exact Node c18aecd/v1009, cloud run 37840649368 and artifact 11577248404 pass. Existing Hub PID 3406917 runs that candidate with finite 3/10 GiB RAM, swap 0, CPU 2, Tasks 512. Native long-shell job 424463a6c7e5aa7cb16950a16593b3db exits 0; hinted/no-hint/repeated completed receipts agree. This satisfies the prerequisite routing outcome.

Fresh Herder metadata reports coordinator 01a11b24-233f-76e0-b368-a6a8655bfad3 idle/completed turn 01a11bee-8118-76e0-917c-e04c29408284 and publisher 01a11b54-d261-7bb3-ac0f-634926280766 idle/completed turn 01a11d31-4656-7e01-8964-d6f456be4d8d. Neither has an active turn. Canonical HEAD cae6fd2 includes this diagnostic ledger; all listed foreign composer source/tests remain uncommitted and owned. An idle session does not release those file boundaries. No Herder repair dispatch, source edit, test, build or restart occurs here. The next integration action is one deduplicated native steer to the existing publisher after fresh status/admission, preserving the composer WIP and validating the accepted-receipt contract.

## Accepted-receipt ownership and source candidate — 2026-10-09

Telegram AI coordinator/mac_mini_primary assigned the existing publisher01a11b54 the accepted-receipt slice and composer integration once, inputId `herder-idle-steer-ack-owner-handoff-20261009-mini-v1`. Source base is published `1f086ba038b2110cbb8c1953152a4136d279f12d`. Publisher owns only `src/adapters/codex-app-server.ts`, `src/adapters/codex-delivery-receipts.ts`, `src/mcp-tools/handlers.ts`, the receipt-focused tests and this ledger. Existing composer source/tests, including all paths previously recorded and its additional evidence ledger, are preserved and have not been rewritten. AutoFindClient and the current chat CWD are unchanged; no worktree, daemon or native session was created.

The source candidate returns verified `admitted/turnId/inputId` immediately for explicit idle steer after one native `turn/start`. Active steer still checks the actual expected turn; queue behavior is retained. Sync continues to wait for matched completion, but its completion failure now retains admitted identity and nonRetryable status, so durable receipt storage cannot delete an already accepted input. The MCP acknowledgement includes the exact native receipt rather than dropping its IDs.

Inspection also confirmed that receipt read previously erased accepted/uncertain evidence after one day or by truncation. The candidate retains that evidence without automatic eviction, keeping the existing finite 2048-record capacity. A full store rejects a new input before native dispatch, preserving all existing evidence. This intentionally trades new admission at capacity for the mandatory no-replay rule; it does not raise the budget or silently clear records. Operator-managed archival/reset policy is outside this slice; no live receipt file was altered.

Prepared focused regression source covers idle acknowledgement with no completion, persisted duplicate after adapter restart, verified active steer, matched sync completion, sync timeout without replay, old accepted/uncertain receipts and full-capacity refusal. These cases have NOT run. No old 40-pass composer result, GPTAdmin long-job receipt or source inspection is being substituted for this matrix.

Current external blocker: shared heavy slot is owned by Telegram language53. The coordinator explicitly permits only light source/metadata work until handoff. Therefore no tests, tsc/Vite/build, browser, commit/push hook, service restart, or acknowledgement canary has run. After explicit handoff: obtain a reviewed Herder-specific finite test/build admission, run the focused receipt matrix plus current composer direct regressions, review the combined source preserving composer history, publish the exact source, use the supported safe deployment with an explicit shared-ZCode handoff, then deliver exactly one harmless stable-ID input to an authorized idle native session and read back one matching user input/turn and the immediate acknowledgement. Never replay the previously accepted GPTAdmin-owner handoff. The graph's AST refresh also waits for its own bounded source-maintenance slot; no unbounded graph rebuild was started.


## Fresh native owner handoff — 2026-10-09

Confirmed source still creates completion for every !queue idle delivery;
main/origin1f086ba has no accepted-steer repair. The listed13foreign composer
paths remain preserved. A fresh real Herder details request reports publisher
idle; existing native Unix-control thread/read verifies completed turn
01a11d8c-1b14-70b2-8cf7-d3f7f8e7e0e2, no active turn, CWD AutoFindClient.
The source-owner request explicitly preserves that thread CWD and its work.
Native Codex wait_threads(timeout0) metadata fetch does not settle in this
contour; the read-only call is cancelled without repeat or runtime mutation.

Exactly one meaningful request reaches existing publisher01a11b54-d261-7bb3-
ac0f-634926280766 through the already-running shared native control socket.
Marker/inputIdherder-idle-steer-ack-owner-handoff-20261009-mini-v1 is checked
against existing native input before delivery and a private receipt guards
operator replay. Fresh native status is idle, so supported turn/start starts
one turn in that existing session; no new thread/daemon/queue is created.
Native admission turn01a11db3-f90d-7222-a18b-4cc50a9d4d85 is followed by one
matching userMessage item01a11db3-ff8b-7040-b783-fb300de0c5cf inProgress.
Receipt `.tmp/mac-mini-ack-handoff-20261009.json` stays private/outsideGit.
This proves source repair handoff, not completion of the acknowledgement fix.

The publisher receives exact adapter/handler/receipt boundaries and idle/active/
deduplicated/sync checks, preserves foreign WIP and the current AutoFindClient
context, and performs only light source/metadata work while Telegram language53
owns the shared heavy consumer. No source fix/test/build/deployment/service
restart is performed by this observer. Existing graph query lacks a specific
steer vocabulary and ranks unrelated adapter sendMessage nodes; current source
and real native evidence therefore remain authoritative.

Next action: existing publisher integrates the admitted-receipt source repair,
then after explicit resource handoff uses the owning bounded admission/checks,
publishes reviewed complete source, follows the supported sharedZCode deployment
handoff and records a genuine idle native acknowledgement without completion
waiting. No second repair message is sent after accepted admission. The defect
remains open until source and actual deployed native consumer are verified.

## Current publisher continuation — 2026-10-09

Root explicitly removed the unverified Telegram language53 manual test prerequisite. This is not permission to bypass a live lock or stop another consumer. Current canonical main is 93716395fc585e964e0d224314aaa3d6ff953416; all receipt/composer WIP remains preserved. The previous 40-pass/failed-build receipt is historical evidence, not proof of the changed closure. The current matrix includes receipt retention and idle/active/repeated/sync, current composer/HTTP/queue regressions, human-stop and existing active-adoption guards. Receipt/adoption fixtures now use inherited TMPDIR, keeping temporary state inside the canonical lease.

Publisher prepares one exact source/tool manifest and sequential checks/build actor for Infra01a11b2c registration and a fresh actual OFD/book/host/service-reserve admission. FastAgent11 remains its separate owner's job; agreed handlers/human-stop/types bytes remain unchanged. No tests/build or publication has started at this checkpoint. Supported shared-ZCode/client handoff remains a separate deployment prerequisite; accepted GPTAdmin input will not be replayed.

Root subsequently supplied exact language53 mapping: Codex01a11afc-4f5d-75e3-8810-b13348bb8d93 on server-88, freshly idle/no active turn, last turn interrupted. The human confirmed it finished and removed the old hold; this does not reclassify its consumer outcome or admit a shared Herder restart. Root evidence: `ServersAdministartion/.tmp/fleet-codex-watch-20261007/monitor/herder-language53-hold-resolution.json`. No foreign88 session was touched.

Source review also corrected legacy native-adapter assertions to verify admission/turn identity, added one MCP acknowledgement check and six actual fake-native protocol cases. The exact packet requests 82 cases: 76 current receipt/composer/stop/adoption cases and six native protocol cases. Actor-owned directory-FD spelling for child TMPDIR resolves to the same canonical lease, preserving finite storage accounting while keeping Unix socket paths below their native limit; global test Herder stores are redirected into that lease. These are source changes, not run results.

## Exact current external admission boundary

Final source packet: `.tmp/herder-steer-idle-ack-20261009/combined-case.json`, SHA256796ed7b924b2b547828328d3a8e316107ccdd41b67cc733939f986231289713d,132 source/tool pins; all verified unchanged after preparation. Current HEAD93716395 equals freshly fetched origin/main before task commit. Foreign composer14 hashes and FastAgent11's three agreed inputs are unchanged. Static diff whitespace and actor syntax checks pass; these are not regression/build results. Native direct steer delivered the packet to active Infra01a11b2c turn01a11f2e-6e81-72e3-8ec6-43ccedf86709; receipts remain ignored/private.

The actual current runner CLI/contract registers herder-fastagent100 but no receipt/composer focused or build case. The FastAgent11 grant must not be borrowed. No fresh admission has been received for this132-pin packet, therefore no test/build payload has been released. Smallest next action belongs to Infra01a11b2c: review/register the exact finite cases or state an actual capacity/OFD/book/consumer rejection, then give the supported single-attempt launch/receipt path. Publisher proceeds independently after that result; no additional human permission or language53 release is required.

Separate deployment inspection: agent-herder.service remains active, MainPID763536/start52840375, invocationa4faf853b2334d9aa9b02d5f31c1fdcc, KillMode=control-group. Its direct cgroup contains only that Node process and no child cgroups. Existing API reports no nonterminal jobs and ZCode active/ready. Neither idle jobs nor service cgroup population proves the shared stdio clients are safe to disconnect. No restart/kill/static runtime replacement/native prompt was performed; a supported fresh active-client/handoff proof remains required before deployment.

FastAgent owner subsequently appended its own tracker commit `df6b491e5c89752ddd957f1a74a5a7c91c8266c9` over93716395. Exact Git delta is only `.agents/tasks/work-20261007-fast-agent-cards-continuation.md`; all132 runtime/test/tool pins remain identical and all history is preserved. The actor requires exactHEAD, so packet provenance was refreshed before any admission/payload: SHA256f3cd16a6fae90f4e48babe16f5d6e8c7c264e580e290e3fc3ea0ce3791e98e43. No completed test was repeated.

Execution-first owner update2026-10-09: independent documentation/WIP must not block explicitly pinned inputs; repeated LLM approval is not a workload budget. Owned actor now verifies immutable132 bytes and source ancestry, records actualHEAD, and permits unrelated documentation commits. Updated exact packet SHA2561610ccf4c0e69f2917d267d734bcc9be004950c82601a427ba4f42d3ea44f3c3. Infra owner must automate real reserve/OFD/book checks and register the finite case under existing task authorization; no added human permission is requested. PSI alone is not proof of unsafe capacity. Shared stdio handoff remains the separately explicit deployment condition.

Fresh existing API consumer observation2026-10-09T07:09:23Z: `/api/sessions` reports 6 active ZCode sessions, with recent native activity. The actual adapter starts stdio through independent `agent-herder-zcode-app-server-8740a059.scope`; deployed dispose closes stdin and may terminate that child. Therefore the one-PID Herder service cgroup is NOT evidence of safe disconnection. No restart/stop occurred. Current active-client/handoff evidence is saved at `.tmp/herder-steer-idle-ack-20261009/deployed-zcode-client-observation.json`. This specific deployment condition does not block independent pinned focused checks/build/publication.

Actual85 attempt via canonical authorized-case cbbc044 was interrupted by ENOENT storage-walk race on Vitest atomic cache temporary file. Own run-u12900/inode50420338 cleanup confirmed gone; no full85/peak/build proof. Partial nine-case receipt file reported two failures at228ms/174ms, both using an arbitrary100ms whole-operation race across durable filesystem writes. Replaced that unreliable clock with a fail-fast completion-subscription probe: idle steer/resume must never request task-completion waiting, while real admission metadata and dedup assertions remain. The seven remaining cases and unfinished attempt are evidence only; full85 must run after owned guard repair. This test-only correction does not relax native admission or the300s sync completion semantics.

## Actual native focused result and Unix fixture isolation — 2026-10-09

Canonical storage fix e90d450 allowed a complete diagnostic run: nine files /78PASS in19.10s and the real fake-native subset5PASS/1FAIL. The Unix-control case timed out at the unchanged5000ms deadline. This is83PASS/1FAIL across84selected, not85; the earlier82/85 arithmetic was wrong. Scope run-u13185/inode50471052 is gone, controls scrubbed, capacity book empty; peak257646592B, swap/OOM0. Original logs under .tmp/herder-steer-idle-ack-20261009/run-temp/bounded-fas284uz are preserved. Build has not run.

The fixture invokes raw transcript getSession/listSessions on every native control observation; those enumerate real host Codex PIDs and /proc file descriptors despite the fixture having no native process. Its socket, SQLite and rollout are exclusively test-owned. The narrow candidate stubs only those two process probes on that fixture instance, leaving every real socket RPC, transcript, reconnect, interruption and human-stop assertion intact. The test remains5000ms; each RPC now has1000ms timeout and final cleanup terminates only mock WS clients. This is a proposed fixture repair, not a green claim. Exact tests/codex-app-server.test.ts hash31b7aad44bf9c957328a29971e8de7dcfb545d46c7890f446302b3554de08846 was delivered once to the active sole executor01a11b43, native steer receipt saved.

Executor adds the meaningful intentional-identical-text/distinct-inputId regression to the existing84selection, refreshes all exact inputs and runs one combined85confirmation followed by ONE build. Publisher alone commits/pushes reviewed source and promotes/restarts the authorized Herder service. FastAgent11 already passed independently and will not be repeated; shared UV0.10.42 remains unchanged. MacMini browser watchdog failure belongs to the existing recovery owner and must be resolved before real UI acceptance.

## Verified focused/build delivery checkpoint — 2026-10-09

Actual refreshed matrix is85 ordinary selected PASS (79 across9files plus6 native protocol cases;31 unrelated native cases filtered). Case0f363e6a, receipt attempt2879911fdd382eb4ec47ac908850f8d5, scope run-u13487/inode50530442, peak269647872B, swap/OOM0, same-generation cleanup true. Unix case passed with unchanged5000ms and real socket/SQLite/reconnect/interrupt coverage. Previous83PASS/1FAIL is retained as history. FastAgent11 independent accepted receipt is reused by unchanged source equivalence and was not rerun.

ONE combined tsc/Vite build passed through registered native authorized-case c4b720d3 / attemptdfe90e035ac1ed99eb13579601274aa4; scope run-u13664/inode50545480, peak559095808B, swap/OOM0 and same-generation cleanup true. Build output and exact manifest remain in .tmp/herder-steer-idle-ack-20261009/run-temp/bounded-s1n5f4du. Current133 source/tool pins match the completed focused/build source; all build source files are included. R40 fb9e78e policy/model UI and published FastAgent Continue/031 guards are included. Publisher independently verifies outputs before scoped source commit.

Runtime is still original PID763536 at this checkpoint; publication and deployment are next, not claimed by green tests. User explicitly authorized Herder restart. Existing shared UV FastAgent0.10.42 is retained; no foreign daemon/unit, provider prompt or old accepted input is stopped/replayed. Existing owner1b43 alone executes checks/build and performs post-activation UI/native receipt acceptance; FastAgent same-demo Continue remains exclusively with01a11747, and R40 quiet diagnosis with01a11f86.

## Published source and exact live promotion — 2026-10-09

Scoped23owned paths were committed/pushed as00c7b9a23314b52202870dbc3f6ae4fb337b35ee. HEAD/origin matched and the Herder checkout was clean immediately after publication; AutoFind foreign WIP was never included. Each compiled source/test blob equals the133accepted byte pins. Exact build manifest SHA256e35fd2382859db416b4e1ce2be9066087a81943a07fd75190731d002545dd73a contains212files (208backend/deployed files including web assets plus4web-static originals).

Promotion initially failed because copying the runner-sealed0555artifact preserved a directory mode that prohibits cross-parent rename. Original dist was restored, but the shell continued to restart the old source: PID1106639. This unnecessary restart is recorded, not hidden as ONEsuccessful activation. The corrected mutation chmods only the publisher's staging copy to0755, leaves the accepted immutable artifact untouched, verifies all208hashes, retains originaldist for rollback and renames the exact candidate into dist. The subsequent authorized service restart is live PID1116921 / invocation8add6fd85c044b39b05acccaf525d9a6 / NRestarts0. No foreign unit received an explicit stop/signal and the shared UV FastAgent0.10.42 metadata bytes are unchanged.

Fresh actual HTTP200: /, /api/jobs, /api/adapters, /api/automation/launch-policy and both new assets index-CicdSq3x.js/index-DusS0Th4.css. The saved global policy remained unchanged and did not yet contain incidentExecution; R40 owns the subsequent supported settings write. Complete artifact/runtime hashes and rollback pointer are in .tmp/herder-steer-idle-ack-20261009/promotion-receipt.json.

One meaningful exact-release handoff was delivered to each distinct consumer owner: active composer01a11b43 and FastAgent01a11747 via fresh native steer; idle R40 via stable inputId herder-live-r40-00c7b9a-20261009-v1 through the deployed Herder MCP. This actual live delivery immediately returned admitted:true, turnId01a11fdb-40fe-7491-86ca-c7ac94a1f3e1 and the same inputId. It proves live queue acknowledgement identity, not a substitute for explicit-idle-steer/UI/second-response canaries. Original accepted GPTAdmin input and FastAgent demo were not replayed.

Source/build/runtime delivery is FINISH; final consumer acceptance remains in progress with the established owners. Composer UI/native canary is01a11b43; SAMEFastAgent blankContinue is01a11747 after existing Mini QA recovery1f58; subscription selection/reload plus quiet diagnosis isR40/01a11f86. No tests or build need repetition on these unchanged bytes.
