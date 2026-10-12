# Agent Herder fleet deployment

Status: Linux100/44/88 deployed. One real cabinet-created Codex session on88 has native same-ID readback and headed HTTPS opening proof. Mac launchers are source-verified; their first real startup exposed a Darwin thread-table parser error and remains unaccepted until repaired and rerun. Whole fleet and the parent shared-MCP migration remain open.

The target is a local native Herder on server100, server44, server88, Mac Mini and Mac M1. The cabinet lists and filters sessions by host and creates a session with an explicit host and harness. Preserve native authentication, existing sessions and reverse SSH.

## Shared mesh boundary

Reuse GPTAdmin's authenticated registry and child-MCP relay, which GrepMesh already consumes. Do not route Herder through file-search tools or create a second independent fleet registry. Generic responsibilities are host identity, service capabilities, bounded discovery, direct/relay selection, topology generation and freshness. Search/index/OCR stay in GrepMesh; native session control stays in Herder. Each service retains its own authorization, and mutable session state is scoped to user/profile/host/harness/native ID.

GrepMesh's existing Rust implementation is in src/gptadmin.rs, src/topology.rs and src/topology_cache.rs in its owning checkout. It retains absent peers without extending their freshness and prefers known direct routes with Hub fallback. Its service-specific list_locations probe and grepmesh-fleet credentials are not a generic core. A separate library extraction must have real consumers in both projects and preserve current GrepMesh acceptance; no extra mesh daemon is required for the existing registry contract.

## Verified placement and boundaries

| Node | Verified identity | Current Herder evidence | Public entry |
|---|---|---|---|
| 100 | roomhacker-server-100 | Existing local service, loopback18787 | agent.bezrabotnyi.com |
| 44 | server-44, x86_64 | Own agent-herder-fleet.service, loopback18791, Codex only | agent44.bezrabotnyi.com |
| 88 | roomhacker-server-88, x86_64 | Own agent-herder-fleet.service, loopback18791; actual cabinet create/read/open accepted | agent88.bezrabotnyi.com |
| Mac Mini | mac-mini-2012.lan, Macmini6,2 | Own managed Herder18789 installed ecd603e; shared native Codex preserved; outgoing Mesh authorization repair pending | agent-mac-mini.bezrabotnyi.com |
| Mac M1 | MacBook-Pro-User.local, MacBookPro18,2, arm64 | Earlier local native controller/Herder proofs retained; currently reverse2222 and recovery LAN unavailable, current rollout not accepted | agent-mac-m1.bezrabotnyi.com |

M1 operator access uses its existing reverse SSH2222 first. Mac Mini uses canonical LAN SSH192.168.2.4. Do not label a forwarded100 endpoint as a Mac node. Own Herder18789 is installed on Mini and was previously installed on M1; an offline M1 is explicit, not fresh readiness. Preserve M1's historical18787 forward. Installed44/88 singleton ports are18791 and100 is18787.

## Budgets and admission

Existing Herder100 has CPU4, MemoryHigh1GiB/Max2GiB, swap512MiB, Tasks512 and IOWeight50. Initial observed memory was794693632 bytes/tasks11. Keep its existing bounds during this delivery. These values do not authorize a budget on another host.

The existing source-check profile herder-delivery-focused100 is CPU1, MemoryHigh512MiB/Max1GiB, swap0, Tasks128, wall120s, temp64MiB and IOWeight10. It is run through the canonical bounded-foreground.py authorized-case route, which refreshes reserve, retains the lease/OFD and verifies cleanup. Current OpenCode21-unit check measured157409280 bytes; JSON/outbox28-unit check measured98000896 bytes. These are test peaks, not daemon peaks.

Before any new node starts, record its exact finite RAM/CPU/tasks/swap/temp/disk/I/O candidate and fresh host/UID/co-tenant reserves in the owning task. Measure startup peak and steady state of that same candidate. Mac Mini has8GiB RAM and initially used1906.5MiB swap; retain SSH/browser/native service capacity and check the live trend. No model/browser fan-out, host limit increases or foreign process stops are part of node admission.

## Delivery and acceptance

55 is the sole Herder100 integration/deploy executor. The existing mesh worktree produces new files; preserved UI/OpenCode WIP is integrated and checked before deployment. Publish the reviewed candidate, deploy that exact source/artifact, retain a backup and rollback receipt, and read back actual running identity and bounds.

New ingress ownership is limited to the four new agent44/88/Mac vhosts. Canonical nginx-dev workflow is refresh, enable, check, scoped main push and the existing timer's per-site apply. Preserve the existing agent100 vhost, GPTAdmin cookie authorization, wildcard TLS and separate Airlock route. Publish only after real upstream node identity has been proved.

For each reachable node, use the actual cabinet to list local sessions, select host+harness, create a harmless native session and read back its native host/session/cwd identity. Validate filtering, identical native IDs on different hosts, and explicit offline M1 behavior without losing cached sessions or claiming live readiness. Unsupported harnesses must be explicit. Retain pending/unknown admission receipts; never automatically resend accepted or unknown inputs when changing hosts.

Whole fleet delivery remains open until those consumer receipts exist. Source units, discovery online, HTTP200 or one88→100 delivery do not close it.

The four remote public routes now use their native Herder for both UI and Fleet access, with an independent HAOS owner-cookie verifier. Maintained HAOS8443 recovery also routes those aliases directly to the same peer, without rebuilding its app or changing global roles/auth. Real88→SAME44 session metadata and owner-cookie HAOS reads are accepted; missing native history is shown as unavailable. The screenshot crop was uniformly blank, so that artifact is not pixel acceptance. M1's current release and the complete five-node/harness matrix remain open.

Public Mini cannot assume outgoing SSH keys exist. Its approved owner credential must stay inside one immutable HTTP request context, with generation+host-specific MCP state; cookie rotation retains the existing profile journal and UNKNOWN intent identity. Source-only HTTPS transport/wiring work does not itself prove a working Mini consumer. Local SSH-native and public owner-cookie realms remain separate.

Mini ecd603e stopped after an artifact census deadline at5.012s/count14341, not RAM/CPU exhaustion. Recovery retains one active release plus the exact inactive f9b95ea rollback directory under promotion-backups/retained-inactive-<SHA>; moving it back to releases/<SHA> precedes selecting the saved prior config on rollback. No artifact bytes were deleted, limits raised, or shared native/browser restarted. Measured active71682153 plus rollback71682022 bytes remain below the original combined512MiB envelope; active census0.322s and both measurements0.514s. Keep cold rollback storage finite and immutable; do not treat moving arbitrary data outside the observed tree as a resource exemption. See .tmp/herder-fleet-20261010/mini-single-release-census-recovery.json for the exact restoration pointer.

## Current finite node candidates and rollback

Linux44/88: RAM384MiB soft/768MiB hard, CPU1, swap0, Tasks128, NOFILE4096, IOWeight10; own temp128MiB/state64MiB/log16MiB, two immutable releases at most512MiB, host reserve4GiB and disk reserve2GiB. Actual post-upgrade44 memory72884224bytes/tasks9;88 memory106618880bytes/tasks10. SSH ingress tunnel has separate16/64MiB RAM, CPU5%, swap0, Tasks16, IOWeight10 and NOFILE128. Only verified local harnesses are advertised;44 OpenCode service and ZCode server payload were absent. The daemon joins the existing shared Codex socket and88's existing authenticated OpenCode4097; no private Codex writer or copied token.

Darwin Herder candidate: RSS256MiB soft30s/512MiB hard, sustained CPU100%/20s and150% instantaneous after10s grace,128 threads/16processes, own temp128MiB/state64MiB, up to two releases/512MiB, low-priority IO; host reserve Mini2GiB/M1 4GiB, disk2GiB. Darwin watchdog bounds are observations and owned-process cleanup, not kernel reservations or swap0 guarantees. Python wrapper and shared native controllers require separate measurement. KeepAlive=false; do not restart-loop a failed candidate.

M1 explicit common native controller candidate: foreground installed Codex app-server Unix listener; separate320MiB soft/30s and512MiB hard RSS, CPU100% sustained/200% peak,64threads/16processes,temp/state16MiB, host reserve4GiB/disk2GiB, startup30s/cleanup10s and KeepAlive=false. Canonical socket must initially be absent; any preexisting or unknown owner refuses startup. Preserve ChatGPT's existing EXEC-SERVER/helper34393 and account/config/history. Mini already has its managed controller and must not start another. A listener proof alone is not a native request or fleet acceptance.

Native budget adjustment (2026-10-10, runtime owner55): initial soft256MiB/30s stopped owned common Codex60791 after525.94s at286736KiB RSS (about280MiB),33threads/CPU51%, host available19461570KiB. The initial256 threshold is retained as a RED regression; candidate native-only soft320MiB/30s keeps HARD512MiB, CPU/threads/process/temp/state/host4GiB/disk/cleanup unchanged. HerderNode stays soft256MiB/30s. Mac node bootstrap sets AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS=30000 instead of5000 to reduce background observation fan-out; full native session listing is preserved. This is a source-verified candidate within the existing hard reserve; owner55 must prove warm runtime and the real cabinet consumer before acceptance.

Native parallelism candidate (2026-10-10): preserve common79404 failure after2188s at109threads/RSS160416KiB, CPU50.8%/sustained15.65%, one process and host available19GiB. Its empty-create UNKNOWN receipt remains owned by55; never recreate that session. The installed M1 receipt resolves Codex0.160.0; that tag's [CLI dispatcher](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cli/src/main.rs#L940) uses the [arg0 runtime builder](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/arg0/src/lib.rs#L275). Its [lockfile](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/Cargo.lock) pins Tokio1.52.3/Rayon-core1.13.0. Only the new owned child's env now sets TOKIO_WORKER_THREADS=1 and RAYON_NUM_THREADS=1; parent env/global config/credentials/CLI are preserved. [Tokio worker env](https://github.com/tokio-rs/tokio/blob/tokio-1.52.3/tokio/src/loom/std/mod.rs#L77) is used by that runtime; [Rayon default-pool env](https://docs.rs/rayon-core/1.13.0/src/rayon_core/lib.rs.html) applies if a default Rayon pool is used. This does not prove those pools caused the109threads. [Tokio's separate blocking pool](https://github.com/tokio-rs/tokio/blob/tokio-1.52.3/tokio/src/runtime/builder.rs#L282) defaults to512; the Codex builder does not set its limit and these worker env knobs cannot cap it. No unsupported blocking-pool env is invented. Also arg0 loads ~/.codex/.env before constructing the runtime and may overwrite these non-CODEX-prefixed keys: owner55 must read-only verify no conflicting entries and effective startup behavior, without printing or changing secrets. Thread64/HARD512/CPU1 and all other admission/cleanup limits remain; source tests are not proof that a warmed native workload fits64. If still over budget, preserve the exact failure and request a supported native blocking-pool/control seam rather than raise caps or replay UNKNOWN creation.

Artifact accounting adjustment (2026-10-10, runtime owner55): retain failed M1Node81690 receipt at186.06s/RSS152896KiB, artifact deadline attempt2/count14480/elapsed2.0s for roughly17000 entries in two immutable releases. Only artifact full census has a5s total window (a full first traversal may use all5s; only remaining time can admit a fresh deadline-only retry) and30s cadence; temp/state/default storage keeps the1s-per-attempt/2s-total window. Every tick verifies known root/release UID/device/inode/mtime/ctime closure without following symlinks; changed closure or expired measurement requires fresh complete accounting. Unknown/failed census never substitutes zero or prior usage. Samples report artifactCensusAgeSeconds, so reused usage is explicitly dated. This cadence deliberately permits payload accounting lag within an existing release: shallow closure checks do not detect in-place nested-file growth; bytes/file caps are re-enforced by the next full census after30s (up to5s to complete, plus existing observer scheduling). Cached bytes are a prior verified measurement, never a claim of instantaneous payload size. The hard30000-entry/512MiB/two-release limits, process/CPU/RAM/reserves and cleanup remain unchanged. This is source candidate evidence; sole runtime owner55 must prove warm operation and the real cabinet consumer.

Install packets contain exact source/artifact/payload and launcher hashes. Native plutil lint precedes launchctl. A malformed legacy plist is retained with its SHA/provenance; it is not copied into the new valid label. Before activation refresh host/shared reserves and preserve the existing service/release/config. Roll back only the newly owned labels or current symlink/config to the recorded previous release; never stop a shared/foreign native controller, delete an unknown socket, change global auth or replay an accepted input.

Linux source576bfcd cabinet88 proof: `.tmp/herder-fleet-20261010/ui/accepted88-ui-receipt.json`, same native session01a1234e-69c0-7532-86b9-477c1e209a4f, model-free/messages0; screenshot `ui/fleet88-same-opened.png`. Backup100 `runtime-100/dist-before-empty`;44/88 retain `node-config-before-empty.json` and previous immutable release. This is one verified vertical; further host/harness UI proofs and real Mac readiness are required.

### Transient Darwin metadata timeout recovery

The M1 native manager22298 and Node54788 stopped with `TimeoutExpired` while their last verified working sets remained142656/129232KiB and native11threads. The failed receipts are retained. Known read-only probes (`ps`, `lsof`, `sysctl`, `memory_pressure`) now get at most one fresh timeout-only retry: each attempt≤2s, common window≤4s, never beyond the existing cleanup deadline. Other commands never retry; repeated failure refuses with safe stage/attempt metadata and no raw argv. RAM/CPU/thread/process/storage/host reserve limits, cleanup10s and KeepAlive=false are unchanged. This does not permit stale samples or report an unobserved host as healthy. Real startup/warm/consumer evidence remains required.

Mini90850 later failed with a5.006s combined timeout after discarding two partial2.5s artifact passes (second count5540). The first complete artifact traversal now may use the existing full5s window. A healthy3–5s tree no longer fails solely because both shorter passes were discarded. The total5s/30000files/512MiB/two-release bounds, dated30s accounting and temp/state1s/2s bounds remain unchanged. The previous failure is retained; this is not a higher IO/time/memory allowance.

### Mini runtime identity (10.10.2026)

The existing Apple `/usr/bin/python3` LaunchAgent context failed HAOS LAN
connections with EHOSTUNREACH, while the same Node/cookie worked from SSH.
Mini already had user-approved `org.python.python` local-network permission.
Use the installed Python.app interpreter resolved from
`/usr/local/opt/python3/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python`
for this node's rendered `__PYTHON_BIN__`; preserve the prior plist as rollback,
run native plutil and helper --check, and await both owned listener and manager
exit before bootstrap. No privacy database/settings changes are required.
The actual controlled Mini cookie consumer then returned four ready hosts and
the same accepted44 metadata through HAOS TLS. This is Mini-specific installed
runtime evidence, not a default path or permission grant for M1. Process/storage
bounds and shared native controls remain unchanged.

### Узел вне домашней сети

Идентичность `hostId + harness + nativeSessionId` не меняется при переезде;
маршрут и наблюдаемый проект не заменяют её. Подтверждённый мобильный M1
использует существующие publicTLS aliases: M1 actor/peer через443, обычнаяCA
и прежний owner-cookie verifier. Другие approvedLAN пути сохраняют
HAOS192.168.2.101:8443. M1 public ingress требует reverse tunnel100;
доступность при loss100 для него не заявляется. Недоступный маршрут остаётся
explicit stale, наличие config/DNS не обновляет freshness. Registry/relay
GPTAdmin общий, без отдельного полногоHub или копирования credentials.

Compact mesh snapshot использует Codex metadata page≤3 в прежнем2s budget:
actual M1 thread/list12 пропускал deadline, page3 читалась. Native cursor,
adapter overflow и меньший bounded window explicit limited/completefalse.
Global output≤12, exact-ID/full native list/history и STOP/admission guards
сохранены. Страница не является полным inventory; currentCwd не подменяется
каталогом запуска. Нестабильный target transport/history сохраняет отдельный
отказ, успешная страница не доказывает доступность всей истории.

### M1 periodic socket verification (12 October 2026)

The Node watchdog retains the global sole-FD-owner census during Codex
admission/JOIN. Each periodic poll instead scopes `lsof -t -nP -a -p PID -U
PHYSICAL_SOCKET` to the already-approved native PID. UID, lstart generation,
Codex app-server argv, exact kernel text mapping, socket UID/type and inode
before/after remain fresh; empty, foreign, failed and timed-out observations
refuse. A periodic result does not claim a fresh global sole-owner census.
The existing two attempts / four-second window and all workload/reserve/cleanup
bounds remain unchanged. No controller or socket is created or adopted.

Deliver the published helper through an exact config/helper/Node-manifest CAS:
retain the old files and receipt, update only the helper and its `launcherHashes`
pin, record its source commit/hash separately, keep the installed Node source
and payload manifest unchanged, run native admission, then start the previously
stopped owned node once. Acceptance requires native `fleet_node_info`, fresh
cabinet host readiness and multiple steady watchdog samples, with native Codex
identity unchanged; `--check` alone is insufficient.


### M1 artifact census after the native-PID fix (2026-10-12)

The first targeted-owner runtime remained alive for 763.97 seconds, then its
protected `last-run.json` recorded `observation_failed` in the artifact census:
4.257 seconds, RSS196320KiB, one process. The native PID/generation/socket proof
continued to pass. This is a separate observer failure; the old stderr log is
not a receipt for the latest run.

The initial replacement used one `/usr/bin/du -A -l -a -k -P .` physical FTS traversal for both entry
count and the final root byte total, instead of sequential find and du walks.
[Apple's source](https://github.com/apple-oss-distributions/file_cmds/blob/main/du/du.c)
emits all files with `-a`, counts file hard-link entries with `-l`, and reports
traversal/output errors by nonzero exit. Newlines in names conservatively
increase the entry count; only the complete final root summary selects bytes.
Stream output in32KiB chunks retaining64bytes; never log paths. Keep the original
five-second window, cleanup reserve, 30000 entries plus root,512MiB/two releases,
root UID/device/inode proof,30-second census cadence and fail-closed errors.
Native candidate measured two releases149498880bytes in0.101 seconds; this is
read-only candidate evidence, not steady/public-owner acceptance.

The du approach later failed again at35.46s/RSS149360KiB with a4.311s
artifact deadline. `mac-artifact-probe.c` replaces per-file formatted output
with one bounded numeric summary from a physical FTS walk. Parent pins cwd
to the verified root FD and checks root/release generation before/after;
symlinks are counted without following, hard links count per entry, dirs and
files round upward independently. This is conservative apparent accounting:
native17811 entries total155599872bytes versus the prior du149498880bytes.
No paths enter stdout/stderr. File/byte overflow or incomplete traversal returns
nonzero without a partial summary; parent also checks the complete128-byte-max
frame. Same5s/.75s cleanup reserve,30000 descendants plus root,512MiB/two
releases,30s dated cadence and all other resource/native fences remain.
Seal `mac-artifact-probe` together with Python launcherHashes in one CAS; keep
the kernel owner helper and Node payload unchanged. Native SDK compile+three
candidate scans took1.915s/42432KiB peak; cold803ms, warm68ms. This candidate
does not prove steady LaunchAgent/public consumer acceptance. Do not claim
`taskpolicy -d utility` fixes background I/O: XNU may already use utility tier.


### M1 periodic kernel observer (2026-10-12)

The single-traversal helper passed artifact accounting, but the next owned
Node stopped at46.10s: targeted lsof UNIX-owner timeout, RSS148192KiB,
CPU0.46%, artifact age2.775s and host free22817013KiB. Preserve both failures;
there is no evidence of RAM/CPU shortage or an owner-cookie policy failure.

`mac-codex-owner-probe.c` is a read-only SDK-built helper sealed alongside the
Python launcher in `node-config.json.launcherHashes`. Periodic text identity
uses libproc `proc_pidpath` (kernel executable vnode path, independent of argv).
Admission obtains the native listener FD via a bounded4096-entry LISTFDS;
subsequent checks reread that known FD using FDSOCKETINFO, checking AF_UNIX,
SOCK_STREAM, SO_ACCEPTCONN and exact local bound physical path. A duplicated
FD of the same kernel socket is accepted at admission; distinct sockets refuse.
The FD is an in-process hint, never a cached successful observation.

Keep fresh UID/start/argv and pathname UID/type/device/inode fences before/after,
and preserve global lsof sole-owner proof at JOIN. SOCKETINFO does not populate
vnode `soi_stat`; do not claim an atomic FD-to-current-pathname-inode guarantee.
This matches lsof's UNIX path selection and additionally requires listen state.
[Apple libproc/XNU](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c),
[Apple lsof path selection](https://github.com/apple-oss-distributions/lsof/blob/main/lsof/dialects/darwin/libproc/dsock.c).

Each helper call retains the existing2s/two-attempt/common4s deadline and
fail-closed incomplete/error/empty behavior. Deliver source+SDK build receipt,
binary SHA, launcher SHA and both sealed config entries in one guarded CAS;
no Node payload or native controller replacement is required. Initial native
SDK compile took1.078s, observed55MiB peak; socket probe8.8ms and text636.8ms
(first read). Require steady/native/public-owner acceptance after installation.

Periodic UID/start/argv identity now uses the same sealed helper: full BSD
records before/after preserve UID and microsecond start generation; PROCARGS2
parses only its bounded argument count, never exposes environment values.
The existing admission still verifies ps, executable mappings and global socket
exclusivity. Unknown, truncated or changed kernel records refuse without input
replay. This removes periodic ps identity latency without raising the existing
two-attempt/four-second observation budget. A separate native-manager census
deadline was recorded for PID29017; do not describe this identity change as
proof that all process-census deadlines are resolved.


### Shared native and Node kernel group census

The native29017 manager recorded a real `ps -g` deadline after19205.7s while
inside its resource budget. The sealed owner helper now provides `--group`
using PROC_PGRP_ONLY and full BSD/TASKINFO records only for that group. At most
16 members are admitted; full/partial PID buffers, foreign UID/group, missing
live task data and PID microsecond-generation changes refuse. Group membership
and every generation are refreshed before a complete numeric frame is emitted.
Zombie zero-resource rows require fresh BSD zombie proof; empty groups additionally
require the caller's kernel absence check. No environment, argv or foreign task
metrics are emitted. RSS rounds up to KiB; CPU Mach ticks use the reported timebase;
thread counts retain Node128/native64 guards and all previous workload budgets.
Both supervisors import the shared path; the native pre-import and preparation
checks now require its sealed helper. Cleanup compares full generation tokens.

Focused checks:68 supervisor+6 C observer+13 native+3 artifact scenarios, fast
unit category, expected3s/max20s combined. The real SDK group probe on the approved
87650 controller took7.5ms; compilation/probes772ms,56688KiB peak. Native reload
requires fresh direct read-only loaded-thread/receipt proof of no active or unknown
admitted work. Preserve SID/history/profile/auth and managed labels, and never
repeat a start after an unknown ACK before reconciling actual state.


### Artifact probe policy: retained327s failure and paired actor proof

After the shared native census installation, nine snapshots over80.8s passed,
but Node5936 stopped at327.46s with artifact deadline4.365s/RSS190592KiB.
Native5771 remained alive. Retain this failure; prior READY was not final stability.

A finite owned read-only LaunchAgent copied Background/Nice10/LowPriorityIO,
then ran six paired A/B and B/A artifact probes (focused integration,
expected25s/max60s; actual16.896s including12 one-second gaps). All measured
155599872bytes. Baseline wall364/310/461/654/382/606ms versus candidate
142/139/193/146/125/149ms; candidate CPU104..128ms, child peak below1.6MiB.
The candidate uses `/usr/sbin/taskpolicy -a -c utility -d standard -g utility`
only for the sealed artifact helper. SETEXEC preserves owned-child cleanup;
utility QoS is capped and Nice10 retained. Parent/native/Node policy is unchanged.
Five-second gate,750ms cleanup reserve, byte/entry/root-generation checks and
30-second census cadence stay unchanged. The policy is OS-supported, not a
claim of an effective kernel tier on every system; external suppression may
still apply. Require actual steady/public evidence beyond the prior327s failure.
[Apple taskpolicy](https://github.com/apple-oss-distributions/system_cmds/blob/main/taskpolicy/taskpolicy.c),
[Apple launchd I/O policy](https://github.com/apple-oss-distributions/launchd/blob/main/src/core.c).
