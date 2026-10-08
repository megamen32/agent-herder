# Herder idle-steer acknowledgement

Status: confirmed acknowledgement defect; repair awaits the existing Herder integration owner and a measured test/deployment slot. GPTAdmin routing is deployed and passes the real native exact-owner canary. No accepted message is replayed. This ledger records admission separately from task completion.

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
