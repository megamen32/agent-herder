# Agent Herder fleet deployment

Status: Linux100/44/88 deployed. One real cabinet-created Codex session on88 has native same-ID readback and headed HTTPS opening proof. Mac launchers are source-verified; their first real startup exposed a Darwin thread-table parser error and remains unaccepted until repaired and rerun. Whole fleet and the parent shared-MCP migration remain open.

The target is a local native Herder on server100, server44, server88, Mac Mini and Mac M1. The cabinet lists and filters sessions by host and creates a session with an explicit host and harness. Preserve native authentication, existing sessions and reverse SSH.

## Shared mesh boundary

Reuse GPTAdmin's authenticated registry and child-MCP relay, which GrepMesh already consumes. Do not route Herder through file-search tools or create a second independent fleet registry. Generic responsibilities are host identity, service capabilities, bounded discovery, direct/relay selection, topology generation and freshness. Search/index/OCR stay in GrepMesh; native session control stays in Herder. Each service retains its own authorization, and mutable session state is scoped to user/profile/host/harness/native ID.

GrepMesh's existing Rust implementation is in src/gptadmin.rs, src/topology.rs and src/topology_cache.rs in its owning checkout. It retains absent peers without extending their freshness and prefers known direct routes with Hub fallback. Its service-specific list_locations probe and grepmesh-fleet credentials are not a generic core. A separate library extraction must have real consumers in both projects and preserve current GrepMesh acceptance; no extra mesh daemon is required for the existing registry contract.

## Verified placement and boundaries

| Node | Verified identity | Current Herder evidence | Proposed public entry |
|---|---|---|---|
| 100 | roomhacker-server-100 | Existing local service, loopback18787 | agent.bezrabotnyi.com |
| 44 | server-44, x86_64 | Own agent-herder-fleet.service, loopback18791, Codex only | agent44.bezrabotnyi.com |
| 88 | roomhacker-server-88, x86_64 | Own agent-herder-fleet.service, loopback18791; actual cabinet create/read/open accepted | agent88.bezrabotnyi.com |
| Mac Mini | mac-mini-2012.lan, Macmini6,2 | Existing managed Codex36862 reused; own Herder candidate not runtime-accepted | agent-mac-mini.bezrabotnyi.com |
| Mac M1 | MacBook-Pro-User.local, MacBookPro18,2, arm64 | 18787 is an SSH forward to100; own bounded native Codex controller and Herder not yet accepted | agent-mac-m1.bezrabotnyi.com |

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

## Current finite node candidates and rollback

Linux44/88: RAM384MiB soft/768MiB hard, CPU1, swap0, Tasks128, NOFILE4096, IOWeight10; own temp128MiB/state64MiB/log16MiB, two immutable releases at most512MiB, host reserve4GiB and disk reserve2GiB. Actual post-upgrade44 memory72884224bytes/tasks9;88 memory106618880bytes/tasks10. SSH ingress tunnel has separate16/64MiB RAM, CPU5%, swap0, Tasks16, IOWeight10 and NOFILE128. Only verified local harnesses are advertised;44 OpenCode service and ZCode server payload were absent. The daemon joins the existing shared Codex socket and88's existing authenticated OpenCode4097; no private Codex writer or copied token.

Darwin Herder candidate: RSS256MiB soft30s/512MiB hard, sustained CPU100%/20s and150% instantaneous after10s grace,128 threads/16processes, own temp128MiB/state64MiB, up to two releases/512MiB, low-priority IO; host reserve Mini2GiB/M1 4GiB, disk2GiB. Darwin watchdog bounds are observations and owned-process cleanup, not kernel reservations or swap0 guarantees. Python wrapper and shared native controllers require separate measurement. KeepAlive=false; do not restart-loop a failed candidate.

M1 explicit common native controller candidate: foreground installed Codex app-server Unix listener; separate320MiB soft/30s and512MiB hard RSS, CPU100% sustained/200% peak,64threads/16processes,temp/state16MiB, host reserve4GiB/disk2GiB, startup30s/cleanup10s and KeepAlive=false. Canonical socket must initially be absent; any preexisting or unknown owner refuses startup. Preserve ChatGPT's existing EXEC-SERVER/helper34393 and account/config/history. Mini already has its managed controller and must not start another. A listener proof alone is not a native request or fleet acceptance.

Native budget adjustment (2026-10-10, runtime owner55): initial soft256MiB/30s stopped owned common Codex60791 after525.94s at286736KiB RSS (about280MiB),33threads/CPU51%, host available19461570KiB. The initial256 threshold is retained as a RED regression; candidate native-only soft320MiB/30s keeps HARD512MiB, CPU/threads/process/temp/state/host4GiB/disk/cleanup unchanged. HerderNode stays soft256MiB/30s. Mac node bootstrap sets AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS=30000 instead of5000 to reduce background observation fan-out; full native session listing is preserved. This is a source-verified candidate within the existing hard reserve; owner55 must prove warm runtime and the real cabinet consumer before acceptance.

Artifact accounting adjustment (2026-10-10, runtime owner55): retain failed M1Node81690 receipt at186.06s/RSS152896KiB, artifact deadline attempt2/count14480/elapsed2.0s for roughly17000 entries in two immutable releases. Only artifact full census now has a5s total window (2.5s per attempt, one fresh deadline-only retry) and30s cadence; temp/state/default storage keeps the1s-per-attempt/2s-total window. Every tick verifies known root/release UID/device/inode/mtime/ctime closure without following symlinks; changed closure or expired measurement requires fresh complete accounting. Unknown/failed census never substitutes zero or prior usage. Samples report artifactCensusAgeSeconds, so reused usage is explicitly dated. This cadence deliberately permits payload accounting lag within an existing release: shallow closure checks do not detect in-place nested-file growth; bytes/file caps are re-enforced by the next full census after30s (up to5s to complete, plus existing observer scheduling). Cached bytes are a prior verified measurement, never a claim of instantaneous payload size. The hard30000-entry/512MiB/two-release limits, process/CPU/RAM/reserves and cleanup remain unchanged. This is source candidate evidence; sole runtime owner55 must prove warm operation and the real cabinet consumer.

Install packets contain exact source/artifact/payload and launcher hashes. Native plutil lint precedes launchctl. A malformed legacy plist is retained with its SHA/provenance; it is not copied into the new valid label. Before activation refresh host/shared reserves and preserve the existing service/release/config. Roll back only the newly owned labels or current symlink/config to the recorded previous release; never stop a shared/foreign native controller, delete an unknown socket, change global auth or replay an accepted input.

Linux source576bfcd cabinet88 proof: `.tmp/herder-fleet-20261010/ui/accepted88-ui-receipt.json`, same native session01a1234e-69c0-7532-86b9-477c1e209a4f, model-free/messages0; screenshot `ui/fleet88-same-opened.png`. Backup100 `runtime-100/dist-before-empty`;44/88 retain `node-config-before-empty.json` and previous immutable release. This is one verified vertical; further host/harness UI proofs and real Mac readiness are required.
