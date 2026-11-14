# Herder process leases implementation

Status: local and remote source integration is implemented in an isolated worktree. Coherent verification and immutable candidate preparation are in progress. Full native acceptance is incomplete. Shared runtime has not been switched.
The user authorised the full plan on 2026-11-13.
Plan: https://chatgpt.com/space/page_835ee164266081918e5e4297ac92a2a3

## Source and ownership

Base: origin/main b371e9a0e57f12f44bf069ef5277e71afb81991f.
Latest fetched origin/main: a1c17a48ef05ff132af53f5018053e365cbece61, observed 2026-11-14.
The source checkpoint will retain the new shared-core packaging work when merged.
Worktree: /home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113.
Branch: feat/herder-process-leases-20261113.
Coordinator: ChatGPT session 6af76992-9198-8191-b01c-aaa6f7c6a044.
Shared main contains unrelated WIP and remains unchanged.

The first coherent implementation is committed and pushed:
0d398e197bac384fb916aad03289210fbb37988a.
Its immutable build worktree is
/home/roomhacker/agents-projects/.worktrees/herder-process-leases-build-0d398e19.

Later hardening, platform support and migration work described below must be
associated with its own committed SHA and rebuilt before installation. A green
source test does not prove that the shared installed runtime contains that fix.

## Architecture

Keep fourteen v1 public tool names. Extend resource and automation with process
completion, exact claim bindings and a read-only wait_status operation.

The registered resource descriptor and owner.json remain the canonical claim
authority. A durable execution binding records occupancy, not another owner.
Expiry, revision, nonce and fencing checks apply to acquisition, renewal,
release, binding and every protected effect.

ExecutionStore and herder_process_worker are internal Herder components. A
worker can outlive the control plane and renew claims without model calls.
The resource bridge belongs to the same release and has no independent
scheduler.

Trusted install configuration grants process and resource administration to
explicit principals. MCP arguments never grant access. Existing session ACLs,
native address bindings and scope generations remain mandatory.

A process has a stable execution reference, immutable request digest, real
executor identity, absolute deadline and durable completion receipt. Source
metadata is captured explicitly as Git status evidence, not a content snapshot.
Artifacts require separate verification.

The source session remains the owner. A completed execution releases its build
slot or returns a claim to that session for a bounded handback interval anchored
to the original completion time.

## Implemented work

| Area | Implementation |
| --- | --- |
| Universal ownership | Resource registration, revision CAS, aliases, claims, expiry, retired nonces and durable execution occupancy. |
| Linux supervision | PID birth and boot identity, pidfd signalling, systemd user scope or direct subreaper, whole-tree evidence, crash recovery and no command replay. |
| macOS supervision | launchd job, boot and PID generation identity, private coalition task counts and kernel-checked signalling. No generic PID kill fallback. |
| Lease lifecycle | Bind before command, renew while owned work is live, stop owned work on lease loss, receipt before finalization, bounded handback. |
| Wait lifecycle | ProcessCompletion, Timer and SessionCompletion use durable registration, fast return, one background driver, busy-parent deferral, pause/CAS cancellation and exact session continuation. |
| HumanStop | Cancellation generation persists through restart. Process launch admission and HumanStop use the same canonical gate. A stopped registration cannot start a later build. |
| Lost ACK | Bounded native admission recovery using original request key, exact session and real native message ID. Full before/after CAS, atomic dispatch finalization, no resend, original UNKNOWN evidence retained. |
| Aggregate create tasks | A confirmed child admission can refresh an old aggregate projection using one exact native create receipt. Original parent bytes remain evidence. |
| Automatic work gates | Stop judge, unfinished-session paths, cadence and final automatic native admission inspect canonical waits. Human messages remain independent. |
| Remote scheduler reads | Existing pinned GPTAdmin transport reaches exact central AgentHerder authority. Missing, stale or ambiguous evidence blocks automatic work. |
| Canonical compatibility | resume_after and scheduled delivery use the same native automation authority; direct resume uses scoped native receipts and a principal-wide key reservation. No legacy clock or writable ReceiptLedger is constructed in canonical mode. |
| Legacy API | Standalone Agent Resume effectful entrypoints retire explicitly or use a trusted injected Herder facade. No fallback detached resume daemon is started. |
| Release compatibility | TypeScript and Python release gates delegate to one canonical resource bridge after a sealed, fenced migration. |
| Rollout | Immutable candidate, exact component provenance, guarded selector CAS, durable occupancy, independent process identity and consumer schema receipts. |

RemoteStart now has a separate trusted executor backend using the existing
Fleet GPTAdmin transport. It binds the actual executor, immutable job handle,
worker/config/root identity, one start dispatch and an independent Linux
deadline supervisor. Only the central authority owns resource claims. A stale
live ACK, transport partition or uncertain start cannot cause a command replay
or an indefinite renew. This source integration still needs its own native
remote execution receipt.

Local Linux and macOS share the process API and worker contract. Remote
lease execution on macOS and lease-bound RemoteAttach remain explicitly
unsupported. SSH client completion, container client exit and a remote harness
profile do not establish remote job completion.

## Native acceptance evidence

All paths below belong to this task under
/home/roomhacker/herder-artifacts/process-leases-20261113.

### Immutable Linux candidate

Candidate: /home/roomhacker/herder-artifacts/releases/process-leases-0d398e19-v2.
Manifest SHA256:
11afb9a3c15ee8d3622251da67cadfcb8f485fe225335de20ff208f151fd6d46.
Core SHA256:
94adedb51454bb2699412d3cf64eaa7a2428f403cdddddb45b2e333e2a79f3ff.
Worker SHA256:
1d16c41c87e3274fadd601ddd6fedeae8be1bda227853addbebbd374e2424913.

The candidate was checked without changing the public selector. Its private
canaries use fresh authority databases and protected test workspaces.

### Real build, renewal and control-plane restart

Run: canary-opencode-0d398e19-v1.
Session: session:ce6abe2a53c09de35c174eb369041bca.
Native session: ses_e2904998cffe49QdECwwDXtbsz.
Execution:
exec-54e39abb02c0e85b599e580abf4722ba832b7a7cc1abf144a1e7c2d8b0531283.

A real C program was compiled with cc, executed and checked for PROCESS_BUILD_OK.
The supervised command lasted 40.262 seconds with a 15-second lease.
The control plane was stopped and absent for 18 seconds. The same worker,
execution and claim survived; a post-restart read proved a renewed future
deadline. The worker's terminal receipt records exit_code 0, tree_complete true,
process_may_be_running false and completed lease finalization.

The first test harness treated a transient read-side scope_unavailable as fatal
and closed the control plane during wake handoff. The original wake intent is
durable dispatching with no persisted native receipt. This run therefore proves
build/renewal/restart/terminal processing, but does not yet prove a successful
native continuation. No command or wake was resent.

The canary harness now retries only the bounded read operation on an explicit
effect:none scope_unavailable response. It never retries a possible mutation.
The exact original checkpoint and receipt remain available for reconciliation.

### Paired candidate f488d9b0 and rejected wake acceptance

The immutable candidate is
/home/roomhacker/herder-artifacts/releases/process-leases-f488d9b0-v1.
Source commit: f488d9b001c139cf49f67186b1558a05e98d4a8a.
Manifest SHA256:
9eec5f04617567ed36b8c971ec74670a92bef1a508b2d4d195fdc3f0f7cfa223.
Core SHA256:
3f56a10649648d0e5f770b5fcc75b2ec7ad5afab1278b339ee4a9bba43f777cf.
Worker SHA256:
294eb29bf7ff009d48f5c194e788bdc190a6f26587cf3dd842b9cad0a1e88a65.

Run: canary-opencode-f488d9b0-v1.
Session: session:86b362c58630f70aebca7d019758bbd8.
Native session: ses_e28d1a406ffeboMQ5p2YPwj6Up.
The C build ran once for 40.452 seconds. With a 15-second claim and the
control plane absent for 18 seconds, the same claim renewed and the same
execution completed with exit 0 and proven empty process tree. Claim release
and artifact digest were independently observed.

The original quick check returned PASS after seeing the first assistant answer.
Its history projection was incomplete. Review of actual native records found
two assistant messages for the single wake intent:
msg_1d72f22da001t2BiLzZYF0Wb3b and
msg_1d72f38e6001ToSuu6D56sg7Mk.
The original user input is msg_1d72f22a800118GOIOBnk8yk4V.
The one canonical task is
mcp-delivery-task:28ec46e0dc95c1ffbe7b66fe875705315324f351373db16afc8b2704213643a2.

The checkpoint now says FAILED_NATIVE_DUPLICATE and preserves the original
quick-check evidence, both native message identities, and the valid build/lease
receipts. No build or wake was resent. This is not full native acceptance.

The installed native prompt schema has no atomic idle/turn admission condition.
The installed Hindsight hook already uses synthetic resume:false but inserts
its message with the native default delivery semantics. Simply changing Queue
to Steer could interrupt a concurrently started human turn. The updated runner
therefore advertises nativeAutomaticContinuation:
unsupported-no-idle-admission-v1. Automatic process, timer, dependency and child
wait creation must refuse before a new protected effect on that profile.
Existing jobs still reconcile and finalize resources; original delivery intents
remain available for read-only recovery.

The canary helper now waits for stable native idle, checks duplicate assistant
answers, and requires complete history before accepting a unique continuation.
A native receipt proves input admission; it cannot by itself prove exactly one
model turn.

### Harness matrix

| Harness/profile | Observed outcome | Acceptance state |
| --- | --- | --- |
| Codex local | Quota guard rejected thread/start before native submission. Fresh 2026-11-14 provider read reports 6% remaining, while the unchanged local policy reserves 20%. | Blocked by the configured reserve; no session created and no policy bypass. |
| Codex server-44 | Exact create returned create_not_sent with no create/prompt effect. | Not accepted; do not infer a model turn occurred. |
| OpenCode v2 | Paired f488d9b0 candidate admitted the initial prompt and completed the real build. One canonical wake produced two native assistant replies. | FAILED_NATIVE_DUPLICATE. Automatic continuation is capability-gated off for this installed protocol; explicit delivery and fresh creation remain separate. |
| ZCode | One exact promoted input and matching native user message found. The model failed with Token Plan quota code 2056. | Native admission proven, model continuation blocked. Lost-ACK recovery must be checked in the updated candidate. |
| ChatGPT UserIO | Original create remains dispatching/UNKNOWN after caller timeout. | Preserve original operation, reconcile read-only, never repeat create blindly. |
| ZAI UserIO | One bounded create ended after the native 120-second handoff with outcome_unknown; no persisted native binding. | Not accepted. Preserve the original key and do not repeat create. |
| Claude | Disabled according to the user's choice. | Excluded. |
| Hermes | No active public native profile in the inspected six-profile installation. | Not enabled for this rollout. |

Read-only quota evidence from 2026-11-14 00:16 UTC is retained in
quota-preflight-20261114.json. Codex provider allowed:true does not override
Herder's configured reserve. MiniMax still reports quota_exhausted; GLM reports
unknown after a provider error. No new native submission was made by this check.

ZCode evidence binds the exact original create-prompt key, native session
sess_bae78beb-46f1-4199-8eaa-d1a145b1833e and native user message
msg_mwfieii0_d643363f-cb40-4f1d-a28f-570d5ee3a54c. Its native sourceCommandId
preserves the original request correlation. Recovery accepts the exact native
automation anchor, rejects raw human input IDs and leaves reserved-prefix
collisions UNKNOWN. A text match is not used as proof.

The first public OpenCode QA session was explicitly contained and interrupted
after it started work without the intended initial prompt. Its HumanStop remains
active. Evidence: opencode-containment-v1.json. It is not a successful acceptance
session and must not be resumed.

### Preserved browser uncertainty

ChatGPT original key canary-chatgpt-0d398e19-v1-create has no native receipt.
The installed browser bundle does not retain the original create request key in
its local draft mapping. Matching a title or creation time would not establish
the original operation. No blind replay is permitted.

ZAI original key canary-zai-0d398e19-v1-create belongs to
create-operation:8b290852236819388c4d15c9d699133d. Its exact intent is unknown,
not rejected, with no native receipt or session binding. Its checkpoint is
canary-zai-0d398e19-v1/checkpoint.json.

### Native macOS evidence

Mac Mini was reached through its currently verified host identity. Source was
copied into an owned isolated directory and checked by digest. Native cargo
check --bins passed for the worker, MCP core and resource bridge on macOS 15.7.8
with Rust 1.97.1.

The final real process suite passed 15 tests, including a detached setsid grandchild
that outlived its wrapper, worker SIGKILL with retained UNKNOWN occupancy,
coalition-empty recovery and safe cancellation by PID generation. A wrong PID
generation was rejected by the kernel while the intended child remained alive.
This is platform acceptance evidence, not a shared fleet deployment receipt.

## Test checkpoints

Test counts describe separate suites and must not be added without checking
their overlap.

- Original Linux implementation: library 218, engine 12, resource 26, bindings 6,
  automation 8 and catalog 6 tests passed.
- Canonical release bridge: Rust 10, real Python/Rust 2, cutover 15, canonical
  Python gate 5 and real TypeScript/Rust 6 passed.
- Wait gates and remote read route: TypeScript 48 passed; local reader 13 passed.
- Cadence/admission/ZCode projection: targeted 44 passed.
- OpenCode protocol/projection: 53 passed, including the observed top-level native
  v2 payload and the capability-gated initial-turn admission.
- Lost-ACK/CAS: scoped receipt recovery 15, AHAP 12 and the existing reconciliation
  test passed. Existing create-prompt 4 and create/delivery wire checks passed.
- Root process automation 12 passed after automatic ACK reconciliation and
  HumanStop-before-launch admission fencing were connected.
- Native macOS process supervision 15 passed; process units 2, pinned gates 2,
  real worker lease renew/release 1 and automation restart/wake 1 passed.
- Final Linux process supervision 16 passed; process automation 12 passed,
  including a real claim released after proven cancellation before launch.
- Strict candidate packaging: baseline 15, adapter transition 12 and rollout
  coordinator 18 passed. The adapter suite includes actual tsc and bundling.
- The first full Rust run passed 220 library tests but stopped at one launcher
  fixture whose script was group-writable under umask 0002. The fixture now
  explicitly uses mode 0700; the exact regression passed with that umask.
  The full run must be resumed after the coherent recovery fixes.
- Coherent Rust verification on 2026-11-14 passed all 33 targets: 465 tests
  passed and 7 native/opt-in tests remained ignored. The command used --locked,
  --all-targets, --no-fail-fast and --test-threads=1. The private
  rust-source-test-receipt-20261114.json binds the log and 167 crate source files.
  The initial parallel run exposed a transient fake-executable ETXTBUSY and an
  invalid two-second fixture wall-clock assertion. The latter now checks one
  actual admission; canonical_waits also passed 14/14 in parallel.
- Canonical direct resume passed 18 focused tests after the typed conflict fix.
  Principal-wide delivery keys passed 7, scoped receipt recovery passed 20.
- Paired runtime readiness passed 34 TypeScript tests, plus 9 existing gate/auth
  checks and tsc. Python readiness 10, coordinator 22, candidate 17 and paired
  adapter packaging 12 passed; the final persistent environment hardening was
  rechecked in the readiness suite.
- TypeScript --noEmit and git diff --check passed at reported source
  checkpoints. Final merged TypeScript and immutable candidate checks are
  recorded with their own commit and receipt.

Logs and native task receipts are retained with this task. The final report
must distinguish source tests, isolated candidate evidence and actual installed
consumer evidence.

## Migration and deployment gates

The current public MCP still uses the prior composite manifest. The TypeScript
service is another installed surface and must be upgraded separately. A native
core restart alone does not activate TS automatic-continuation gates.

The adapter update must pin new OpenCode and ZCode bundles from the same clean
source. It must preserve all other component hashes and every existing authority
database, gate, generation, principal, native account, model and environment.
Only the reviewed adapter path may change in a new protected sibling profile.
Existing profiles are retained.

The canonical release cutover currently encounters three retained legacy
records: vpn-panel fence 9, exmanager fence 1 and macintel-webvnc fence 1.
Expiry or an absent PID does not prove their protected operation completed.
In particular, the observed vpn-panel cleanup receipt releases fence 8, while
the retained record is the later fence 9. It cannot close that generation.

Forty-seven legacy Agent Resume records previously reported running despite
missing recorded process and watcher PIDs. Preserve them as unresolved evidence;
do not bulk-wake their sessions, relaunch commands or manufacture success.

Shared rollout requires a current project release proof held through guarded
installation, the exact child restart, fresh process identity and actual
consumer verification. The production coordinator requires the source to be
merged into freshly fetched origin/main. Unresolved cutover occupancy cannot be
deleted to bypass this gate.

Airlock VPS is excluded. No calls or notifications to people are permitted in
acceptance. Keep the existing default and public-child selectors distinct.
Preserve the shared dirty main and the separately retained local commit 98593d9c.

## Canonical source integration and migration boundary

The native owner runtime now hosts ProcessCompletion, Timer, SessionCompletion
and existing child completion through one automation driver. Timer due times
are persisted once. Dependencies bind exact native turn identity and reject
cross-profile cycles. Read-only session.resolve and deliver.receipt use scoped
bindings and work without starting an adapter. Missing or ambiguous evidence
remains a typed error.

Canonical TypeScript compatibility delegates to that runtime over the exact
pinned Fleet route. It starts no legacy resume-after sweep and constructs no
legacy ReceiptLedger. Its direct-resume key is principal-wide, durably bound to
one target and payload inside the existing resource authority, and rechecked
at the actual native handoff. Cross-session key reuse and corrupted bindings
cannot produce another send. A lost ACK reads only the original intent and
receipt.

Old waits and receipts remain at their original locations as sealed evidence.
The activation barrier checks exact inventories and original writer birth
identities; an old process already inside handoff must be drained. UNKNOWN,
pending and insufficiently settled cancelled records block new admission.
HumanRequest-bound canonical waits and Darwin writer-drain activation remain
explicitly unsupported pending their own reviewed authority/verifier.
No legacy fallback is allowed after selecting canonical mode.

The candidate includes the immutable remote bridge. Native execution will use
only an isolated controller on roomhacker-server-100 and the freshly verified
server-44 executor, with existing credential generation and exact artifact pins.
The remote test does not send a model prompt.

The production coordinator also requires a paired TypeScript canonical cutover
proof. The old installed TS scheduler must not remain capable of continuing
sessions while the new native core owns waits. Installed process identity,
immutable source/configuration, writer drain and a fresh query through the
actual TS gate must be verified across the native switch. Isolated candidates
do not change shared services.

See canonical-waits-and-resume.md and remote-process-execution.md for exact
contracts and focused test evidence. These source changes do not settle the
native/profile or migration blockers recorded above.

## Remaining closure work

1. Finish the coherent source checkpoint and immutable paired adapter package.
2. Reconcile the original native UNKNOWN operations without resend.
3. Complete the full live build-to-continuation canary on the new candidate.
4. Record active-profile and executor acceptance with truthful provider blockers.
5. Resolve or preserve legacy state through the reviewed migration procedure.
6. Integrate through the required PR workflow and perform guarded installation
   only when all actual deployment gates are satisfied.
7. Record installed hashes, exact consumer evidence and the final support matrix.
