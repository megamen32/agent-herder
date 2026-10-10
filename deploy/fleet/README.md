# Agent Herder fleet deployment

Status: deployment preparation. A published source or metadata-only mesh leaf is not acceptance of a local Herder node or the fleet cabinet.

The target is a local native Herder on server100, server44, server88, Mac Mini and Mac M1. The cabinet lists and filters sessions by host and creates a session with an explicit host and harness. Preserve native authentication, existing sessions and reverse SSH.

## Shared mesh boundary

Reuse GPTAdmin's authenticated registry and child-MCP relay, which GrepMesh already consumes. Do not route Herder through file-search tools or create a second independent fleet registry. Generic responsibilities are host identity, service capabilities, bounded discovery, direct/relay selection, topology generation and freshness. Search/index/OCR stay in GrepMesh; native session control stays in Herder. Each service retains its own authorization, and mutable session state is scoped to user/profile/host/harness/native ID.

GrepMesh's existing Rust implementation is in src/gptadmin.rs, src/topology.rs and src/topology_cache.rs in its owning checkout. It retains absent peers without extending their freshness and prefers known direct routes with Hub fallback. Its service-specific list_locations probe and grepmesh-fleet credentials are not a generic core. A separate library extraction must have real consumers in both projects and preserve current GrepMesh acceptance; no extra mesh daemon is required for the existing registry contract.

## Verified placement and boundaries

| Node | Verified identity | Current Herder evidence | Proposed public entry |
|---|---|---|---|
| 100 | roomhacker-server-100 | Existing local service, loopback18787 | agent.bezrabotnyi.com |
| 44 | server-44, x86_64 | Full agent-herder.service absent | agent44.bezrabotnyi.com |
| 88 | roomhacker-server-88, x86_64 | Full service absent; thin mesh/native88 canary separately accepted | agent88.bezrabotnyi.com |
| Mac Mini | Mac-mini-roomhacker, Macmini6,2 | Local Node/Codex available; full node not deployed | agent-mac-mini.bezrabotnyi.com |
| Mac M1 | MacBook-Pro-User.local, MacBookPro18,2, arm64 | Local Node/Codex/OpenCode/ZCode available;18787 is an SSH forward to100 | agent-mac-m1.bezrabotnyi.com |

M1 is reached through its existing reverse SSH2222. Mac Mini is reached through canonical LAN SSH192.168.2.4. Do not label a forwarded100 endpoint as a Mac node.18789 was free on both Macs at the initial probe and is a proposed local-node port, subject to the actual executor's contract and a fresh bind check. Do not replace M1's existing18787 forward.

## Budgets and admission

Existing Herder100 has CPU4, MemoryHigh1GiB/Max2GiB, swap512MiB, Tasks512 and IOWeight50. Initial observed memory was794693632 bytes/tasks11. Keep its existing bounds during this delivery. These values do not authorize a budget on another host.

The existing source-check profile herder-delivery-focused100 is CPU1, MemoryHigh512MiB/Max1GiB, swap0, Tasks128, wall120s, temp64MiB and IOWeight10. It is run through the canonical bounded-foreground.py authorized-case route, which refreshes reserve, retains the lease/OFD and verifies cleanup. Current OpenCode21-unit check measured157409280 bytes; JSON/outbox28-unit check measured98000896 bytes. These are test peaks, not daemon peaks.

Before any new node starts, record its exact finite RAM/CPU/tasks/swap/temp/disk/I/O candidate and fresh host/UID/co-tenant reserves in the owning task. Measure startup peak and steady state of that same candidate. Mac Mini has8GiB RAM and initially used1906.5MiB swap; retain SSH/browser/native service capacity and check the live trend. No model/browser fan-out, host limit increases or foreign process stops are part of node admission.

## Delivery and acceptance

55 is the sole Herder100 integration/deploy executor. The existing mesh worktree produces new files; preserved UI/OpenCode WIP is integrated and checked before deployment. Publish the reviewed candidate, deploy that exact source/artifact, retain a backup and rollback receipt, and read back actual running identity and bounds.

New ingress ownership is limited to the four new agent44/88/Mac vhosts. Canonical nginx-dev workflow is refresh, enable, check, scoped main push and the existing timer's per-site apply. Preserve the existing agent100 vhost, GPTAdmin cookie authorization, wildcard TLS and separate Airlock route. Publish only after real upstream node identity has been proved.

For each reachable node, use the actual cabinet to list local sessions, select host+harness, create a harmless native session and read back its native host/session/cwd identity. Validate filtering, identical native IDs on different hosts, and explicit offline M1 behavior without losing cached sessions or claiming live readiness. Unsupported harnesses must be explicit. Retain pending/unknown admission receipts; never automatically resend accepted or unknown inputs when changing hosts.

Whole fleet delivery remains open until those consumer receipts exist. Source units, discovery online, HTTP200 or one88→100 delivery do not close it.
