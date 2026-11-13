# Herder process leases implementation

Status: implementation in isolated worktree. User authorised the full plan on 2026-11-13.
Plan: https://chatgpt.com/space/page_835ee164266081918e5e4297ac92a2a3

## Source and ownership

Base: origin/main b371e9a0e57f12f44bf069ef5277e71afb81991f.
Worktree: /home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113.
Branch: feat/herder-process-leases-20261113.
Coordinator: ChatGPT session 6af76992-9198-8191-b01c-aaa6f7c6a044.
Shared main contains unrelated WIP and remains unchanged.

## Decisions

Keep fourteen v1 public tool names. Extend resource and automation with process completion and bindings.
Resource owner.json remains the canonical claim. A durable binding records occupancy, not another owner.
ExecutionStore is an internal Herder process supervisor. The worker binary is part of the same immutable release.
Trusted install configuration grants process and resource administration to explicit principals. MCP arguments never grant access.
Persist immutable request intent, execution identity, absolute deadline and completion receipt.
Wait registration returns without waiting for completion. A background dispatcher uses the existing scoped delivery intents and Human Stop authority.
One stable wake ID identifies a continuation. Unknown delivery is reconciled with the native receipt and never blindly replayed.
The source session remains the owner. Terminal work releases its build slot or hands a claim back for a bounded period.
Keep old state and receipts during migration. The 47 stale legacy running records require reconciliation and are not success.
New code must preserve the installed AHAP and UserIO browser changes already in origin/main.

## Work packages

- process_supervisor: process engine, worker, engine tests.
- resource_leases: ownership TTL, fencing, occupancy, resource application, ownership tests.
- root: public schemas, process automation, delegated lease controller, native runtime wiring, end-to-end tests and integration.
- runtime_inventory: candidate install/check/rollback helper and compatibility inventory.

## Acceptance

A real process survives two test TTLs and a control-plane restart, while no LLM polling occurs.
The same session receives one verified receipt. Exit-before-wait, worker death, PID reuse, lease loss, Human Stop and lost native ACK are tested.
Run actual native acceptance for every enabled installed adapter and preserve remote execution identity.
Install/check both the public Rust MCP and affected TypeScript compatibility paths. Report exact remaining blockers.
No test calls or notifications to people. Airlock VPS excluded. Claude remains disabled.
